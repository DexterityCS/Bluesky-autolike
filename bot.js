const https = require("https");
const http  = require("http");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────
const BLUESKY_HANDLE     = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD   = process.env.BLUESKY_PASSWORD;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ACTIONS_PER_RUN    = parseInt(process.env.ACTIONS_PER_RUN || "25");
const FOLLOW_BACK_DAYS   = 7;

const MIN_FOLLOWERS       = 25;
const MIN_ACCOUNT_DAYS    = 30;
const MAX_POST_AGE_DAYS   = 7;
const MAX_FOLLOW_RATIO    = 3;    // tightened from 10 — was letting mass-follow/churn accounts through
const MAX_FOLLOWING_COUNT = 1500; // hard cap — flags mass-followers even if their ratio looks OK

const DAILY_ACTION_CAP   = 100; // lowered from 200 — high volume can look bot-like to Bluesky's spam detection
const HOURLY_LIMIT       = 30;  // lowered from 60

const REPLY_FREQUENCY      = 3;
const REPLY_COOLDOWN_DAYS  = 7;
const MIN_REPLY_TEXT_LEN   = 30;
const DISCORD_WEBHOOK_URL  = process.env.DISCORD_WEBHOOK_URL || null;
const GIST_TOKEN           = process.env.GIST_TOKEN || null;
const GIST_ID              = process.env.GIST_ID || "9e21611814d0c5b84c94a9bc15ed21fa";

const FOLLOWER_MILESTONES  = [100, 250, 500, 1000, 2500, 5000, 10000];
const WEEKLY_SUMMARY_DAY   = 1;
const SPIKE_THRESHOLD      = 3;
const BLOCK_LIST_PATH      = "data/blocklist.json";

const SCORE_LIKE_WEIGHT    = 1;
const SCORE_REPLY_WEIGHT   = 3;
const SCORE_REPOST_WEIGHT  = 2;
const MIN_ENGAGEMENT_SCORE = 0;
const MUTUAL_NETWORK_BOOST = true;
const REPLY_PERSONAS = ["hype", "analytical", "friendly"];
const PAUSE_PATH = "data/pause.json";

const DEFAULT_TERMS = [
  "#CS2", "CS2", "counter-strike",
  "#ApexLegends", "apex legends",
  "#Overwatch",
  "#Minecraft", "minecraft",
  "#Terraria", "terraria",
];

// ── Filter fallbacks — minimal safety net if Gist unavailable ──
const NSFW_TAGS     = ["nsfw", "18+", "onlyfans", "porn", "xxx", "lewd", "hentai"];
const POLITICAL_TAGS = ["maga", "trump", "biden", "election", "lgbtq", "transgender"];
const NSFW_EMOJI_LIST = ["🔞", "💦", "🍆", "🍑", "👅", "💋"];

const TRIMMED_TERMS_PATH    = "data/trimmed_terms.json";
const CANDIDATE_TERMS_PATH  = "data/candidate_terms.json";
const GRADUATED_TERMS_PATH  = "data/graduated_terms.json";

const MAX_CANDIDATE_DISCOVERY  = 5;
const MAX_ACTIVE_SEARCH_TERMS  = 15;
const GRADUATE_MIN_RUNS        = 15;
const GRADUATE_MIN_AVG         = 1.0;

const PROTECTED_TERMS = new Set([
  "#CS2", "CS2", "counter-strike",
  "#ApexLegends", "apex legends",
  "#Overwatch",
  "#Minecraft", "minecraft",
  "#Terraria", "terraria",
]);

let _blockListStore    = null;
let _trimmedStore      = null;
let _candidateStore    = null;
let _graduatedStore    = null;
let _filtersStore      = null;

function loadTrimmedTerms() {
  if (_trimmedStore) return new Set(_trimmedStore);
  if (!fs.existsSync(TRIMMED_TERMS_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(TRIMMED_TERMS_PATH, "utf8"))); }
  catch { return new Set(); }
}

function saveTrimmedTerms(trimmedSet) {
  _trimmedStore = [...trimmedSet];
  fs.writeFileSync(TRIMMED_TERMS_PATH, JSON.stringify(_trimmedStore, null, 2));
}

function loadCandidateTerms() {
  if (_candidateStore) return _candidateStore;
  if (!fs.existsSync(CANDIDATE_TERMS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(CANDIDATE_TERMS_PATH, "utf8")); }
  catch { return []; }
}

function saveCandidateTerms(candidates) {
  _candidateStore = candidates;
  fs.writeFileSync(CANDIDATE_TERMS_PATH, JSON.stringify(candidates, null, 2));
}

function loadGraduatedTerms() {
  if (_graduatedStore) return new Set(_graduatedStore);
  if (!fs.existsSync(GRADUATED_TERMS_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(GRADUATED_TERMS_PATH, "utf8"))); }
  catch { return new Set(); }
}

function initFromGist(gist) {
  if (!gist) return;
  const gistBlockList  = getGistFile(gist, "blocklist.json");
  const gistTrimmed    = getGistFile(gist, "trimmed_terms.json");
  const gistCandidates = getGistFile(gist, "candidate_terms.json");
  const gistGraduated  = getGistFile(gist, "graduated_terms.json");
  const gistFilters    = getGistFile(gist, "filters.json");
  if (gistBlockList)  _blockListStore  = gistBlockList;
  if (gistTrimmed)    _trimmedStore    = gistTrimmed;
  if (gistCandidates) _candidateStore  = gistCandidates;
  if (gistGraduated)  _graduatedStore  = gistGraduated;
  if (gistFilters)    _filtersStore    = gistFilters;
  if (gistBlockList || gistTrimmed || gistCandidates || gistGraduated || gistFilters) {
    console.log("📥 Loaded data from Gist");
  }
  if (gistFilters) {
    console.log("🔒 Filters loaded from Gist");
  }
}

const TRIMMED_TERMS   = loadTrimmedTerms();
const CANDIDATE_TERMS = loadCandidateTerms();
const GRADUATED_TERMS = loadGraduatedTerms();
const ACTIVE_CANDIDATES  = CANDIDATE_TERMS.filter(c => c.status === "active").map(c => c.term);

const SEARCH_TERMS  = [
  ...(process.env.SEARCH_TERMS
    ? process.env.SEARCH_TERMS.split(",").map(s => s.trim()).filter(Boolean)
    : DEFAULT_TERMS),
  ...ACTIVE_CANDIDATES,
  ...[...GRADUATED_TERMS],
].filter(t => !TRIMMED_TERMS.has(t));

if (TRIMMED_TERMS.size > 0) {
  console.log(`✂️  Skipping ${TRIMMED_TERMS.size} auto-trimmed term(s): ${[...TRIMMED_TERMS].join(", ")}`);
}
if (ACTIVE_CANDIDATES.length > 0) {
  console.log(`🧪 Testing ${ACTIVE_CANDIDATES.length} candidate term(s): ${ACTIVE_CANDIDATES.join(", ")}`);
}
if (GRADUATED_TERMS.size > 0) {
  console.log(`🎓 Graduated terms active: ${[...GRADUATED_TERMS].join(", ")}`);
}

const POSTS_PER_SEARCH = 100;
const STATS_PATH       = "data/stats.json";

if (!fs.existsSync("data")) fs.mkdirSync("data");

// ── Stats ─────────────────────────────────────────────────
function loadStats(gist = null) {
  const defaults = {
    totalLikes: 0, totalFollows: 0, totalUnfollows: 0, totalReplies: 0,
    runs: 0, lastRun: null, lastLikedAt: {}, lastRepliedAt: {}, dailyActions: {},
    hourlyActions: [], followedAt: {},
    followBackRate: { followed: 0, followedBack: 0 },
    followerHistory: [],
    termPerformance: {},
    filteredCount: 0,
    filterHitLog: [],
    replyEngagement: { sent: 0, gotLiked: 0, gotReplied: 0 },
    replyPersonaStats: {},
    replyPersonaGameStats: {},
    milestonesCelebrated: [],
    lastWeeklySummary: null,
    lastMonthlySummary: null,
    runHistory: [],
    actionsHistory: [],
    termFollowBackRate: {},
    lastFollowBackAlert: null,
  };
  if (gist) {
    const gistStats = getGistFile(gist, "stats.json");
    if (gistStats) return { ...defaults, ...gistStats };
  }
  if (!fs.existsSync(STATS_PATH)) return defaults;
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(STATS_PATH, "utf8")) }; }
  catch { return defaults; }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
}

async function saveStatsToGist(stats) {
  if (!GIST_TOKEN || !GIST_ID) return;
  await syncAllToGist(stats);
}

// ── Gist I/O ──────────────────────────────────────────────────
let _gistCache = null;

async function fetchGist() {
  if (!GIST_TOKEN || !GIST_ID) return null;
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
    if (res.status !== 200) return null;
    _gistCache = res.body;
    return res.body;
  } catch { return null; }
}

function getGistFile(gist, filename) {
  if (!gist?.files?.[filename]?.content) return null;
  try { return JSON.parse(gist.files[filename].content); }
  catch { return null; }
}

async function syncAllToGist(stats) {
  if (!GIST_TOKEN || !GIST_ID) return;
  try {
    const blockList  = _blockListStore  || [...loadBlockList()];
    const trimmed    = _trimmedStore    || [...loadTrimmedTerms()];
    const candidates = _candidateStore  || loadCandidateTerms();
    const graduated  = _graduatedStore  || [...loadGraduatedTerms()];

    const files = {
      "stats.json":           { content: JSON.stringify(stats,       null, 2) },
      "blocklist.json":       { content: JSON.stringify(blockList,   null, 2) },
      "trimmed_terms.json":   { content: JSON.stringify(trimmed,     null, 2) },
      "candidate_terms.json": { content: JSON.stringify(candidates,  null, 2) },
      "graduated_terms.json": { content: JSON.stringify(graduated,   null, 2) },
    };

    // Only sync filters back if we loaded them — don't overwrite with null
    if (_filtersStore) {
      files["filters.json"] = { content: JSON.stringify(_filtersStore, null, 2) };
    }

    const body = JSON.stringify({ files });
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
      console.log("📡 All data synced to Gist");
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

// ── Safe truncation — never cuts a multi-byte character (emoji, CJK, etc.) in half ──
function safeTruncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || "";
  let cut = str.slice(0, maxLen);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

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

  // The enumerated list above can under-report — Bluesky's getFollowers list
  // tends to omit accounts that are deactivated, taken down, or otherwise
  // unresolvable, even though they still count as a follow on the graph.
  // profile.followersCount is the platform's real running total, so use that
  // for the reported count. The enumerated Set is still needed separately
  // for membership checks (e.g. "did this account follow me back") since
  // there's no way to check membership for accounts the list API won't return.
  let realCount = followers.size;
  const profile = await getProfile(did, token);
  if (profile && typeof profile.followersCount === "number") {
    realCount = profile.followersCount;
    if (realCount !== followers.size) {
      console.log(`ℹ️  Follower list enumerated ${followers.size}, but profile reports ${realCount} — using profile count (likely deactivated/unresolvable accounts in the difference)`);
    }
  }

  console.log(`👥 You have ${realCount} followers`);
  return { followers, count: realCount };
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

async function getLatestPost(actorDid, token) {
  const res = await apiRequest(
    `app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actorDid)}&limit=1&filter=posts_no_replies`,
    "GET", null, token
  );
  if (res.status !== 200 || !res.body.feed?.length) return null;
  return res.body.feed[0].post;
}

// ── Filter accessors — loaded from Gist, fall back to hardcoded ──
function getFilters() {
  return _filtersStore || null;
}

function getNsfwTags()      { return getFilters()?.nsfw_exact      || NSFW_TAGS; }
function getPoliticalTags() { return getFilters()?.political_exact || POLITICAL_TAGS; }
function getNsfwEmoji()     { return getFilters()?.nsfw_emoji      || NSFW_EMOJI_LIST; }
function getBlockedLabels() { return getFilters()?.blocked_labels  || ["porn","sexual","nudity","graphic-media","adult-only","nsfw"]; }

// ── Leet speak normalizer ─────────────────────────────────
function normalizeLeet(text) {
  const map = getFilters()?.leet_map || {
    "0":"o","1":"i","3":"e","4":"a","5":"s","6":"g","7":"t","8":"b","@":"a","$":"s","!":"i","+":"t"
  };
  return text.split("").map(c => map[c] || c).join("");
}

// ── Smart filter check — stems + exact + leet ─────────────
function containsFilteredTag(text, tagList) {
  const lower      = text.toLowerCase();
  const normalized = normalizeLeet(lower);
  return tagList.some(tag => lower.includes(tag) || normalized.includes(tag));
}

function containsStem(text, stems) {
  const lower      = text.toLowerCase();
  const normalized = normalizeLeet(lower);
  return stems.some(stem => lower.includes(stem) || normalized.includes(stem));
}

function findFilteredTag(text, tagList) {
  const lower      = text.toLowerCase();
  const normalized = normalizeLeet(lower);
  return tagList.find(tag => lower.includes(tag) || normalized.includes(tag)) || null;
}

function isFilteredContent(text) {
  const filters = getFilters();
  if (!filters) {
    // Fall back to old behavior
    return containsFilteredTag(text, NSFW_TAGS) || containsFilteredTag(text, POLITICAL_TAGS);
  }
  return (
    containsStem(text, filters.nsfw_stems || []) ||
    containsFilteredTag(text, filters.nsfw_exact || []) ||
    containsStem(text, filters.political_stems || []) ||
    containsFilteredTag(text, filters.political_exact || [])
  );
}

function isFilteredProfile(profileText) {
  return isFilteredContent(profileText);
}

function recordFilterHit(stats, handle, reason, keyword = null) {
  if (!stats.filterHitLog) stats.filterHitLog = [];
  stats.filterHitLog.unshift({ handle, reason, keyword, at: new Date().toISOString() });
  if (stats.filterHitLog.length > 100) stats.filterHitLog.pop();
}

// ── Gaming relevance check ────────────────────────────────
const GAMING_TERMS = [
  "cs2", "counter-strike", "counterstrike", "csgo", "premier", "faceit",
  "awp", "ak47", "m4a1", "valorant", "pistol round", "eco", "clutch",
  "smoke", "flash", "molotov", "defuse", "plant", "ct side", "t side",
  "apex legends", "apex", "wraith", "pathfinder", "bloodhound", "respawn",
  "battle royale", "ring", "legends",
  "rainbow six", "r6", "siege", "operator", "roam",
  "overwatch", "ow2", "blizzard", "tank", "support", "dps", "healer",
  "minecraft", "creeper", "steve", "enderman", "nether", "redstone",
  "terraria", "boss", "hardmode",
  "gaming", "gamer", "fps", "streamer", "twitch", "stream", "esports",
  "ranked", "matchmaking", "kill", "headshot", "frag", "loadout",
  "crosshair", "sensitivity", "ping", "lag", "win rate", "kd ratio",
  "game", "gameplay", "highlights", "clip", "play of the game",
];

// ── Context exclusion — terms that indicate CS2 ≠ Counter-Strike ──
const CITIES_SKYLINES_TERMS = [
  "cities skylines", "city skylines", "zoning", "traffic flow", "city planning",
  "road layout", "urban planning", "city builder", "mayor", "downtown",
  "residential zone", "commercial zone", "industrial zone", "public transit",
  "chirper", "paradox", "colossal order", "tile", "intersection",
  "roundabout", "highway ramp", "city sprawl", "mass transit",
];

// Other common uses of CS1/CS2/CS3 as sequel numbering
const NON_CS_SEQUEL_PATTERNS = [
  /\bcs1\b.*\bcs2\b/i,   // "CS1 and CS2" — sequel context
  /\bcs2\b.*\bcs3\b/i,   // "CS2 and CS3"
  /\bcs1\b.*\bcs3\b/i,   // "CS1 through CS3"
];

function isCitiesSkylines(text) {
  const lower = text.toLowerCase();
  if (CITIES_SKYLINES_TERMS.some(term => lower.includes(term))) return true;
  if (NON_CS_SEQUEL_PATTERNS.some(pattern => pattern.test(text))) return true;
  return false;
}

function isGamingRelevant(post) {
  const text = (post.record?.text || "").toLowerCase();

  // Exclude Cities Skylines 2 posts that use "CS2" — wrong game
  if (isCitiesSkylines(text)) return false;

  if (GAMING_TERMS.some(term => text.includes(term))) return true;
  const tags = post.record?.tags || [];
  if (tags.some(t => GAMING_TERMS.some(term => t.toLowerCase().includes(term)))) return true;
  if (text.trim().length < 15) return false;
  return false;
}

async function isGamingRelevantAI(postText) {
  if (!ANTHROPIC_API_KEY) return true;
  const text = postText.toLowerCase();

  // Don't short-circuit on cs2 alone — could be Cities Skylines 2
  // Only skip AI check if we have unambiguous gaming terms
  const unambiguousTerms = GAMING_TERMS.filter(t => t !== "cs2" && t !== "#cs2");
  const hasObviousTerm = unambiguousTerms.some(term => text.includes(term));

  // Also skip if Cities Skylines context detected
  if (isCitiesSkylines(text)) return false;

  if (hasObviousTerm) return true;

  try {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: "You are a content classifier. Answer only YES or NO.",
      messages: [{
        role: "user",
        content: `Is this post about gaming, esports, streaming, or game-related content? Answer only YES or NO.\n\nPost: "${safeTruncate(postText, 300)}"`
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
    if (res.status !== 200) return true;
    const answer = res.body.content?.[0]?.text?.trim().toUpperCase();
    return answer === "YES";
  } catch {
    return true;
  }
}

async function passesQualityFilters(authorDid, post, token, stats) {
  const postDate = new Date(post.indexedAt || post.record?.createdAt || 0);
  const postAgeDays = (Date.now() - postDate) / 86400000;
  if (postAgeDays > MAX_POST_AGE_DAYS) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    return { pass: false, reason: `post too old (${Math.floor(postAgeDays)}d)` };
  }

  const profile = await getProfile(authorDid, token);
  if (!profile) return { pass: true, reason: "no profile" };

  const followerCount  = profile.followersCount || 0;
  const followingCount = profile.followsCount   || 0;
  if (followerCount < MIN_FOLLOWERS) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    return { pass: false, reason: `too few followers (${followerCount})` };
  }

  if (followerCount > 0 && followingCount / followerCount > MAX_FOLLOW_RATIO) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, `spam ratio (${followingCount} following / ${followerCount} followers)`);
    return { pass: false, reason: `spam ratio (${followingCount} following / ${followerCount} followers)` };
  }

  if (followingCount > MAX_FOLLOWING_COUNT) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, `mass-follower (${followingCount} following, over ${MAX_FOLLOWING_COUNT} cap)`);
    return { pass: false, reason: `mass-follower (${followingCount} following)` };
  }

  if (profile.createdAt) {
    const ageDays = (Date.now() - new Date(profile.createdAt)) / 86400000;
    if (ageDays < MIN_ACCOUNT_DAYS) {
      stats.filteredCount = (stats.filteredCount || 0) + 1;
      return { pass: false, reason: `account too new (${Math.floor(ageDays)}d)` };
    }
  }

  const bio         = (profile.description || "").toLowerCase();
  const displayName = (profile.displayName  || "").toLowerCase();
  const handle      = (profile.handle       || "").toLowerCase();
  const profileFull = [bio, displayName, handle].join(" ");

  const profileLabels = profile.labels || [];
  if (profileLabels.some(l => getBlockedLabels().includes(l.val))) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, "blocked account label");
    return { pass: false, reason: `blocked account label` };
  }

  if (isFilteredProfile(profileFull)) {
    const filters = getFilters();
    const hitNsfw = filters
      ? (containsStem(profileFull, filters.nsfw_stems || []) || containsFilteredTag(profileFull, filters.nsfw_exact || []))
      : containsFilteredTag(profileFull, NSFW_TAGS);
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, hitNsfw ? "NSFW content in profile" : "political content in profile");
    return { pass: false, reason: hitNsfw ? "NSFW profile bio/name" : "political profile bio/name" };
  }

  const rawBio = profile.description || "";
  if (getNsfwEmoji().some(e => rawBio.includes(e))) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, "NSFW emoji in profile");
    return { pass: false, reason: `NSFW emoji in profile` };
  }

  if (bio.length > 10 && ANTHROPIC_API_KEY) {
    try {
      const langCheck = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system: "You are a language detector. Answer only YES or NO.",
        messages: [{
          role: "user",
          content: `Is this text written in English? Answer only YES or NO.\n\n"${safeTruncate(bio, 300)}"`
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
    } catch {}
  } else if (bio.length > 10 && !isEnglishText(bio)) {
    stats.filteredCount = (stats.filteredCount || 0) + 1;
    autoBlock(authorDid, "non-English profile bio");
    return { pass: false, reason: `non-English profile bio` };
  }

  return { pass: true, reason: "ok" };
}

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

    let current = thread;
    while (current?.parent) {
      current = current.parent;
    }

    function collectPosts(node) {
      if (!node?.post?.record?.text) return;
      posts.push({
        handle: node.post.author?.handle || "unknown",
        text:   node.post.record.text,
      });
      if (node.replies?.length) {
        collectPosts(node.replies[0]);
      }
    }

    collectPosts(current);
    return posts.length > 1 ? posts : null;
  } catch {
    return null;
  }
}

async function generateReply(postText, authorHandle, persona = "friendly", token = null, postUri = null) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const langCheck = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: "You are a language detector. Answer only YES or NO.",
      messages: [{
        role: "user",
        content: `Is this text written in English? Answer only YES or NO.\n\n"${safeTruncate(postText, 300)}"`
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
  } catch {}

  if (isFilteredContent(postText)) {
    console.log(`   🚫 Skipped reply — filtered content (NSFW/political)`);
    return null;
  }

  // Final AI guard — explicitly verify post is gaming before replying
  if (ANTHROPIC_API_KEY) {
    try {
      const guardCheck = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system: "You are a content classifier. Answer only YES or NO.",
        messages: [{
          role: "user",
          content: `Is this post specifically about Counter-Strike 2 (the FPS game by Valve), esports, or game streaming? Answer only YES or NO.

Important notes:
- CS2 can mean Counter-Strike 2 OR Cities Skylines 2 — only YES if it's clearly Counter-Strike
- CS1, CS2, CS3 used as sequel numbers (like book series, album names, seasons) are NOT Counter-Strike
- If the post mentions CS2 alongside CS1 or CS3, it is almost certainly NOT Counter-Strike

Post: "${safeTruncate(postText, 300)}"`
        }]
      });
      const guardRes = await request({
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      }, guardCheck);
      const isGaming = guardRes.body.content?.[0]?.text?.trim().toUpperCase() === "YES";
      if (!isGaming) {
        console.log(`   🎯 Skipped reply — AI confirmed post is not gaming content`);
        return null;
      }
    } catch {}
  }

  const personaInstructions = {
    hype:       "Be enthusiastic and hyped up. Use energy but not cringe. Sound genuinely excited about the topic.",
    analytical: "Be insightful and tactical. Offer a brief strategic take or observation about what they said.",
    friendly:   "Be warm, conversational, and genuine. Sound like a real fellow gamer.",
  };

  const instruction = personaInstructions[persona] || personaInstructions.friendly;

  const text = postText.toLowerCase();
  let gameContext = "gaming";
  if (text.includes("cs2") || text.includes("counter-strike") || text.includes("counterstrike")) gameContext = "CS2";
  else if (text.includes("apex") || text.includes("apex legends")) gameContext = "Apex Legends";
  else if (text.includes("rainbow six") || text.includes("r6") || text.includes("siege")) gameContext = "Rainbow Six Siege";
  else if (text.includes("overwatch") || text.includes("ow2")) gameContext = "Overwatch";
  else if (text.includes("minecraft")) gameContext = "Minecraft";
  else if (text.includes("terraria")) gameContext = "Terraria";

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
  return { text: res.body.content[0].text.trim(), gameContext };
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
  console.log(`\n🧹 Checking for non-followers (${FOLLOW_BACK_DAYS}-day follow-back window)...`);

  for (const [targetDid, { rkey, handle }] of following.entries()) {
    if (followers.has(targetDid)) continue;
    if (!rkey) continue;

    if (whitelist.has(handle)) {
      console.log(`   🛡️  Skipped @${handle} — whitelisted`);
      continue;
    }

    const followedAt = stats.followedAt?.[targetDid]?.followedAt
      ? new Date(stats.followedAt[targetDid].followedAt)
      : null;

    if (followedAt && followedAt > followBackCutoff) {
      console.log(`   ⏳ @${handle} — followed ${Math.floor((Date.now() - followedAt) / 86400000)}d ago, waiting ${FOLLOW_BACK_DAYS - Math.floor((Date.now() - followedAt) / 86400000)}d more`);
      continue;
    }

    const ok = await unfollowAccount(did, rkey, token);
    if (ok) {
      totalUnfollows++;
      console.log(`   🗑️  Unfollowed @${handle} (not followed back in ${FOLLOW_BACK_DAYS}+ days)`);
      following.delete(targetDid);
      // ── Decrement followBackRate.followed when unfollowing ──
      if (stats.followedAt?.[targetDid]) {
        if (!stats.followedAt[targetDid].followedBack) {
          // Only decrement if they never followed back — already-followed-back accounts
          // stay in followedBack count since they're real followers
          stats.followBackRate.followed = Math.max(0, (stats.followBackRate.followed || 0) - 1);
        }
        delete stats.followedAt[targetDid];
      }
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
function recalculateFollowBackRate(stats, following) {
  let followed   = 0;
  let followedBack = 0;
  for (const [did, info] of Object.entries(stats.followedAt || {})) {
    if (!following.has(did)) continue;
    followed++;
    if (info.followedBack) followedBack++;
  }
  stats.followBackRate = { followed, followedBack };
  console.log(`📊 Follow-back rate recalculated: ${followed} currently followed, ${followedBack} followed back`);
}

async function updateFollowBackRate(stats, followers, following) {
  if (!stats.followedAt)          stats.followedAt          = {};
  if (!stats.termFollowBackRate)  stats.termFollowBackRate   = {};

  let newFollowBacks = 0;
  const newFollowBackDetails = [];

  for (const [followedDid, info] of Object.entries(stats.followedAt)) {
    if (info.followedBack) continue;
    if (followers.has(followedDid)) {
      stats.followedAt[followedDid].followedBack = true;
      newFollowBacks++;
      newFollowBackDetails.push({
        handle: info.handle || followedDid,
        term:   info.term   || "unknown",
        followedAt: info.followedAt,
      });
      const term = info.term;
      if (term && stats.termFollowBackRate[term]) {
        stats.termFollowBackRate[term].followedBack = (stats.termFollowBackRate[term].followedBack || 0) + 1;
        if (info.followedAt) {
          const daysToFollowBack = (Date.now() - new Date(info.followedAt)) / 86400000;
          const tfbr = stats.termFollowBackRate[term];
          if (!tfbr.totalDaysToFollowBack) tfbr.totalDaysToFollowBack = 0;
          if (!tfbr.followBackCount) tfbr.followBackCount = 0;
          tfbr.totalDaysToFollowBack += daysToFollowBack;
          tfbr.followBackCount++;
          tfbr.avgDaysToFollowBack = tfbr.totalDaysToFollowBack / tfbr.followBackCount;
        }
      }
    }
  }

  recalculateFollowBackRate(stats, following);

  const rate = stats.followBackRate.followed > 0
    ? ((stats.followBackRate.followedBack / stats.followBackRate.followed) * 100).toFixed(1)
    : "0.0";
  console.log(`📈 Follow-back rate: ${rate}% (${stats.followBackRate.followedBack}/${stats.followBackRate.followed})`);

  const termRates = Object.entries(stats.termFollowBackRate)
    .filter(([, d]) => d.followed > 0)
    .map(([term, d]) => ({ term, rate: ((d.followedBack || 0) / d.followed * 100).toFixed(1), followed: d.followed }))
    .sort((a, b) => parseFloat(b.rate) - parseFloat(a.rate))
    .slice(0, 3);
  if (termRates.length > 0) {
    console.log(`📊 Top term follow-back rates: ${termRates.map(t => `"${t.term}" ${t.rate}% (${t.followed})`).join(", ")}`);
  }

  if (newFollowBackDetails.length > 0 && DISCORD_WEBHOOK_URL) {
    console.log(`🎉 ${newFollowBackDetails.length} new follow-back(s) detected`);
    try {
      const url = new URL(DISCORD_WEBHOOK_URL);
      const body = JSON.stringify({
        embeds: [{
          title: "🎉 New Follow-Backs!",
          color: 0x00ff88,
          description: newFollowBackDetails.map(f => {
            const daysAgo = f.followedAt
              ? Math.floor((Date.now() - new Date(f.followedAt)) / 86400000)
              : null;
            const timing = daysAgo !== null ? ` (followed ${daysAgo}d ago)` : "";
            return `**@${f.handle}**${timing} — found via \`${f.term}\``;
          }).join("\n"),
          footer: { text: `${rate}% overall follow-back rate • ${stats.followBackRate.followedBack}/${stats.followBackRate.followed} currently following` },
        }]
      });
      await request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, body);
      console.log("📨 Follow-back notification posted to Discord");
    } catch (e) {
      console.warn(`Discord follow-back notification failed: ${e.message}`);
    }
  }

  const FOLLOW_BACK_ALERT_THRESHOLD = 2.0;
  const numericRate = parseFloat(rate);
  if (
    DISCORD_WEBHOOK_URL &&
    stats.followBackRate.followed >= 50 &&
    numericRate < FOLLOW_BACK_ALERT_THRESHOLD &&
    numericRate > 0
  ) {
    const lastAlertDate = stats.lastFollowBackAlert || null;
    const today = new Date().toISOString().slice(0, 10);
    if (lastAlertDate !== today) {
      stats.lastFollowBackAlert = today;
      try {
        const url = new URL(DISCORD_WEBHOOK_URL);
        const body = JSON.stringify({
          embeds: [{
            title: "⚠️ Follow-Back Rate Alert",
            color: 0xff3d57,
            description: `Follow-back rate has dropped to **${rate}%** — below the ${FOLLOW_BACK_ALERT_THRESHOLD}% threshold.\n\nThis may indicate the bot is following accounts outside the target audience. Consider reviewing active search terms.`,
            fields: [
              { name: "Current Rate",  value: `${rate}%`, inline: true },
              { name: "Threshold",     value: `${FOLLOW_BACK_ALERT_THRESHOLD}%`, inline: true },
              { name: "Total Tracked", value: `${stats.followBackRate.followedBack}/${stats.followBackRate.followed}`, inline: true },
            ],
            footer: { text: `Alert fires once per day when rate is below threshold with 50+ follows tracked` },
          }]
        });
        await request({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }, body);
        console.log(`⚠️  Follow-back rate alert posted to Discord (${rate}%)`);
      } catch (e) {
        console.warn(`Discord follow-back alert failed: ${e.message}`);
      }
    }
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
    last.count = count;
  } else {
    stats.followerHistory.push({ date: today, count });
    if (stats.followerHistory.length > 30) stats.followerHistory.shift();
  }
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
const DEAD_TERM_MIN_RUNS = 15;
const DEAD_TERM_MIN_AVG  = 0.5;

async function autoTrimDeadTerms(stats) {
  if (!stats.termPerformance) return;

  const trimmed = [];

  for (const [term, data] of Object.entries(stats.termPerformance)) {
    if (data.runs < DEAD_TERM_MIN_RUNS) continue;
    if (PROTECTED_TERMS.has(term)) continue;

    const avgEngagement = (data.likes + data.follows) / data.runs;
    if (avgEngagement < DEAD_TERM_MIN_AVG) {
      trimmed.push({ term, avgEngagement: avgEngagement.toFixed(2), runs: data.runs });
      delete stats.termPerformance[term];
    }
  }

  if (trimmed.length > 0) {
    console.log(`\n✂️  Auto-trimmed ${trimmed.length} dead search term(s):`);
    trimmed.forEach(t => console.log(`   - "${t.term}" — ${t.avgEngagement} avg engagement/run over ${t.runs} runs`));

    if (stats.termFollowBackRate) {
      trimmed.forEach(({ term }) => {
        if (stats.termFollowBackRate[term]) delete stats.termFollowBackRate[term];
      });
    }

    const trimmedSet = loadTrimmedTerms();
    trimmed.forEach(({ term }) => trimmedSet.add(term));
    saveTrimmedTerms(trimmedSet);
    console.log(`💾 Saved ${trimmedSet.size} total trimmed term(s) to ${TRIMMED_TERMS_PATH}`);

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
const GAME_SEEDS = [
  { game: "CS2",            seed: "CS2" },
  { game: "Apex Legends",   seed: "apex legends" },
  { game: "Overwatch",      seed: "#Overwatch" },
  { game: "Minecraft",      seed: "minecraft" },
  { game: "Terraria",       seed: "terraria" },
];

const HASHTAG_BLOCKLIST = new Set([
  "art", "music", "politics", "news", "crypto", "nft", "ai", "love",
  "photography", "food", "travel", "fashion", "fitness", "health",
  "memes", "funny", "anime", "manga", "vtuber", "stream", "twitch",
  "twitter", "bluesky", "fediverse", "mastodon",
]);

// ── Graduate high-performing candidate terms ──────────────────
async function graduateCandidateTerms(stats) {
  const candidates = loadCandidateTerms();
  const graduated  = loadGraduatedTerms();
  const newGrads   = [];

  for (const candidate of candidates) {
    if (candidate.status !== "active") continue;

    const perf = stats.termPerformance?.[candidate.term];
    if (!perf || perf.runs < GRADUATE_MIN_RUNS) continue;

    const avg = (perf.likes + perf.follows) / perf.runs;
    if (avg >= GRADUATE_MIN_AVG) {
      candidate.status        = "graduated";
      candidate.graduatedAt   = new Date().toISOString();
      candidate.avgEngagement = avg.toFixed(2);
      graduated.add(candidate.term);
      newGrads.push(candidate);
      console.log(`🎓 Graduated "${candidate.term}" — ${avg.toFixed(2)} avg engagement/run over ${perf.runs} runs`);
    }
  }

  if (newGrads.length > 0) {
    saveCandidateTerms(candidates);
    saveGraduatedTerms(graduated);

    if (DISCORD_WEBHOOK_URL) {
      try {
        const url = new URL(DISCORD_WEBHOOK_URL);
        const body = JSON.stringify({
          embeds: [{
            title: "🎓 Search Terms Graduated!",
            color: 0xffd600,
            description: newGrads.map(c =>
              `**"${c.term}"** — ${c.avgEngagement} avg engagement/run over ${stats.termPerformance[c.term].runs} runs (from ${c.sourceGame})`
            ).join("\n"),
            footer: { text: `These terms are now permanently active alongside DEFAULT_TERMS` },
          }]
        });
        await request({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }, body);
        console.log("📨 Discord graduation notification posted");
      } catch (e) {
        console.warn(`Discord graduation notification failed: ${e.message}`);
      }
    }
  }

  return newGrads;
}

async function discoverNewTerms(token, stats) {
  const candidates = loadCandidateTerms();
  const existingTerms = new Set([
    ...SEARCH_TERMS,
    ...candidates.map(c => c.term),
    ...[...loadTrimmedTerms()],
  ]);

  const discovered = [];
  const seed = GAME_SEEDS[Math.floor(Math.random() * GAME_SEEDS.length)];
  console.log(`\n🔍 Discovering new terms via "${seed.seed}" (${seed.game})...`);

  try {
    const posts = await searchPosts(seed.seed, token);
    const hashtagCounts = {};

    for (const post of posts) {
      const tags = (post.record?.text || "").match(/#\w+/g) || [];

      for (const tag of tags) {
        const clean = tag.toLowerCase();
        if (existingTerms.has(clean)) continue;
        if (existingTerms.has(tag)) continue;
        if (clean.length < 4) continue;
        if (HASHTAG_BLOCKLIST.has(clean.slice(1))) continue;

        const tagWord = clean.slice(1);
        const isGamingRelated = GAMING_TERMS.some(t => tagWord.includes(t) || t.includes(tagWord)) ||
          ["cs2", "apex", "overwatch", "minecraft", "terraria", "valorant", "gaming",
           "gamer", "fps", "esport", "streamer", "siege", "fortnite", "league",
           "rocket", "halo", "cod", "battlefield", "steam", "indie"].some(g => tagWord.includes(g));

        if (!isGamingRelated) continue;
        if (isFilteredContent(clean)) continue;

        hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
      }
    }

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

function isOriginalPost(post) {
  if (post.reason?.$type === "app.bsky.feed.defs#reasonRepost") return false;
  if (post.record?.embed?.$type === "app.bsky.embed.record") return false;
  return true;
}

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
        const pgKey = persona && reply.gameContext ? `${persona}/${reply.gameContext}` : null;
        if ((post.likeCount || 0) > 0) {
          newLikes++;
          stats.replyEngagement.gotLiked++;
          if (persona && stats.replyPersonaStats[persona]) stats.replyPersonaStats[persona].gotLiked = (stats.replyPersonaStats[persona].gotLiked || 0) + 1;
          if (pgKey && stats.replyPersonaGameStats?.[pgKey]) stats.replyPersonaGameStats[pgKey].gotLiked = (stats.replyPersonaGameStats[pgKey].gotLiked || 0) + 1;
        }
        if ((post.replyCount || 0) > 0) {
          newReplies++;
          stats.replyEngagement.gotReplied++;
          if (persona && stats.replyPersonaStats[persona]) stats.replyPersonaStats[persona].gotReplied = (stats.replyPersonaStats[persona].gotReplied || 0) + 1;
          if (pgKey && stats.replyPersonaGameStats?.[pgKey]) stats.replyPersonaGameStats[pgKey].gotReplied = (stats.replyPersonaGameStats[pgKey].gotReplied || 0) + 1;
        }
        reply.checkedEngagement = true;
      }
    } catch {}
    await sleep(200);
  }

  if (newLikes + newReplies > 0) {
    console.log(`💬 Reply engagement: ${newLikes} replies got liked, ${newReplies} got replied to`);
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

  if (labels.some(l => getBlockedLabels().includes(l.val))) return true;
  if (isFilteredContent(text)) return true;
  if (tags.some(t => isFilteredContent(t))) return true;

  return false;
}

function isPaused() {
  if (!fs.existsSync(PAUSE_PATH)) return false;
  try { return JSON.parse(fs.readFileSync(PAUSE_PATH, "utf8")).paused === true; }
  catch { return false; }
}

function scorePost(post) {
  const likes    = post.likeCount    || 0;
  const replies  = post.replyCount   || 0;
  const reposts  = post.repostCount  || 0;
  return (likes * SCORE_LIKE_WEIGHT) + (replies * SCORE_REPLY_WEIGHT) + (reposts * SCORE_REPOST_WEIGHT);
}

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

function shouldRunUnfollows(stats) {
  const today = new Date().toISOString().slice(0, 10);
  if (stats.lastUnfollowDate === today) return false;
  return true;
}

function getReplyPersona(stats) {
  const idx = (stats.totalReplies || 0) % REPLY_PERSONAS.length;
  return REPLY_PERSONAS[idx];
}

const WHITELIST_PATH = "data/whitelist.json";

function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"))); }
  catch { return new Set(); }
}

function loadBlockList() {
  if (_blockListStore) return new Set(_blockListStore);
  if (!fs.existsSync(BLOCK_LIST_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(BLOCK_LIST_PATH, "utf8"))); }
  catch { return new Set(); }
}

function saveBlockList(blockList) {
  _blockListStore = [...blockList];
  fs.writeFileSync(BLOCK_LIST_PATH, JSON.stringify(_blockListStore, null, 2));
}

function autoBlock(did, reason, stats = null, handle = null, following = null, myDid = null, token = null, blockList = null) {
  const list = loadBlockList();
  if (!list.has(did)) {
    list.add(did);
    saveBlockList(list);
    if (blockList) blockList.add(did);
    console.log(`   🚫 Auto-blocked ${handle || did} — ${reason}`);
    if (stats) recordFilterHit(stats, handle || did, reason);
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

function checkForSpike(stats, actionsThisRun) {
  const history = stats.actionsHistory || [];
  if (history.length < 3) return false;

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

function recordRunHistory(stats, entry) {
  if (!stats.runHistory) stats.runHistory = [];
  stats.runHistory.unshift(entry);
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

async function checkAndPostWeeklySummary(stats, token, did, followerCount) {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCDay() !== WEEKLY_SUMMARY_DAY) return;
  if (stats.lastWeeklySummary === today) return;

  const history    = stats.followerHistory || [];
  const weekAgo    = history.find(h => { const d = (new Date(today) - new Date(h.date)) / 86400000; return d >= 6 && d <= 8; });
  const weeklyGain = weekAgo ? followerCount - weekAgo.count : 0;
  const fbRate     = stats.followBackRate?.followed > 0
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

  if (DISCORD_WEBHOOK_URL) {
    try {
      const topTerms = Object.entries(stats.termPerformance || {})
        .sort((a, b) => (b[1].likes + b[1].follows) - (a[1].likes + a[1].follows))
        .slice(0, 3)
        .map(([term, d]) => {
          const avg = (d.likes + d.follows) / (d.runs || 1);
          return `**"${term}"** — ${avg.toFixed(1)} avg/run (${d.likes}❤️ ${d.follows}➕)`;
        })
        .join("\n") || "No data yet";

      const personaBreakdown = Object.entries(stats.replyPersonaStats || {})
        .filter(([, d]) => d.sent > 0)
        .map(([p, d]) => {
          const likeRate = d.sent > 0 ? ((d.gotLiked || 0) / d.sent * 100).toFixed(0) : "0";
          return `**${p}**: ${likeRate}% liked (${d.gotLiked || 0}/${d.sent} sent)`;
        })
        .join("\n") || "No replies sent yet";

      const growthStr = weeklyGain >= 0 ? `+${weeklyGain}` : `${weeklyGain}`;

      const url = new URL(DISCORD_WEBHOOK_URL);
      const body = JSON.stringify({
        embeds: [{
          title: "📊 Weekly Bot Summary",
          color: 0xffd600,
          fields: [
            { name: "👥 Follower Growth",     value: `${growthStr} this week (${followerCount} total)`, inline: true },
            { name: "📈 Follow-back Rate",    value: `${fbRate}% (${stats.followBackRate?.followedBack || 0}/${stats.followBackRate?.followed || 0} currently following)`, inline: true },
            { name: "❤️ Total Likes Given",   value: String(stats.totalLikes || 0), inline: true },
            { name: "💬 Total Replies Sent",  value: String(stats.totalReplies || 0), inline: true },
            { name: "🔄 Total Runs",          value: String(stats.runs || 0), inline: true },
            { name: "🗑️ Total Unfollows",     value: String(stats.totalUnfollows || 0), inline: true },
            { name: "🏆 Top Search Terms",    value: topTerms, inline: false },
            { name: "🎭 Reply Persona Breakdown", value: personaBreakdown, inline: false },
          ],
          footer: { text: `Week ending ${today} • dexterityCS Bluesky Bot` },
        }]
      });
      await request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, body);
      console.log("📨 Weekly Discord summary posted");
    } catch (e) {
      console.warn(`Discord weekly summary failed: ${e.message}`);
    }
  }
}

// ── Monthly Discord recap ─────────────────────────────────
async function checkAndPostMonthlySummary(stats, followerCount) {
  if (!DISCORD_WEBHOOK_URL) return;

  const now   = new Date();
  const today = now.toISOString().slice(0, 10);

  if (now.getUTCDate() !== 1) return;
  if (stats.lastMonthlySummary === today) return;

  const history  = stats.followerHistory || [];
  const monthAgo = history.find(h => {
    const d = (new Date(today) - new Date(h.date)) / 86400000;
    return d >= 28 && d <= 33;
  });
  const monthlyGain = monthAgo ? followerCount - monthAgo.count : 0;

  const fbRate = stats.followBackRate?.followed > 0
    ? ((stats.followBackRate.followedBack / stats.followBackRate.followed) * 100).toFixed(1)
    : "0";

  const topTerm = Object.entries(stats.termPerformance || {})
    .sort((a, b) => (b[1].likes + b[1].follows) - (a[1].likes + a[1].follows))[0];
  const topTermStr = topTerm
    ? `**"${topTerm[0]}"** — ${((topTerm[1].likes + topTerm[1].follows) / (topTerm[1].runs || 1)).toFixed(1)} avg/run`
    : "No data";

  const topFbTerm = Object.entries(stats.termFollowBackRate || {})
    .filter(([, d]) => d.followed >= 5)
    .map(([term, d]) => ({ term, rate: ((d.followedBack || 0) / d.followed * 100) }))
    .sort((a, b) => b.rate - a.rate)[0];
  const topFbStr = topFbTerm
    ? `**"${topFbTerm.term}"** — ${topFbTerm.rate.toFixed(1)}% follow-back rate`
    : "Not enough data";

  const topPersona = Object.entries(stats.replyPersonaStats || {})
    .filter(([, d]) => d.sent > 0)
    .map(([p, d]) => ({ p, likeRate: (d.gotLiked || 0) / d.sent * 100 }))
    .sort((a, b) => b.likeRate - a.likeRate)[0];
  const topPersonaStr = topPersona
    ? `**${topPersona.p}** — ${topPersona.likeRate.toFixed(0)}% like rate`
    : "No data";

  const growthStr = monthlyGain >= 0 ? `+${monthlyGain}` : `${monthlyGain}`;
  const prevMonth = new Date(now);
  prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
  const prevMonthName = prevMonth.toLocaleString("default", { month: "long", timeZone: "UTC" });

  try {
    const url = new URL(DISCORD_WEBHOOK_URL);
    const body = JSON.stringify({
      embeds: [{
        title: `📅 ${prevMonthName} Monthly Recap`,
        color: 0xffd600,
        fields: [
          { name: "👥 Follower Growth",       value: `${growthStr} this month (${followerCount} total)`, inline: true },
          { name: "📈 Follow-back Rate",      value: `${fbRate}% (${stats.followBackRate?.followedBack || 0}/${stats.followBackRate?.followed || 0} currently following)`, inline: true },
          { name: "❤️ Total Likes Given",     value: String(stats.totalLikes || 0), inline: true },
          { name: "💬 Total Replies Sent",    value: String(stats.totalReplies || 0), inline: true },
          { name: "🔄 Total Runs",            value: String(stats.runs || 0), inline: true },
          { name: "➕ Total Follows Made",    value: String(stats.totalFollows || 0), inline: true },
          { name: "🏆 Best Search Term",      value: topTermStr, inline: false },
          { name: "🎯 Best Follow-back Term", value: topFbStr, inline: false },
          { name: "🎭 Best Reply Persona",    value: topPersonaStr, inline: false },
        ],
        footer: { text: `${prevMonthName} summary • dexterityCS Bluesky Bot` },
      }]
    });
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, body);
    stats.lastMonthlySummary = today;
    console.log(`📅 Monthly Discord recap posted for ${prevMonthName}`);
  } catch (e) {
    console.warn(`Discord monthly recap failed: ${e.message}`);
  }
}

// ── Smarter follow budget weights ────────────────────────────
function computeTermWeights(stats, searchTerms) {
  const weights = {};
  const tfbr  = stats.termFollowBackRate || {};
  const tperf = stats.termPerformance    || {};

  for (const term of searchTerms) {
    const fbData   = tfbr[term]  || {};
    const perfData = tperf[term] || {};

    const fbRate = fbData.followed >= 5
      ? (fbData.followedBack || 0) / fbData.followed
      : 0.5;

    const avgDays = fbData.avgDaysToFollowBack;
    const velocityScore = avgDays != null
      ? Math.max(0, Math.min(1, 1 / (avgDays * 0.5)))
      : 0.5;

    const avgEngagement = perfData.runs > 0
      ? (perfData.likes + perfData.follows) / perfData.runs
      : 0.5;
    const engScore = Math.min(1, avgEngagement / 5);

    const weight = (fbRate * 0.5) + (velocityScore * 0.3) + (engScore * 0.2);
    weights[term] = Math.max(0.1, weight);
  }

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const scale = searchTerms.length / total;
  for (const term of searchTerms) {
    weights[term] = weights[term] * scale;
  }

  const top = Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`🎯 Term weights: ${top.map(([t, w]) => `"${t}" ${w.toFixed(2)}x`).join(", ")}`);

  return weights;
}

async function run() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD env vars");
    process.exit(1);
  }

  await selfTest();

  const gist = await fetchGist();
  initFromGist(gist);

  if (!getFilters()) {
    console.warn("⚠️  filters.json not found in Gist — using hardcoded fallbacks. Add filters.json to your Gist to enable smart filtering.");
  } else {
    const f = getFilters();
    console.log(`🔒 Smart filters active — ${f.nsfw_stems?.length || 0} NSFW stems, ${f.political_stems?.length || 0} political stems, ${f.nsfw_emoji?.length || 0} emoji`);
  }

  if (isPaused()) {
    console.log("⏸️  Bot is paused — skipping run. Toggle pause off in the dashboard to resume.");
    return;
  }

  const stats = loadStats(gist);
  pruneLastLikedAt(stats);
  pruneLastRepliedAt(stats);

  const dailyUsed = getDailyActionsUsed(stats);
  if (dailyUsed >= DAILY_ACTION_CAP) {
    console.log(`⛔ Daily action cap reached (${dailyUsed}/${DAILY_ACTION_CAP}) — skipping run`);
    return;
  }

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

  const netFollowers = getNetFollowerGain(stats, followerCount);
  if (netFollowers !== 0) console.log(`👥 Net followers since last run: ${netFollowers >= 0 ? "+" : ""}${netFollowers}`);

  await checkReplyEngagement(did, token, stats);
  await checkAndPostMilestones(followerCount, stats, token, did);
  await checkAndPostWeeklySummary(stats, token, did, followerCount);
  await checkAndPostMonthlySummary(stats, followerCount);

  recordFollowerCount(stats, followerCount);
  await updateFollowBackRate(stats, followers, following);

  let totalUnfollows = 0;
  if (shouldRunUnfollows(stats)) {
    totalUnfollows = await runUnfollows(did, token, following, followers, stats);
    stats.lastUnfollowDate = new Date().toISOString().slice(0, 10);
  } else {
    console.log(`⏰ Unfollow check skipped — already ran today (${stats.lastUnfollowDate})`);
  }

  const likeBackCount = await runLikeBackFollowers(did, token, following, followers, stats);

  let totalLikes   = likeBackCount;
  let totalFollows = 0;
  let totalReplies = 0;
  let likesSinceLastReply = 0;

  console.log(`\n🔎 Search terms: ${SEARCH_TERMS.join(", ")}`);

  const latestPostByAuthor = new Map();
  const postTermMap        = new Map();

  for (const term of SEARCH_TERMS) {
    console.log(`\n🔍 Searching "${term}"...`);
    const posts = await searchPosts(term, token);
    console.log(`   Found ${posts.length} posts`);

    for (const post of posts) {
      const authorDid = post.author?.did;
      if (!authorDid || !post.uri || !post.cid) continue;
      if (authorDid === did) continue;
      if (!isOriginalPost(post)) continue;

      const postText = (post.record?.text || "").trim();
      if (postText.length < 5) continue;

      if (isNSFW(post)) {
        const keyword = findFilteredTag(postText, getNsfwTags()) || findFilteredTag(postText, getPoliticalTags());
        console.log(`   🚫 Skipped filtered post (NSFW/political) by @${post.author?.handle}${keyword ? ` [${keyword}]` : ""}`);
        if (authorDid) autoBlock(authorDid, `NSFW/political post content${keyword ? `: ${keyword}` : ""}`, stats, post.author?.handle, following, did, token, blockList);
        continue;
      }

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

  const sortedAuthors = [...latestPostByAuthor.entries()].sort(([didA, postA], [didB, postB]) => {
    let scoreA = scorePost(postA);
    let scoreB = scorePost(postB);
    if (mutualNetwork.has(didA)) scoreA += 10;
    if (mutualNetwork.has(didB)) scoreB += 10;
    return scoreB - scoreA;
  });

  const filteredAuthors = MIN_ENGAGEMENT_SCORE > 0
    ? sortedAuthors.filter(([, post]) => scorePost(post) >= MIN_ENGAGEMENT_SCORE)
    : sortedAuthors;

  console.log(`📊 ${filteredAuthors.length} authors after engagement filter (min score: ${MIN_ENGAGEMENT_SCORE})`);

  const termWeights    = computeTermWeights(stats, SEARCH_TERMS);
  const likedThisRun   = new Set();
  const termLikes      = {};
  const termFollows    = {};
  const followsPerTerm = actionsTarget / Math.max(1, SEARCH_TERMS.length);
  const termFollowBudget = {};
  for (const term of SEARCH_TERMS) {
    termFollowBudget[term] = Math.max(1, Math.round(termWeights[term] * followsPerTerm));
  }

  const currentPersona = getReplyPersona(stats);
  console.log(`💬 Reply persona this run: ${currentPersona}`);

  for (const [authorDid, post] of filteredAuthors) {
    if (totalLikes + totalFollows >= actionsTarget) break;

    const uri = post.uri;
    const cid = post.cid;
    if (!uri || !cid) continue;
    if (likedThisRun.has(authorDid)) continue;

    if (blockList.has(authorDid)) {
      likedThisRun.add(authorDid);
      continue;
    }

    const { pass, reason } = await passesQualityFilters(authorDid, post, token, stats);
    if (!pass) {
      console.log(`   🚫 Skipped @${post.author?.handle} — ${reason}`);
      likedThisRun.add(authorDid);
      await sleep(300);
      continue;
    }

    const postText = post.record?.text || "";
    const relevant = await isGamingRelevantAI(postText);
    if (!relevant) {
      console.log(`   🎯 Skipped @${post.author?.handle} — post not gaming related`);
      likedThisRun.add(authorDid);
      await sleep(300);
      continue;
    }

    if (ANTHROPIC_API_KEY && postText.length > 10) {
      try {
        const langCheck = JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 10,
          system: "You are a language detector. Answer only YES or NO.",
          messages: [{ role: "user", content: `Is this text written in English? Answer only YES or NO.\n\n"${safeTruncate(postText, 300)}"` }]
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
      } catch {}
    }

    const postDate  = new Date(post.indexedAt || post.record?.createdAt || 0);
    const lastLiked = stats.lastLikedAt[authorDid] ? new Date(stats.lastLikedAt[authorDid]) : null;
    const term      = postTermMap.get(authorDid) || SEARCH_TERMS[0];

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
          if (!following.has(authorDid) && (termFollows[term] || 0) < (termFollowBudget[term] || 1)) {
            const followed = await followAccount(authorDid, did, token);
            if (followed) {
              totalFollows++;
              following.set(authorDid, { handle: post.author?.handle });
              stats.followedAt[authorDid] = { handle: post.author?.handle, followedBack: false, followedAt: new Date().toISOString(), term };
              termFollows[term] = (termFollows[term] || 0) + 1;
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

      if (ANTHROPIC_API_KEY && likesSinceLastReply >= REPLY_FREQUENCY) {
        const postText = targetPost.record?.text || "";
        if (postText.length >= MIN_REPLY_TEXT_LEN && canReply(authorDid, stats)) {
          const replyResult = await generateReply(postText, post.author?.handle, currentPersona, token, targetPost.uri);
          if (replyResult) {
            const { text: replyText, gameContext: replyGameContext } = replyResult;
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
                gameContext: replyGameContext,
              });
              if (stats.sentReplies.length > 50) stats.sentReplies.shift();
              stats.replyEngagement.sent++;
              if (!stats.replyPersonaStats) stats.replyPersonaStats = {};
              if (!stats.replyPersonaStats[currentPersona]) stats.replyPersonaStats[currentPersona] = { sent: 0, gotLiked: 0, gotReplied: 0 };
              stats.replyPersonaStats[currentPersona].sent++;
              if (!stats.replyPersonaGameStats) stats.replyPersonaGameStats = {};
              const pgKey = `${currentPersona}/${replyGameContext}`;
              if (!stats.replyPersonaGameStats[pgKey]) stats.replyPersonaGameStats[pgKey] = { sent: 0, gotLiked: 0, gotReplied: 0, persona: currentPersona, game: replyGameContext };
              stats.replyPersonaGameStats[pgKey].sent++;
              console.log(`   💬 Replied to @${post.author?.handle} [${currentPersona}/${replyGameContext}]: "${replyText}"`);
              recordHourlyAction(stats);
              recordDailyAction(stats);
            }
          }
          await sleep(1000);
        }
      }
    }

    if (!following.has(authorDid) && (termFollows[term] || 0) < (termFollowBudget[term] || 1)) {
      const followed = await followAccount(authorDid, did, token);
      if (followed) {
        totalFollows++;
        following.set(authorDid, { handle: post.author?.handle });
        stats.followedAt[authorDid] = { handle: post.author?.handle, followedBack: false, followedAt: new Date().toISOString(), term };
        termFollows[term] = (termFollows[term] || 0) + 1;
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

  for (const term of SEARCH_TERMS) {
    recordTermPerformance(stats, term, termLikes[term] || 0, termFollows[term] || 0);
  }

  logTopTerms(stats);
  const trimmedThisRun = await autoTrimDeadTerms(stats);
  await cycleInNextCandidate(trimmedThisRun ? trimmedThisRun.length : 0);
  await graduateCandidateTerms(stats);
  await discoverNewTerms(token, stats);

  const totalActions = totalLikes + totalFollows + totalReplies;

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
  console.log(`📈 Follow-back rate: ${rate}% (${stats.followBackRate.followedBack}/${stats.followBackRate.followed} currently following)`);
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
    timestamp:   new Date().toISOString(),
    likes:       totalLikes,
    follows:     totalFollows,
    unfollows:   totalUnfollows,
    replies:     totalReplies,
    netFollowers,
    filtered:    stats.filteredCount || 0,
  });

  saveStats(stats);
  await saveStatsToGist(stats);

  console.log(`📊 Cumulative — ${stats.totalLikes} likes, ${stats.totalFollows} follows, ${stats.totalUnfollows} unfollows, ${stats.totalReplies} replies across ${stats.runs} runs`);

  if (DISCORD_WEBHOOK_URL && stats.replyPersonaGameStats && Object.keys(stats.replyPersonaGameStats).length > 0) {
    try {
      const pgStats = stats.replyPersonaGameStats;
      const byGame  = {};
      for (const [key, data] of Object.entries(pgStats)) {
        if (data.sent === 0) continue;
        if (!byGame[data.game]) byGame[data.game] = [];
        const likeRate = data.sent > 0 ? ((data.gotLiked || 0) / data.sent * 100).toFixed(0) : "0";
        byGame[data.game].push(`${data.persona}: ${likeRate}% liked (${data.gotLiked || 0}/${data.sent})`);
      }
      const description = Object.entries(byGame)
        .map(([game, lines]) => `**${game}**\n${lines.join("\n")}`)
        .join("\n\n");

      if (description) {
        const url = new URL(DISCORD_WEBHOOK_URL);
        const body = JSON.stringify({
          embeds: [{
            title: "🎭 Reply Persona × Game Breakdown",
            color: 0xff8c1e,
            description,
            footer: { text: `Cumulative across all runs` },
          }]
        });
        await request({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }, body);
        console.log("📨 Persona/game breakdown posted to Discord");
      }
    } catch (e) {
      console.warn(`Discord persona/game breakdown failed: ${e.message}`);
    }
  }

  await postDiscordSummary({
    likes: totalLikes, follows: totalFollows, unfollows: totalUnfollows,
    replies: totalReplies, followBackRate: rate,
    netFollowers, topTerm, runs: stats.runs,
  });
}

run().catch(async (err) => {
  console.error("❌ Bot error:", err.message);
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
          title: "❌ Bot Run Failed",
          color: 0xff3d57,
          description: `\`\`\`${err.message}\`\`\``,
          footer: { text: new Date().toLocaleString() },
        }]
      }));
    } catch {}
  }
  process.exit(1);
});
