// analyze-reply-timing.js
// One-off diagnostic: pulls all your bot's replies to other people's posts
// and checks which hour-of-day gets the best real engagement (likes/replies
// on YOUR reply, from the stranger/community, not your own followers).
// This is the right diagnostic for the auto-liker/reply bot specifically —
// analyze-timing.js measures your own-follower audience; this measures
// whether your replies land well with the strangers you're engaging.
//
// Usage: BLUESKY_HANDLE=... BLUESKY_PASSWORD=... node analyze-reply-timing.js
// Optional: TIMEZONE=America/Chicago (default), MAX_REPLIES=150 (default),
//           DISCORD_WEBHOOK_URL=... to post results

const https = require("https");

const BLUESKY_HANDLE      = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD    = process.env.BLUESKY_PASSWORD;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const TIMEZONE            = process.env.TIMEZONE || "America/Chicago";
const MAX_REPLIES         = parseInt(process.env.MAX_REPLIES || "150");

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

// Fetch the account's own feed and keep only posts that ARE replies
// (i.e. have a record.reply field) authored by this account.
async function getOwnReplies(did, token, maxReplies) {
  const replies = [];
  let cursor = null;
  do {
    const path = `app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const item of res.body.feed || []) {
      const post = item.post;
      if (post?.author?.did === did && post.record?.reply) {
        replies.push(post);
      }
    }
    cursor = res.body.cursor;
  } while (cursor && replies.length < maxReplies);
  return replies.slice(0, maxReplies);
}

function localHour(isoString, timeZone) {
  const date = new Date(isoString);
  const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone });
  let hour = parseInt(formatter.formatToParts(date).find(p => p.type === "hour").value, 10);
  if (hour === 24) hour = 0;
  return hour;
}

function buildBarChart(counts, maxWidth = 20, decimals = 0) {
  const max = Math.max(...counts, 0.01);
  return counts.map((c, hour) => {
    const barLen = Math.round((c / max) * maxWidth);
    const bar = "█".repeat(barLen);
    const label = String(hour).padStart(2, "0");
    return `${label}:00  ${bar} ${c.toFixed(decimals)}`;
  }).join("\n");
}

async function postToDiscord(volumeByHour, avgEngagementByHour, totalReplies) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const volumeChart = buildBarChart(volumeByHour, 20, 0);
    const avgChart    = buildBarChart(avgEngagementByHour, 20, 2);

    const url = new URL(DISCORD_WEBHOOK_URL);
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, JSON.stringify({
      embeds: [{
        title: "📊 Reply Timing Analysis (auto-liker/reply bot)",
        color: 0xff8c1e,
        fields: [
          { name: `📨 Replies sent per hour (${totalReplies} total, ${TIMEZONE})`, value: `\`\`\`\n${volumeChart}\n\`\`\`` },
          { name: `⭐ Avg engagement per reply, by hour sent (likes+reposts+replies)`, value: `\`\`\`\n${avgChart}\n\`\`\`` },
        ],
        footer: { text: `The second chart is what matters — high bars there mean replies sent at that hour land well with strangers.` },
      }]
    }));
    console.log("📨 Reply timing analysis posted to Discord");
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

  console.log(`📚 Fetching up to ${MAX_REPLIES} recent replies...`);
  const replies = await getOwnReplies(did, token, MAX_REPLIES);
  console.log(`   Found ${replies.length} replies`);

  if (replies.length === 0) {
    console.log("No replies found — nothing to analyze yet.");
    return;
  }

  const volumeByHour     = new Array(24).fill(0);
  const engagementByHour = new Array(24).fill(0);

  for (const reply of replies) {
    const sentAt = reply.record?.createdAt || reply.indexedAt;
    if (!sentAt) continue;
    const hour = localHour(sentAt, TIMEZONE);
    const engagement = (reply.likeCount || 0) + (reply.repostCount || 0) + (reply.replyCount || 0);
    volumeByHour[hour]++;
    engagementByHour[hour] += engagement;
  }

  const avgEngagementByHour = engagementByHour.map((sum, hour) =>
    volumeByHour[hour] > 0 ? sum / volumeByHour[hour] : 0
  );

  console.log(`\n📨 Replies sent per hour (${TIMEZONE}):`);
  console.log(buildBarChart(volumeByHour, 20, 0));
  console.log(`\n⭐ Avg engagement per reply, by hour sent:`);
  console.log(buildBarChart(avgEngagementByHour, 20, 2));

  await postToDiscord(volumeByHour, avgEngagementByHour, replies.length);
}

main().catch(err => {
  console.error("❌ Analysis error:", err.message);
  process.exit(1);
});
