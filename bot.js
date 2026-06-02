const https = require("https");
const http  = require("http");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────
const BLUESKY_HANDLE     = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD   = process.env.BLUESKY_PASSWORD;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ACTIONS_PER_RUN    = parseInt(process.env.ACTIONS_PER_RUN || "25");
const INACTIVE_DAYS      = 60;

// Engagement quality filters
const MIN_FOLLOWERS      = 10;
const MIN_ACCOUNT_DAYS   = 30;
const MAX_POST_AGE_DAYS  = 7;
const MAX_FOLLOW_RATIO   = 10; // following/followers ratio — skip if above this (spam signal)

// Daily/hourly caps
const DAILY_ACTION_CAP   = 200;
const HOURLY_LIMIT       = 60;

// Reply config — 1 in every N liked posts gets a reply
const REPLY_FREQUENCY    = 5;

const DEFAULT_TERMS = ["#CS2", "#CounterStrike", "#CounterStrike2", "#CS2clips", "CS2", "counter-strike"];
const SEARCH_TERMS  = process.env.SEARCH_TERMS
  ? process.env.SEARCH_TERMS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_TERMS;

const POSTS_PER_SEARCH = 100;
const STATS_PATH       = "stats.json";

// ── Stats ─────────────────────────────────────────────────
function loadStats() {
  const defaults = {
    totalLikes: 0, totalFollows: 0, totalUnfollows: 0, totalReplies: 0,
    runs: 0, lastRun: null, lastLikedAt: {}, dailyActions: {},
    hourlyActions: [], followedAt: {},
    followBackRate: { followed: 0, followedBack: 0 },
    followerHistory: [], // [{ date, count }] for growth velocity
    termPerformance: {}, // { term: { likes, follows } }
    filteredCount: 0,
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

  return { pass: true, reason: "ok" };
}

// ── AI Reply generation ───────────────────────────────────
async function generateReply(postText, authorHandle) {
  if (!ANTHROPIC_API_KEY) return null;

  const body = JSON.stringify({
    model: "claude-opus-4-5",
    max_tokens: 150,
    system: "You are Dexterity (@dexteritycs.bsky.social), a CS2 streamer and content creator. Write short, genuine, conversational replies to CS2 posts. Sound like a real player — not a bot. Never use emojis excessively. Max 200 characters. Output only the reply text, nothing else.",
    messages: [{
      role: "user",
      content: `Reply to this CS2 post by @${authorHandle}:\n\n"${postText}"\n\nWrite a short genuine reply as Dexterity. Keep it under 200 characters.`
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
async function runUnfollows(did, token, following, followers) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INACTIVE_DAYS);
  let totalUnfollows = 0;
  console.log(`\n🧹 Checking for inactive non-followers...`);
  for (const [targetDid, { rkey, handle }] of following.entries()) {
    if (followers.has(targetDid)) continue;
    if (!rkey) continue;
    const lastPost = await getLastPostDate(targetDid, token);
    const isInactive = !lastPost || lastPost < cutoff;
    if (isInactive) {
      const ok = await unfollowAccount(did, rkey, token);
      if (ok) {
        totalUnfollows++;
        const str = lastPost ? lastPost.toLocaleDateString() : "never";
        console.log(`   🗑️  Unfollowed @${handle} (last post: ${str})`);
        following.delete(targetDid);
      }
      await sleep(800);
    }
  }
  console.log(`✅ Unfollowed ${totalUnfollows} inactive non-followers`);
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

// ── Main run ──────────────────────────────────────────────
async function run() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD env vars");
    process.exit(1);
  }

  const stats = loadStats();

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
  const following       = await getFollowing(did, token);
  const { followers, count: followerCount } = await getFollowers(did, token);

  // Record follower count for growth velocity
  recordFollowerCount(stats, followerCount);

  // Update follow-back rate
  updateFollowBackRate(stats, followers);

  // Unfollow inactive non-followers
  const totalUnfollows = await runUnfollows(did, token, following, followers);

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
  const likedThisRun   = new Set();
  const termLikes      = {};
  const termFollows    = {};

  for (const [authorDid, post] of latestPostByAuthor.entries()) {
    if (totalLikes + totalFollows >= actionsTarget) break;

    const uri = post.uri;
    const cid = post.cid;
    if (!uri || !cid) continue;
    if (likedThisRun.has(authorDid)) continue;

    // Quality filters
    const { pass, reason } = await passesQualityFilters(authorDid, post, token, stats);
    if (!pass) {
      console.log(`   🚫 Skipped @${post.author?.handle} — ${reason}`);
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
              stats.followedAt[authorDid] = { handle: post.author?.handle, followedBack: false };
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
        if (postText.length > 10) {
          const replyText = await generateReply(postText, post.author?.handle);
          if (replyText) {
            const replied = await replyToPost(targetPost, replyText, did, token);
            if (replied) {
              totalReplies++;
              likesSinceLastReply = 0;
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
        stats.followedAt[authorDid] = { handle: post.author?.handle, followedBack: false };
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

  const rate = stats.followBackRate.followed > 0
    ? ((stats.followBackRate.followedBack / stats.followBackRate.followed) * 100).toFixed(1)
    : "0.0";

  console.log(`\n✅ Run complete — ${totalLikes} likes, ${totalFollows} follows, ${totalUnfollows} unfollows, ${totalReplies} replies`);
  console.log(`📈 Follow-back rate: ${rate}% (${stats.followBackRate.followedBack}/${stats.followBackRate.followed})`);
  console.log(`🚫 Filtered this run: ${stats.filteredCount || 0} accounts`);

  stats.totalLikes     = (stats.totalLikes || 0) + totalLikes;
  stats.totalFollows   = (stats.totalFollows || 0) + totalFollows;
  stats.totalUnfollows = (stats.totalUnfollows || 0) + totalUnfollows;
  stats.totalReplies   = (stats.totalReplies || 0) + totalReplies;
  stats.filteredCount  = 0; // reset per run
  stats.runs           = (stats.runs || 0) + 1;
  stats.lastRun        = new Date().toISOString();
  saveStats(stats);

  console.log(`📊 Cumulative — ${stats.totalLikes} likes, ${stats.totalFollows} follows, ${stats.totalUnfollows} unfollows, ${stats.totalReplies} replies across ${stats.runs} runs`);
}

run().catch((err) => {
  console.error("❌ Bot error:", err.message);
  process.exit(1);
});
