// ============================================================
//  dexterityCS — Sync Bluesky Blocks to blocklist.json
//  Fetches all accounts you've manually blocked on Bluesky
//  and adds them to blocklist.json
//  Run: node sync_blocks.js
// ============================================================

const https = require("https");
const fs    = require("fs");

const BLUESKY_HANDLE   = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;
const BLOCK_LIST_PATH  = process.env.BLOCK_LIST_PATH || "blocklist.json";

function apiRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "bsky.social",
      path: `/xrpc/${path}`,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
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
    for (const account of batch) {
      blocks.add(account.did);
    }
    cursor = res.body.cursor;
    await sleep(300);
  } while (cursor);

  return blocks;
}

function loadBlockList() {
  if (!fs.existsSync(BLOCK_LIST_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(BLOCK_LIST_PATH, "utf8"))); }
  catch { return new Set(); }
}

function saveBlockList(list) {
  fs.writeFileSync(BLOCK_LIST_PATH, JSON.stringify([...list], null, 2));
}

async function main() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Set BLUESKY_HANDLE and BLUESKY_PASSWORD env vars");
    console.error("   Windows:   set BLUESKY_HANDLE=yourhandle.bsky.social && set BLUESKY_PASSWORD=yourpassword");
    console.error("   Mac/Linux: export BLUESKY_HANDLE=yourhandle.bsky.social BLUESKY_PASSWORD=yourpassword");
    process.exit(1);
  }

  const { token } = await login();

  // Fetch blocks from Bluesky
  const blueskyBlocks = await fetchBlocks(null, token);
  console.log(`\n✅ Found ${blueskyBlocks.size} blocked accounts on Bluesky`);

  // Load existing blocklist.json
  const existing = loadBlockList();
  const beforeCount = existing.size;
  console.log(`📄 Existing blocklist.json: ${beforeCount} entries`);

  // Merge
  for (const did of blueskyBlocks) {
    existing.add(did);
  }

  const added = existing.size - beforeCount;
  saveBlockList(existing);

  console.log(`\n✅ Sync complete:`);
  console.log(`   Bluesky blocks:   ${blueskyBlocks.size}`);
  console.log(`   Previously in blocklist.json: ${beforeCount}`);
  console.log(`   New entries added: ${added}`);
  console.log(`   Total in blocklist.json: ${existing.size}`);
  console.log(`\n📄 Saved to ${BLOCK_LIST_PATH}`);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
