// ============================================================
//  dexterityCS — Sync Bluesky Blocks to Gist
//  Fetches all accounts you've manually blocked on Bluesky
//  and syncs them to the Gist (with local file fallback)
//  Run: node sync_blocks.js
// ============================================================
const https = require("https");
const fs    = require("fs");

const BLUESKY_HANDLE   = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;
const GIST_TOKEN       = process.env.GIST_TOKEN || null;
const GIST_ID          = process.env.GIST_ID || "9e21611814d0c5b84c94a9bc15ed21fa";
const BLOCK_LIST_PATH  = "data/blocklist.json";

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => (data += c));
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

async function login() {
  const res = await apiRequest("com.atproto.server.createSession", "POST", {
    identifier: BLUESKY_HANDLE,
    password:   BLUESKY_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  console.log(`✅ Logged in as ${BLUESKY_HANDLE}`);
  return { token: res.body.accessJwt, did: res.body.did };
}

async function fetchBlocks(did, token) {
  const blocks = new Set();
  let cursor = null;
  let page   = 0;
  console.log("📋 Fetching your Bluesky blocks...");
  do {
    const path = `app.bsky.graph.getBlocks?limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res  = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) {
      console.error(`❌ Failed to fetch blocks: ${res.status}`);
      break;
    }
    const batch = res.body.blocks || [];
    page++;
    console.log(`   Page ${page}: ${batch.length} blocked accounts`);
    for (const account of batch) blocks.add(account.did);
    cursor = res.body.cursor;
    await sleep(300);
  } while (cursor);
  return blocks;
}

// ── Load existing blocklist from Gist or local file ───────────
async function loadBlockList() {
  // Try Gist first
  if (GIST_TOKEN && GIST_ID) {
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
      if (res.status === 200 && res.body.files?.["blocklist.json"]?.content) {
        const list = JSON.parse(res.body.files["blocklist.json"].content);
        console.log(`📥 Loaded ${list.length} entries from Gist`);
        return new Set(list);
      }
    } catch (e) {
      console.warn(`⚠️  Gist load failed: ${e.message} — falling back to local file`);
    }
  }
  // Fallback to local file
  if (!fs.existsSync(BLOCK_LIST_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(BLOCK_LIST_PATH, "utf8"))); }
  catch { return new Set(); }
}

// ── Save blocklist to Gist and local file ─────────────────────
async function saveBlockList(list) {
  const arr = [...list];

  // Save to local file as fallback
  if (!fs.existsSync("data")) fs.mkdirSync("data");
  fs.writeFileSync(BLOCK_LIST_PATH, JSON.stringify(arr, null, 2));
  console.log(`💾 Saved to ${BLOCK_LIST_PATH}`);

  // Save to Gist
  if (GIST_TOKEN && GIST_ID) {
    try {
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
      }, JSON.stringify({
        files: { "blocklist.json": { content: JSON.stringify(arr, null, 2) } }
      }));
      if (res.status === 200) {
        console.log("📡 Blocklist synced to Gist");
      } else {
        console.warn(`⚠️  Gist sync failed: ${res.status}`);
      }
    } catch (e) {
      console.warn(`⚠️  Gist sync error: ${e.message}`);
    }
  }
}

async function main() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Set BLUESKY_HANDLE and BLUESKY_PASSWORD env vars");
    process.exit(1);
  }

  const { token } = await login();
  const blueskyBlocks = await fetchBlocks(null, token);
  console.log(`\n✅ Found ${blueskyBlocks.size} blocked accounts on Bluesky`);

  const existing = await loadBlockList();
  const beforeCount = existing.size;
  console.log(`📄 Existing blocklist: ${beforeCount} entries`);

  for (const did of blueskyBlocks) existing.add(did);
  const added = existing.size - beforeCount;

  await saveBlockList(existing);

  console.log(`\n✅ Sync complete:`);
  console.log(`   Bluesky blocks:    ${blueskyBlocks.size}`);
  console.log(`   Previously stored: ${beforeCount}`);
  console.log(`   New entries added: ${added}`);
  console.log(`   Total:             ${existing.size}`);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
