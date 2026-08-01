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
// Rank/rating can be overridden via env vars so you can update them
// without touching code — just edit the repo variable/secret whenever
// your rank changes. Falls back to the hardcoded defaults if unset.
// ── Ken's actual writing voice — used to bias generated posts to sound like
// him specifically, not a generic "gamer persona." Update this directly if
// his style shifts; it's plain text, no code changes needed.
const VOICE_STYLE = `Match this real writing voice as closely as possible:
- Drop apostrophes in contractions (dont, im, ive, ill, didnt, youve, cant, wont)
- Casual/inconsistent capitalization — dont sweat capitalizing "I" or sentence starts consistently
- Minimal punctuation — comma splices instead of proper sentence breaks are fine and authentic
- Terse and direct, even explaining something technical or opinionated — no hedging, no over-explaining
- Never use exclamation points or emoji
- Sound like real unpolished typing, not edited/cleaned-up writing
- IMPORTANT: You are NOT currently streaming and havent streamed in years — never reference streaming, being live, your stream, or Twitch as a current activity. You're a gamer and content creator posting on Bluesky, that's it.`;

const PLAYER_CONTEXT = {
  cs2: {
    rank: process.env.CS2_RANK || "Premier",
    rating: process.env.CS2_RATING || null, // omit specific number if unset — see prompt below
    focus: process.env.CS2_FOCUS || "improving overall gameplay and utility usage",
    handle: "dexteritycs",
  },
  ow2: {
    rank: process.env.OW2_RANK || "climbing the ranked ladder",
    goal: process.env.OW2_GOAL || "climbing higher in ranked",
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
// ── Content rotation — built dynamically from weights ─────
const DEFAULT_WEIGHTS = { cs2: 3, ow2: 2, incremental: 2, backlog_poll: 1, progress_teaser: 1, quick_question: 2 };

function buildContentTypes(weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const types = [];
  for (const [type, count] of Object.entries(w)) {
    for (let i = 0; i < Math.max(1, count); i++) types.push(type);
  }
  return types;
}

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

// ── Safe truncation — never cuts a multi-byte character (emoji, CJK, etc.) in half ──
function safeTruncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || "";
  let cut = str.slice(0, maxLen);
  // If we landed on the high surrogate of a pair, back off one more character
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

// ── Recent posts of a type — used to steer Claude away from repeating itself ──
function getRecentPostTexts(contentStats, type, limit = 5) {
  if (!contentStats.sentPosts?.length) return [];
  return contentStats.sentPosts
    .filter(p => p.type === type && p.text)
    .slice(-limit)
    .map(p => p.text);
}

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
    lastPostType:       null,
    lastPostAt:         null,
    celebratedGames:    [],
    postedIncrementals: [],
    rotationIndex:      0,
    totalPosts:         0,
    sentPosts:          [],       // track URIs for engagement checking
    typeWeights:        { cs2: 3, ow2: 2, incremental: 2, backlog_poll: 1, progress_teaser: 1, quick_question: 2 }, // adjustable weights
    typeEngagement:     { cs2: { likes: 0, reposts: 0, posts: 0 },
                          ow2: { likes: 0, reposts: 0, posts: 0 },
                          incremental: { likes: 0, reposts: 0, posts: 0 },
                          backlog_poll: { likes: 0, reposts: 0, posts: 0 },
                          progress_teaser: { likes: 0, reposts: 0, posts: 0 },
                          quick_question: { likes: 0, reposts: 0, posts: 0 } },
    uncelebratedQueue:  [], // confirmed 100% completions waiting to be posted about
    confirmedComplete:  [], // appids already confirmed 100% — skip re-checking achievements for these
    lastProgressTeaseAppid: null, // avoid teasing the same in-progress game twice in a row
    activeBacklogPoll:  null, // { uri, cid, options, postedAt } — one open poll at a time
    pollWinnerAppid:    null, // set once a poll resolves — biases the next progress_teaser pick
    repliedToComments:  [],   // reply URIs already responded to, so we don't reply twice
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

// ── Reply to a specific post (used for replying to comments on your own posts) ──
async function replyToBlueskyPost(rootUri, rootCid, parentUri, parentCid, text, token, did) {
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
      reply: {
        root:   { uri: rootUri, cid: rootCid },
        parent: { uri: parentUri, cid: parentCid },
      },
      createdAt: new Date().toISOString(),
    },
  }));
  if (res.status !== 200) throw new Error(`Reply post failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

// ── Fetch all replies in a thread (flattened, any depth) ──
async function fetchPostReplies(uri, token) {
  try {
    const res = await request({
      hostname: "bsky.social",
      path: `/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=6`,
      method: "GET",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    });
    if (res.status !== 200 || !res.body.thread) return [];

    const replies = [];
    function walk(node) {
      if (!node?.replies?.length) return;
      for (const child of node.replies) {
        if (child?.post) {
          replies.push({
            uri:          child.post.uri,
            cid:          child.post.cid,
            authorDid:    child.post.author?.did,
            authorHandle: child.post.author?.handle,
            text:         child.post.record?.text || "",
          });
          walk(child);
        }
      }
    }
    walk(res.body.thread);
    return replies;
  } catch (e) {
    console.warn(`Fetch replies failed: ${e.message}`);
    return [];
  }
}

// ── Claude content generation ─────────────────────────────
// ── Backlog helpers — real owned-but-unfinished games, from the cached Steam library ──
function getBacklogCandidates(contentStats) {
  const celebrated = new Set(contentStats.celebratedGames || []);
  const confirmed  = new Set((contentStats.confirmedComplete || []).map(String));
  return (contentStats.gameLibrary || []).filter(g => {
    const id = String(g.appid);
    if (celebrated.has(id) || confirmed.has(id)) return false;
    if (!g.playtime || g.playtime <= 0) return false; // only games actually started
    return true;
  });
}

async function fetchAchievementProgress(appid) {
  if (!STEAM_API_KEY) return null;
  try {
    const res = await request({
      hostname: "api.steampowered.com",
      path: `/ISteamUserStats/GetPlayerAchievements/v1/?appid=${appid}&key=${STEAM_API_KEY}&steamid=${STEAM_ID}`,
      method: "GET",
      headers: { "User-Agent": "dexteritycs-bot" },
    });
    if (res.status !== 200 || !res.body.playerstats?.achievements) return null;
    const achievements = res.body.playerstats.achievements;
    if (achievements.length === 0) return null;
    const total    = achievements.length;
    const unlocked = achievements.filter(a => a.achieved === 1).length;
    return { unlocked, total };
  } catch { return null; }
}

// ── Reply to comments on your own posts ───────────────────
const MAX_COMMENT_REPLIES_PER_RUN = 5;
const COMMENT_REPLY_WINDOW_HOURS  = 72;

async function generateCommentReply(rootText, commentText, commentAuthorHandle) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 120,
      system: "You are Dexterity (@dexteritycs.bsky.social), a gamer and content creator replying genuinely to comments on your own Bluesky posts. Be warm, specific, and conversational — like a real person glad someone engaged, not a template. Never discuss politics, NSFW topics, or anything off-topic from gaming/streaming — if the comment is off-topic, low-effort, or inappropriate, respond with exactly: SKIP. Output only the reply text or SKIP, nothing else.",
      messages: [{
        role: "user",
        content: `Your original post said: "${safeTruncate(rootText, 200)}"\n\n@${commentAuthorHandle} replied: "${safeTruncate(commentText, 200)}"\n\nWrite a short, genuine reply to them. Under 200 characters.`
      }]
    });
    const res = await request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    }, body);
    if (res.status !== 200) {
      const errMsg = res.body?.error?.message || JSON.stringify(res.body);
      console.warn(`   ⚠️  Comment reply generation failed: ${res.status} — ${errMsg}`);
      return null;
    }
    const text = res.body.content?.[0]?.text?.trim();
    if (!text || text.toUpperCase() === "SKIP") return null;
    return text;
  } catch (e) {
    console.warn(`   ⚠️  Comment reply generation error: ${e.message}`);
    return null;
  }
}

async function checkAndReplyToOwnComments(token, did, contentStats) {
  if (!contentStats.sentPosts?.length) return;
  if (!contentStats.repliedToComments) contentStats.repliedToComments = [];
  const alreadyReplied = new Set(contentStats.repliedToComments);

  const cutoff = Date.now() - (COMMENT_REPLY_WINDOW_HOURS * 3600000);
  const recentPosts = contentStats.sentPosts.filter(p => p.uri && p.cid && new Date(p.sentAt).getTime() > cutoff);
  if (!recentPosts.length) return;

  let repliesSent = 0;
  console.log(`💬 Checking comments on ${recentPosts.length} recent post(s)...`);

  for (const post of recentPosts) {
    if (repliesSent >= MAX_COMMENT_REPLIES_PER_RUN) break;
    const replies = await fetchPostReplies(post.uri, token);

    for (const reply of replies) {
      if (repliesSent >= MAX_COMMENT_REPLIES_PER_RUN) break;
      if (!reply.authorDid || reply.authorDid === did) continue; // skip self-replies
      if (!reply.cid) continue;
      if (alreadyReplied.has(reply.uri)) continue;
      if (!reply.text || reply.text.trim().length < 3) continue;

      const replyText = await generateCommentReply(post.text || "", reply.text, reply.authorHandle || "there");
      // Mark as attempted either way — don't retry the same comment forever
      alreadyReplied.add(reply.uri);
      contentStats.repliedToComments.push(reply.uri);

      if (!replyText) {
        console.log(`   ⏭️  Skipped comment from @${reply.authorHandle} — nothing genuine to say`);
        continue;
      }

      try {
        await replyToBlueskyPost(post.uri, post.cid, reply.uri, reply.cid, replyText, token, did);
        repliesSent++;
        console.log(`   💬 Replied to @${reply.authorHandle}: "${replyText}"`);
        await sleep(500);
      } catch (e) {
        console.warn(`   ⚠️  Reply failed for @${reply.authorHandle}: ${e.message}`);
      }
    }
  }

  if (contentStats.repliedToComments.length > 300) {
    contentStats.repliedToComments = contentStats.repliedToComments.slice(-300);
  }

  if (repliesSent > 0) {
    console.log(`✅ Sent ${repliesSent} comment repl${repliesSent === 1 ? "y" : "ies"} this run`);
  }
}

// ── Close the loop on backlog poll winners ────────────────
const POLL_RESOLUTION_HOURS = 24;

async function resolvePollIfReady(token, did, contentStats) {
  const poll = contentStats.activeBacklogPoll;
  if (!poll) return null;

  const hoursSince = (Date.now() - new Date(poll.postedAt).getTime()) / 3600000;
  if (hoursSince < POLL_RESOLUTION_HOURS) return null;

  const replies = await fetchPostReplies(poll.uri, token);
  const tally = poll.options.map(o => ({ ...o, votes: 0 }));
  for (const reply of replies) {
    if (reply.authorDid === did) continue;
    const text = (reply.text || "").toLowerCase();
    for (const opt of tally) {
      if (opt.name && text.includes(opt.name.toLowerCase())) opt.votes++;
    }
  }

  const totalVotes = tally.reduce((sum, o) => sum + o.votes, 0);
  contentStats.activeBacklogPoll = null; // resolve regardless — don't keep re-checking this poll forever

  if (totalVotes === 0) {
    console.log("🗳️  Poll window closed with no votes — no winner announced");
    return null;
  }

  tally.sort((a, b) => b.votes - a.votes);
  const winner = tally[0];
  console.log(`🗳️  Poll resolved — winner: "${winner.name}" (${winner.votes}/${totalVotes} votes)`);
  contentStats.pollWinnerAppid = winner.appid;
  return { winner, totalVotes };
}

async function generateContent(type, context = {}, contentStats = null) {
  const recentTexts = contentStats ? getRecentPostTexts(contentStats, type) : [];
  const avoidRepeatBlock = recentTexts.length
    ? `\n\nYour last few posts of this type were:\n${recentTexts.map((t, i) => `${i + 1}. "${t}"`).join("\n")}\n\nWrite something genuinely different this time — a different angle, structure, and opening line. Don't reuse phrasing or the same observation.`
    : "";

  const prompts = {
    cs2: `You are Dexterity (@dexteritycs.bsky.social), a CS2 player and content creator.
Current status: ${PLAYER_CONTEXT.cs2.rank} rank${PLAYER_CONTEXT.cs2.rating ? `, ${PLAYER_CONTEXT.cs2.rating} Premier rating` : ""}.
Currently focusing on: ${PLAYER_CONTEXT.cs2.focus}.
${context.playtimeHours ? `Real total CS2 playtime on record: ${context.playtimeHours} hours. Use this naturally if it fits — a real number like this lands better than a vague claim.` : ""}

Write a genuine, conversational Bluesky post about CS2. Could be:
- Something you're working on improving (callouts, positioning, utility)
- A thought about the Premier grind or ranked experience
- A tip or observation from recent gameplay
- Something relatable to players around your rank

The post MUST end with a specific, answerable question that invites a real reply — not a generic "thoughts?" or "anyone else?". Ask something a CS2 player could actually answer from their own experience (e.g. a concrete choice, preference, or opinion), so people have something real to reply with.

Lead with a real opinion, not a neutral observation — a specific take (even a slightly critical or contrarian one, like "X map's callouts are actually broken" rather than "X map is fine") reads as more genuine and gets more real engagement than safe, agreeable commentary.

Sound like a real player, not a brand. Don't state a specific numeric rating unless one was given above — vague/relative language about rank progress is fine and safer than a number that might be out of date.
Keep it under 280 chars. No excessive emojis.
Include 1-2 relevant hashtags like #CS2 #CounterStrike. Output only the post text.${avoidRepeatBlock}`,

    ow2: `You are Dexterity (@dexteritycs.bsky.social), an OW2 player and content creator.
Current status: ${PLAYER_CONTEXT.ow2.rank}, working on ${PLAYER_CONTEXT.ow2.goal}.
Support mains: ${PLAYER_CONTEXT.ow2.supportMains.join(", ")}.
Damage mains: ${PLAYER_CONTEXT.ow2.damageMains.join(", ")}.

Write a genuine, conversational Bluesky post about Overwatch 2. Could be:
- A thought about playing Kiriko or Moira in ranked
- Something about the ranked grind experience
- A tip or frustration about Soldier, Bastion, or Junkrat
- Something relatable to support/flex players climbing ranked

The post MUST end with a specific, answerable question that invites a real reply — not a generic "thoughts?" or "anyone else?". Ask something an OW2 player could actually answer from their own experience (e.g. a concrete pick, matchup, or opinion), so people have something real to reply with.

Lead with a real opinion, not a neutral observation — a specific take (even a slightly critical or contrarian one) reads as more genuine and gets more real engagement than safe, agreeable commentary.

Sound like a real player. Don't state a specific rank tier unless one was clearly given above — vague/relative language about rank progress is fine and safer than a tier that might be out of date.
Keep it under 280 chars. No excessive emojis.
Include 1-2 hashtags like #Overwatch2 #OW2. Output only the post text.${avoidRepeatBlock}`,

    incremental: `You are Dexterity (@dexteritycs.bsky.social), a content creator who loves incremental/idle games.
You have 100% completed all achievements in dozens of incremental games on Steam.
The game to post about today: "${context.game}"

Write a genuine, honest post sharing your thoughts on this specific game. Focus on:
- What makes it satisfying or unique as an incremental
- The core loop or mechanic that stands out
- Whether the 100% grind was worth it
- Something specific that fans of the genre would appreciate

The post MUST end with a specific, answerable question — something inviting people to share their own take on this game or genre (e.g. asking what they'd rate the grind, or what similar game they'd compare it to), not a generic "anyone played this?".

Lead with a real opinion, not neutral praise — if part of the grind was actually annoying or overrated, say so. A specific take reads as more genuine and gets more real engagement than safe, agreeable commentary.

Be genuine and specific — not generic praise. Keep it under 280 chars.
Include #IdleGames or #IncrementalGames and optionally the game name as a tag if it works.
Output only the post text.${avoidRepeatBlock}`,

    backlog_poll: `You are Dexterity (@dexteritycs.bsky.social), a content creator with a backlog of started-but-unfinished Steam games.
Three real games from your actual backlog to choose between: "${context.pollOptions?.[0]?.name}", "${context.pollOptions?.[1]?.name}", "${context.pollOptions?.[2]?.name}"

Write a genuine post asking your followers to help you decide which of these three games to focus on 100%-completing next. Requirements:
- Name all three games clearly so people can pick one
- End with a direct, explicit ask for people to reply with their vote/pick — this is the whole point of the post
- Sound like a real streamer asking real fans for input, not a generic poll bot
- Keep it light and conversational

Keep it under 280 chars. No excessive emojis.
Include #IdleGames or a relevant hashtag if it fits naturally. Output only the post text.${avoidRepeatBlock}`,

    progress_teaser: `You are Dexterity (@dexteritycs.bsky.social), a content creator grinding toward 100% completion on a game.
Game: "${context.game}"
Real progress: ${context.unlocked}/${context.total} achievements unlocked (${context.percent}%)

Write a genuine mid-grind update post about where you're at with this specific game. Requirements:
- Reference the real progress naturally (exact numbers are good, they're more credible than vague claims)
- Convey genuine texture — what's left, what's been tricky, anticipation for finishing it
- Lead with an actual opinion about the grind (e.g. "this achievement is unfairly brutal" or "way easier than people say"), not a neutral status update — a real take reads more genuine and gets more real engagement
- End with a specific, answerable question inviting people to share their own experience with this game or genre (not a generic "wish me luck" with no hook)
- Sound like a real person mid-grind, not a status report

Keep it under 280 chars. No excessive emojis.
Include #IdleGames or a relevant hashtag if it fits naturally. Output only the post text.${avoidRepeatBlock}`,

    quick_question: `You are Dexterity (@dexteritycs.bsky.social), a gamer and content creator who plays CS2 and Overwatch 2.

Write a short, fun either/or (or short-answer) question post for your gaming audience. It should be genuinely debatable — something any CS2 or Overwatch 2 player could answer in one word or a quick reply, ideally something people actually disagree about. Style examples only, write your own original question, don't reuse these: "AWP or rifle for your first buy?", "Kiriko or Moira when the enemy has a Widow?"

Requirements:
- Pick ONE specific genuine either/or (or short-answer) question about CS2 or Overwatch 2
- Make it a real debate players would actually have opinions about — if you add setup, give it a real stance ("X is criminally underrated") rather than neutral framing
- No fluff or preamble — mostly just the question, maybe one line of setup
- Must end with the question itself, clearly

Keep it under 200 chars. No excessive emojis. Include one relevant hashtag (#CS2 or #Overwatch2). Output only the post text.${avoidRepeatBlock}`,

    poll_result_announcement: `You are Dexterity (@dexteritycs.bsky.social), a gamer and content creator who just got real feedback from your community.
Your followers voted on which backlog game to play next. Real result: "${context.winnerName}" won with ${context.winnerVotes} out of ${context.totalVotes} votes.

Write a short, genuine post announcing the winner and that you're starting on it. Requirements:
- Reference the real vote count naturally if it fits well (don't force it if the numbers are small and it'd read awkwardly)
- Sound excited and grateful that people actually voted, not like a status report
- Optionally tease that a progress update on this game is coming soon

Keep it under 280 chars. No excessive emojis. Include a relevant hashtag if it fits naturally. Output only the post text.`,

    steam_completion: `You are Dexterity (@dexteritycs.bsky.social), a content creator who 100% completes games on Steam.
You just 100%'d all achievements in: "${context.game}"
Completion date: ${context.completedAt ? new Date(context.completedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "recently"}
${context.isNew ? "This was just completed." : "This was completed a while back — mention the date naturally."}
${context.genres ? `Steam genres: ${context.genres}` : ""}
${context.description ? `Game description: ${safeTruncate(context.description, 200)}` : ""}

Write an excited but genuine celebration post. Include:
- That you got 100% achievements
- The completion date naturally worked into the post
- Something brief and honest about the game based on what it actually is
- Keep the energy real, not cringe

For hashtags: use the actual Steam genres above to pick 2-3 relevant hashtags. Always include #Steam.

Under 280 chars. Output only the post text.`,
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
    system: `You are a content writer for a gamer and content creator. ${VOICE_STYLE}\n\nOutput only the post text, nothing else. No quotes around the text.`,
    messages: [{ role: "user", content: prompts[type] }],
  }));

  if (res.status !== 200) {
    const errMsg = res.body?.error?.message || JSON.stringify(res.body);
    throw new Error(`Claude API error: ${res.status} — ${errMsg}`);
  }
  return res.body.content?.[0]?.text?.trim();
}

// ── Steam completion checker ──────────────────────────────
async function checkSteamCompletions(contentStats) {
  if (!STEAM_API_KEY) {
    console.log("⚠️  No STEAM_API_KEY — skipping completion check");
    return null;
  }

  try {
    const gamesRes = await request({
      hostname: "api.steampowered.com",
      path: `/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${STEAM_ID}&include_appinfo=true&include_played_free_games=true&skip_unvetted_apps=0`,
      method: "GET",
      headers: { "User-Agent": "dexteritycs-bot" },
    });

    if (gamesRes.status !== 200 || !gamesRes.body.response?.games) {
      console.warn("Steam owned games fetch failed");
      return null;
    }

    const games     = gamesRes.body.response.games || [];
    console.log(`📚 Steam returned ${games.length} games`);

    // Cache the full library so we have a stable list across runs
    if (!contentStats.gameLibrary || contentStats.gameLibrary.length < games.length) {
      contentStats.gameLibrary = games.map(g => ({
        appid: String(g.appid),
        name: g.name || `App ${g.appid}`,
        playtime: g.playtime_forever || 0,
        rtime_last_played: g.rtime_last_played || 0,
      }));
      console.log(`💾 Cached ${contentStats.gameLibrary.length} games to Gist`);
    } else {
      // Merge any new games into existing cache
      const existingIds = new Set(contentStats.gameLibrary.map(g => g.appid));
      const newGames = games.filter(g => !existingIds.has(String(g.appid)));
      if (newGames.length > 0) {
        contentStats.gameLibrary.push(...newGames.map(g => ({
          appid: String(g.appid),
          name: g.name || `App ${g.appid}`,
          playtime: g.playtime_forever || 0,
          rtime_last_played: g.rtime_last_played || 0,
        })));
        console.log(`➕ Added ${newGames.length} new games to cached library`);
      }
    }

    // Use cached library as the source of truth
    const allGames = contentStats.gameLibrary;
    const celebrated  = new Set(contentStats.celebratedGames || []);
    const confirmedComplete = new Set((contentStats.confirmedComplete || []).map(String));
    const checkedGames = contentStats.checkedGames || {};
    const recheckAfterDays = 7;

    const candidates = allGames
      .filter(g => {
        if (celebrated.has(String(g.appid))) return false;
        if (confirmedComplete.has(String(g.appid))) return false; // already confirmed — sitting in the queue
        const lastChecked = checkedGames[String(g.appid)];
        if (lastChecked) {
          const daysSince = (Date.now() - new Date(lastChecked).getTime()) / 86400000;
          if (daysSince < recheckAfterDays) return false;
        }
        return true;
      })
      .sort((a, b) => (b.rtime_last_played || 0) - (a.rtime_last_played || 0));

    console.log(`🎮 Checking ${candidates.length} unchecked games for 100% completion...`);

    let newCompletion  = null;
    let historicalPool = [];
    const NOW = Date.now();
    const NEW_THRESHOLD_DAYS = 3;

    for (const game of candidates) {
      await sleep(300);
      try {
        const achRes = await request({
          hostname: "api.steampowered.com",
          path: `/ISteamUserStats/GetPlayerAchievements/v1/?appid=${game.appid}&key=${STEAM_API_KEY}&steamid=${STEAM_ID}`,
          method: "GET",
          headers: { "User-Agent": "dexteritycs-bot" },
        });

        if (!contentStats.checkedGames) contentStats.checkedGames = {};

        if (achRes.status !== 200 || !achRes.body.playerstats?.achievements) {
          contentStats.checkedGames[String(game.appid)] = new Date().toISOString();
          continue;
        }

        const achievements = achRes.body.playerstats.achievements;
        if (achievements.length === 0) {
          contentStats.checkedGames[String(game.appid)] = new Date().toISOString();
          continue;
        }

        const total    = achievements.length;
        const unlocked = achievements.filter(a => a.achieved === 1).length;

        if (unlocked !== total || unlocked === 0) {
          // Not 100% yet — mark as checked, recheck in 7 days
          contentStats.checkedGames[String(game.appid)] = new Date().toISOString();
          continue;
        }

        // 100% found! Check store data for NSFW filter and genre info
        let gameDescription = null;
        let gameGenres      = null;
        let isAdultOnly     = false;
        try {
          const storeRes = await request({
            hostname: "store.steampowered.com",
            path: `/api/appdetails?appids=${game.appid}&filters=basic,genres,short_description,content_descriptors`,
            method: "GET",
            headers: { "User-Agent": "dexteritycs-bot" },
          });
          const appData = storeRes.body?.[String(game.appid)]?.data;
          if (appData) {
            gameDescription = appData.short_description || null;
            gameGenres      = appData.genres?.map(g => g.description).join(", ") || null;
            const descriptorIds = appData.content_descriptors?.ids || [];
            isAdultOnly = descriptorIds.includes(3) || descriptorIds.includes(4) ||
                          (appData.required_age && parseInt(appData.required_age) >= 18);
          }
        } catch {}

        if (isAdultOnly) {
          console.log(`   🔞 Skipped ${game.name} — adult only content`);
          contentStats.celebratedGames.push(String(game.appid)); // permanently skip
          continue;
        }

        const lastUnlockTime = Math.max(...achievements
          .filter(a => a.achieved === 1 && a.unlocktime)
          .map(a => a.unlocktime * 1000));
        const lastUnlockDate = new Date(lastUnlockTime);
        const daysAgo = (NOW - lastUnlockTime) / 86400000;

        const completion = {
          appid:        String(game.appid),
          name:         game.name,
          achievements: total,
          playtime:     game.playtime_forever,
          completedAt:  lastUnlockDate,
          isNew:        daysAgo <= NEW_THRESHOLD_DAYS,
          description:  gameDescription,
          genres:       gameGenres,
        };

        if (completion.isNew) {
          console.log(`🏆 Brand new 100%! ${game.name} (completed ${lastUnlockDate.toLocaleDateString()})`);
          newCompletion = completion;
          break; // stop immediately — post this one now
        } else {
          console.log(`📜 Historical 100%: ${game.name} (completed ${lastUnlockDate.toLocaleDateString()})`);
          historicalPool.push(completion);

          // Persist into the durable queue so it survives across runs and
          // doesn't need to be re-fetched from Steam every time
          if (!contentStats.uncelebratedQueue) contentStats.uncelebratedQueue = [];
          const alreadyQueued = contentStats.uncelebratedQueue.some(q => q.appid === completion.appid);
          if (!alreadyQueued) {
            contentStats.uncelebratedQueue.push({
              appid:        completion.appid,
              name:         completion.name,
              achievements: completion.achievements,
              playtime:     completion.playtime,
              completedAt:  completion.completedAt,
              description:  completion.description,
              genres:       completion.genres,
              queuedAt:     new Date().toISOString(),
            });
          }
          if (!contentStats.confirmedComplete) contentStats.confirmedComplete = [];
          if (!contentStats.confirmedComplete.includes(completion.appid)) {
            contentStats.confirmedComplete.push(completion.appid);
          }
          // Keep scanning for a brand new one
        }
      } catch (e) {
        console.warn(`Achievement check failed for ${game.name}: ${e.message}`);
      }
    }

    if (newCompletion) return newCompletion;

    // Pick the oldest entry from the durable queue — not just what this run happened to scan.
    // The queue accumulates across runs, so this reflects the full backlog.
    if (contentStats.uncelebratedQueue?.length > 0) {
      const sorted = [...contentStats.uncelebratedQueue].sort(
        (a, b) => new Date(a.completedAt) - new Date(b.completedAt)
      );
      const pick = sorted[0];
      return { ...pick, isNew: false, completedAt: new Date(pick.completedAt) };
    }

    console.log("No uncelebrated 100% completions found this run");
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
      backlog_poll:     { title: "🗳️ Backlog Poll Posted",             color: 0x9b59b6 },
      progress_teaser:  { title: "📊 Progress Teaser Posted",           color: 0x3498db },
      quick_question:   { title: "❓ Quick Question Posted",           color: 0x2ecc71 },
      poll_result_announcement: { title: "🏁 Poll Result Announced",   color: 0x9b59b6 },
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

async function postCompletionToDiscord(completion, postText, bskyPostUri) {
  if (!DISCORD_COMPLETION_WEBHOOK_URL) return;
  try {
    const playtimeHours = completion.playtime
      ? `${Math.floor(completion.playtime / 60)}h ${completion.playtime % 60}m`
      : null;
    const steamUrl    = `https://store.steampowered.com/app/${completion.appid}`;
    const thumbnailUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${completion.appid}/header.jpg`;
    const bskyUrl     = bskyPostUri
      ? `https://bsky.app/profile/dexteritycs.bsky.social/post/${bskyPostUri.split("/").pop()}`
      : null;

    const fields = [
      { name: "🏅 Achievements", value: `${completion.achievements} / ${completion.achievements}`, inline: true },
    ];
    if (playtimeHours) fields.push({ name: "⏱️ Playtime", value: playtimeHours, inline: true });
    if (bskyUrl) fields.push({ name: "🦋 Bluesky Post", value: `[View Post](${bskyUrl})`, inline: true });
    fields.push({ name: "🎮 Steam Page", value: `[${completion.name}](${steamUrl})`, inline: false });

    const url = new URL(DISCORD_COMPLETION_WEBHOOK_URL);
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, JSON.stringify({
      embeds: [{
        title: `🏆 100% — ${completion.name}`,
        color: 0xffd600,
        description: `"${postText}"`,
        thumbnail: { url: thumbnailUrl },
        fields,
        footer: { text: `dexterityCS • Steam Completions` },
        timestamp: new Date().toISOString(),
      }]
    }));
    console.log("📨 Completion embed posted to Discord");
  } catch (e) {
    console.warn(`Discord completion notification failed: ${e.message}`);
  }
}

// ── Check engagement on previously sent posts ─────────────
const ENGAGEMENT_CHECK_HOURS = 48;
const NOTABLE_LIKES           = 3;
const NOTABLE_REPOSTS         = 1;

async function checkPostEngagement(token, did, contentStats) {
  if (!contentStats.sentPosts?.length) return;

  const cutoff = Date.now() - (ENGAGEMENT_CHECK_HOURS * 3600000);
  const active = contentStats.sentPosts.filter(p => new Date(p.sentAt).getTime() > cutoff);
  const unchecked = active.filter(p => !p.finalChecked);
  if (!unchecked.length) return;

  console.log(`📊 Checking engagement on ${unchecked.length} recent post(s)...`);

  let newNotable = [];

  for (const post of unchecked) {
    try {
      const res = await request({
        hostname: "bsky.social",
        path: `/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(post.uri)}`,
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
      });
      if (res.status !== 200 || !res.body.posts?.length) continue;

      const bskyPost  = res.body.posts[0];
      const likes     = bskyPost.likeCount   || 0;
      const reposts   = bskyPost.repostCount || 0;
      const replies   = bskyPost.replyCount  || 0;
      const prevLikes   = post.lastLikes   || 0;
      const prevReposts = post.lastReposts || 0;

      // Update running totals
      post.lastLikes   = likes;
      post.lastReposts = reposts;
      post.lastReplies = replies;
      post.lastChecked = new Date().toISOString();

      // Accumulate engagement per type
      const type = post.type;
      if (type && contentStats.typeEngagement?.[type]) {
        const newLikes   = likes   - prevLikes;
        const newReposts = reposts - prevReposts;
        if (newLikes > 0)   contentStats.typeEngagement[type].likes   += newLikes;
        if (newReposts > 0) contentStats.typeEngagement[type].reposts += newReposts;
      }

      // Mark as final if past the 48-hour window
      const ageHours = (Date.now() - new Date(post.sentAt).getTime()) / 3600000;
      if (ageHours >= ENGAGEMENT_CHECK_HOURS) post.finalChecked = true;

      // Check if notable
      if (likes >= NOTABLE_LIKES || reposts >= NOTABLE_REPOSTS) {
        const alreadyNotified = post.notified;
        if (!alreadyNotified) {
          post.notified = true;
          newNotable.push({ post, likes, reposts, replies });
        }
      }
    } catch (e) {
      console.warn(`Engagement check failed for post: ${e.message}`);
    }
    await sleep(300);
  }

  // Prune posts older than 48 hours that are fully checked
  contentStats.sentPosts = active.filter(p => !p.finalChecked || !p.notified);
  if (contentStats.sentPosts.length > 50) contentStats.sentPosts = contentStats.sentPosts.slice(-50);

  // Post notable engagement to Discord
  for (const { post, likes, reposts, replies } of newNotable) {
    if (!DISCORD_WEBHOOK_URL) continue;
    try {
      const bskyUrl = post.uri
        ? `https://bsky.app/profile/dexteritycs.bsky.social/post/${post.uri.split("/").pop()}`
        : null;
      const url = new URL(DISCORD_WEBHOOK_URL);
      await request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, JSON.stringify({
        embeds: [{
          title: "🔥 Notable Post Engagement!",
          color: 0x00ff88,
          description: `"${safeTruncate(post.text, 200) || "—"}"`,
          fields: [
            { name: "❤️ Likes",    value: String(likes),   inline: true },
            { name: "🔁 Reposts",  value: String(reposts), inline: true },
            { name: "💬 Replies",  value: String(replies), inline: true },
            { name: "📝 Type",     value: post.type || "—", inline: true },
            ...(bskyUrl ? [{ name: "🦋 View Post", value: `[Open](${bskyUrl})`, inline: true }] : []),
          ],
          footer: { text: `dexterityCS Content Bot` },
          timestamp: new Date().toISOString(),
        }]
      }));
      console.log(`🔥 Notable engagement posted to Discord — ${likes} likes, ${reposts} reposts`);
    } catch (e) {
      console.warn(`Discord notable engagement failed: ${e.message}`);
    }
  }
}

// ── Adjust content rotation weights based on engagement ───
function adjustContentWeights(contentStats) {
  const eng = contentStats.typeEngagement;
  if (!eng) return;

  const types = ["cs2", "ow2", "incremental", "backlog_poll", "progress_teaser", "quick_question"];
  const scores = {};

  for (const type of types) {
    const data = eng[type] || { likes: 0, reposts: 0, posts: 0 };
    if (data.posts < 10) {
      // Not enough data yet — keep current/default weight. Raised from 3 to 10:
      // with only a few posts, one lucky like can swing the weight hard.
      scores[type] = contentStats.typeWeights?.[type] ?? DEFAULT_WEIGHTS[type] ?? 1;
      continue;
    }
    // Score = (likes + reposts * 2) per post — reposts weighted higher
    const perPost = (data.likes + data.reposts * 2) / data.posts;
    scores[type] = perPost;
  }

  // Normalize scores to weights between 1 and 5
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  if (total === 0) return;

  const newWeights = {};
  for (const type of types) {
    // Scale to range 1-5, minimum 1 so no type is fully starved
    newWeights[type] = Math.max(1, Math.round((scores[type] / total) * 10));
  }

  const changed = JSON.stringify(newWeights) !== JSON.stringify(contentStats.typeWeights);
  if (changed) {
    console.log(`⚖️  Adjusted content weights: CS2=${newWeights.cs2} OW2=${newWeights.ow2} Incremental=${newWeights.incremental} BacklogPoll=${newWeights.backlog_poll} ProgressTeaser=${newWeights.progress_teaser} QuickQuestion=${newWeights.quick_question}`);
    contentStats.typeWeights = newWeights;

    if (DISCORD_WEBHOOK_URL) {
      const url = new URL(DISCORD_WEBHOOK_URL);
      request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, JSON.stringify({
        embeds: [{
          title: "⚖️ Content Rotation Weights Adjusted",
          color: 0xff8c1e,
          fields: [
            { name: "🎮 CS2",             value: `${newWeights.cs2}x`,             inline: true },
            { name: "🏥 OW2",             value: `${newWeights.ow2}x`,             inline: true },
            { name: "🎲 Incremental",     value: `${newWeights.incremental}x`,     inline: true },
            { name: "🗳️ Backlog Poll",    value: `${newWeights.backlog_poll}x`,    inline: true },
            { name: "📊 Progress Teaser", value: `${newWeights.progress_teaser}x`, inline: true },
            { name: "❓ Quick Question",  value: `${newWeights.quick_question}x`,  inline: true },
          ],
          description: "Weights auto-adjusted based on post engagement over last 10+ posts.",
          footer: { text: `dexterityCS Content Bot` },
        }]
      })).catch(() => {});
    }
  }
}
async function postQueueSummary(contentStats) {
  if (!DISCORD_WEBHOOK_URL) return;
  const queue = contentStats.uncelebratedQueue || [];
  if (queue.length === 0) return;

  const sorted = [...queue].sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
  const preview = sorted.slice(0, 20).map((g, i) => {
    const date = new Date(g.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${i + 1}. **${g.name}** — completed ${date}`;
  }).join("\n");
  const extra = sorted.length > 20 ? `\n…and ${sorted.length - 20} more` : "";

  try {
    const url = new URL(DISCORD_WEBHOOK_URL);
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, JSON.stringify({
      embeds: [{
        title: `📋 100% Completion Queue — ${queue.length} game(s) waiting`,
        color: 0xffd600,
        description: `${preview}${extra}`,
        footer: { text: `Oldest completions post first, one every 2h cooldown • dexterityCS Content Bot` },
      }]
    }));
    console.log(`📨 Queue summary posted to Discord (${queue.length} games)`);
  } catch (e) {
    console.warn(`Discord queue summary failed: ${e.message}`);
  }
}

async function postCelebratedSummary(contentStats) {
  if (!DISCORD_WEBHOOK_URL) return;
  const celebrated = contentStats.celebratedGames || [];
  if (celebrated.length === 0) return;

  const libraryByAppid = new Map((contentStats.gameLibrary || []).map(g => [String(g.appid), g.name]));
  const names = celebrated.map(appid => libraryByAppid.get(String(appid)) || `App ${appid}`);
  const preview = names.slice(0, 30).map((n, i) => `${i + 1}. ${n}`).join("\n");
  const extra = names.length > 30 ? `\n…and ${names.length - 30} more` : "";

  try {
    const url = new URL(DISCORD_WEBHOOK_URL);
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, JSON.stringify({
      embeds: [{
        title: `✅ Already Posted About — ${celebrated.length} game(s)`,
        color: 0x00ff88,
        description: `${preview}${extra}`,
        footer: { text: `dexterityCS Content Bot` },
      }]
    }));
    console.log(`📨 Celebrated games summary posted to Discord (${celebrated.length} games)`);
  } catch (e) {
    console.warn(`Discord celebrated summary failed: ${e.message}`);
  }
}

async function run() {
  console.log("🚀 Content bot starting...");

  // ── Queue-only mode — report both the backlog and what's already been posted ──
  // Runs before the credential checks below since it never logs into Bluesky
  // or calls the Anthropic API — it only reads the Gist.
  if (process.env.QUEUE_ONLY === "true") {
    const contentStats = await fetchContentStats();

    const queue = contentStats.uncelebratedQueue || [];
    console.log(`📋 ${queue.length} game(s) in the uncelebrated queue:`);
    [...queue]
      .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt))
      .forEach((g, i) => {
        const date = new Date(g.completedAt).toLocaleDateString();
        console.log(`   ${i + 1}. ${g.name} — completed ${date}`);
      });

    const libraryByAppid = new Map((contentStats.gameLibrary || []).map(g => [String(g.appid), g.name]));
    const celebrated = contentStats.celebratedGames || [];
    console.log(`\n✅ ${celebrated.length} game(s) already posted about:`);
    celebrated.forEach((appid, i) => {
      console.log(`   ${i + 1}. ${libraryByAppid.get(String(appid)) || `App ${appid}`}`);
    });

    await postQueueSummary(contentStats);
    await postCelebratedSummary(contentStats);
    return;
  }

  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD");
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error("❌ Missing ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const contentStats = await fetchContentStats();

  const { token, did } = await login();

  const steamCheckOnly = process.env.STEAM_CHECK_ONLY === "true";
  const contentOnly    = process.env.CONTENT_ONLY === "true";

  // ── Check engagement + adjust weights (skip in steam-check-only mode) ──
  if (!steamCheckOnly) {
    await checkPostEngagement(token, did, contentStats);
    adjustContentWeights(contentStats);
    await checkAndReplyToOwnComments(token, did, contentStats);

    const pollResult = await resolvePollIfReady(token, did, contentStats);
    if (pollResult) {
      const announceText = await generateContent("poll_result_announcement", {
        winnerName:  pollResult.winner.name,
        winnerVotes: pollResult.winner.votes,
        totalVotes:  pollResult.totalVotes,
      }, contentStats);
      if (announceText) {
        const announceResult = await postToBluesky(announceText, token, did);
        await postDiscordNotification("poll_result_announcement", announceText, { game: pollResult.winner.name });
        if (!contentStats.sentPosts) contentStats.sentPosts = [];
        contentStats.sentPosts.push({
          uri:          announceResult?.uri || null,
          cid:          announceResult?.cid || null,
          type:         "poll_result_announcement",
          text:         safeTruncate(announceText, 200),
          sentAt:       new Date().toISOString(),
          lastLikes:    0,
          lastReposts:  0,
          lastReplies:  0,
          notified:     false,
          finalChecked: false,
        });
        contentStats.totalPosts = (contentStats.totalPosts || 0) + 1;
      }
    }
  }

  // ── Step 1: Check Steam for new 100% completions ─────────
  // Skip entirely if running in content-only mode
  if (!contentOnly) {
    const lastCompletionHoursAgo = contentStats.lastCompletionPostAt
      ? (Date.now() - new Date(contentStats.lastCompletionPostAt).getTime()) / 3600000
      : 999;

  if (lastCompletionHoursAgo < 2) {
    console.log(`⏳ Skipping Steam check — completion posted ${lastCompletionHoursAgo.toFixed(1)}h ago (2h cooldown)`);
  } else {
    const queueSizeBefore = (contentStats.uncelebratedQueue || []).length;
    const newCompletion = await checkSteamCompletions(contentStats);
    const queueSizeAfter = (contentStats.uncelebratedQueue || []).length;
    if (queueSizeAfter > queueSizeBefore) {
      console.log(`📋 Queue grew from ${queueSizeBefore} to ${queueSizeAfter} game(s)`);
      await postQueueSummary(contentStats);
    }

    if (newCompletion) {
      console.log(`🎉 Posting Steam 100% celebration for "${newCompletion.name}"`);
      if (newCompletion.genres) console.log(`🎮 Game genres: ${newCompletion.genres}`);

      const postText = await generateContent("steam_completion", {
        game:        newCompletion.name,
        completedAt: newCompletion.completedAt,
        isNew:       newCompletion.isNew,
        description: newCompletion.description,
        genres:      newCompletion.genres,
      }, contentStats);
      if (postText) {
        const bskyPost = await postToBluesky(postText, token, did);
        const bskyUri  = bskyPost?.uri || null;
        await postCompletionToDiscord(newCompletion, postText, bskyUri);
        contentStats.celebratedGames.push(newCompletion.appid);
        if (contentStats.uncelebratedQueue) {
          contentStats.uncelebratedQueue = contentStats.uncelebratedQueue.filter(q => q.appid !== newCompletion.appid);
        }
        if (contentStats.confirmedComplete) {
          contentStats.confirmedComplete = contentStats.confirmedComplete.filter(id => id !== newCompletion.appid);
        }
        contentStats.totalPosts           = (contentStats.totalPosts || 0) + 1;
        contentStats.lastPostAt           = new Date().toISOString();
        contentStats.lastPostType         = "steam_completion";
        contentStats.lastCompletionPostAt = new Date().toISOString();

        if (!INCREMENTAL_GAMES.includes(newCompletion.name)) {
          INCREMENTAL_GAMES.push(newCompletion.name);
          console.log(`📝 Auto-added "${newCompletion.name}" to incremental games list in Gist`);
          await saveContentStats(contentStats, INCREMENTAL_GAMES);
        } else {
          await saveContentStats(contentStats);
        }
      }

      if (steamCheckOnly) return;
      // Fall through to regular content
    } else {
      if (steamCheckOnly) {
        console.log("🎮 Steam check complete — no new completions this run");
        await saveContentStats(contentStats);
        return;
      }
    }
  }
  } // end if (!contentOnly)

  if (steamCheckOnly) return;

  // ── Step 2: Post scheduled content ───────────────────────
  const CONTENT_TYPES = buildContentTypes(contentStats.typeWeights);
  const type = CONTENT_TYPES[contentStats.rotationIndex % CONTENT_TYPES.length];
  console.log(`📝 Posting ${type} content (rotation index ${contentStats.rotationIndex}, weights: CS2=${contentStats.typeWeights?.cs2 || 3} OW2=${contentStats.typeWeights?.ow2 || 2} Inc=${contentStats.typeWeights?.incremental || 2})`);

  let context = {};
  const CS2_APPID = "730";
  if (type === "cs2") {
    const cs2Entry = (contentStats.gameLibrary || []).find(g => String(g.appid) === CS2_APPID);
    if (cs2Entry?.playtime) {
      context.playtimeHours = Math.round(cs2Entry.playtime / 60);
      console.log(`🕹️  Real CS2 playtime: ${context.playtimeHours}h`);
    }
  }

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

  if (type === "backlog_poll") {
    const candidates = getBacklogCandidates(contentStats);
    if (candidates.length < 3) {
      console.warn(`⚠️  Only ${candidates.length} backlog candidate(s) available (need 3) — skipping backlog poll this run`);
      return;
    }
    // Pick 3 distinct random candidates — keep the full objects (appid+name),
    // not just names, so we can tally votes against them later
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    context.pollOptions = shuffled.slice(0, 3);
    console.log(`🗳️  Backlog poll options: ${context.pollOptions.map(o => o.name).join(", ")}`);
  }

  if (type === "progress_teaser") {
    if (!STEAM_API_KEY) {
      console.warn("⚠️  No STEAM_API_KEY — skipping progress teaser this run");
      return;
    }
    let candidates = getBacklogCandidates(contentStats)
      .filter(g => String(g.appid) !== String(contentStats.lastProgressTeaseAppid))
      .sort((a, b) => (b.rtime_last_played || 0) - (a.rtime_last_played || 0));

    // If a backlog poll recently picked a winner, tease that one first
    if (contentStats.pollWinnerAppid) {
      const idx = candidates.findIndex(g => String(g.appid) === String(contentStats.pollWinnerAppid));
      if (idx > 0) {
        const [winnerGame] = candidates.splice(idx, 1);
        candidates.unshift(winnerGame);
      }
    }

    if (candidates.length === 0) {
      console.warn("⚠️  No progress teaser candidates available — skipping this run");
      return;
    }
    const pick = candidates[0];
    const progress = await fetchAchievementProgress(pick.appid);
    if (!progress || progress.unlocked === 0 || progress.unlocked >= progress.total) {
      console.warn(`⚠️  No usable partial progress for "${pick.name}" — skipping progress teaser this run`);
      return;
    }
    context.game    = pick.name;
    context.unlocked = progress.unlocked;
    context.total     = progress.total;
    context.percent   = Math.round((progress.unlocked / progress.total) * 100);
    contentStats.lastProgressTeaseAppid = pick.appid;
    if (String(pick.appid) === String(contentStats.pollWinnerAppid)) {
      contentStats.pollWinnerAppid = null; // one-time nudge consumed
    }
    console.log(`📊 Progress teaser: "${pick.name}" — ${progress.unlocked}/${progress.total} (${context.percent}%)`);
  }

  const postText = await generateContent(type, context, contentStats);
  if (!postText) {
    console.error("❌ Failed to generate content");
    process.exit(1);
  }

  const postResult = await postToBluesky(postText, token, did);
  await postDiscordNotification(type, postText, context);

  // Track post for engagement feedback loop
  if (!contentStats.sentPosts) contentStats.sentPosts = [];
  contentStats.sentPosts.push({
    uri:          postResult?.uri || null,
    cid:          postResult?.cid || null,
    type,
    text:         safeTruncate(postText, 200),
    sentAt:       new Date().toISOString(),
    lastLikes:    0,
    lastReposts:  0,
    lastReplies:  0,
    notified:     false,
    finalChecked: false,
  });

  // If this was a backlog poll, remember it so we can tally votes and
  // announce a winner once the resolution window passes
  if (type === "backlog_poll" && postResult?.uri && postResult?.cid) {
    contentStats.activeBacklogPoll = {
      uri:      postResult.uri,
      cid:      postResult.cid,
      options:  context.pollOptions,
      postedAt: new Date().toISOString(),
    };
  }


  // Track post count per type for weight adjustment
  if (!contentStats.typeEngagement) contentStats.typeEngagement = { cs2: { likes: 0, reposts: 0, posts: 0 }, ow2: { likes: 0, reposts: 0, posts: 0 }, incremental: { likes: 0, reposts: 0, posts: 0 }, backlog_poll: { likes: 0, reposts: 0, posts: 0 }, progress_teaser: { likes: 0, reposts: 0, posts: 0 }, quick_question: { likes: 0, reposts: 0, posts: 0 } };
  if (!contentStats.typeEngagement[type]) contentStats.typeEngagement[type] = { likes: 0, reposts: 0, posts: 0 };
  if (contentStats.typeEngagement[type]) contentStats.typeEngagement[type].posts++;

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
