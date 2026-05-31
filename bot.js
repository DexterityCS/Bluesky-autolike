const https = require("https");

const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;
const ACTIONS_PER_RUN = 25; // moderate: 20-30
const HASHTAGS = ["#CS2", "#CounterStrike"];

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

async function searchPosts(tag, token) {
  const query = encodeURIComponent(tag);
  const res = await apiRequest(`app.bsky.feed.searchPosts?q=${query}&limit=50`, "GET", null, token);
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

  for (const tag of HASHTAGS) {
    if (totalLikes + totalFollows >= actionsTarget) break;
    console.log(`\n🔍 Searching ${tag}...`);
    const posts = await searchPosts(tag, token);
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
  console.log(JSON.stringify({ likes: totalLikes, follows: totalFollows, timestamp: new Date().toISOString() }));
}

run().catch((err) => {
  console.error("❌ Bot error:", err.message);
  process.exit(1);
});
