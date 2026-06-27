const https = require("https");
const http  = require("http");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────
const BLUESKY_HANDLE     = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD   = process.env.BLUESKY_PASSWORD;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ACTIONS_PER_RUN    = parseInt(process.env.ACTIONS_PER_RUN || "25");
const INACTIVE_DAYS      = 60;   // unfollow if inactive this long (still used as secondary check)
const FOLLOW_BACK_DAYS   = 7;    // unfollow if not followed back within this many days

// Engagement quality filters
const MIN_FOLLOWERS      = 25;
const MIN_ACCOUNT_DAYS   = 30;
const MAX_POST_AGE_DAYS  = 7;
const MAX_FOLLOW_RATIO   = 10; // following/followers ratio — skip if above this (spam signal)

// Daily/hourly caps
const DAILY_ACTION_CAP   = 200;
const HOURLY_LIMIT       = 60;

// Reply config — 1 in every N liked posts gets a reply
const REPLY_FREQUENCY      = 3;
const REPLY_COOLDOWN_DAYS  = 7;    // don't reply to same account more than once per X days
const MIN_REPLY_TEXT_LEN   = 30;   // minimum post text length to attempt a reply
const DISCORD_WEBHOOK_URL  = process.env.DISCORD_WEBHOOK_URL || null; // optional run summary
const GIST_TOKEN           = process.env.GIST_TOKEN || null;
const GIST_ID              = process.env.GIST_ID || "9e21611814d0c5b84c94a9bc15ed21fa";

// Follower milestones to celebrate
const FOLLOWER_MILESTONES  = [100, 250, 500, 1000, 2500, 5000, 10000];

// Weekly summary — posts every Monday
const WEEKLY_SUMMARY_DAY   = 1; // 0=Sun, 1=Mon

// Account protection
const SPIKE_THRESHOLD      = 3;
const BLOCK_LIST_PATH      = "data/blocklist.json";

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
const PAUSE_PATH = "data/pause.json";

const DEFAULT_TERMS = [
  // CS2
  "#CS2", "CS2", "counter-strike",
  // Apex Legends
  "#ApexLegends", "apex legends",
  // Overwatch
  "#Overwatch",
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
  // Kink/BDSM lifestyle
  "bratty", "submissive", "dominant", "domme", "femdom", "findom",
  "daddy dom", "mommy dom", "owned by", "collared", "pet play",
  "little space", "age play", "ddlg", "mdlg",
  // Furry
  "furry", "fursona", "fursuit", "yiff",
  // Egirl/aesthetic NSFW adjacent
  "egirl", "e-girl", "bunny girl",
  "brat ",
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
  // Gender identity
  "nonbinary", "non-binary", "enby", "they/them", "she/her", "he/him",
  "genderfluid", "gender fluid", "agender", "two spirit",
  "queer", "sapphic", "achillean", "aroace", "asexual", "bisexual",
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

const TRIMMED_TERMS_PATH    = "data/trimmed_terms.json";
const CANDIDATE_TERMS_PATH  = "data/candidate_terms.json";

// Term discovery config
const MAX_CANDIDATE_DISCOVERY = 5;   // max new candidates to discover per run
const MAX_ACTIVE_SEARCH_TERMS = 15;  // max total active search terms at once

// Protected terms — never auto-trimmed regardless of performance
const PROTECTED_TERMS = new Set([
  "#CS2", "CS2", "counter-strike",
  "#ApexLegends", "apex legends",
  "#Overwatch",
  "#Minecraft", "minecraft",
  "#Terraria", "terraria",
]);

function loadTrimmedTerms() {
  if (!fs.existsSync(TRIMMED_TERMS_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(TRIMMED_TERMS_PATH, "utf8"))); }
  catch { return new Set(); }
}

function saveTrimmedTerms(trimmedSet) {
  fs.writeFileSync(TRIMMED_TERMS_PATH, JSON.stringify([...trimmedSet], null, 2));
}

function loadCandidateTerms() {
  if (!fs.existsSync(CANDIDATE_TERMS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(CANDIDATE_TERMS_PATH, "utf8")); }
  catch { return []; }
}

function saveCandidateTerms(candidates) {
  fs.writeFileSync(CANDIDATE_TERMS_PATH, JSON.stringify(candidates, null, 2));
}

const TRIMMED_TERMS = loadTrimmedTerms();
const CANDIDATE_TERMS = loadCandidateTerms();
const ACTIVE_CANDIDATES = CANDIDATE_TERMS.filter(c => c.status === "active").map(c => c.term);

const NSFW_ACCOUNTS = new Set(); // populated from blocklist
const SEARCH_TERMS  = [
  ...(process.env.SEARCH_TERMS
    ? process.env.SEARCH_TERMS.split(",").map(s => s.trim()).filter(Boolean)
    : DEFAULT_TERMS),
  ...ACTIVE_CANDIDATES,
].filter(t => !TRIMMED_TERMS.has(t));

if (TRIMMED_TERMS.size > 0) {
  console.log(`✂️  Skipping ${TRIMMED_TERMS.size} auto-trimmed term(s): ${[...TRIMMED_TERMS].join(", ")}`);
}
if (ACTIVE_CANDIDATES.length > 0) {
  console.log(`🧪 Testing ${ACTIVE_CANDIDATES.length} candidate term(s): ${ACTIVE_CANDIDATES.join(", ")}`);
}

const POSTS_PER_SEARCH = 100;
const STATS_PATH       = "data/stats.json";

// Ensure data directory exists
if (!fs.existsSync("data")) fs.mkdirSync("data");

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
    filterHitLog: [],            // last 100 filter hits with reason + keyword
    replyEngagement: { sent: 0, gotLiked: 0, gotReplied: 0 },
    replyPersonaStats: {},       // per-persona engagement tracking
    milestonesCelebrated: [],
    lastWeeklySummary: null,
    runHistory: [],              // last 10 runs for dashboard table
    actionsHistory: [],          // recent run action counts for spike detection
    termFollowBackRate: {},      // follow-back rate per search term
  };
  if (!fs.existsSync(STATS_PATH)) return defaults;
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(STATS_PATH, "utf8")) }; }
  catch { return defaults; }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
}

async function saveStatsToGist(stats) {
  if (!GIST_TOKEN || !GIST_ID) return;
  try {
    const body = JSON.stringify({
      files: {
        "stats.json": {
          content: JSON.stringify(stats, null, 2),
        },
      },
    });
    const res = await request({
      hostname: "api.github.com",
      path: `/gists/${GIST_ID}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GIST_TOKEN}`,
        "User-Agent": "dexteritycs-bot",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, body);
    if (res.status === 200) {
      console.log("📡 Stats synced to Gist");
    } else {
      console.warn(`⚠️  Gist sync failed: ${res.status}`);
    }
  } catch (e) {
    console.warn(`⚠️  Gist sync error: ${e.message}`);
  }
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

async function apiRequest(path, method, body, token, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await request({
      hostname: "bsky.social",
      path: `/xrpc/${path}`,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    }, body);

    if (res.status === 429) {
      const retryAfter = res.body?.retryAfter || (attempt * 30);
      console.warn(`   ⏳ Rate limited — waiting ${retryAfter}s before retry ${attempt}/${retries}`);
      await sleep(retryAfter * 1000);
      continue;
    }

    return res;
  }
  console.warn(`   ⚠️  Max retries reached for ${path}`);
  return { status: 429, body: {} };
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

// ── Content filter helpers ────────────────────────────────

// Simple includes-based check (works correctly for multi-word phrases)
function containsFilteredTag(text, tagList) {
  const lower = text.toLowerCase();
  return tagList.some(tag => lower.includes(tag));
}

// Returns the matched keyword or null
function findFilteredTag(text, tagList) {
  const lower = text.toLowerCase();
  return tagList.find(tag => lower.includes(tag)) || null;
}

// Log a filter hit to stats (keeps last 100)
function recordFilterHit(stats, handle, reason, keyword = null) {
  if (!stats.filterHitLog) stats.filterHitLog = [];
  stats.filterHitLog.unshift({
    handle,
    reason,
    keyword,
    at: new Date().toISOString(),
  });
  if (stats.filterHitLog.length > 100) stats.filterHitLog.pop();
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
      model: "claude-haiku-4-5-20251001",
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

  // NSFW keyword check — plain includes (handles multi-word tags correctly)
  if (containsFilteredTag(profileFull, NSFW_TAGS)) {
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

  // Political keyword check — plain includes (handles multi-word tags correctly)
  if (containsFilteredTag(profileFull, POLITICAL_TAGS)) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, `political keyword in profile: ${POLITICAL_TAGS.find(t => profileFull.includes(t))}`);
    return { pass: false, reason: `political profile bio/name` };
  }

  // Non-English bio check — AI detection to catch Latin-script non-English (German, French, etc.)
  if (bio.length > 10 && ANTHROPIC_API_KEY) {
    try {
      const langCheck = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system: "You are a language detector. Answer only YES or NO.",
        messages: [{
          role: "user",
          content: `Is this text written in English? Answer only YES or NO.\n\n"${bio.slice(0, 300)}"`
        }]
      });
      const langRes = await request({
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      }, langCheck);
      const isEnglish = langRes.body.content?.[0]?.text?.trim().toUpperCase() === "YES";
      if (!isEnglish) {
        stats.filteredCount = (stats.filteredCount || 0) + 1;
        autoBlock(authorDid, "non-English profile bio (AI detected)");
        return { pass: false, reason: `non-English profile bio` };
      }
    } catch {
      // fail open — if check errors, don't block on language
    }
  } else if (bio.length > 10 && !isEnglishText(bio)) {
    // fallback if no API key
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, "non-English profile bio");
    return { pass: false, reason: `non-English profile bio` };
  }

  return { pass: true, reason: "ok" };
}

// ── AI Reply generation ───────────────────────────────────
// ── Thread context fetcher ────────────────────────────────────
async function getThreadContext(postUri, token) {
  try {
    const res = await apiRequest(
      `app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri)}&depth=10&parentHeight=10`,
      "GET", null, token
    );
    if (res.status !== 200 || !res.body.thread) return null;

    const thread = res.body.thread;
    const posts  = [];

    // Walk up to root via parent chain
    let current = thread;
    while (current?.parent) {
      current = current.parent;
    }

    // Now walk back down collecting post texts
    function collectPosts(node) {
      if (!node?.post?.record?.text) return;
      posts.push({
        handle: node.post.author?.handle || "unknown",
        text:   node.post.record.text,
      });
      // Follow the first reply in the chain down to our target
      if (node.replies?.length) {
        collectPosts(node.replies[0]);
      }
    }

    collectPosts(current);
    return posts.length > 1 ? posts : null; // only useful if there's actual thread context
  } catch {
    return null;
  }
}

async function generateReply(postText, authorHandle, persona = "friendly", token = null, postUri = null) {
  if (!ANTHROPIC_API_KEY) return null;

  // Only reply to English posts — AI language check
  try {
    const langCheck = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: "You are a language detector. Answer only YES or NO.",
      messages: [{
        role: "user",
        content: `Is this text written in English? Answer only YES or NO.\n\n"${postText.slice(0, 300)}"`
      }]
    });
    const langRes = await request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    }, langCheck);
    const isEnglish = langRes.body.content?.[0]?.text?.trim().toUpperCase() === "YES";
    if (!isEnglish) {
      console.log(`   🌐 Skipped reply — non-English post (AI detected)`);
      return null;
    }
  } catch {
    // fail open — if check errors, fall through to reply attempt
  }

  // Never reply to political or NSFW posts — use plain includes for reliable multi-word matching
  if (containsFilteredTag(postText, POLITICAL_TAGS)) {
    console.log(`   🚫 Skipped reply — political post`);
    return null;
  }
  if (containsFilteredTag(postText, NSFW_TAGS)) {
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

  // Fetch thread context if this post is part of a thread
  let threadContext = "";
  if (token && postUri) {
    const threadPosts = await getThreadContext(postUri, token);
    if (threadPosts && threadPosts.length > 1) {
      console.log(`   🧵 Thread context: ${threadPosts.length} posts`);
      threadContext = "\n\nThread context (read from top):\n" +
        threadPosts.map(p => `@${p.handle}: "${p.text}"`).join("\n") +
        `\n\nThe post you are replying to is the last one by @${authorHandle}.`;
    }
  }

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 150,
    system: `You are Dexterity (@dexteritycs.bsky.social), a gamer and content creator who plays CS2, Apex Legends, Rainbow Six Siege, Overwatch, Minecraft, and Terraria. Write short, genuine, conversational replies to gaming posts. ${instruction} Sound like a real gamer — not a bot. Never use emojis excessively. Always reply in English only. Max 200 characters. Output only the reply text, nothing else.`,
    messages: [{
      role: "user",
      content: `Reply to this ${gameContext} post by @${authorHandle}:\n\n"${postText}"${threadContext}\n\nWrite a short genuine reply as Dexterity. Keep it relevant to ${gameContext} and under 200 characters.`
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

  const whitelist = loadWhitelist();
  if (whitelist.size > 0) console.log(`🛡️  Whitelist loaded — ${whitelist.size} protected accounts`);

  let totalUnfollows = 0;
  console.log(`\n🧹 Checking for non-followers (14-day follow-back window)...`);

  for (const [targetDid, { rkey, handle }] of following.entries()) {
    // Always keep mutual followers
    if (followers.has(targetDid)) continue;
    if (!rkey) continue;

    // Whitelist check — skip protected accounts
    if (whitelist.has(handle)) {
      console.log(`   🛡️  Skipped @${handle} — whitelisted`);
      continue;
    }

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
  if (!stats.followedAt)          stats.followedAt          = {};
  if (!stats.followBackRate)      stats.followBackRate       = { followed: 0, followedBack: 0 };
  if (!stats.termFollowBackRate)  stats.termFollowBackRate   = {};
  let newFollowBacks = 0;
  for (const [followedDid, info] of Object.entries(stats.followedAt)) {
    if (info.followedBack) continue;
    if (followers.has(followedDid)) {
      stats.followedAt[followedDid].followedBack = true;
      newFollowBacks++;
      // Update per-term follow-back rate
      const term = info.term;
      if (term && stats.termFollowBackRate[term]) {
        stats.termFollowBackRate[term].followedBack = (stats.termFollowBackRate[term].followedBack || 0) + 1;
      }
    }
  }
  stats.followBackRate.followedBack += newFollowBacks;
  const rate = stats.followBackRate.followed > 0
    ? ((stats.followBackRate.followedBack / stats.followBackRate.followed) * 100).toFixed(1)
    : "0.0";
  console.log(`📈 Follow-back rate: ${rate}% (${stats.followBackRate.followedBack}/${stats.followBackRate.followed})`);
  // Log top term follow-back rates
  const termRates = Object.entries(stats.termFollowBackRate)
    .filter(([, d]) => d.followed > 0)
    .map(([term, d]) => ({ term, rate: ((d.followedBack || 0) / d.followed * 100).toFixed(1), followed: d.followed }))
    .sort((a, b) => parseFloat(b.rate) - parseFloat(a.rate))
    .slice(0, 3);
  if (termRates.length > 0) {
    console.log(`📊 Top term follow-back rates: ${termRates.map(t => `"${t.term}" ${t.rate}% (${t.followed})`).join(", ")}`);
  }
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

// ── Auto-trim dead search terms ───────────────────────────────
const DEAD_TERM_MIN_RUNS     = 15;   // minimum runs before eligible for trimming
const DEAD_TERM_MIN_AVG      = 0.5;  // minimum avg engagements per run to keep

async function autoTrimDeadTerms(stats) {
  if (!stats.termPerformance) return;

  const trimmed = [];

  for (const [term, data] of Object.entries(stats.termPerformance)) {
    if (data.runs < DEAD_TERM_MIN_RUNS) continue; // not enough data yet
    if (PROTECTED_TERMS.has(term)) continue;       // never trim protected terms

    const avgEngagement = (data.likes + data.follows) / data.runs;
    if (avgEngagement < DEAD_TERM_MIN_AVG) {
      trimmed.push({ term, avgEngagement: avgEngagement.toFixed(2), runs: data.runs });
      delete stats.termPerformance[term];
    }
  }

  if (trimmed.length > 0) {
    console.log(`\n✂️  Auto-trimmed ${trimmed.length} dead search term(s):`);
    trimmed.forEach(t => console.log(`   - "${t.term}" — ${t.avgEngagement} avg engagement/run over ${t.runs} runs`));

    // Also remove from termFollowBackRate
    if (stats.termFollowBackRate) {
      trimmed.forEach(({ term }) => {
        if (stats.termFollowBackRate[term]) delete stats.termFollowBackRate[term];
      });
    }

    // Save to trimmed_terms.json so they're excluded from future searches
    const trimmedSet = loadTrimmedTerms();
    trimmed.forEach(({ term }) => trimmedSet.add(term));
    saveTrimmedTerms(trimmedSet);
    console.log(`💾 Saved ${trimmedSet.size} total trimmed term(s) to ${TRIMMED_TERMS_PATH}`);

    // Post Discord notification
    if (DISCORD_WEBHOOK_URL) {
      try {
        const url = new URL(DISCORD_WEBHOOK_URL);
        const body = JSON.stringify({
          embeds: [{
            title: "✂️ Search Terms Auto-Trimmed",
            color: 0xff8c1e,
            description: trimmed.map(t =>
              `**"${t.term}"** — ${t.avgEngagement} avg engagement/run over ${t.runs} runs`
            ).join("\n"),
            footer: { text: `${trimmed.length} term(s) removed • These terms will no longer be searched automatically` },
          }]
        });
        await request({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }, body);
        console.log("📨 Discord trim notification posted");
      } catch (e) {
        console.warn(`Discord trim notification failed: ${e.message}`);
      }
    }
  }

  return trimmed;
}

// ── Cycle in next candidate when a term is trimmed ────────────
async function cycleInNextCandidate(trimmedCount) {
  if (trimmedCount === 0) return;

  const candidates = loadCandidateTerms();
  const queued = candidates.filter(c => c.status === "queued");
  const active = candidates.filter(c => c.status === "active");

  // Only cycle in if we have room and queued candidates
  const currentActiveCount = SEARCH_TERMS.length;
  const slotsAvailable = Math.max(0, MAX_ACTIVE_SEARCH_TERMS - currentActiveCount + trimmedCount);
  const toActivate = queued.slice(0, Math.min(trimmedCount, slotsAvailable));

  if (toActivate.length === 0) return;

  toActivate.forEach(c => { c.status = "active"; c.activatedAt = new Date().toISOString(); });
  saveCandidateTerms(candidates);

  console.log(`🔄 Cycled in ${toActivate.length} new term(s): ${toActivate.map(c => c.term).join(", ")}`);

  if (DISCORD_WEBHOOK_URL) {
    try {
      const url = new URL(DISCORD_WEBHOOK_URL);
      const body = JSON.stringify({
        embeds: [{
          title: "🔄 New Search Terms Activated",
          color: 0x00e5ff,
          description: toActivate.map(c => `**"${c.term}"** — discovered from ${c.sourceGame}`).join("\n"),
          footer: { text: `${queued.length - toActivate.length} term(s) still queued` },
        }]
      });
      await request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, body);
    } catch (e) {
      console.warn(`Discord cycle notification failed: ${e.message}`);
    }
  }
}

// ── Discover new search terms from Bluesky ────────────────────
// Valid game identifiers to ensure discovered terms are gaming-related
const GAME_SEEDS = [
  { game: "CS2",            seed: "CS2" },
  { game: "Apex Legends",   seed: "apex legends" },
  { game: "Overwatch",      seed: "#Overwatch" },
  { game: "Minecraft",      seed: "minecraft" },
  { game: "Terraria",       seed: "terraria" },
];

// Known non-gaming hashtags to always reject
const HASHTAG_BLOCKLIST = new Set([
  "art", "music", "politics", "news", "crypto", "nft", "ai", "love",
  "photography", "food", "travel", "fashion", "fitness", "health",
  "memes", "funny", "anime", "manga", "vtuber", "stream", "twitch",
  "twitter", "bluesky", "fediverse", "mastodon",
]);

async function discoverNewTerms(token, stats) {
  const candidates = loadCandidateTerms();
  const existingTerms = new Set([
    ...SEARCH_TERMS,
    ...candidates.map(c => c.term),
    ...[...loadTrimmedTerms()],
  ]);

  const discovered = [];

  // Pick a random game seed to search this run
  const seed = GAME_SEEDS[Math.floor(Math.random() * GAME_SEEDS.length)];
  console.log(`\n🔍 Discovering new terms via "${seed.seed}" (${seed.game})...`);

  try {
    const posts = await searchPosts(seed.seed, token);
    const hashtagCounts = {};

    for (const post of posts) {
      const text = (post.record?.text || "").toLowerCase();
      const tags = (post.record?.text || "").match(/#\w+/g) || [];

      for (const tag of tags) {
        const clean = tag.toLowerCase();
        // Skip if already known, blocked, or too short
        if (existingTerms.has(clean)) continue;
        if (existingTerms.has(tag)) continue;
        if (clean.length < 4) continue;
        if (HASHTAG_BLOCKLIST.has(clean.slice(1))) continue;

        // Must contain a gaming-related keyword or game name
        const tagWord = clean.slice(1); // remove #
        const isGamingRelated = GAMING_TERMS.some(t => tagWord.includes(t) || t.includes(tagWord)) ||
          ["cs2", "apex", "overwatch", "minecraft", "terraria", "valorant", "gaming",
           "gamer", "fps", "esport", "streamer", "siege", "fortnite", "league",
           "rocket", "halo", "cod", "battlefield", "steam", "indie"].some(g => tagWord.includes(g));

        if (!isGamingRelated) continue;

        // NSFW/political filter
        if (containsFilteredTag(clean, NSFW_TAGS)) continue;
        if (containsFilteredTag(clean, POLITICAL_TAGS)) continue;

        hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
      }
    }

    // Sort by frequency and take top candidates
    const sorted = Object.entries(hashtagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CANDIDATE_DISCOVERY);

    for (const [tag, count] of sorted) {
      if (discovered.length >= MAX_CANDIDATE_DISCOVERY) break;
      candidates.push({
        term: tag,
        sourceGame: seed.game,
        discoveredAt: new Date().toISOString(),
        status: "queued",
        frequency: count,
      });
      discovered.push(tag);
      existingTerms.add(tag);
      console.log(`   💡 Discovered: "${tag}" (seen ${count}x in ${seed.game} posts)`);
    }

    if (discovered.length > 0) {
      saveCandidateTerms(candidates);

      if (DISCORD_WEBHOOK_URL) {
        try {
          const url = new URL(DISCORD_WEBHOOK_URL);
          const body = JSON.stringify({
            embeds: [{
              title: "💡 New Search Terms Discovered",
              color: 0x00ff88,
              description: discovered.map(t => `**"${t}"** — found in ${seed.game} posts`).join("\n"),
              footer: { text: `Added to queue • Will activate when slots open up` },
            }]
          });
          await request({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: "POST",
            headers: { "Content-Type": "application/json" },
          }, body);
        } catch (e) {
          console.warn(`Discord discovery notification failed: ${e.message}`);
        }
      }
    } else {
      console.log(`   No new gaming terms found this run`);
    }
  } catch (e) {
    console.warn(`Term discovery failed: ${e.message}`);
  }

  return discovered;
}
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
  if (!stats.replyPersonaStats) stats.replyPersonaStats = {};

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
        const persona = reply.persona;
        if ((post.likeCount || 0) > 0) {
          newLikes++;
          stats.replyEngagement.gotLiked++;
          if (persona && stats.replyPersonaStats[persona]) stats.replyPersonaStats[persona].gotLiked = (stats.replyPersonaStats[persona].gotLiked || 0) + 1;
        }
        if ((post.replyCount || 0) > 0) {
          newReplies++;
          stats.replyEngagement.gotReplied++;
          if (persona && stats.replyPersonaStats[persona]) stats.replyPersonaStats[persona].gotReplied = (stats.replyPersonaStats[persona].gotReplied || 0) + 1;
        }
        reply.checkedEngagement = true;
      }
    } catch {}
    await sleep(200);
  }

  if (newLikes + newReplies > 0) {
    console.log(`💬 Reply engagement: ${newLikes} replies got liked, ${newReplies} got replied to`);
    // Log persona breakdown
    const personaSummary = Object.entries(stats.replyPersonaStats)
      .filter(([, d]) => d.sent > 0)
      .map(([p, d]) => `${p}: ${d.gotLiked || 0}❤️ ${d.gotReplied || 0}💬 / ${d.sent} sent`)
      .join(", ");
    if (personaSummary) console.log(`   🎭 Persona breakdown: ${personaSummary}`);
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

// ── NSFW / political filter ───────────────────────────────
function isNSFW(post) {
  const text   = (post.record?.text || "").toLowerCase();
  const labels = post.labels || [];
  const tags   = post.record?.tags || [];

  // Check Bluesky's built-in content labels
  if (labels.some(l => ["porn", "sexual", "nudity", "graphic-media"].includes(l.val))) return true;

  // Check post text for NSFW keywords — plain includes (handles multi-word tags correctly)
  if (containsFilteredTag(text, NSFW_TAGS)) return true;

  // Check post tags for NSFW
  if (tags.some(t => NSFW_TAGS.includes(t.toLowerCase()))) return true;

  // Check political keywords in text — plain includes (handles multi-word tags correctly)
  if (containsFilteredTag(text, POLITICAL_TAGS)) return true;

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
function shouldRunUnfollows(stats) {
  const today = new Date().toISOString().slice(0, 10);
  if (stats.lastUnfollowDate === today) return false;
  return true;
}

// ── Reply persona ─────────────────────────────────────────
function getReplyPersona(stats) {
  const idx = (stats.totalReplies || 0) % REPLY_PERSONAS.length;
  return REPLY_PERSONAS[idx];
}


const WHITELIST_PATH   = "data/whitelist.json";

function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"))); }
  catch { return new Set(); }
}

function loadBlockList() {
  if (!fs.existsSync(BLOCK_LIST_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(BLOCK_LIST_PATH, "utf8"))); }
  catch { return new Set(); }
}

function saveBlockList(blockList) {
  fs.writeFileSync(BLOCK_LIST_PATH, JSON.stringify([...blockList], null, 2));
}

function autoBlock(did, reason, stats = null, handle = null, following = null, myDid = null, token = null) {
  const list = loadBlockList();
  if (!list.has(did)) {
    list.add(did);
    saveBlockList(list);
    console.log(`   🚫 Auto-blocked ${handle || did} — ${reason}`);
    // Log filter hit
    if (stats) recordFilterHit(stats, handle || did, reason);
    // Auto-unfollow if we're following them
    if (following && myDid && token && following.has(did)) {
      const rkey = following.get(did)?.rkey;
      if (rkey) {
        unfollowAccount(myDid, rkey, token).then(ok => {
          if (ok) {
            following.delete(did);
            console.log(`   🗑️  Auto-unfollowed @${handle || did} (was following blocked account)`);
          }
        }).catch(() => {});
      }
    }
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
          model: "claude-sonnet-4-6", max_tokens: 200,
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
      model: "claude-sonnet-4-6", max_tokens: 250,
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

  // Unfollow inactive non-followers — runs once per day on first cycle
  let totalUnfollows = 0;
  if (shouldRunUnfollows(stats)) {
    totalUnfollows = await runUnfollows(did, token, following, followers, stats);
    stats.lastUnfollowDate = new Date().toISOString().slice(0, 10);
  } else {
    console.log(`⏰ Unfollow check skipped — already ran today (${stats.lastUnfollowDate})`);
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

      // Skip image-only posts — no text to filter or reply to
      const postText = (post.record?.text || "").trim();
      if (postText.length < 5) continue;

      if (isNSFW(post)) {
        const keyword = findFilteredTag(postText, NSFW_TAGS) || findFilteredTag(postText, POLITICAL_TAGS);
        console.log(`   🚫 Skipped filtered post (NSFW/political) by @${post.author?.handle}${keyword ? ` [${keyword}]` : ""}`);
        if (authorDid) autoBlock(authorDid, `NSFW/political post content${keyword ? `: ${keyword}` : ""}`, stats, post.author?.handle, following, did, token);
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

    // Post text language check — skip non-English posts before liking
    if (ANTHROPIC_API_KEY && postText.length > 10) {
      try {
        const langCheck = JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 10,
          system: "You are a language detector. Answer only YES or NO.",
          messages: [{ role: "user", content: `Is this text written in English? Answer only YES or NO.\n\n"${postText.slice(0, 300)}"` }]
        });
        const langRes = await request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        }, langCheck);
        const isEnglish = langRes.body.content?.[0]?.text?.trim().toUpperCase() === "YES";
        if (!isEnglish) {
          console.log(`   🌐 Skipped @${post.author?.handle} — non-English post`);
          recordFilterHit(stats, post.author?.handle, "non-English post text");
          likedThisRun.add(authorDid);
          await sleep(300);
          continue;
        }
      } catch { /* fail open */ }
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
              stats.followedAt[authorDid] = { handle: post.author?.handle, followedBack: false, followedAt: new Date().toISOString(), term };
              stats.followBackRate.followed++;
              termFollows[term] = (termFollows[term] || 0) + 1;
              // Term follow-back tracking
              if (!stats.termFollowBackRate) stats.termFollowBackRate = {};
              if (!stats.termFollowBackRate[term]) stats.termFollowBackRate[term] = { followed: 0, followedBack: 0 };
              stats.termFollowBackRate[term].followed++;
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
          const replyText = await generateReply(postText, post.author?.handle, currentPersona, token, targetPost.uri);
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
                persona: currentPersona,
              });
              // Keep only last 50 sent replies
              if (stats.sentReplies.length > 50) stats.sentReplies.shift();
              stats.replyEngagement.sent++;
              // Track per-persona stats
              if (!stats.replyPersonaStats) stats.replyPersonaStats = {};
              if (!stats.replyPersonaStats[currentPersona]) stats.replyPersonaStats[currentPersona] = { sent: 0, gotLiked: 0, gotReplied: 0 };
              stats.replyPersonaStats[currentPersona].sent++;
              console.log(`   💬 Replied to @${post.author?.handle} [${currentPersona}]: "${replyText}"`);
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
        stats.followedAt[authorDid] = { handle: post.author?.handle, followedBack: false, followedAt: new Date().toISOString(), term };
        stats.followBackRate.followed++;
        termFollows[term] = (termFollows[term] || 0) + 1;
        // Term follow-back tracking
        if (!stats.termFollowBackRate) stats.termFollowBackRate = {};
        if (!stats.termFollowBackRate[term]) stats.termFollowBackRate[term] = { followed: 0, followedBack: 0 };
        stats.termFollowBackRate[term].followed++;
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
  const trimmedThisRun = await autoTrimDeadTerms(stats);
  await cycleInNextCandidate(trimmedThisRun ? trimmedThisRun.length : 0);
  await discoverNewTerms(token, stats);

  const totalActions = totalLikes + totalFollows + totalReplies;

  // Spike detection — halt if actions are abnormally high
  if (checkForSpike(stats, totalActions)) {
    saveStats(stats);
    await saveStatsToGist(stats);
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
  await saveStatsToGist(stats);

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
