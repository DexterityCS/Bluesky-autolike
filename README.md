# dexterityCS — Bluesky CS2 Auto-Liker/Follower

An intelligent GitHub Actions bot that grows your Bluesky presence by engaging with CS2 content creators automatically. Runs every 4 hours, fully configurable via a GitHub Pages dashboard.

---

## Features

### Engagement
- Searches configurable hashtags and keywords across 6+ default CS2 terms
- Collects all posts per run and deduplicates to the **most recent post per author**
- Likes and follows authors — skips if already liked recently
- Profile fetch fallback — if the search result is stale, fetches the author's actual latest post
- Engagement scoring — sorts authors by likes × replies × reposts before processing
- Mutual network boost — accounts followed by people you follow get +10 priority score
- Likes back anyone who follows you with a recent post
- AI-generated contextual replies via Claude — reads each post and replies as Dexterity
- Reply persona rotation — cycles between `hype`, `analytical`, and `friendly` each run
- Skips reposts and quote posts — only engages with original content

### Smart Filtering
- Skips accounts with fewer than 10 followers
- Skips accounts created less than 30 days ago
- Skips posts older than 7 days
- Skips accounts with following/followers ratio above 10× (spam signal)
- Block list — permanently skip specific accounts
- Minimum engagement score filter (configurable)

### Unfollow Management
- Smart unfollow timing — unfollows only run once per day at 12:00 UTC
- Unfollows accounts that are **both** inactive 60+ days **and** not following back
- Always keeps accounts that follow you back

### Safety & Rate Limiting
- Pause mode — toggle in dashboard to skip all scheduled runs without disabling the workflow
- Daily action cap: 200 actions across all runs
- Hourly limit: 60 actions per hour
- Spike detector — halts run if actions are 3× the historical average
- Concurrency lock — prevents parallel runs from duplicating actions
- 800ms delay between actions

### Automated Posts
- **Follower milestones** — auto-posts to Bluesky at 100, 250, 500, 1K, 2.5K, 5K, 10K followers
- **Weekly Monday summary** — auto-posts weekly stats recap every Monday (followers gained, likes given, follow-back rate)
- Both use Claude to write genuine posts if `ANTHROPIC_API_KEY` is set, otherwise falls back to default text

### Analytics & Reporting
- Cumulative stats in `stats.json`: likes, follows, unfollows, replies, follow-back rate
- Growth velocity — 30-day follower history, daily average gain
- Best performing search terms — tracks which terms drive the most engagement
- Follow-back rate — % of followed accounts that follow back over time
- Reply engagement tracker — tracks how many AI replies got liked or replied to
- Net follower gain per run
- Run history — last 10 runs with full stats
- Discord run summary webhook — optional embed after every run
- `lastLikedAt` auto-pruned every 30 days to keep `stats.json` lean

### Dashboard (GitHub Pages)
- Manual trigger with 60-second cooldown
- **Pause / Resume** toggle — pauses all scheduled runs
- **⬇ Export** — downloads full stats as CSV
- **Live run log** — polls GitHub Actions API, shows step status, auto-refreshes every 10s during active runs
- **Blocklist manager** — add/remove accounts directly in the dashboard
- Inline GitHub token input — saved to localStorage
- Search term editor — add/remove terms without touching secrets
- Actions per run slider (10–100) — persists to localStorage
- Stat cards: Likes, Follows, Unfollows, Replies, Follow-back Rate, Last Run
- Run history table — last 10 runs color-coded
- Follower growth chart — 30-day canvas line chart
- Search term performance table — all terms ranked by cumulative engagement
- Upcoming run times in your local timezone with live countdown
- Cron expression visual breakdown

---

## Repo Structure

```
Bluesky-autolike/
├── bot.js                          — core bot logic
├── undo-likes.js                   — utility: undo recent likes within a time window
├── unfollow-non-english.js         — utility: unfollow non-English accounts
├── index.html                      — GitHub Pages dashboard
├── package.json
├── stats.json                      — auto-generated cumulative stats
├── blocklist.json                  — auto-generated block list
├── pause.json                      — auto-generated pause flag
├── README.md
├── RELEASE_NOTES.md
└── .github/
    └── workflows/
        ├── schedule.yml            — main bot (every 4 hours)
        ├── keepalive.yml           — monthly commit to prevent deactivation
        └── post-release.yml        — auto-posts release notes to Bluesky via Claude
```

---

## Setup

### 1. Create a GitHub repo and push all files

### 2. Add Repository Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `BLUESKY_HANDLE` | ✅ | Your full handle e.g. `dexteritycs.bsky.social` |
| `BLUESKY_PASSWORD` | ✅ | App Password from bsky.app → Settings → App Passwords |
| `ANTHROPIC_API_KEY` | Optional | Enables AI replies, milestone posts, weekly summaries |
| `DISCORD_WEBHOOK_URL` | Optional | Discord channel webhook for run summaries |
| `SEARCH_TERMS` | Optional | Comma-separated override for scheduled runs |
| `ACTIONS_PER_RUN` | Optional | Default actions for scheduled runs (default: 25) |

### 3. Enable GitHub Actions
Actions tab → enable workflows if prompted.

### 4. Enable GitHub Pages
Settings → Pages → Source: `main` branch, `/ (root)` folder.

Dashboard: `dexteritycs.github.io/Bluesky-autolike`

### 5. Add your GitHub PAT to the dashboard
- `github.com/settings/tokens` → Generate new token (classic) → check `repo` scope
- Open the dashboard, paste your token, check "Remember on this device"

---

## Configuration

All thresholds are at the top of `bot.js`:

```js
const INACTIVE_DAYS        = 60;   // days before unfollowing inactive non-followers
const MIN_FOLLOWERS        = 10;   // minimum followers to engage with
const MIN_ACCOUNT_DAYS     = 30;   // minimum account age in days
const MAX_POST_AGE_DAYS    = 7;    // only like posts this many days old or newer
const MAX_FOLLOW_RATIO     = 10;   // max following/followers ratio (spam filter)
const DAILY_ACTION_CAP     = 200;  // max actions per day
const HOURLY_LIMIT         = 60;   // max actions per hour
const REPLY_FREQUENCY      = 5;    // reply every N likes (requires ANTHROPIC_API_KEY)
const REPLY_COOLDOWN_DAYS  = 7;    // days before replying to same account again
const MIN_REPLY_TEXT_LEN   = 30;   // min post length to attempt reply
const SPIKE_THRESHOLD      = 3;    // halt if actions are Nx the average
const UNFOLLOW_HOUR_UTC    = 12;   // UTC hour to run unfollows (once per day)
const MIN_ENGAGEMENT_SCORE = 0;    // min post score to engage (0 = all posts)
const MUTUAL_NETWORK_BOOST = true; // boost accounts in your mutual network
const FOLLOWER_MILESTONES  = [100, 250, 500, 1000, 2500, 5000, 10000];
```

---

## Utility Scripts

### Undo recent likes
```cmd
set BLUESKY_HANDLE=dexteritycs.bsky.social
set BLUESKY_PASSWORD=your-app-password
set HOURS_BACK=24
node undo-likes.js
```

### Unfollow non-English accounts
```cmd
set BLUESKY_HANDLE=dexteritycs.bsky.social
set BLUESKY_PASSWORD=your-app-password
node unfollow-non-english.js
```

---

## Schedule

Runs automatically at `0 */4 * * *` UTC — every 4 hours, 6× per day:

| UTC | CDT |
|-----|-----|
| 12:00 AM | 7:00 PM |
| 4:00 AM | 11:00 PM |
| 8:00 AM | 3:00 AM |
| 12:00 PM | 7:00 AM |
| 4:00 PM | 11:00 AM |
| 8:00 PM | 3:00 PM |

Unfollows run once per day at **12:00 UTC (7:00 AM CDT)**.

A monthly keep-alive commit fires on the 1st of every month to prevent GitHub from disabling the workflow after 60 days.

---

## Troubleshooting

**Missing BLUESKY_HANDLE or BLUESKY_PASSWORD**
Check your repo secrets are named exactly `BLUESKY_HANDLE` and `BLUESKY_PASSWORD` (not `BLUESKY_APP_PASSWORD`).

**Duplicate runs / spam liking**
Don't cancel runs mid-execution. The concurrency lock prevents parallel runs but cancelling and re-triggering creates duplicate state. Let runs finish naturally.

**Workflow not running automatically**
GitHub sometimes skips scheduled runs on busy repos. The monthly keepalive commit prevents the 60-day deactivation. If it still doesn't run, go to Actions tab and manually enable the workflow.

**404 on manual trigger from dashboard**
Check the `GITHUB_USER` and `GITHUB_REPO` constants at the top of `index.html` match your actual repo.

**stats.json growing too large**
`lastLikedAt` is auto-pruned every 30 days. `hourlyActions` is filtered on every run. If the file is still large, delete `followedAt` entries older than 90 days manually.

---

## Links

- Dashboard: [dexteritycs.github.io/Bluesky-autolike](https://dexteritycs.github.io/Bluesky-autolike)
- Twitch: [twitch.tv/dexterity_cs](https://twitch.tv/dexterity_cs)
- Bluesky: [@dexteritycs.bsky.social](https://bsky.app/profile/dexteritycs.bsky.social)
- GitHub: [github.com/dexteritycs](https://github.com/dexteritycs)
