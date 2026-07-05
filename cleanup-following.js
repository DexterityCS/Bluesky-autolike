const https = require("https");
const fs    = require("fs");

const BLUESKY_HANDLE      = process.env.BLUESKY_HANDLE;
const BLUESKY_PASSWORD    = process.env.BLUESKY_PASSWORD;
const DRY_RUN             = process.env.DRY_RUN === "true";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

// Same thresholds as the updated bot.js
const MAX_FOLLOW_RATIO    = 3;
const MAX_FOLLOWING_COUNT = 1500;
const MIN_FOLLOWERS       = 25;

const WHITELIST_PATH = "data/whitelist.json";

function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"))); }
  catch { return new Set(); }
}

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

async function getFollowing(did, token) {
  const following = [];
  let cursor = null;
  do {
    const path = `app.bsky.graph.getFollows?actor=${encodeURIComponent(did)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await apiRequest(path, "GET", null, token);
    if (res.status !== 200) break;
    for (const f of res.body.follows || []) {
      const rkey = f.viewer?.following?.split("/").pop();
      following.push({
        did: f.did,
        handle: f.handle,
        rkey,
        followersCount: f.followersCount,
        followsCount: f.followsCount,
      });
    }
    cursor = res.body.cursor;
  } while (cursor);
  console.log(`📋 Currently following ${following.length} accounts`);
  return following;
}

async function getProfile(actorDid, token) {
  const res = await apiRequest(
    `app.bsky.actor.getProfile?actor=${encodeURIComponent(actorDid)}`,
    "GET", null, token
  );
  if (res.status !== 200) return null;
  return res.body;
}

async function unfollowAccount(myDid, rkey, token) {
  const res = await apiRequest("com.atproto.repo.deleteRecord", "POST",
    { repo: myDid, collection: "app.bsky.graph.follow", rkey }, token
  );
  return res.status === 200;
}

async function postDiscordSummary({ dryRun, totalChecked, flagged, unfollowed }) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const url = new URL(DISCORD_WEBHOOK_URL);
    const topFlagged = flagged.slice(0, 15)
      .map(f => `**@${f.handle}** — ${f.reason}`)
      .join("\n") || "None";
    const extra = flagged.length > 15 ? `\n…and ${flagged.length - 15} more` : "";

    const body = JSON.stringify({
      embeds: [{
        title: dryRun ? "🧪 Following Cleanup — Dry Run" : "🧹 Following Cleanup Complete",
        color: dryRun ? 0xffd600 : 0x00e5ff,
        fields: [
          { name: "Accounts Checked", value: String(totalChecked), inline: true },
          { name: "Flagged",          value: String(flagged.length), inline: true },
          { name: dryRun ? "Would Unfollow" : "Unfollowed", value: String(dryRun ? flagged.length : unfollowed), inline: true },
        ],
        description: `${topFlagged}${extra}`,
        footer: { text: dryRun ? "Dry run — no accounts were actually unfollowed" : `dexterityCS following cleanup • ${new Date().toLocaleString()}` },
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
    console.warn(`Discord summary failed: ${e.message}`);
  }
}

async function main() {
  if (!BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
    console.error("❌ Missing BLUESKY_HANDLE or BLUESKY_PASSWORD env vars");
    process.exit(1);
  }

  const { token, did } = await login();
  const following = await getFollowing(did, token);
  const whitelist = loadWhitelist();
  if (whitelist.size > 0) console.log(`🛡️  Whitelist loaded — ${whitelist.size} protected accounts`);

  const flagged = [];

  console.log(`\n🔍 Auditing ${following.length} accounts against thresholds:`);
  console.log(`   MAX_FOLLOW_RATIO=${MAX_FOLLOW_RATIO}, MAX_FOLLOWING_COUNT=${MAX_FOLLOWING_COUNT}, MIN_FOLLOWERS=${MIN_FOLLOWERS}\n`);

  for (const account of following) {
    if (!account.rkey) continue;
    if (whitelist.has(account.handle)) {
      console.log(`   🛡️  Skipped @${account.handle} — whitelisted`);
      continue;
    }

    // Prefer live profile data over cached follow-list counts, since those can be stale
    const profile = await getProfile(account.did, token);
    const followers = profile?.followersCount ?? account.followersCount ?? 0;
    const followingCount = profile?.followsCount ?? account.followsCount ?? 0;

    let reason = null;
    if (followingCount > MAX_FOLLOWING_COUNT) {
      reason = `mass-follower (${followingCount} following)`;
    } else if (followers > 0 && followingCount / followers > MAX_FOLLOW_RATIO) {
      reason = `spam ratio (${followingCount} following / ${followers} followers)`;
    } else if (followers < MIN_FOLLOWERS) {
      reason = `too few followers (${followers})`;
    }

    if (reason) {
      flagged.push({ ...account, followers, followingCount, reason });
      console.log(`   🚩 @${account.handle} — ${reason}`);
    }

    await sleep(300); // be gentle on the API
  }

  console.log(`\n📊 Flagged ${flagged.length} of ${following.length} accounts for unfollow`);

  if (flagged.length === 0) {
    console.log("✅ Nothing to clean up — your following list already looks healthy.");
    await postDiscordSummary({ dryRun: DRY_RUN, totalChecked: following.length, flagged: [], unfollowed: 0 });
    return;
  }

  if (DRY_RUN) {
    console.log("\n🧪 DRY RUN — no unfollows performed. Flagged accounts:");
    flagged.forEach(f => console.log(`   @${f.handle} — ${f.reason}`));
    console.log("\nRe-run without DRY_RUN=true to actually unfollow these.");
    await postDiscordSummary({ dryRun: true, totalChecked: following.length, flagged, unfollowed: 0 });
    return;
  }

  let unfollowed = 0;
  for (const account of flagged) {
    const ok = await unfollowAccount(did, account.rkey, token);
    if (ok) {
      unfollowed++;
      console.log(`   🗑️  Unfollowed @${account.handle}`);
    }
    await sleep(800);
  }

  console.log(`\n✅ Cleanup complete — unfollowed ${unfollowed}/${flagged.length} flagged accounts`);
  await postDiscordSummary({ dryRun: false, totalChecked: following.length, flagged, unfollowed });
}

main().catch(err => {
  console.error("❌ Cleanup script error:", err.message);
  process.exit(1);
});
