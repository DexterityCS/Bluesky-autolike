const https = require("https");

const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;
const ACTIONS_PER_RUN = parseInt(process.env.ACTIONS_PER_RUN || "25");
const INACTIVE_DAYS = 60; // unfollow if inactive this many days AND not following back

// Hashtags and keywords — customize via env vars or edit defaults here
const DEFAULT_TERMS = ["#CS2", "#CounterStrike", "#CounterStrike2", "#CS2clips", "CS2", "counter-strike"];
const SEARCH_TERMS = process.env.SEARCH_TERMS
  ? process.env.SEARCH_TERMS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_TERMS;

const POSTS_PER_SEARCH = 100;

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function apiRequest(path, method, body, token) {
  const options = {
    hostname: "bsky.social",
    path: `/xrpc/${path}`,
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  };
  return request(options, body);
}

async function login() {
  const res = await apiRequest("com.atproto.server.createSession", "POST", {
    identifier: BLUESKY_HANDLE,
    password: BLUESKY_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  console.log(`✅ Logged in as ${BLUESKY_HANDLE}`);
  return { token: res.body.accessJwt, did: res.body.did };
}

async function getFollowing(did, token) {
  const following = new Map(); // did → {rkey, handle}
  let cursor = null;
  do {
    const path = `app.bsky.graph.getFollows?actor=${encodeURIComponent(did)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const f of res.body.follows || []) {
      // rkey is the last segment of the follow record URI
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
  return followers;
}

async function getLastPostDate(actorDid, token) {
  const res = await apiRequest(
    `app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actorDid)}&limit=1`,
    "GET", null, token
  );
  if (res.status !== 200 || !res.body.feed?.length) return null;
  return new Date(res.body.feed[0].post.indexedAt);
}

async function unfollowAccount(myDid, rkey, token) {
  const res = await apiRequest(
    `com.atproto.repo.deleteRecord`,
    "POST",
    { repo: myDid, collection: "app.bsky.graph.follow", rkey },
    token
  );
  return res.status === 200;
}

async function searchPosts(term, token) {
  const query = encodeURIComponent(term);
  const res = await apiRequest(`app.bsky.feed.searchPosts?q=${query}&limit=${POSTS_PER_SEARCH}`, "GET", null, token);
  if (res.status !== 200) return [];
  return res.body.posts || [];
}

async function isAlreadyLiked(uri, token) {
  const res = await apiRequest(
    `app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
    "GET", null, token
  );
  if (res.status !== 200 || !res.body.posts?.length) return false;
  return !!res.body.posts[0].viewer?.like;
}

async function likePost(uri, cid, did, token) {
  const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
    repo: did,
    collection: "app.bsky.feed.like",
    record: { subject: { uri, cid }, createdAt: new Date().toISOString() },
  }, token);
  return res.status === 200;
}

async function followAccount(targetDid, did, token) {
  const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
    repo: did,
    collection: "app.bsky.graph.follow",
    record: { subject: targetDid, createdAt: new Date().toISOString() },
  }, token);
  return res.status === 200;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Unfollow accounts that are inactive AND don't follow back ──
async function runUnfollows(did, token, following, followers) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INACTIVE_DAYS);

  let totalUnfollows = 0;
  console.log(`\n🧹 Checking for inactive non-followers (inactive ${INACTIVE_DAYS}+ days AND not following back)...`);

  for (const [targetDid, { rkey, handle }] of following.entries()) {
    // Keep if they follow you back
    if (followers.has(targetDid)) continue;

    // Keep if rkey is missing (can't unfollow safely)
    if (!rkey) continue;

    // Check last post date
    const lastPost = await getLastPostDate(targetDid, token);
    const isInactive = !lastPost || lastPost < cutoff;

    if (isInactive) {
      const unfollowed = await unfollowAccount(did, rkey, token);
      if (unfollowed) {
        totalUnfollows++;
        const lastPostStr = lastPost ? lastPost.toLocaleDateString() : "never";
        console.log(`   🗑️  Unfollowed @${handle} (last post: ${lastPostStr}, not following back)`);
        following.delete(targetDid);
      }
      await sleep(800);
    }
  }

  console.log(`✅ Unfollowed ${totalUnfollows} inactive non-followers`);
  return totalUnfollows;
}

async function run() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD env vars");
    process.exit(1);
  }

  const { token, did } = await login();
  const following = await getFollowing(did, token);
  const followers = await getFollowers(did, token);

  // Run unfollows first to free up space
  const totalUnfollows = await runUnfollows(did, token, following, followers);

  let totalLikes = 0;
  let totalFollows = 0;
  const actionsTarget = ACTIONS_PER_RUN;

  console.log(`\n🔎 Search terms: ${SEARCH_TERMS.join(", ")}`);

  // Collect all posts across all search terms, keep only most recent per author
  const latestPostByAuthor = new Map(); // did → most recent post

  for (const term of SEARCH_TERMS) {
    console.log(`\n🔍 Searching "${term}"...`);
    const posts = await searchPosts(term, token);
    console.log(`   Found ${posts.length} posts`);

    for (const post of posts) {
      const authorDid = post.author?.did;
      if (!authorDid || !post.uri || !post.cid) continue;
      if (authorDid === did) continue; // skip own posts

      const existing = latestPostByAuthor.get(authorDid);
      const postDate = new Date(post.indexedAt || post.record?.createdAt || 0);
      const existingDate = existing ? new Date(existing.indexedAt || existing.record?.createdAt || 0) : null;

      if (!existing || postDate > existingDate) {
        latestPostByAuthor.set(authorDid, post);
      }
    }
  }

  console.log(`\n📋 ${latestPostByAuthor.size} unique authors found`);

  const likedThisRun = new Set(); // track liked author DIDs in memory

  for (const [authorDid, post] of latestPostByAuthor.entries()) {
    if (totalLikes + totalFollows >= actionsTarget) break;

    const uri = post.uri;
    const cid = post.cid;
    if (!uri || !cid) continue;

    // Skip if already liked this author this run
    if (likedThisRun.has(authorDid)) continue;

    // Like the most recent post only if not already liked
    const alreadyLiked = await isAlreadyLiked(uri, token);
    if (!alreadyLiked) {
      const liked = await likePost(uri, cid, did, token);
      if (liked) {
        totalLikes++;
        likedThisRun.add(authorDid);
        console.log(`   ❤️  Liked post by @${post.author?.handle}`);
      }
    } else {
      likedThisRun.add(authorDid);
      console.log(`   ⏭️  Already liked @${post.author?.handle} — skipping`);
    }

    // Follow if not already following
    if (!following.has(authorDid)) {
      const followed = await followAccount(authorDid, did, token);
      if (followed) {
        totalFollows++;
        following.set(authorDid, { handle: post.author?.handle });
        console.log(`   ➕ Followed @${post.author?.handle}`);
      }
    }

    await sleep(800);
  }

  console.log(`\n✅ Run complete — ${totalLikes} likes, ${totalFollows} follows, ${totalUnfollows} unfollows`);

  // Update cumulative stats.json
  const fs = require("fs");
  const statsPath = "stats.json";
  let stats = { totalLikes: 0, totalFollows: 0, totalUnfollows: 0, runs: 0, lastRun: null };
  if (fs.existsSync(statsPath)) {
    try { stats = JSON.parse(fs.readFileSync(statsPath, "utf8")); } catch {}
  }
  stats.totalLikes     = (stats.totalLikes || 0) + totalLikes;
  stats.totalFollows   = (stats.totalFollows || 0) + totalFollows;
  stats.totalUnfollows = (stats.totalUnfollows || 0) + totalUnfollows;
  stats.runs           = (stats.runs || 0) + 1;
  stats.lastRun        = new Date().toISOString();
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  console.log(`📊 Cumulative — ${stats.totalLikes} likes, ${stats.totalFollows} follows, ${stats.totalUnfollows} unfollows across ${stats.runs} runs`);
}

run().catch((err) => {
  console.error("❌ Bot error:", err.message);
  process.exit(1);
});


function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function apiRequest(path, method, body, token) {
  const options = {
    hostname: "bsky.social",
    path: `/xrpc/${path}`,
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  };
  return request(options, body);
}

async function login() {
  const res = await apiRequest("com.atproto.server.createSession", "POST", {
    identifier: BLUESKY_HANDLE,
    password: BLUESKY_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  console.log(`✅ Logged in as ${BLUESKY_HANDLE}`);
  return { token: res.body.accessJwt, did: res.body.did };
}

async function getFollowing(did, token) {
  const following = new Set();
  let cursor = null;
  do {
    const path = `app.bsky.graph.getFollows?actor=${encodeURIComponent(did)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const f of res.body.follows || []) following.add(f.did);
    cursor = res.body.cursor;
  } while (cursor);
  console.log(`📋 Already following ${following.size} accounts`);
  return following;
}

async function searchPosts(term, token) {
  // Bluesky search works for both hashtags (#CS2) and keywords (CS2) with same endpoint
  const query = encodeURIComponent(term);
  const res = await apiRequest(`app.bsky.feed.searchPosts?q=${query}&limit=${POSTS_PER_SEARCH}`, "GET", null, token);
  if (res.status !== 200) return [];
  return res.body.posts || [];
}

async function likePost(uri, cid, did, token) {
  const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
    repo: did,
    collection: "app.bsky.feed.like",
    record: {
      subject: { uri, cid },
      createdAt: new Date().toISOString(),
    },
  }, token);
  return res.status === 200;
}

async function followAccount(targetDid, did, token) {
  const res = await apiRequest("com.atproto.repo.createRecord", "POST", {
    repo: did,
    collection: "app.bsky.graph.follow",
    record: {
      subject: targetDid,
      createdAt: new Date().toISOString(),
    },
  }, token);
  return res.status === 200;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD env vars");
    process.exit(1);
  }

  const { token, did } = await login();
  const alreadyFollowing = await getFollowing(did, token);

  let totalLikes = 0;
  let totalFollows = 0;
  const actionsTarget = ACTIONS_PER_RUN;
  const seenDids = new Set();

  console.log(`🔎 Search terms: ${SEARCH_TERMS.join(", ")}`);

  for (const term of SEARCH_TERMS) {
    if (totalLikes + totalFollows >= actionsTarget) break;
    console.log(`\n🔍 Searching "${term}"...`);
    const posts = await searchPosts(term, token);
    console.log(`   Found ${posts.length} posts`);

    for (const post of posts) {
      if (totalLikes + totalFollows >= actionsTarget) break;

      const authorDid = post.author?.did;
      const uri = post.uri;
      const cid = post.cid;

      if (!authorDid || !uri || !cid) continue;
      if (authorDid === did) continue; // skip own posts

      // Like the post
      const liked = await likePost(uri, cid, did, token);
      if (liked) {
        totalLikes++;
        console.log(`   ❤️  Liked post by @${post.author?.handle}`);
      }

      // Follow the author if not already following
      if (!alreadyFollowing.has(authorDid) && !seenDids.has(authorDid)) {
        seenDids.add(authorDid);
        const followed = await followAccount(authorDid, did, token);
        if (followed) {
          totalFollows++;
          alreadyFollowing.add(authorDid);
          console.log(`   ➕ Followed @${post.author?.handle}`);
        }
      }

      await sleep(800); // rate limit buffer
    }
  }

  console.log(`\n✅ Run complete — ${totalLikes} likes, ${totalFollows} follows`);

  // Update cumulative stats.json
  const fs = require("fs");
  const statsPath = "stats.json";
  let stats = { totalLikes: 0, totalFollows: 0, runs: 0, lastRun: null };
  if (fs.existsSync(statsPath)) {
    try { stats = JSON.parse(fs.readFileSync(statsPath, "utf8")); } catch {}
  }
  stats.totalLikes   = (stats.totalLikes || 0) + totalLikes;
  stats.totalFollows = (stats.totalFollows || 0) + totalFollows;
  stats.runs         = (stats.runs || 0) + 1;
  stats.lastRun      = new Date().toISOString();
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  console.log(`📊 Cumulative — ${stats.totalLikes} likes, ${stats.totalFollows} follows across ${stats.runs} runs`);
}

run().catch((err) => {
  console.error("❌ Bot error:", err.message);
  process.exit(1);
});
