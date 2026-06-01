// post-release.mjs
// Triggers on GitHub release → generates Bluesky post via Claude → posts it
// Works for all dexteritycs repos

import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";

const {
  ANTHROPIC_API_KEY,
  BLUESKY_HANDLE,
  BLUESKY_PASSWORD,
  RELEASE_NAME,
  RELEASE_BODY,
  RELEASE_URL,
  REPO_NAME,
  REPO_DESCRIPTION,
} = process.env;

// Repo context map — tells Claude what each tool actually does
const REPO_CONTEXT = {
  "Spotify-widget":    "a Twitch stream overlay that shows the currently playing Spotify song with album art, progress bar, and a backtick color customization menu",
  "Challenge-Wheel":   "a CS2 channel points spin wheel for Twitch — viewers redeem points to trigger live spins in OBS via EventSub WebSocket",
  "Card-Drop":         "a TCG-style collectible card drop widget for Twitch — channel point redemptions trigger card pulls with 5 rarity tiers and holographic effects",
  "Redeem-Popup":      "an on-stream notification overlay that shows a styled card whenever a viewer redeems any Twitch channel points reward",
  "CS2-Hot-Takes":     "a Twitch overlay that delivers spicy CS2 hot takes on stream when triggered by channel point redemptions",
  "Twitch-Clip-Wall":  "a BRB screen overlay that auto-cycles recent Twitch clips using native MP4 playback directly in OBS",
  "CS2-Stats-Overlay": "a live CS2 HUD overlay for OBS that pulls K/D, Win Rate, and Premier Rating from Tracker.gg via a Railway proxy",
  "Bluesky-autolike":  "a GitHub Actions bot that automatically likes and follows CS2 content creators on Bluesky by searching configurable hashtags and keywords — runs every 4 hours with a dashboard for manual control",
};

const repoContext = REPO_CONTEXT[REPO_NAME] || REPO_DESCRIPTION || "a Twitch stream tool";

// Validate env
const missing = ["ANTHROPIC_API_KEY","BLUESKY_HANDLE","BLUESKY_PASSWORD"].filter(k => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing secrets:", missing.join(", "));
  console.error("   Repo → Settings → Secrets → Actions → New repository secret");
  process.exit(1);
}

async function generatePost() {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = `You just shipped a new release of your Twitch stream tool.

Tool: "${RELEASE_NAME}" from the repo "${REPO_NAME}"
What it does: ${repoContext}
Release notes: ${RELEASE_BODY || "New update dropped"}
Release URL: ${RELEASE_URL}

Write a Bluesky post announcing this release. Rules:
- Written as Dexterity (@dexteritycs.bsky.social), a CS2 streamer and open-source stream tool dev
- Excited but not cringe — real streamer/dev energy
- Briefly mention what the tool does or what changed in this release
- Invite other streamers to try it (it's free/open source)
- Include the release URL
- 2-3 relevant hashtags (#Twitch #StreamTools #CS2 #OBS etc — pick what fits)
- Max 280 chars including the URL
- Output ONLY the post text, nothing else`;

  const msg = await anthropic.messages.create({
    model:      "claude-opus-4-5",
    max_tokens: 400,
    system:     "You are Dexterity, a CS2 streamer and indie developer who builds free open-source Twitch tools. Write punchy, real posts. Never corporate. Output only the post text.",
    messages:   [{ role: "user", content: prompt }],
  });

  return msg.content[0].text.trim();
}

async function blueskyLogin() {
  const res = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${await res.text()}`);
  return await res.json();
}

async function postToBluesky(text, accessJwt, did) {
  const facets  = [];
  const encoder = new TextEncoder();

  // URL facets
  const urlRegex = /https?:\/\/[^\s]+/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const start = encoder.encode(text.slice(0, match.index)).length;
    const end   = start + encoder.encode(match[0]).length;
    facets.push({ index: { byteStart: start, byteEnd: end }, features: [{ $type: "app.bsky.richtext.facet#link", uri: match[0] }] });
  }

  // Hashtag facets
  const tagRegex = /#(\w+)/g;
  while ((match = tagRegex.exec(text)) !== null) {
    const start = encoder.encode(text.slice(0, match.index)).length;
    const end   = start + encoder.encode(match[0]).length;
    facets.push({ index: { byteStart: start, byteEnd: end }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: match[1] }] });
  }

  const res = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessJwt}` },
    body: JSON.stringify({
      repo: did, collection: "app.bsky.feed.post",
      record: { $type: "app.bsky.feed.post", text, facets: facets.length ? facets : undefined, createdAt: new Date().toISOString() },
    }),
  });

  if (!res.ok) throw new Error(`Post failed: ${await res.text()}`);
  return await res.json();
}

(async () => {
  try {
    console.log(`🚀 Release: ${RELEASE_NAME} (${REPO_NAME})`);
    console.log("🤖 Generating post...");
    const postText = await generatePost();
    console.log(`📝 "${postText}"`);

    console.log("🔐 Logging into Bluesky...");
    const { accessJwt, did } = await blueskyLogin();

    console.log("📤 Posting...");
    const result = await postToBluesky(postText, accessJwt, did);
    console.log(`✅ Posted! URI: ${result.uri}`);
  } catch(err) {
    console.error("❌", err.message);
    process.exit(1);
  }
})();
