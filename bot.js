const https = require("https");

const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;
const ACTIONS_PER_RUN = parseInt(process.env.ACTIONS_PER_RUN || "25");
const INACTIVE_DAYS = 60;

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
    "com.atproto.repo.deleteRecord",
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

async function getLatestPost(actorDid, token) {
  const res = await apiRequest(
    `app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actorDid)}&limit=1&filter=posts_no_replies`,
    "GET", null, token
  );
  if (res.status !== 200 || !res.body.feed?.length) return null;
  return res.body.feed[0].post;
}


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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runUnfollows(did, token, following, followers) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INACTIVE_DAYS);

  let totalUnfollows = 0;
  console.log(`\n🧹 Checking for inactive non-followers (inactive ${INACTIVE_DAYS}+ days AND not following back)...`);

  for (const [targetDid, { rkey, handle }] of following.entries()) {
    if (followers.has(targetDid)) continue;
    if (!rkey) continue;

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

  const totalUnfollows = await runUnfollows(did, token, following, followers);

  let totalLikes = 0;
  let totalFollows = 0;
  const actionsTarget = ACTIONS_PER_RUN;

  console.log(`\n🔎 Search terms: ${SEARCH_TERMS.join(", ")}`);

  // Collect all posts, keep only most recent per author
  const latestPostByAuthor = new Map();

  for (const term of SEARCH_TERMS) {
    console.log(`\n🔍 Searching "${term}"...`);
    const posts = await searchPosts(term, token);
    console.log(`   Found ${posts.length} posts`);

    for (const post of posts) {
      const authorDid = post.author?.did;
      if (!authorDid || !post.uri || !post.cid) continue;
      if (authorDid === did) continue;

      const existing = latestPostByAuthor.get(authorDid);
      const postDate = new Date(post.indexedAt || post.record?.createdAt || 0);
      const existingDate = existing ? new Date(existing.indexedAt || existing.record?.createdAt || 0) : null;

      if (!existing || postDate > existingDate) {
        latestPostByAuthor.set(authorDid, post);
      }
    }
  }

  const fs = require("fs");
  const statsPath = "stats.json";
  let stats = { totalLikes: 0, totalFollows: 0, totalUnfollows: 0, runs: 0, lastRun: null, lastLikedAt: {} };
  if (fs.existsSync(statsPath)) {
    try { stats = { ...stats, ...JSON.parse(fs.readFileSync(statsPath, "utf8")) }; } catch {}
  }
  if (!stats.lastLikedAt) stats.lastLikedAt = {};

  console.log(`\n📋 ${latestPostByAuthor.size} unique authors found`);

  const likedThisRun = new Set();

  for (const [authorDid, post] of latestPostByAuthor.entries()) {
    if (totalLikes + totalFollows >= actionsTarget) break;

    const uri = post.uri;
    const cid = post.cid;
    if (!uri || !cid) continue;
    if (likedThisRun.has(authorDid)) continue;

    const postDate = new Date(post.indexedAt || post.record?.createdAt || 0);
    const lastLiked = stats.lastLikedAt[authorDid] ? new Date(stats.lastLikedAt[authorDid]) : null;

    // If search result post isn't newer than last liked, fetch their actual latest post
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
              console.log(`   ➕ Followed @${post.author?.handle}`);
            }
          }
          await sleep(800);
          continue;
        }
      } else {
        console.log(`   ⏭️  No posts found for @${post.author?.handle} — skipping`);
        likedThisRun.add(authorDid);
        await sleep(300);
        continue;
      }
    }

    const liked = await likePost(targetPost.uri, targetPost.cid, did, token);
    if (liked) {
      totalLikes++;
      likedThisRun.add(authorDid);
      const targetDate = new Date(targetPost.indexedAt || targetPost.record?.createdAt || 0);
      stats.lastLikedAt[authorDid] = targetDate.toISOString();
      console.log(`   ❤️  Liked post by @${post.author?.handle}`);
    }

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
