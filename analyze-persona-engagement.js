// analyze-persona-engagement.js
// One-off diagnostic: reads your engagement bot's own sentReplies log (from
// the Gist), then fetches LIVE current engagement numbers for those replies
// from Bluesky, and breaks down real performance by persona (hype/analytical/
// friendly). This is a manual on-demand snapshot of the same data the bot
// now uses internally to auto-adjust persona weights — useful for checking
// in without digging through run logs.
//
// Usage: BLUESKY_HANDLE=... BLUESKY_PASSWORD=... GIST_TOKEN=... GIST_ID=... node analyze-persona-engagement.js
// Optional: DISCORD_WEBHOOK_URL=... to post results, MAX_REPLIES=200 (default)

const https = require("https");

const BLUESKY_HANDLE      = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD    = process.env.BLUESKY_PASSWORD;
const GIST_TOKEN          = process.env.GIST_TOKEN;
const GIST_ID             = process.env.GIST_ID;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const MAX_REPLIES         = parseInt(process.env.MAX_REPLIES || "200");

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

async function fetchSentReplies() {
  if (!GIST_TOKEN || !GIST_ID) throw new Error("Missing GIST_TOKEN or GIST_ID");
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
  if (res.status !== 200) throw new Error(`Gist fetch failed: ${res.status}`);
  const statsFile = res.body.files?.["stats.json"];
  if (!statsFile?.content) throw new Error("stats.json not found in Gist");
  const stats = JSON.parse(statsFile.content);
  return stats.sentReplies || [];
}

// Batch-fetch live post views (likeCount/repostCount/replyCount), 25 URIs at a time
async function fetchLivePostViews(uris, token) {
  const views = new Map();
  for (let i = 0; i < uris.length; i += 25) {
    const batch = uris.slice(i, i + 25);
    const query = batch.map(u => `uris=${encodeURIComponent(u)}`).join("&");
    const res = await apiRequest(`app.bsky.feed.getPosts?${query}`, "GET", null, token);
    if (res.status === 200) {
      for (const post of res.body.posts || []) {
        views.set(post.uri, post);
      }
    }
    await sleep(300);
  }
  return views;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function buildBarChart(labeledValues, maxWidth = 20, decimals = 2) {
  const max = Math.max(...labeledValues.map(v => v.value), 0.01);
  return labeledValues.map(({ label, value }) => {
    const barLen = Math.round((value / max) * maxWidth);
    const bar = "█".repeat(barLen);
    return `${label.padEnd(12)} ${bar} ${value.toFixed(decimals)}`;
  }).join("\n");
}

async function postToDiscord(personaData, topReplies) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const avgChart = buildBarChart(
      Object.entries(personaData).map(([p, d]) => ({ label: p, value: d.avg })), 20, 2
    );
    const medianChart = buildBarChart(
      Object.entries(personaData).map(([p, d]) => ({ label: p, value: d.median })), 20, 2
    );
    const countsText = Object.entries(personaData)
      .map(([p, d]) => `**${p}**: ${d.count} replies checked`)
      .join("\n");
    const topRepliesText = topReplies.length
      ? topReplies.map((r, i) => `${i + 1}. **${r.persona}** — ${r.engagement} engagement — "${r.text}"`).join("\n")
      : "No replies found";

    const url = new URL(DISCORD_WEBHOOK_URL);
    await request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, JSON.stringify({
      embeds: [{
        title: "🎭 Persona Engagement Analysis",
        color: 0x9b59b6,
        fields: [
          { name: "📋 Sample sizes", value: countsText },
          { name: "⭐ Average engagement per reply, by persona", value: `\`\`\`\n${avgChart}\n\`\`\`` },
          { name: "📐 Median engagement per reply, by persona (less sensitive to outliers)", value: `\`\`\`\n${medianChart}\n\`\`\`` },
          { name: "🔝 Top 5 individual replies", value: topRepliesText },
        ],
        footer: { text: "If average is high but median is low for a persona, that persona's average is being carried by one or two outlier replies." },
      }]
    }));
    console.log("📨 Persona analysis posted to Discord");
  } catch (e) {
    console.warn(`Discord post failed: ${e.message}`);
  }
}

async function main() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD");
    process.exit(1);
  }

  const { token } = await login();

  console.log("📚 Reading sentReplies from Gist...");
  const sentReplies = (await fetchSentReplies()).filter(r => r.uri && r.persona).slice(-MAX_REPLIES);
  console.log(`   Found ${sentReplies.length} replies with persona tags`);

  if (sentReplies.length === 0) {
    console.log("No tagged replies found — nothing to analyze yet.");
    return;
  }

  console.log("🔍 Fetching live engagement numbers for each reply...");
  const uris = sentReplies.map(r => r.uri);
  const liveViews = await fetchLivePostViews(uris, token);

  const byPersona = {};
  const allScored = [];

  for (const reply of sentReplies) {
    const post = liveViews.get(reply.uri);
    if (!post) continue;
    const engagement = (post.likeCount || 0) + (post.repostCount || 0) * 2 + (post.replyCount || 0) * 3;
    if (!byPersona[reply.persona]) byPersona[reply.persona] = [];
    byPersona[reply.persona].push(engagement);
    allScored.push({ persona: reply.persona, engagement, text: (post.record?.text || "").slice(0, 80) });
  }

  const personaData = {};
  for (const [persona, values] of Object.entries(byPersona)) {
    personaData[persona] = {
      count:  values.length,
      avg:    values.reduce((a, b) => a + b, 0) / values.length,
      median: median(values),
      max:    Math.max(...values),
    };
  }

  const topReplies = [...allScored].sort((a, b) => b.engagement - a.engagement).slice(0, 5);

  console.log("\n📊 Persona breakdown:");
  for (const [persona, d] of Object.entries(personaData)) {
    console.log(`   ${persona}: ${d.count} replies — avg ${d.avg.toFixed(2)}, median ${d.median.toFixed(2)}, max ${d.max}`);
  }
  console.log("\n🔝 Top 5 individual replies:");
  topReplies.forEach((r, i) => console.log(`   ${i + 1}. ${r.persona} — ${r.engagement} engagement — "${r.text}"`));

  await postToDiscord(personaData, topReplies);
}

main().catch(err => {
  console.error("❌ Analysis error:", err.message);
  process.exit(1);
});
