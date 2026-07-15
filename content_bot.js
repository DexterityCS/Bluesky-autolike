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
const DEFAULT_WEIGHTS = { cs2: 3, ow2: 2, incremental: 2 };

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
    typeWeights:        { cs2: 3, ow2: 2, incremental: 2 }, // adjustable weights
    typeEngagement:     { cs2: { likes: 0, reposts: 0, posts: 0 },
                          ow2: { likes: 0, reposts: 0, posts: 0 },
                          incremental: { likes: 0, reposts: 0, posts: 0 } },
    uncelebratedQueue:  [], // confirmed 100% completions waiting to be posted about
    confirmedComplete:  [], // appids already confirmed 100% — skip re-checking achievements for these
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
async function generateContent(type, context = {}, contentStats = null) {
  const recentTexts = contentStats ? getRecentPostTexts(contentStats, type) : [];
  const avoidRepeatBlock = recentTexts.length
    ? `\n\nYour last few posts of this type were:\n${recentTexts.map((t, i) => `${i + 1}. "${t}"`).join("\n")}\n\nWrite something genuinely different this time — a different angle, structure, and opening line. Don't reuse phrasing or the same observation.`
    : "";

  const prompts = {
    cs2: `You are Dexterity (@dexteritycs.bsky.social), a CS2 player and Twitch streamer.
Current status: ${PLAYER_CONTEXT.cs2.rank} rank${PLAYER_CONTEXT.cs2.rating ? `, ${PLAYER_CONTEXT.cs2.rating} Premier rating` : ""}.
Currently focusing on: ${PLAYER_CONTEXT.cs2.focus}.

Write a genuine, conversational Bluesky post about CS2. Could be:
- Something you're working on improving (callouts, positioning, utility)
- A thought about the Premier grind or ranked experience
- A tip or observation from recent gameplay
- Something relatable to players around your rank

Sound like a real player, not a brand. Don't state a specific numeric rating unless one was given above — vague/relative language about rank progress is fine and safer than a number that might be out of date.
Keep it under 280 chars. No excessive emojis.
Include 1-2 relevant hashtags like #CS2 #CounterStrike. Output only the post text.${avoidRepeatBlock}`,

    ow2: `You are Dexterity (@dexteritycs.bsky.social), an OW2 player and Twitch streamer.
Current status: ${PLAYER_CONTEXT.ow2.rank}, working on ${PLAYER_CONTEXT.ow2.goal}.
Support mains: ${PLAYER_CONTEXT.ow2.supportMains.join(", ")}.
Damage mains: ${PLAYER_CONTEXT.ow2.damageMains.join(", ")}.

Write a genuine, conversational Bluesky post about Overwatch 2. Could be:
- A thought about playing Kiriko or Moira in ranked
- Something about the ranked grind experience
- A tip or frustration about Soldier, Bastion, or Junkrat
- Something relatable to support/flex players climbing ranked

Sound like a real player. Don't state a specific rank tier unless one was clearly given above — vague/relative language about rank progress is fine and safer than a tier that might be out of date.
Keep it under 280 chars. No excessive emojis.
Include 1-2 hashtags like #Overwatch2 #OW2. Output only the post text.${avoidRepeatBlock}`,

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

    steam_completion: `You are Dexterity (@dexteritycs.bsky.social), a Twitch streamer who 100% completes games on Steam.
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
    system: "You are a content writer for a gaming streamer. Output only the post text, nothing else. No quotes around the text.",
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

  const types = ["cs2", "ow2", "incremental"];
  const scores = {};

  for (const type of types) {
    const data = eng[type] || { likes: 0, reposts: 0, posts: 0 };
    if (data.posts < 10) {
      // Not enough data yet — keep default weight. Raised from 3 to 10:
      // with only 3 posts, one lucky like can swing the weight hard.
      scores[type] = contentStats.typeWeights?.[type] || (type === "cs2" ? 3 : 2);
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
    console.log(`⚖️  Adjusted content weights: CS2=${newWeights.cs2} OW2=${newWeights.ow2} Incremental=${newWeights.incremental}`);
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
            { name: "🎮 CS2",         value: `${newWeights.cs2}x`,         inline: true },
            { name: "🏥 OW2",         value: `${newWeights.ow2}x`,         inline: true },
            { name: "🎲 Incremental", value: `${newWeights.incremental}x`, inline: true },
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
    type,
    text:         safeTruncate(postText, 200),
    sentAt:       new Date().toISOString(),
    lastLikes:    0,
    lastReposts:  0,
    lastReplies:  0,
    notified:     false,
    finalChecked: false,
  });

  // Track post count per type for weight adjustment
  if (!contentStats.typeEngagement) contentStats.typeEngagement = { cs2: { likes: 0, reposts: 0, posts: 0 }, ow2: { likes: 0, reposts: 0, posts: 0 }, incremental: { likes: 0, reposts: 0, posts: 0 } };
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
