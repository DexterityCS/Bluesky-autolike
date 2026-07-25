// analyze-timing.js
// One-off diagnostic: pulls real like timestamps across your recent posts
// and compares WHEN people actually engage against WHEN you post,
// broken down by hour of day (local time). Posts the comparison to Discord
// as two side-by-side bar charts.
//
// Usage: BLUESKY_HANDLE=... BLUESKY_PASSWORD=... node analyze-timing.js
// Optional: TIMEZONE=America/Chicago (default), MAX_POSTS=80 (default),
//           DISCORD_WEBHOOK_URL=... to post results

const https = require("https");

const BLUESKY_HANDLE      = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD    = process.env.BLUESKY_PASSWORD;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const TIMEZONE            = process.env.TIMEZONE || "America/Chicago";
const MAX_POSTS           = parseInt(process.env.MAX_POSTS || "80");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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
      console.warn(`   ⏳ Rate limited — waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    return res;
  }
  return { status: 429, body: {} };
}

async function login() {
  const res = await apiRequest("com.atproto.server.createSession", "POST", {
    identifier: BLUESKY_HANDLE, password: BLUESKY_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  console.log(`✅ Logged in as ${BLUESKY_HANDLE}`);
  return { token: res.body.accessJwt, did: res.body.did };
}

async function getOwnPosts(did, token, maxPosts) {
  const posts = [];
  let cursor = null;
  do {
    const path = `app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=100&filter=posts_no_replies${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const item of res.body.feed || []) {
      if (item.post?.author?.did === did) posts.push(item.post);
    }
    cursor = res.body.cursor;
  } while (cursor && posts.length < maxPosts);
  return posts.slice(0, maxPosts);
}

async function getLikesForPost(uri, token) {
  const likes = [];
  let cursor = null;
  do {
    const path = `app.bsky.feed.getLikes?uri=${encodeURIComponent(uri)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const like of res.body.likes || []) {
      if (like.createdAt) likes.push(like.createdAt);
    }
    cursor = res.body.cursor;
  } while (cursor);
  return likes;
}

function localHour(isoString, timeZone) {
  const date = new Date(isoString);
  const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone });
  const parts = formatter.formatToParts(date);
  let hour = parseInt(parts.find(p => p.type === "hour").value, 10);
  if (hour === 24) hour = 0;
  return hour;
}

function buildBarChart(counts, maxWidth = 20) {
  const max = Math.max(...counts, 1);
  return counts.map((c, hour) => {
    const barLen = Math.round((c / max) * maxWidth);
    const bar = "█".repeat(barLen);
    const label = String(hour).padStart(2, "0");
    return `${label}:00  ${bar} ${c}`;
  }).join("\n");
}

async function postToDiscord(likeHourCounts, postHourCounts, totalLikes, totalPosts) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const likeChart = buildBarChart(likeHourCounts);
    const postChart = buildBarChart(postHourCounts);

    const url = new URL(DISCORD_WEBHOOK_URL);
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, JSON.stringify({
      embeds: [{
        title: "📊 Engagement Timing Analysis",
        color: 0x00e5ff,
        fields: [
          { name: `❤️ When likes arrive (${totalLikes} total, ${TIMEZONE})`, value: `\`\`\`\n${likeChart}\n\`\`\`` },
          { name: `📝 When you post (${totalPosts} posts, ${TIMEZONE})`, value: `\`\`\`\n${postChart}\n\`\`\`` },
        ],
        footer: { text: `Compare the two charts — if your posting hours don't line up with your like hours, that's a scheduling mismatch worth fixing.` },
      }]
    }));
    console.log("📨 Timing analysis posted to Discord");
  } catch (e) {
    console.warn(`Discord post failed: ${e.message}`);
  }
}

async function main() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD");
    process.exit(1);
  }

  const { token, did } = await login();

  console.log(`📚 Fetching up to ${MAX_POSTS} recent posts...`);
  const posts = await getOwnPosts(did, token, MAX_POSTS);
  console.log(`   Found ${posts.length} posts`);

  const likeHourCounts = new Array(24).fill(0);
  const postHourCounts = new Array(24).fill(0);
  let totalLikes = 0;

  for (const post of posts) {
    const postedAt = post.record?.createdAt || post.indexedAt;
    if (postedAt) postHourCounts[localHour(postedAt, TIMEZONE)]++;

    const likeCount = post.likeCount || 0;
    if (likeCount === 0) continue;

    const likes = await getLikesForPost(post.uri, token);
    for (const createdAt of likes) {
      likeHourCounts[localHour(createdAt, TIMEZONE)]++;
      totalLikes++;
    }
    await sleep(300);
  }

  console.log(`\n❤️  When likes arrive (${TIMEZONE}):`);
  console.log(buildBarChart(likeHourCounts));
  console.log(`\n📝 When you post (${TIMEZONE}):`);
  console.log(buildBarChart(postHourCounts));

  await postToDiscord(likeHourCounts, postHourCounts, totalLikes, posts.length);
}

main().catch(err => {
  console.error("❌ Analysis error:", err.message);
  process.exit(1);
});
