const https = require("https");
const http  = require("http");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────
const BLUESKY_HANDLE     = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD   = process.env.BLUESKY_PASSWORD;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ACTIONS_PER_RUN    = parseInt(process.env.ACTIONS_PER_RUN || "25");
const INACTIVE_DAYS      = 60;   // unfollow if inactive this long (still used as secondary check)
const FOLLOW_BACK_DAYS   = 14;   // unfollow if not followed back within this many days

// Engagement quality filters
const MIN_FOLLOWERS      = 10;
const MIN_ACCOUNT_DAYS   = 30;
const MAX_POST_AGE_DAYS  = 7;
const MAX_FOLLOW_RATIO   = 10; // following/followers ratio — skip if above this (spam signal)

// Daily/hourly caps
const DAILY_ACTION_CAP   = 200;
const HOURLY_LIMIT       = 60;

// Reply config — 1 in every N liked posts gets a reply
const REPLY_FREQUENCY      = 5;
const REPLY_COOLDOWN_DAYS  = 7;    // don't reply to same account more than once per X days
const MIN_REPLY_TEXT_LEN   = 30;   // minimum post text length to attempt a reply
const DISCORD_WEBHOOK_URL  = process.env.DISCORD_WEBHOOK_URL || null; // optional run summary

// Follower milestones to celebrate
const FOLLOWER_MILESTONES  = [100, 250, 500, 1000, 2500, 5000, 10000];

// Weekly summary — posts every Monday
const WEEKLY_SUMMARY_DAY   = 1; // 0=Sun, 1=Mon

// Account protection
const SPIKE_THRESHOLD      = 3;
const BLOCK_LIST_PATH      = "blocklist.json";

// Smart unfollow timing — only unfollow once per day at this UTC hour
const UNFOLLOW_HOUR_UTC    = 12;

// Engagement scoring — weight for prioritizing posts
const SCORE_LIKE_WEIGHT    = 1;
const SCORE_REPLY_WEIGHT   = 3;
const SCORE_REPOST_WEIGHT  = 2;
const MIN_ENGAGEMENT_SCORE = 0; // 0 = engage with everything, raise to filter low-engagement

// Mutual network — boost accounts followed by people you follow
const MUTUAL_NETWORK_BOOST = true;

// Reply personas — rotate between these tones
const REPLY_PERSONAS = ["hype", "analytical", "friendly"];

// Pause mode flag — checked at start of each run
const PAUSE_PATH = "pause.json";

const DEFAULT_TERMS = [
  // CS2
  "#CS2", "#CounterStrike", "#CounterStrike2", "#CS2clips", "CS2", "counter-strike",
  // Apex Legends
  "#ApexLegends", "#Apex", "apex legends",
  // Rainbow Six Siege
  "#RainbowSixSiege", "#R6Siege", "#R6",
  // Overwatch
  "#Overwatch", "#Overwatch2", "#OW2",
  // Minecraft
  "#Minecraft", "minecraft",
  // Terraria
  "#Terraria", "terraria",
];

// NSFW tags and keywords to filter out — posts containing these will be skipped
// NSFW tags — kept tight to avoid false positives on gaming content
const NSFW_TAGS = [
  // Explicit terms
  "nsfw", "18+", "onlyfans", "lewd", "hentai", "nude", "naked", "porn",
  "xxx", "erotic", "fetish", "adult content", "explicit content", "kink",
  "bdsm", "nudes", "slutty", "sexy pics", "hot pics", "fansly", "manyvids",
  "admireme", "patreon nsfw", "spicy content", "thirst trap", "thirsty",
  "cam girl", "camgirl", "camboy", "sex work", "sexwork", "sw friendly",
  "horny", "slutty", "booty", "ass pics", "topless", "lingerie model",
  "only fans", "of link", "of account", "subscribe to my", "mdni", "dni",
];

// Political keywords — posts containing these will be skipped entirely
const POLITICAL_TAGS = [
  // US Politics
  "democrat", "republican", "maga", "biden", "trump", "harris", "obama",
  "desantis", "aoc", "bernie", "pelosi", "mcconnell", "election", "ballot",
  "vote", "voted", "voting", "voter", "congress", "senate", "senate", "gop",
  "liberal", "conservative", "leftist", "right wing", "far right", "far left",
  "socialist", "fascist", "communist", "antifa", "blm", "black lives matter",
  "abortion", "prolife", "prochoice", "pro-life", "pro-choice", "roe v wade",
  "gun control", "gun rights", "2nd amendment", "nra", "ar-15",
  "immigration", "deportation", "border wall", "illegal alien",
  "white supremac", "white nationalist", "kkk", "neo nazi",
  // Social/identity politics
  "lgbtq", "transgender", "trans rights", "pride parade", "pride month", "pride",
  "gay rights", "homophob", "transphob",
  // General political
  "political", "politics", "propaganda", "protest", "activist", "activism",
  "rally", "inauguration", "presidency", "whitehouse", "white house", "capitol",
  "supreme court", "constitution", "amendment", "bill of rights",
  "deep state", "mainstream media", "msm", "fake news", "cancel culture",
  "woke", "anti-woke", "crt", "critical race theory",
];

// NSFW emoji — checked separately since regex word boundary doesn't catch emoji
const NSFW_EMOJI_LIST = [
  "🔞", "💦", "🍆", "🍑", "👅", "💋", "🥵", "😈", "🤤",
  "🍒", "🌶️", "🔥🔥🔥", "💯🔥",
];

const NSFW_ACCOUNTS = new Set(); // populated from blocklist
const SEARCH_TERMS  = process.env.SEARCH_TERMS
  ? process.env.SEARCH_TERMS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_TERMS;

const POSTS_PER_SEARCH = 100;
const STATS_PATH       = "stats.json";

// ── Stats ─────────────────────────────────────────────────
function loadStats() {
  const defaults = {
    totalLikes: 0, totalFollows: 0, totalUnfollows: 0, totalReplies: 0,
    runs: 0, lastRun: null, lastLikedAt: {}, lastRepliedAt: {}, dailyActions: {},
    hourlyActions: [], followedAt: {},
    followBackRate: { followed: 0, followedBack: 0 },
    followerHistory: [],
    termPerformance: {},
    filteredCount: 0,
    replyEngagement: { sent: 0, gotLiked: 0, gotReplied: 0 },
    milestonesCelebrated: [],
    lastWeeklySummary: null,
    runHistory: [],          // last 10 runs for dashboard table
    actionsHistory: [],      // recent run action counts for spike detection
  };
  if (!fs.existsSync(STATS_PATH)) return defaults;
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(STATS_PATH, "utf8")) }; }
  catch { return defaults; }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
}

function getDailyActionsUsed(stats) {
  const today = new Date().toISOString().slice(0, 10);
  return stats.dailyActions[today] || 0;
}

function recordDailyAction(stats, count = 1) {
  const today = new Date().toISOString().slice(0, 10);
  stats.dailyActions[today] = (stats.dailyActions[today] || 0) + count;
  const keys = Object.keys(stats.dailyActions).sort();
  if (keys.length > 7) delete stats.dailyActions[keys[0]];
}

function getHourlyActionsUsed(stats) {
  const oneHourAgo = Date.now() - 3600000;
  stats.hourlyActions = (stats.hourlyActions || []).filter(t => t > oneHourAgo);
  return stats.hourlyActions.length;
}

function recordHourlyAction(stats) {
  stats.hourlyActions = stats.hourlyActions || [];
  stats.hourlyActions.push(Date.now());
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

function apiRequest(path, method, body, token) {
  return request({
    hostname: "bsky.social",
    path: `/xrpc/${path}`,
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  }, body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Auth ──────────────────────────────────────────────────
async function login() {
  const res = await apiRequest("com.atproto.server.createSession", "POST", {
    identifier: BLUESKY_HANDLE, password: BLUESKY_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  console.log(`✅ Logged in as ${BLUESKY_HANDLE}`);
  return { token: res.body.accessJwt, did: res.body.did };
}

// ── Graph ─────────────────────────────────────────────────
async function getFollowing(did, token) {
  const following = new Map();
  let cursor = null;
  do {
    const path = `app.bsky.graph.getFollows?actor=${encodeURIComponent(did)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const f of res.body.follows || []) {
      const rkey = f.viewer?.following?.split("/").pop();
      following.set(f.did, { rkey, handle: f.handle });
    }
    cursor = res.body.cursor;
  } while (cursor);
  console.log(`📋 Already following ${following.size} accounts`);
  return following;
}

async function getFollowers(did, token) {
  const followers = new Set();
  let cursor = null;
  do {
    const path = `app.bsky.graph.getFollowers?actor=${encodeURIComponent(did)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const f of res.body.followers || []) followers.add(f.did);
    cursor = res.body.cursor;
  } while (cursor);
  console.log(`👥 You have ${followers.size} followers`);
  return { followers, count: followers.size };
}

// ── Profile ───────────────────────────────────────────────
async function getProfile(actorDid, token) {
  const res = await apiRequest(
    `app.bsky.actor.getProfile?actor=${encodeURIComponent(actorDid)}`,
    "GET", null, token
  );
  if (res.status !== 200) return null;
  return res.body;
}

async function getLastPostDate(actorDid, token) {
  const res = await apiRequest(
    `app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actorDid)}&limit=1`,
    "GET", null, token
  );
  if (res.status !== 200 || !res.body.feed?.length) return null;
  return new Date(res.body.feed[0].post.indexedAt);
}

async function getLatestPost(actorDid, token) {
  const res = await apiRequest(
    `app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actorDid)}&limit=1&filter=posts_no_replies`,
    "GET", null, token
  );
  if (res.status !== 200 || !res.body.feed?.length) return null;
  return res.body.feed[0].post;
}

// ── Quality filters ───────────────────────────────────────

// ── Gaming relevance check ────────────────────────────────
const GAMING_TERMS = [
  // CS2
  "cs2", "counter-strike", "counterstrike", "csgo", "premier", "faceit",
  "awp", "ak47", "m4a1", "valorant", "pistol round", "eco", "clutch",
  "smoke", "flash", "molotov", "defuse", "plant", "ct side", "t side",
  // Apex
  "apex legends", "apex", "wraith", "pathfinder", "bloodhound", "respawn",
  "battle royale", "ring", "legends",
  // R6
  "rainbow six", "r6", "siege", "operator", "roam",
  // Overwatch
  "overwatch", "ow2", "blizzard", "tank", "support", "dps", "healer",
  // Minecraft
  "minecraft", "creeper", "steve", "enderman", "nether", "redstone",
  // Terraria
  "terraria", "boss", "hardmode",
  // General gaming
  "gaming", "gamer", "fps", "streamer", "twitch", "stream", "esports",
  "ranked", "matchmaking", "kill", "headshot", "frag", "loadout",
  "crosshair", "sensitivity", "ping", "lag", "win rate", "kd ratio",
  "game", "gameplay", "highlights", "clip", "play of the game",
];

function isGamingRelevant(post) {
  const text = (post.record?.text || "").toLowerCase();

  // Quick check — if any gaming term appears it's relevant
  if (GAMING_TERMS.some(term => text.includes(term))) return true;

  // Check hashtags
  const tags = post.record?.tags || [];
  if (tags.some(t => GAMING_TERMS.some(term => t.toLowerCase().includes(term)))) return true;

  // If post is very short (under 15 chars) and no gaming terms, skip
  if (text.trim().length < 15) return false;

  return false;
}

async function isGamingRelevantAI(postText) {
  if (!ANTHROPIC_API_KEY) return true; // if no API key, don't gate on this

  // Only use AI check for ambiguous posts (no obvious gaming terms)
  const text = postText.toLowerCase();
  const hasObviousTerm = GAMING_TERMS.some(term => text.includes(term));
  if (hasObviousTerm) return true;

  try {
    const body = JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 10,
      system: "You are a content classifier. Answer only YES or NO.",
      messages: [{
        role: "user",
        content: `Is this post about gaming, esports, streaming, or game-related content? Answer only YES or NO.

Post: "${postText.slice(0, 300)}"`
      }]
    });

    const res = await request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    }, body);

    if (res.status !== 200) return true; // fail open
    const answer = res.body.content?.[0]?.text?.trim().toUpperCase();
    return answer === "YES";
  } catch {
    return true; // fail open on error
  }
}

async function passesQualityFilters(authorDid, post, token, stats) {
  // Post recency
  const postDate = new Date(post.indexedAt || post.record?.createdAt || 0);
  const postAgeDays = (Date.now() - postDate) / 86400000;
  if (postAgeDays > MAX_POST_AGE_DAYS) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    return { pass: false, reason: `post too old (${Math.floor(postAgeDays)}d)` };
  }

  const profile = await getProfile(authorDid, token);
  if (!profile) return { pass: true, reason: "no profile" };

  // Follower count
  const followerCount  = profile.followersCount || 0;
  const followingCount = profile.followsCount   || 0;
  if (followerCount < MIN_FOLLOWERS) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    return { pass: false, reason: `too few followers (${followerCount})` };
  }

  // Spam ratio — following way more than followers
  if (followerCount > 0 && followingCount / followerCount > MAX_FOLLOW_RATIO) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    return { pass: false, reason: `spam ratio (${followingCount} following / ${followerCount} followers)` };
  }

  // Account age
  if (profile.createdAt) {
    const ageDays = (Date.now() - new Date(profile.createdAt)) / 86400000;
    if (ageDays < MIN_ACCOUNT_DAYS) {
      stats.filteredCount = (stats.filteredCount || 0) + 1;
      return { pass: false, reason: `account too new (${Math.floor(ageDays)}d)` };
    }
  }

  // ── Profile content checks ────────────────────────────────
  const bio         = (profile.description || "").toLowerCase();
  const displayName = (profile.displayName  || "").toLowerCase();
  const handle      = (profile.handle       || "").toLowerCase();
  const profileFull = [bio, displayName, handle].join(" ");

  // Check Bluesky official account labels first (most reliable)
  const profileLabels = profile.labels || [];
  if (profileLabels.some(l => ["porn", "sexual", "nudity", "graphic-media", "adult-only", "nsfw"].includes(l.val))) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, "NSFW account label");
    return { pass: false, reason: `NSFW account label` };
  }

  // NSFW keyword check — use simple includes (no word boundary needed for explicit terms)
  if (NSFW_TAGS.some(tag => profileFull.includes(tag))) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, `NSFW keyword in profile: ${NSFW_TAGS.find(t => profileFull.includes(t))}`);
    return { pass: false, reason: `NSFW profile bio/name` };
  }

  // NSFW emoji patterns commonly used in adult profiles
  const rawBio = profile.description || "";
  if (NSFW_EMOJI_LIST.some(e => rawBio.includes(e))) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, "NSFW emoji in profile");
    return { pass: false, reason: `NSFW emoji in profile` };
  }

  // Political keyword check
  if (POLITICAL_TAGS.some(tag => profileFull.includes(tag))) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, `political keyword in profile: ${POLITICAL_TAGS.find(t => profileFull.includes(t))}`);
    return { pass: false, reason: `political profile bio/name` };
  }

  // Non-English bio check — skip accounts whose bio is primarily non-English
  if (bio.length > 10 && !isEnglishText(bio)) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, "non-English profile bio");
    return { pass: false, reason: `non-English profile bio` };
  }

  return { pass: true, reason: "ok" };
}

// ── AI Reply generation ───────────────────────────────────
async function generateReply(postText, authorHandle, persona = "friendly") {
  if (!ANTHROPIC_API_KEY) return null;

  // Only reply to English posts
  if (!isEnglishText(postText)) {
    console.log(`   🌐 Skipped reply — non-English post`);
    return null;
  }

  // Never reply to NSFW or political posts
  if (POLITICAL_TAGS.some(tag => new RegExp(`\b${tag}\b`, "i").test(postText.toLowerCase()))) {
    console.log(`   🚫 Skipped reply — political post`);
    return null;
  }
  if (NSFW_TAGS.some(tag => new RegExp(`\b${tag}\b`, "i").test(postText.toLowerCase()))) {
    console.log(`   🚫 Skipped reply — NSFW post`);
    return null;
  }

  const personaInstructions = {
    hype:       "Be enthusiastic and hyped up. Use energy but not cringe. Sound genuinely excited about the topic.",
    analytical: "Be insightful and tactical. Offer a brief strategic take or observation about what they said.",
    friendly:   "Be warm, conversational, and genuine. Sound like a real fellow gamer.",
  };

  const instruction = personaInstructions[persona] || personaInstructions.friendly;

  // Detect game context from post text
  const text = postText.toLowerCase();
  let gameContext = "gaming";
  if (text.includes("cs2") || text.includes("counter-strike") || text.includes("counterstrike")) gameContext = "CS2";
  else if (text.includes("apex") || text.includes("apex legends")) gameContext = "Apex Legends";
  else if (text.includes("rainbow six") || text.includes("r6") || text.includes("siege")) gameContext = "Rainbow Six Siege";
  else if (text.includes("overwatch") || text.includes("ow2")) gameContext = "Overwatch";
  else if (text.includes("minecraft")) gameContext = "Minecraft";
  else if (text.includes("terraria")) gameContext = "Terraria";

  const body = JSON.stringify({
    model: "claude-opus-4-5",
    max_tokens: 150,
    system: `You are Dexterity (@dexteritycs.bsky.social), a gamer and content creator who plays CS2, Apex Legends, Rainbow Six Siege, Overwatch, Minecraft, and Terraria. Write short, genuine, conversational replies to gaming posts. ${instruction} Sound like a real gamer — not a bot. Never use emojis excessively. Always reply in English only. Max 200 characters. Output only the reply text, nothing else.`,
    messages: [{
      role: "user",
      content: `Reply to this ${gameContext} post by @${authorHandle}:\n\n"${postText}"\n\nWrite a short genuine reply as Dexterity. Keep it relevant to ${gameContext} and under 200 characters.`
    }]
  });

  const res = await request({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
  }, body);

  if (res.status !== 200 || !res.body.content?.[0]?.text) return null;
  return res.body.content[0].text.trim();
}

async function replyToPost(post, replyText, did, token) {
  const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
    repo: did,
    collection: "app.bsky.feed.post",
    record: {
      $type: "app.bsky.feed.post",
      text: replyText,
      reply: {
        root:   { uri: post.uri, cid: post.cid },
        parent: { uri: post.uri, cid: post.cid },
      },
      createdAt: new Date().toISOString(),
    },
  }, token);
  return res.status === 200;
}

// ── Actions ───────────────────────────────────────────────
async function likePost(uri, cid, did, token) {
  const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
    repo: did, collection: "app.bsky.feed.like",
    record: { subject: { uri, cid }, createdAt: new Date().toISOString() },
  }, token);
  return res.status === 200;
}

async function followAccount(targetDid, did, token) {
  const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
    repo: did, collection: "app.bsky.graph.follow",
    record: { subject: targetDid, createdAt: new Date().toISOString() },
  }, token);
  return res.status === 200;
}

async function unfollowAccount(myDid, rkey, token) {
  const res = await apiRequest("com.atproto.repo.deleteRecord", "POST",
    { repo: myDid, collection: "app.bsky.graph.follow", rkey }, token
  );
  return res.status === 200;
}

async function searchPosts(term, token) {
  const query = encodeURIComponent(term);
  const res = await apiRequest(`app.bsky.feed.searchPosts?q=${query}&limit=${POSTS_PER_SEARCH}`, "GET", null, token);
  if (res.status !== 200) return [];
  return res.body.posts || [];
}

// ── Unfollow inactive non-followers ──────────────────────
async function runUnfollows(did, token, following, followers, stats) {
  const followBackCutoff = new Date();
  followBackCutoff.setDate(followBackCutoff.getDate() - FOLLOW_BACK_DAYS);

  let totalUnfollows = 0;
  console.log(`\n🧹 Checking for non-followers (14-day follow-back window)...`);

  for (const [targetDid, { rkey, handle }] of following.entries()) {
    // Always keep mutual followers
    if (followers.has(targetDid)) continue;
    if (!rkey) continue;

    // Check when we followed this account
    const followedAt = stats.followedAt?.[targetDid]?.followedAt
      ? new Date(stats.followedAt[targetDid].followedAt)
      : null;

    // If we have a follow date and it's within 14 days, give them more time
    if (followedAt && followedAt > followBackCutoff) {
      const daysLeft = Math.ceil((followedAt - followBackCutoff) / 86400000) + FOLLOW_BACK_DAYS;
      console.log(`   ⏳ @${handle} — followed ${Math.floor((Date.now() - followedAt) / 86400000)}d ago, waiting ${FOLLOW_BACK_DAYS - Math.floor((Date.now() - followedAt) / 86400000)}d more`);
      continue;
    }

    // 14 days have passed and they haven't followed back — unfollow
    const ok = await unfollowAccount(did, rkey, token);
    if (ok) {
      totalUnfollows++;
      console.log(`   🗑️  Unfollowed @${handle} (not followed back in ${FOLLOW_BACK_DAYS}+ days)`);
      following.delete(targetDid);
      // Remove from followedAt tracking
      if (stats.followedAt?.[targetDid]) delete stats.followedAt[targetDid];
    }
    await sleep(800);
  }

  console.log(`✅ Unfollowed ${totalUnfollows} non-followers`);
  return totalUnfollows;
}

// ── Like back new followers ───────────────────────────────
async function runLikeBackFollowers(did, token, following, followers, stats) {
  let liked = 0;
  console.log(`\n💝 Checking for new followers to like back...`);
  for (const followerDid of followers) {
    if (followerDid === did) continue;
    if (stats.lastLikedAt[followerDid]) continue;
    const latestPost = await getLatestPost(followerDid, token);
    if (!latestPost) continue;
    const postAgeDays = (Date.now() - new Date(latestPost.indexedAt || 0)) / 86400000;
    if (postAgeDays > MAX_POST_AGE_DAYS) continue;
    const ok = await likePost(latestPost.uri, latestPost.cid, did, token);
    if (ok) {
      liked++;
      stats.lastLikedAt[followerDid] = new Date().toISOString();
      console.log(`   💝 Liked back @${latestPost.author?.handle || followerDid}`);
    }
    await sleep(800);
  }
  console.log(`✅ Liked back ${liked} new followers`);
  return liked;
}

// ── Follow-back rate ──────────────────────────────────────
function updateFollowBackRate(stats, followers) {
  if (!stats.followedAt)     stats.followedAt     = {};
  if (!stats.followBackRate) stats.followBackRate  = { followed: 0, followedBack: 0 };
  let newFollowBacks = 0;
  for (const [followedDid, info] of Object.entries(stats.followedAt)) {
    if (info.followedBack) continue;
    if (followers.has(followedDid)) {
      stats.followedAt[followedDid].followedBack = true;
      newFollowBacks++;
    }
  }
  stats.followBackRate.followedBack += newFollowBacks;
  const rate = stats.followBackRate.followed > 0
    ? ((stats.followBackRate.followedBack / stats.followBackRate.followed) * 100).toFixed(1)
    : "0.0";
  console.log(`📈 Follow-back rate: ${rate}% (${stats.followBackRate.followedBack}/${stats.followBackRate.followed})`);
}

// ── Growth velocity ───────────────────────────────────────
function pruneLastLikedAt(stats) {
  if (!stats.lastLikedAt) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  let pruned = 0;
  for (const [did, timestamp] of Object.entries(stats.lastLikedAt)) {
    if (new Date(timestamp) < cutoff) {
      delete stats.lastLikedAt[did];
      pruned++;
    }
  }
  if (pruned > 0) console.log(`🧹 Pruned ${pruned} stale lastLikedAt entries`);
}


function recordFollowerCount(stats, count) {
  if (!stats.followerHistory) stats.followerHistory = [];
  const today = new Date().toISOString().slice(0, 10);
  const last  = stats.followerHistory[stats.followerHistory.length - 1];
  if (last?.date === today) {
    last.count = count; // update today's entry
  } else {
    stats.followerHistory.push({ date: today, count });
    if (stats.followerHistory.length > 30) stats.followerHistory.shift(); // keep 30 days
  }
  // Calculate velocity
  if (stats.followerHistory.length >= 2) {
    const oldest = stats.followerHistory[0];
    const days   = (new Date(today) - new Date(oldest.date)) / 86400000 || 1;
    const gained = count - oldest.count;
    const perDay = (gained / days).toFixed(1);
    console.log(`📊 Growth: ${gained >= 0 ? "+" : ""}${gained} followers over ${Math.round(days)} days (${perDay}/day avg)`);
  }
}

// ── Term performance ──────────────────────────────────────
function recordTermPerformance(stats, term, likes, follows) {
  if (!stats.termPerformance) stats.termPerformance = {};
  if (!stats.termPerformance[term]) stats.termPerformance[term] = { likes: 0, follows: 0, runs: 0 };
  stats.termPerformance[term].likes   += likes;
  stats.termPerformance[term].follows += follows;
  stats.termPerformance[term].runs    += 1;
}

function logTopTerms(stats) {
  if (!stats.termPerformance) return;
  const sorted = Object.entries(stats.termPerformance)
    .sort((a, b) => (b[1].likes + b[1].follows) - (a[1].likes + a[1].follows))
    .slice(0, 5);
  console.log(`\n🏆 Top performing search terms:`);
  sorted.forEach(([term, data], i) => {
    console.log(`   ${i + 1}. "${term}" — ${data.likes} likes, ${data.follows} follows across ${data.runs} runs`);
  });
}

// ── Self-test ─────────────────────────────────────────────
async function selfTest() {
  console.log("🔧 Running self-test...");
  const errors = [];

  if (!BLUESKY_HANDLE)   errors.push("BLUESKY_HANDLE not set");
  if (!BLUESKY_PASSWORD) errors.push("BLUESKY_PASSWORD not set");

  // Test Bluesky connectivity
  try {
    const res = await apiRequest(
      `app.bsky.actor.getProfile?actor=${encodeURIComponent(BLUESKY_HANDLE)}`,
      "GET", null, null
    );
    if (res.status === 400 || res.status === 404) errors.push(`Bluesky profile not found for ${BLUESKY_HANDLE}`);
    else console.log(`   ✅ Bluesky reachable`);
  } catch (e) {
    errors.push(`Bluesky API unreachable: ${e.message}`);
  }

  // Test Anthropic if key provided
  if (ANTHROPIC_API_KEY) {
    try {
      const res = await request({
        hostname: "api.anthropic.com",
        path: "/v1/models",
        method: "GET",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.status === 200) console.log(`   ✅ Anthropic API reachable`);
      else errors.push(`Anthropic API returned ${res.status}`);
    } catch (e) {
      errors.push(`Anthropic API unreachable: ${e.message}`);
    }
  }

  if (errors.length) {
    console.error(`\n❌ Self-test failed:\n${errors.map(e => `   - ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log("✅ Self-test passed\n");
}

// ── Discord webhook ───────────────────────────────────────
async function postDiscordSummary(summary) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const url = new URL(DISCORD_WEBHOOK_URL);
    const body = JSON.stringify({
      embeds: [{
        title: "🤖 Bluesky Bot Run Complete",
        color: 0x00e5ff,
        fields: [
          { name: "❤️ Likes",      value: String(summary.likes),      inline: true },
          { name: "➕ Follows",    value: String(summary.follows),    inline: true },
          { name: "🗑️ Unfollows",  value: String(summary.unfollows),  inline: true },
          { name: "💬 Replies",    value: String(summary.replies),    inline: true },
          { name: "📈 Follow-back Rate", value: `${summary.followBackRate}%`, inline: true },
          { name: "👥 Net Followers",    value: `${summary.netFollowers >= 0 ? "+" : ""}${summary.netFollowers}`, inline: true },
          { name: "🏆 Top Term",   value: summary.topTerm || "—",     inline: false },
        ],
        footer: { text: `Run #${summary.runs} • ${new Date().toLocaleString()}` },
      }]
    });
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, body);
    console.log("📨 Discord summary posted");
  } catch (e) {
    console.warn(`Discord webhook failed: ${e.message}`);
  }
}

// ── Reply spam guard ──────────────────────────────────────
function canReply(authorDid, stats) {
  if (!stats.lastRepliedAt) return true;
  const last = stats.lastRepliedAt[authorDid];
  if (!last) return true;
  const daysSince = (Date.now() - new Date(last)) / 86400000;
  return daysSince >= REPLY_COOLDOWN_DAYS;
}

function pruneLastRepliedAt(stats) {
  if (!stats.lastRepliedAt) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  for (const [did, timestamp] of Object.entries(stats.lastRepliedAt)) {
    if (new Date(timestamp) < cutoff) delete stats.lastRepliedAt[did];
  }
}

// ── Repost / quote detection ──────────────────────────────
function isOriginalPost(post) {
  // Skip reposts (reason === "repost") and quote posts
  if (post.reason?.$type === "app.bsky.feed.defs#reasonRepost") return false;
  if (post.record?.embed?.$type === "app.bsky.embed.record") return false; // quote post
  return true;
}

// ── Net follower gain ─────────────────────────────────────
function getNetFollowerGain(stats, currentCount) {
  if (!stats.followerHistory || stats.followerHistory.length < 2) return 0;
  const prev = stats.followerHistory[stats.followerHistory.length - 2];
  return currentCount - (prev?.count || currentCount);
}

// ── Reply engagement tracker ──────────────────────────────
async function checkReplyEngagement(did, token, stats) {
  if (!stats.sentReplies || !stats.sentReplies.length) return;
  if (!stats.replyEngagement) stats.replyEngagement = { sent: 0, gotLiked: 0, gotReplied: 0 };

  // Only check replies from the last 7 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const recent = stats.sentReplies.filter(r => new Date(r.sentAt) > cutoff);
  if (!recent.length) return;

  let newLikes = 0, newReplies = 0;
  for (const reply of recent) {
    if (reply.checkedEngagement) continue;
    try {
      const res = await apiRequest(
        `app.bsky.feed.getPosts?uris=${encodeURIComponent(reply.uri)}`,
        "GET", null, token
      );
      if (res.status === 200 && res.body.posts?.length) {
        const post = res.body.posts[0];
        if ((post.likeCount || 0) > 0) { newLikes++; stats.replyEngagement.gotLiked++; }
        if ((post.replyCount || 0) > 0) { newReplies++; stats.replyEngagement.gotReplied++; }
        reply.checkedEngagement = true;
      }
    } catch {}
    await sleep(200);
  }

  if (newLikes + newReplies > 0) {
    console.log(`💬 Reply engagement: ${newLikes} replies got liked, ${newReplies} got replied to`);
  }
}


// ── English detection ──────────────────────────────────────
function isEnglishText(text) {
  if (!text || text.trim().length < 5) return true;
  const nonLatinScripts = [
    /[\u0400-\u04FF]/, /[\u0600-\u06FF]/, /[\u4E00-\u9FFF]/,
    /[\u3040-\u30FF]/, /[\uAC00-\uD7AF]/, /[\u0900-\u097F]/,
    /[\u0E00-\u0E7F]/, /[\u0370-\u03FF]/,
  ];
  for (const script of nonLatinScripts) { if (script.test(text)) return false; }
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  const totalChars = (text.match(/\S/g) || []).length;
  if (totalChars === 0) return true;
  if (latinChars / totalChars < 0.3) return false;
  return true;
}

// ── NSFW filter ───────────────────────────────────────────
function isNSFW(post) {
  const text   = (post.record?.text || "").toLowerCase();
  const labels = post.labels || [];
  const tags   = post.record?.tags || [];

  // Check Bluesky's built-in content labels
  if (labels.some(l => ["porn", "sexual", "nudity", "graphic-media"].includes(l.val))) return true;

  // Check post text for NSFW keywords (word boundary match to reduce false positives)
  if (NSFW_TAGS.some(tag => new RegExp(`\\b${tag}\\b`, "i").test(text))) return true;

  // Check post tags for NSFW
  if (tags.some(t => NSFW_TAGS.includes(t.toLowerCase()))) return true;

  // Check political keywords in text
  if (POLITICAL_TAGS.some(tag => new RegExp(`\\b${tag}\\b`, "i").test(text))) return true;

  // Check political keywords in post tags
  if (tags.some(t => POLITICAL_TAGS.includes(t.toLowerCase()))) return true;

  return false;
}


function isPaused() {
  if (!fs.existsSync(PAUSE_PATH)) return false;
  try { return JSON.parse(fs.readFileSync(PAUSE_PATH, "utf8")).paused === true; }
  catch { return false; }
}

// ── Engagement score ──────────────────────────────────────
function scorePost(post) {
  const likes    = post.likeCount    || 0;
  const replies  = post.replyCount   || 0;
  const reposts  = post.repostCount  || 0;
  return (likes * SCORE_LIKE_WEIGHT) + (replies * SCORE_REPLY_WEIGHT) + (reposts * SCORE_REPOST_WEIGHT);
}

// ── Mutual network ────────────────────────────────────────
async function getMutualNetwork(did, token) {
  if (!MUTUAL_NETWORK_BOOST) return new Set();
  const mutuals = new Set();
  let cursor = null;
  do {
    const path = `app.bsky.graph.getFollows?actor=${encodeURIComponent(did)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const f of res.body.follows || []) mutuals.add(f.did);
    cursor = res.body.cursor;
  } while (cursor);
  return mutuals;
}

// ── Smart unfollow timing ─────────────────────────────────
function shouldRunUnfollows() {
  const hour = new Date().getUTCHours();
  return hour === UNFOLLOW_HOUR_UTC;
}

// ── Reply persona ─────────────────────────────────────────
function getReplyPersona(stats) {
  const idx = (stats.totalReplies || 0) % REPLY_PERSONAS.length;
  return REPLY_PERSONAS[idx];
}


function loadBlockList() {
  if (!fs.existsSync(BLOCK_LIST_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(BLOCK_LIST_PATH, "utf8"))); }
  catch { return new Set(); }
}

function saveBlockList(blockList) {
  fs.writeFileSync(BLOCK_LIST_PATH, JSON.stringify([...blockList], null, 2));
}

function autoBlock(did, reason) {
  const list = loadBlockList();
  if (!list.has(did)) {
    list.add(did);
    saveBlockList(list);
    console.log(`   🚫 Auto-blocked ${did} — ${reason}`);
  }
}

function addToBlockList(did, handle) {
  const list = loadBlockList();
  list.add(did);
  saveBlockList(list);
  console.log(`🚫 Added @${handle} to block list`);
}

// ── Spike detector ────────────────────────────────────────
function checkForSpike(stats, actionsThisRun) {
  const history = stats.actionsHistory || [];
  if (history.length < 3) return false; // not enough data

  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  if (avg === 0) return false;

  const isSpike = actionsThisRun > avg * SPIKE_THRESHOLD;
  if (isSpike) {
    console.warn(`⚠️  Spike detected — ${actionsThisRun} actions vs avg ${avg.toFixed(1)}. Halting run.`);
  }
  return isSpike;
}

function recordRunActions(stats, count) {
  if (!stats.actionsHistory) stats.actionsHistory = [];
  stats.actionsHistory.push(count);
  if (stats.actionsHistory.length > 20) stats.actionsHistory.shift();
}

// ── Run history ───────────────────────────────────────────
function recordRunHistory(stats, entry) {
  if (!stats.runHistory) stats.runHistory = [];
  stats.runHistory.unshift(entry); // newest first
  if (stats.runHistory.length > 10) stats.runHistory.pop();
}


async function checkAndPostMilestones(followerCount, stats, token, did) {
  if (!stats.milestonesCelebrated) stats.milestonesCelebrated = [];
  for (const milestone of FOLLOWER_MILESTONES) {
    if (followerCount >= milestone && !stats.milestonesCelebrated.includes(milestone)) {
      console.log(`🎉 Milestone reached: ${milestone} followers!`);
      let postText;
      if (ANTHROPIC_API_KEY) {
        const body = JSON.stringify({
          model: "claude-opus-4-5", max_tokens: 200,
          system: "You are Dexterity (@dexteritycs.bsky.social), a CS2 streamer. Write a short genuine excited Bluesky post celebrating a follower milestone. Sound like a real streamer — grateful but not cringe. Include the milestone number. Max 250 chars. Output only the post text.",
          messages: [{ role: "user", content: `Write a Bluesky post celebrating hitting ${milestone} followers. Keep it real and personal.` }]
        });
        const res = await request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        }, body);
        if (res.status === 200 && res.body.content?.[0]?.text) postText = res.body.content[0].text.trim();
      }
      if (!postText) postText = `🎉 Just hit ${milestone.toLocaleString()} followers on Bluesky! Thank you all so much — every follow means a lot. More CS2 content coming! #CS2 #Twitch`;
      const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
        repo: did, collection: "app.bsky.feed.post",
        record: { $type: "app.bsky.feed.post", text: postText, createdAt: new Date().toISOString() },
      }, token);
      if (res.status === 200) {
        stats.milestonesCelebrated.push(milestone);
        console.log(`   ✅ Milestone post published: "${postText}"`);
      }
      await sleep(1000);
    }
  }
}

// ── Weekly summary post ───────────────────────────────────
async function checkAndPostWeeklySummary(stats, token, did, followerCount) {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCDay() !== WEEKLY_SUMMARY_DAY) return;
  if (stats.lastWeeklySummary === today) return;

  const history   = stats.followerHistory || [];
  const weekAgo   = history.find(h => { const d = (new Date(today) - new Date(h.date)) / 86400000; return d >= 6 && d <= 8; });
  const weeklyGain = weekAgo ? followerCount - weekAgo.count : 0;
  const fbRate    = stats.followBackRate?.followed > 0
    ? ((stats.followBackRate.followedBack / stats.followBackRate.followed) * 100).toFixed(1) : "0";

  let postText;
  if (ANTHROPIC_API_KEY) {
    const body = JSON.stringify({
      model: "claude-opus-4-5", max_tokens: 250,
      system: "You are Dexterity (@dexteritycs.bsky.social), a CS2 streamer. Write a weekly stats recap post for Bluesky. Sound natural and conversational. Max 280 chars. Output only the post text.",
      messages: [{ role: "user", content: `Weekly Bluesky recap:\n- New followers: +${weeklyGain}\n- Total: ${followerCount}\n- Likes given: ${stats.totalLikes || 0}\n- Follow-back rate: ${fbRate}%\nInclude CS2/streaming hashtags.` }]
    });
    const res = await request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    }, body);
    if (res.status === 200 && res.body.content?.[0]?.text) postText = res.body.content[0].text.trim();
  }
  if (!postText) postText = `📊 Weekly recap: +${weeklyGain} followers (${followerCount} total), ${stats.totalLikes || 0} likes given, ${fbRate}% follow-back rate. Growing the CS2 community! #CS2 #Twitch`;

  const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
    repo: did, collection: "app.bsky.feed.post",
    record: { $type: "app.bsky.feed.post", text: postText, createdAt: new Date().toISOString() },
  }, token);
  if (res.status === 200) {
    stats.lastWeeklySummary = today;
    console.log(`📊 Weekly summary posted: "${postText}"`);
  }
}

async function run() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD env vars");
    process.exit(1);
  }

  await selfTest();

  // Pause mode check
  if (isPaused()) {
    console.log("⏸️  Bot is paused — skipping run. Toggle pause off in the dashboard to resume.");
    return;
  }

  const stats = loadStats();
  pruneLastLikedAt(stats);
  pruneLastRepliedAt(stats);

  // Daily cap check
  const dailyUsed = getDailyActionsUsed(stats);
  if (dailyUsed >= DAILY_ACTION_CAP) {
    console.log(`⛔ Daily action cap reached (${dailyUsed}/${DAILY_ACTION_CAP}) — skipping run`);
    return;
  }

  // Hourly rate check
  const hourlyUsed = getHourlyActionsUsed(stats);
  if (hourlyUsed >= HOURLY_LIMIT) {
    console.log(`⏳ Hourly rate limit reached (${hourlyUsed}/${HOURLY_LIMIT}) — skipping run`);
    return;
  }

  const remainingToday  = DAILY_ACTION_CAP - dailyUsed;
  const remainingHourly = HOURLY_LIMIT - hourlyUsed;
  const actionsTarget   = Math.min(ACTIONS_PER_RUN, remainingToday, remainingHourly);
  console.log(`🎯 Actions this run: ${actionsTarget} (daily: ${dailyUsed}/${DAILY_ACTION_CAP}, hourly: ${hourlyUsed}/${HOURLY_LIMIT})`);

  const { token, did } = await login();
  const blockList       = loadBlockList();
  const following       = await getFollowing(did, token);
  const { followers, count: followerCount } = await getFollowers(did, token);
  const mutualNetwork   = await getMutualNetwork(did, token);
  console.log(`🤝 Mutual network: ${mutualNetwork.size} accounts`);

  // Net follower gain since last run
  const netFollowers = getNetFollowerGain(stats, followerCount);
  if (netFollowers !== 0) console.log(`👥 Net followers since last run: ${netFollowers >= 0 ? "+" : ""}${netFollowers}`);

  // Check reply engagement
  await checkReplyEngagement(did, token, stats);

  // Check follower milestones
  await checkAndPostMilestones(followerCount, stats, token, did);

  // Check weekly summary
  await checkAndPostWeeklySummary(stats, token, did, followerCount);

  // Record follower count for growth velocity
  recordFollowerCount(stats, followerCount);

  // Update follow-back rate
  updateFollowBackRate(stats, followers);

  // Unfollow inactive non-followers — only run at designated hour
  let totalUnfollows = 0;
  if (shouldRunUnfollows()) {
    totalUnfollows = await runUnfollows(did, token, following, followers, stats);
  } else {
    console.log(`⏰ Unfollow check skipped — runs at ${UNFOLLOW_HOUR_UTC}:00 UTC`);
  }

  // Like back new followers
  const likeBackCount = await runLikeBackFollowers(did, token, following, followers, stats);

  let totalLikes   = likeBackCount;
  let totalFollows = 0;
  let totalReplies = 0;
  let likesSinceLastReply = 0;

  console.log(`\n🔎 Search terms: ${SEARCH_TERMS.join(", ")}`);

  // Collect all posts, track per-term results
  const latestPostByAuthor = new Map();
  const postTermMap = new Map(); // authorDid → term that found them

  for (const term of SEARCH_TERMS) {
    console.log(`\n🔍 Searching "${term}"...`);
    const posts = await searchPosts(term, token);
    console.log(`   Found ${posts.length} posts`);

    for (const post of posts) {
      const authorDid = post.author?.did;
      if (!authorDid || !post.uri || !post.cid) continue;
      if (authorDid === did) continue;
      if (!isOriginalPost(post)) continue;
      if (isNSFW(post)) {
        console.log(`   🚫 Skipped filtered post (NSFW/political) by @${post.author?.handle}`);
        if (authorDid) autoBlock(authorDid, "NSFW/political post content");
        continue;
      }

      // Quick gaming relevance check — skip if no gaming terms found
      if (!isGamingRelevant(post)) continue;
      const existing     = latestPostByAuthor.get(authorDid);
      const postDate     = new Date(post.indexedAt || post.record?.createdAt || 0);
      const existingDate = existing ? new Date(existing.indexedAt || existing.record?.createdAt || 0) : null;
      if (!existing || postDate > existingDate) {
        latestPostByAuthor.set(authorDid, post);
        postTermMap.set(authorDid, term);
      }
    }
  }

  console.log(`\n📋 ${latestPostByAuthor.size} unique authors found`);

  // Sort authors by engagement score, boosting mutual network accounts
  const sortedAuthors = [...latestPostByAuthor.entries()].sort(([didA, postA], [didB, postB]) => {
    let scoreA = scorePost(postA);
    let scoreB = scorePost(postB);
    if (mutualNetwork.has(didA)) scoreA += 10; // boost mutual network
    if (mutualNetwork.has(didB)) scoreB += 10;
    return scoreB - scoreA;
  });

  // Filter by minimum engagement score
  const filteredAuthors = MIN_ENGAGEMENT_SCORE > 0
    ? sortedAuthors.filter(([, post]) => scorePost(post) >= MIN_ENGAGEMENT_SCORE)
    : sortedAuthors;

  console.log(`📊 ${filteredAuthors.length} authors after engagement filter (min score: ${MIN_ENGAGEMENT_SCORE})`);

  const likedThisRun   = new Set();
  const termLikes      = {};
  const termFollows    = {};
  const currentPersona = getReplyPersona(stats);
  console.log(`💬 Reply persona this run: ${currentPersona}`);

  for (const [authorDid, post] of filteredAuthors) {
    if (totalLikes + totalFollows >= actionsTarget) break;

    const uri = post.uri;
    const cid = post.cid;
    if (!uri || !cid) continue;
    if (likedThisRun.has(authorDid)) continue;

    // Block list check
    if (blockList.has(authorDid)) {
      likedThisRun.add(authorDid);
      continue;
    }

    // Quality filters
    const { pass, reason } = await passesQualityFilters(authorDid, post, token, stats);
    if (!pass) {
      console.log(`   🚫 Skipped @${post.author?.handle} — ${reason}`);
      likedThisRun.add(authorDid);
      await sleep(300);
      continue;
    }

    // AI relevance check for ambiguous posts (only fires if no obvious gaming terms)
    const postText = post.record?.text || "";
    const relevant = await isGamingRelevantAI(postText);
    if (!relevant) {
      console.log(`   🎯 Skipped @${post.author?.handle} — post not gaming related`);
      likedThisRun.add(authorDid);
      await sleep(300);
      continue;
    }

    const postDate  = new Date(post.indexedAt || post.record?.createdAt || 0);
    const lastLiked = stats.lastLikedAt[authorDid] ? new Date(stats.lastLikedAt[authorDid]) : null;
    const term      = postTermMap.get(authorDid) || SEARCH_TERMS[0];

    // Profile fetch fallback for stale posts
    let targetPost = post;
    if (lastLiked && postDate <= lastLiked) {
      const latestPost = await getLatestPost(authorDid, token);
      if (latestPost) {
        const latestDate = new Date(latestPost.indexedAt || latestPost.record?.createdAt || 0);
        if (latestDate > lastLiked) {
          if (isNSFW(latestPost)) {
            console.log(`   🔞 Skipped NSFW post by @${post.author?.handle}`);
            likedThisRun.add(authorDid);
            await sleep(300);
            continue;
          }
          targetPost = latestPost;
          console.log(`   🔄 Found newer post from @${post.author?.handle} via profile fetch`);
        } else {
          console.log(`   ⏭️  No new posts from @${post.author?.handle} — skipping`);
          likedThisRun.add(authorDid);
          if (!following.has(authorDid)) {
            const followed = await followAccount(authorDid, did, token);
            if (followed) {
              totalFollows++;
              following.set(authorDid, { handle: post.author?.handle });
              stats.followedAt[authorDid] = { handle: post.author?.handle, followedBack: false, followedAt: new Date().toISOString() };
              stats.followBackRate.followed++;
              termFollows[term] = (termFollows[term] || 0) + 1;
              console.log(`   ➕ Followed @${post.author?.handle}`);
              recordHourlyAction(stats);
              recordDailyAction(stats);
            }
          }
          await sleep(800);
          continue;
        }
      } else {
        likedThisRun.add(authorDid);
        await sleep(300);
        continue;
      }
    }

    // Like
    const liked = await likePost(targetPost.uri, targetPost.cid, did, token);
    if (liked) {
      totalLikes++;
      likesSinceLastReply++;
      likedThisRun.add(authorDid);
      const targetDate = new Date(targetPost.indexedAt || targetPost.record?.createdAt || 0);
      stats.lastLikedAt[authorDid] = targetDate.toISOString();
      termLikes[term] = (termLikes[term] || 0) + 1;
      console.log(`   ❤️  Liked post by @${post.author?.handle}`);
      recordHourlyAction(stats);
      recordDailyAction(stats);

      // AI reply every REPLY_FREQUENCY likes
      if (ANTHROPIC_API_KEY && likesSinceLastReply >= REPLY_FREQUENCY) {
        const postText = targetPost.record?.text || "";
        if (postText.length >= MIN_REPLY_TEXT_LEN && canReply(authorDid, stats)) {
          const replyText = await generateReply(postText, post.author?.handle, currentPersona);
          if (replyText) {
            const replied = await replyToPost(targetPost, replyText, did, token);
            if (replied) {
              totalReplies++;
              likesSinceLastReply = 0;
              stats.lastRepliedAt[authorDid] = new Date().toISOString();
              if (!stats.sentReplies) stats.sentReplies = [];
              stats.sentReplies.push({
                uri: targetPost.uri,
                authorDid,
                sentAt: new Date().toISOString(),
                checkedEngagement: false,
              });
              // Keep only last 50 sent replies
              if (stats.sentReplies.length > 50) stats.sentReplies.shift();
              stats.replyEngagement.sent++;
              console.log(`   💬 Replied to @${post.author?.handle}: "${replyText}"`);
              recordHourlyAction(stats);
              recordDailyAction(stats);
            }
          }
          await sleep(1000);
        }
      }
    }

    // Follow
    if (!following.has(authorDid)) {
      const followed = await followAccount(authorDid, did, token);
      if (followed) {
        totalFollows++;
        following.set(authorDid, { handle: post.author?.handle });
        stats.followedAt[authorDid] = { handle: post.author?.handle, followedBack: false, followedAt: new Date().toISOString() };
        stats.followBackRate.followed++;
        termFollows[term] = (termFollows[term] || 0) + 1;
        console.log(`   ➕ Followed @${post.author?.handle}`);
        recordHourlyAction(stats);
        recordDailyAction(stats);
      }
    }

    await sleep(800);
  }

  // Record term performance
  for (const term of SEARCH_TERMS) {
    recordTermPerformance(stats, term, termLikes[term] || 0, termFollows[term] || 0);
  }

  logTopTerms(stats);

  const totalActions = totalLikes + totalFollows + totalReplies;

  // Spike detection — halt if actions are abnormally high
  if (checkForSpike(stats, totalActions)) {
    saveStats(stats);
    process.exit(1);
  }

  recordRunActions(stats, totalActions);

  const rate = stats.followBackRate.followed > 0
    ? ((stats.followBackRate.followedBack / stats.followBackRate.followed) * 100).toFixed(1)
    : "0.0";

  const topTerm = Object.entries(stats.termPerformance || {})
    .sort((a, b) => (b[1].likes + b[1].follows) - (a[1].likes + a[1].follows))[0]?.[0] || "—";

  console.log(`\n✅ Run complete — ${totalLikes} likes, ${totalFollows} follows, ${totalUnfollows} unfollows, ${totalReplies} replies`);
  console.log(`📈 Follow-back rate: ${rate}% (${stats.followBackRate.followedBack}/${stats.followBackRate.followed})`);
  console.log(`👥 Net followers this run: ${netFollowers >= 0 ? "+" : ""}${netFollowers}`);
  console.log(`🚫 Filtered this run: ${stats.filteredCount || 0} accounts`);
  if (stats.replyEngagement?.sent > 0) {
    console.log(`💬 Reply engagement: ${stats.replyEngagement.gotLiked} liked, ${stats.replyEngagement.gotReplied} replied to (of ${stats.replyEngagement.sent} sent)`);
  }

  stats.totalLikes     = (stats.totalLikes || 0) + totalLikes;
  stats.totalFollows   = (stats.totalFollows || 0) + totalFollows;
  stats.totalUnfollows = (stats.totalUnfollows || 0) + totalUnfollows;
  stats.totalReplies   = (stats.totalReplies || 0) + totalReplies;
  stats.filteredCount  = 0;
  stats.runs           = (stats.runs || 0) + 1;
  stats.lastRun        = new Date().toISOString();

  recordRunHistory(stats, {
    timestamp:  new Date().toISOString(),
    likes:      totalLikes,
    follows:    totalFollows,
    unfollows:  totalUnfollows,
    replies:    totalReplies,
    netFollowers,
    filtered:   stats.filteredCount || 0,
  });

  saveStats(stats);

  console.log(`📊 Cumulative — ${stats.totalLikes} likes, ${stats.totalFollows} follows, ${stats.totalUnfollows} unfollows, ${stats.totalReplies} replies across ${stats.runs} runs`);

  // Post Discord summary
  await postDiscordSummary({
    likes: totalLikes, follows: totalFollows, unfollows: totalUnfollows,
    replies: totalReplies, followBackRate: rate,
    netFollowers, topTerm, runs: stats.runs,
  });
}

run().catch((err) => {
  console.error("❌ Bot error:", err.message);
  process.exit(1);
});
