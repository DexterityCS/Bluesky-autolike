// content_bot.js
// Posts CS2, OW2, and incremental game content to Bluesky twice daily
// Also detects new Steam 100% completions and posts celebrations immediately

const https = require("https");
const http  = require("http");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────
const BLUESKY_HANDLE    = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD  = process.env.BLUESKY_PASSWORD;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISCORD_WEBHOOK_URL            = process.env.DISCORD_WEBHOOK_URL || null;
const DISCORD_COMPLETION_WEBHOOK_URL = process.env.DISCORD_COMPLETION_WEBHOOK_URL || DISCORD_WEBHOOK_URL;
const GIST_TOKEN        = process.env.GIST_TOKEN || null;
const GIST_ID           = process.env.GIST_ID || "9e21611814d0c5b84c94a9bc15ed21fa";
const STEAM_API_KEY     = process.env.STEAM_API_KEY || null;
const STEAM_ID          = "76561198121481638";

// ── Player context ────────────────────────────────────────
const PLAYER_CONTEXT = {
  cs2: {
    rank: "MG2",
    rating: 13500,
    focus: "improving on Nuke and overall gameplay",
    handle: "dexteritycs",
  },
  ow2: {
    rank: "Silver",
    goal: "climbing out of Silver",
    supportMains: ["Kiriko", "Moira"],
    damageMains: ["Soldier: 76", "Bastion", "Junkrat"],
    role: "Support and Damage",
  },
};

// ── Completed incremental games — loaded from Gist ───────
// Edit incremental_games.json in your Gist to add/remove games
let INCREMENTAL_GAMES = [];

// Only celebrate completions unlocked after this date (when bot was set up)
// Prevents posting about games completed before the content bot existed
const COMPLETION_CUTOFF = new Date("2026-06-28T00:00:00.000Z");
// Steam completion check always runs first and overrides if found
const CONTENT_TYPES = ["cs2", "cs2", "cs2", "ow2", "ow2", "incremental", "incremental"];

// ── HTTP ──────────────────────────────────────────────────
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const mod = options.port === 80 ? http : https;
    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Gist helpers ──────────────────────────────────────────
async function fetchContentStats() {
  if (!GIST_TOKEN || !GIST_ID) return getDefaultContentStats();
  try {
    const res = await request({
      hostname: "api.github.com",
      path: `/gists/${GIST_ID}`,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${GIST_TOKEN}`,
        "User-Agent": "dexteritycs-bot",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status !== 200) return getDefaultContentStats();

    // Load content stats
    const statsFile = res.body.files?.["content_stats.json"];
    const stats = statsFile?.content
      ? { ...getDefaultContentStats(), ...JSON.parse(statsFile.content) }
      : getDefaultContentStats();

    // Load incremental games list
    const gamesFile = res.body.files?.["incremental_games.json"];
    if (gamesFile?.content) {
      INCREMENTAL_GAMES = JSON.parse(gamesFile.content);
      console.log(`🎮 Loaded ${INCREMENTAL_GAMES.length} incremental games from Gist`);
    } else {
      console.warn("⚠️  incremental_games.json not found in Gist — add it to enable incremental posts");
    }

    return stats;
  } catch { return getDefaultContentStats(); }
}

function getDefaultContentStats() {
  return {
    lastPostType: null,
    lastPostAt: null,
    celebratedGames: [],      // Steam app IDs already celebrated
    postedIncrementals: [],   // game names already posted about
    rotationIndex: 0,
    totalPosts: 0,
  };
}

async function saveContentStats(stats, gamesList = null) {
  if (!GIST_TOKEN || !GIST_ID) return;
  try {
    const files = {
      "content_stats.json": { content: JSON.stringify(stats, null, 2) },
    };
    if (gamesList !== null) {
      files["incremental_games.json"] = { content: JSON.stringify(gamesList, null, 2) };
    }
    await request({
      hostname: "api.github.com",
      path: `/gists/${GIST_ID}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GIST_TOKEN}`,
        "User-Agent": "dexteritycs-bot",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, JSON.stringify({ files }));
    console.log("📡 Content stats saved to Gist");
  } catch (e) {
    console.warn(`Gist save failed: ${e.message}`);
  }
}

// ── Bluesky auth + post ───────────────────────────────────
async function login() {
  const res = await request({
    hostname: "bsky.social",
    path: "/xrpc/com.atproto.server.createSession",
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_PASSWORD }));
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  console.log(`✅ Logged in as ${BLUESKY_HANDLE}`);
  return { token: res.body.accessJwt, did: res.body.did };
}

async function postToBluesky(text, token, did) {
  // Build facets for hashtags and URLs
  const facets = [];
  const encoder = new TextEncoder();

  const tagRegex = /#(\w+)/g;
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const start = encoder.encode(text.slice(0, match.index)).length;
    const end   = start + encoder.encode(match[0]).length;
    facets.push({ index: { byteStart: start, byteEnd: end }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: match[1] }] });
  }

  const urlRegex = /https?:\/\/[^\s]+/g;
  while ((match = urlRegex.exec(text)) !== null) {
    const start = encoder.encode(text.slice(0, match.index)).length;
    const end   = start + encoder.encode(match[0]).length;
    facets.push({ index: { byteStart: start, byteEnd: end }, features: [{ $type: "app.bsky.richtext.facet#link", uri: match[0] }] });
  }

  const res = await request({
    hostname: "bsky.social",
    path: "/xrpc/com.atproto.repo.createRecord",
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  }, JSON.stringify({
    repo: did,
    collection: "app.bsky.feed.post",
    record: {
      $type: "app.bsky.feed.post",
      text,
      facets: facets.length ? facets : undefined,
      createdAt: new Date().toISOString(),
    },
  }));

  if (res.status !== 200) throw new Error(`Post failed: ${JSON.stringify(res.body)}`);
  console.log(`✅ Posted: "${text.slice(0, 60)}..."`);
  return res.body;
}

// ── Claude content generation ─────────────────────────────
async function generateContent(type, context = {}) {
  const prompts = {
    cs2: `You are Dexterity (@dexteritycs.bsky.social), a CS2 player and Twitch streamer.
Current stats: ${PLAYER_CONTEXT.cs2.rank} rank, ${PLAYER_CONTEXT.cs2.rating} Premier rating.
Currently focusing on: ${PLAYER_CONTEXT.cs2.focus}.

Write a genuine, conversational Bluesky post about CS2. Could be:
- Something you're working on improving (Nuke callouts, positioning, utility)
- A thought about the Premier grind or ranked experience
- A tip or observation from recent gameplay
- Something relatable to MG/high-Silver CS2 players

Sound like a real player, not a brand. Keep it under 280 chars. No excessive emojis.
Include 1-2 relevant hashtags like #CS2 #CounterStrike. Output only the post text.`,

    ow2: `You are Dexterity (@dexteritycs.bsky.social), an OW2 player and Twitch streamer.
Current rank: ${PLAYER_CONTEXT.ow2.rank}, trying to ${PLAYER_CONTEXT.ow2.goal}.
Support mains: ${PLAYER_CONTEXT.ow2.supportMains.join(", ")}.
Damage mains: ${PLAYER_CONTEXT.ow2.damageMains.join(", ")}.

Write a genuine, conversational Bluesky post about Overwatch 2. Could be:
- A thought about playing Kiriko or Moira in ranked
- Something about the Silver rank experience
- A tip or frustration about Soldier, Bastion, or Junkrat
- Something relatable to support/flex players climbing ranked

Sound like a real player. Keep it under 280 chars. No excessive emojis.
Include 1-2 hashtags like #Overwatch2 #OW2. Output only the post text.`,

    incremental: `You are Dexterity (@dexteritycs.bsky.social), a Twitch streamer who loves incremental/idle games.
You have 100% completed all achievements in dozens of incremental games on Steam.
The game to post about today: "${context.game}"

Write a genuine, honest post sharing your thoughts on this specific game. Focus on:
- What makes it satisfying or unique as an incremental
- The core loop or mechanic that stands out
- Whether the 100% grind was worth it
- Something specific that fans of the genre would appreciate

Be genuine and specific — not generic praise. Keep it under 280 chars.
Include #IdleGames or #IncrementalGames and optionally the game name as a tag if it works.
Output only the post text.`,

    steam_completion: `You are Dexterity (@dexteritycs.bsky.social), a Twitch streamer who 100% completes incremental games on Steam.
You just 100%'d all achievements in: "${context.game}"

Write an excited but genuine celebration post. Mention:
- That you just got 100% achievements
- Something brief and honest about the game
- Keep the energy real, not cringe

Under 280 chars. Include #Steam #IncrementalGames. Output only the post text.`,
  };

  const res = await request({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
  }, JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: "You are a content writer for a gaming streamer. Output only the post text, nothing else. No quotes around the text.",
    messages: [{ role: "user", content: prompts[type] }],
  }));

  if (res.status !== 200) throw new Error(`Claude API error: ${res.status}`);
  return res.body.content?.[0]?.text?.trim();
}

// ── Steam completion checker ──────────────────────────────
async function checkSteamCompletions(contentStats) {
  if (!STEAM_API_KEY) {
    console.log("⚠️  No STEAM_API_KEY — skipping completion check");
    return null;
  }

  try {
    // Get all owned games with playtime
    const gamesRes = await request({
      hostname: "api.steampowered.com",
      path: `/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${STEAM_ID}&include_appinfo=true&include_played_free_games=true`,
      method: "GET",
      headers: { "User-Agent": "dexteritycs-bot" },
    });

    if (gamesRes.status !== 200 || !gamesRes.body.response?.games) {
      console.warn("Steam owned games fetch failed");
      return null;
    }

    const games = gamesRes.body.response.games;
    const celebrated = new Set(contentStats.celebratedGames || []);

    // Check games with playtime that haven't been celebrated yet
    // Only check games actually played (playtime > 0)
    // Sort by most recently played so fresh completions are checked first
    const candidates = games
      .filter(g => g.playtime_forever > 0 && !celebrated.has(String(g.appid)))
      .sort((a, b) => (b.rtime_last_played || 0) - (a.rtime_last_played || 0));

    console.log(`🎮 Checking ${candidates.length} played games for 100% completion...`);

    // Check up to 20 candidates per run, prioritizing recently played
    const toCheck = candidates.slice(0, 20);

    for (const game of toCheck) {
      await sleep(500); // Steam rate limit buffer
      try {
        const achRes = await request({
          hostname: "api.steampowered.com",
          path: `/ISteamUserStats/GetPlayerAchievements/v1/?appid=${game.appid}&key=${STEAM_API_KEY}&steamid=${STEAM_ID}`,
          method: "GET",
          headers: { "User-Agent": "dexteritycs-bot" },
        });

        if (achRes.status !== 200 || !achRes.body.playerstats?.achievements) continue;

        const achievements = achRes.body.playerstats.achievements;
        if (achievements.length === 0) continue; // no achievements in this game

        const total    = achievements.length;
        const unlocked = achievements.filter(a => a.achieved === 1).length;

        if (unlocked === total && unlocked > 0) {
          // Check when the last achievement was unlocked
          const lastUnlockTime = Math.max(...achievements
            .filter(a => a.achieved === 1 && a.unlocktime)
            .map(a => a.unlocktime * 1000));
          const lastUnlockDate = new Date(lastUnlockTime);

          if (lastUnlockDate < COMPLETION_CUTOFF) {
            console.log(`   ⏭️  Skipped ${game.name} — completed before cutoff (${lastUnlockDate.toLocaleDateString()})`);
            contentStats.celebratedGames.push(String(game.appid));
            continue;
          }

          console.log(`🏆 New 100%! ${game.name} (${total} achievements, completed ${lastUnlockDate.toLocaleDateString()})`);
          return {
            appid: String(game.appid),
            name: game.name,
            achievements: total,
          };
        }
      } catch (e) {
        console.warn(`Achievement check failed for ${game.name}: ${e.message}`);
      }
    }

    console.log("No new 100% completions found this run");
    return null;
  } catch (e) {
    console.warn(`Steam check error: ${e.message}`);
    return null;
  }
}

// ── Discord notification ──────────────────────────────────
async function postDiscordNotification(type, text, context = {}, webhookOverride = null) {
  const webhookUrl = webhookOverride || DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const configs = {
      cs2:              { title: "🎮 CS2 Post Published",              color: 0x00e5ff },
      ow2:              { title: "🎮 OW2 Post Published",              color: 0xff8c1e },
      incremental:      { title: "🎮 Incremental Game Post Published", color: 0x00ff88 },
      steam_completion: { title: "🏆 Steam 100% Celebration Posted!",  color: 0xffd600 },
    };
    const cfg = configs[type] || { title: "📝 Content Posted", color: 0x00e5ff };
    const url = new URL(webhookUrl);
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, JSON.stringify({
      embeds: [{
        title: cfg.title,
        color: cfg.color,
        description: `"${text}"`,
        footer: { text: context.game ? `Game: ${context.game}` : `dexterityCS Content Bot` },
      }]
    }));
    console.log("📨 Discord notification posted");
  } catch (e) {
    console.warn(`Discord notification failed: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────
async function run() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD");
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error("❌ Missing ANTHROPIC_API_KEY");
    process.exit(1);
  }

  console.log("🚀 Content bot starting...");

  const contentStats = await fetchContentStats();
  const { token, did } = await login();

  // ── Step 1: Check Steam for new 100% completions ─────────
  const newCompletion = await checkSteamCompletions(contentStats);

  if (newCompletion) {
    console.log(`🎉 Posting Steam 100% celebration for "${newCompletion.name}"`);
    const postText = await generateContent("steam_completion", { game: newCompletion.name });
    if (postText) {
      await postToBluesky(postText, token, did);
      await postDiscordNotification("steam_completion", postText, { game: newCompletion.name }, DISCORD_COMPLETION_WEBHOOK_URL);
      contentStats.celebratedGames.push(newCompletion.appid);
      contentStats.totalPosts = (contentStats.totalPosts || 0) + 1;
      contentStats.lastPostAt = new Date().toISOString();
      contentStats.lastPostType = "steam_completion";

      // Auto-add to incremental games list so future posts can include genuine thoughts
      if (!INCREMENTAL_GAMES.includes(newCompletion.name)) {
        INCREMENTAL_GAMES.push(newCompletion.name);
        console.log(`📝 Auto-added "${newCompletion.name}" to incremental games list in Gist`);
        await saveContentStats(contentStats, INCREMENTAL_GAMES);
      } else {
        await saveContentStats(contentStats);
      }
    }
    return;
  }

  // ── Step 2: Post scheduled content ───────────────────────
  const type = CONTENT_TYPES[contentStats.rotationIndex % CONTENT_TYPES.length];
  console.log(`📝 Posting ${type} content (rotation index ${contentStats.rotationIndex})`);

  let context = {};
  if (type === "incremental") {
    if (INCREMENTAL_GAMES.length === 0) {
      console.warn("⚠️  No incremental games loaded — skipping incremental post this run");
      return;
    }
    // Pick a game not recently posted about
    const posted = new Set(contentStats.postedIncrementals || []);
    const available = INCREMENTAL_GAMES.filter(g => !posted.has(g));
    // If all have been posted, reset and start over
    const pool = available.length > 0 ? available : INCREMENTAL_GAMES;
    context.game = pool[Math.floor(Math.random() * pool.length)];
    console.log(`🎮 Incremental game: "${context.game}"`);
  }

  const postText = await generateContent(type, context);
  if (!postText) {
    console.error("❌ Failed to generate content");
    process.exit(1);
  }

  await postToBluesky(postText, token, did);
  await postDiscordNotification(type, postText, context);

  // Update stats
  contentStats.rotationIndex = (contentStats.rotationIndex + 1) % CONTENT_TYPES.length;
  contentStats.lastPostType  = type;
  contentStats.lastPostAt    = new Date().toISOString();
  contentStats.totalPosts    = (contentStats.totalPosts || 0) + 1;

  if (type === "incremental" && context.game) {
    if (!contentStats.postedIncrementals) contentStats.postedIncrementals = [];
    contentStats.postedIncrementals.push(context.game);
    // Keep last 30 to allow revisiting older games eventually
    if (contentStats.postedIncrementals.length > 30) {
      contentStats.postedIncrementals.shift();
    }
  }

  await saveContentStats(contentStats);
  console.log(`✅ Content bot run complete — ${contentStats.totalPosts} total posts`);
}

run().catch(async (err) => {
  console.error("❌ Content bot error:", err.message);
  if (DISCORD_WEBHOOK_URL) {
    try {
      const url = new URL(DISCORD_WEBHOOK_URL);
      await request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, JSON.stringify({
        embeds: [{
          title: "❌ Content Bot Failed",
          color: 0xff3d57,
          description: `\`\`\`${err.message}\`\`\``,
          footer: { text: new Date().toLocaleString() },
        }]
      }));
    } catch {}
  }
  process.exit(1);
});
