# dexterityCS — Bluesky Auto-Engagement Bot

An intelligent GitHub Actions bot that grows your Bluesky presence by engaging with gaming content creators automatically. Runs every 4 hours, fully configurable via a GitHub Pages dashboard.

---

## Supported Games

- **CS2 / Counter-Strike** — primary focus
- **Apex Legends**
- **Rainbow Six Siege**
- **Overwatch / OW2**
- **Minecraft**
- **Terraria**

Search terms are fully customizable from the dashboard without touching secrets.

---

## Features

### Engagement
- Searches configurable hashtags and keywords across all supported games
- Deduplicates to the **most recent post per author** per run
- Skips image-only posts — requires readable text to filter and reply to
- Likes and follows authors not already engaged with recently
- Profile fetch fallback — if search result is stale, fetches the author's actual latest post
- Engagement scoring — sorts authors by likes × replies × reposts before processing
- Mutual network boost — accounts in your extended network get +10 priority score
- Likes back anyone who follows you with a recent post
- AI-generated contextual replies via Claude — reads each post, detects the game, replies as Dexterity
- Reply persona rotation — cycles between `hype`, `analytical`, and `friendly` each run
- English-only replies — AI language detection before replying (catches Latin-script languages like German, French, Spanish)
- Skips reposts and quote posts — only engages with original content

### Smart Filtering
- Skips accounts with fewer than **25 followers**
- Skips accounts created less than 30 days ago
- Skips posts older than 7 days
- Skips accounts with following/followers ratio above 10× (spam signal)
- **Post text language check** — AI English detection before liking, skips non-English posts entirely
- **Post text NSFW/political check** — filters post content before liking, not just profile bios
- **Image-only post skip** — posts with no text are skipped
- NSFW filter — checks Bluesky content labels, post text keywords, profile bio, display name, and handle
- Political filter — skips political, identity politics, and gender identity content
- Block list — permanently skip specific accounts
- **Auto-unfollow on block** — if an auto-blocked account is currently being followed, it gets unfollowed immediately
- **Filter hit log** — last 100 filter blocks recorded with handle, reason, keyword, and timestamp
- Minimum engagement score filter (configurable)

### Unfollow Management
- Smart unfollow timing — unfollows run within an **11:00–13:00 UTC window** (tolerates GitHub Actions cron delays)
- 14-day follow-back window — unfollows accounts that haven't followed back within 14 days
- Always keeps accounts that follow you back
- Whitelist support — add accounts to `whitelist.json` to protect them from unfollowing

### Safety & Rate Limiting
- Pause mode — toggle in dashboard to skip all scheduled runs
- Daily action cap: 200 actions across all runs
- Hourly limit: 60 actions per hour
- **Rate limit backoff** — retries up to 3× on Bluesky 429 responses with escalating delays
- Spike detector — halts if actions are 3× the historical average
- Concurrency lock — prevents parallel runs from duplicating actions
- 800ms delay between actions

### Automated Posts
- **Follower milestones** — auto-posts to Bluesky at 100, 250, 500, 1K, 2.5K, 5K, 10K followers
- **Weekly Monday summary** — auto-posts weekly stats recap every Monday
- Both use Claude to write genuine posts if `ANTHROPIC_API_KEY` is set

### Analytics & Reporting
- Cumulative stats in `stats.json`: likes, follows, unfollows, replies
- Growth velocity — 30-day follower history, daily average gain
- Best performing search terms — tracks which terms drive the most engagement
- **Term follow-back rate** — tracks which search terms produce accounts that actually follow back
- Follow-back rate — % of followed accounts that follow back over time
- Reply engagement tracker — tracks how many AI replies got liked or replied to
- **Reply persona performance** — tracks engagement rate per persona (hype / analytical / friendly)
- **Filter hit log** — last 100 blocks with reason and keyword for tuning filter lists
- Net follower gain per run
- Run history — last 10 runs with full stats
- Discord run summary webhook — optional embed after every run
- `lastLikedAt` auto-pruned every 30 days to keep `stats.json` lean

### Dashboard (GitHub Pages)
- Manual trigger with 60-second cooldown
- **Pause / Resume** toggle
- **⬇ Export** — downloads full stats as CSV
- **Live run log** — polls GitHub Actions API, shows step status, auto-refreshes every 10s
- **Blocklist manager** — add/remove accounts directly in the dashboard
- Inline GitHub token input — saved to localStorage
- Search term editor — add/remove terms without touching secrets, persists to localStorage
- Actions per run slider (10–100) — persists to localStorage
- Stat cards: Likes, Follows, Unfollows, Replies, Follow-back Rate, Last Run
- Run history table — last 10 runs color-coded
- Follower growth chart — 30-day canvas line chart
- Search term performance table — all terms ranked by cumulative engagement
- **Term follow-back rate table** — which search terms convert to actual followers (color-coded)
- **Reply persona performance table** — sent / liked / replied-to / engage% per persona
- **Filter hit log table** — last 100 blocked accounts with reason and timestamp
- Upcoming run times in your local timezone with live countdown
- Cron expression visual breakdown

---

## Repo Structure

```
Bluesky-autolike/
├── bot.js                          — core bot logic
├── index.html                      — GitHub Pages dashboard
├── stats.json                      — auto-generated cumulative stats
├── blocklist.json                  — auto-generated block list
├── whitelist.json                  — accounts protected from unfollowing
├── pause.json                      — auto-generated pause flag
├── README.md
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
| `ANTHROPIC_API_KEY` | Optional | Enables AI replies, language detection, milestone posts, weekly summaries |
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
const MIN_FOLLOWERS        = 25;   // minimum followers to engage with
const MIN_ACCOUNT_DAYS     = 30;   // minimum account age in days
const MAX_POST_AGE_DAYS    = 7;    // only like posts this many days old or newer
const MAX_FOLLOW_RATIO     = 10;   // max following/followers ratio (spam filter)
const DAILY_ACTION_CAP     = 200;  // max actions per day
const HOURLY_LIMIT         = 60;   // max actions per hour
const REPLY_FREQUENCY      = 3;    // reply every N likes (requires ANTHROPIC_API_KEY)
const REPLY_COOLDOWN_DAYS  = 7;    // days before replying to same account again
const MIN_REPLY_TEXT_LEN   = 30;   // min post length to attempt reply
const SPIKE_THRESHOLD      = 3;    // halt if actions are Nx the average
const FOLLOW_BACK_DAYS     = 14;   // unfollow if not followed back within this many days
const MIN_ENGAGEMENT_SCORE = 0;    // min post score to engage (0 = all posts)
const MUTUAL_NETWORK_BOOST = true; // boost accounts in your mutual network
const FOLLOWER_MILESTONES  = [100, 250, 500, 1000, 2500, 5000, 10000];
```

### Whitelist
Add handles to `whitelist.json` to protect accounts from being unfollowed regardless of follow-back status:

```json
[
  "ign.com",
  "eslcs.bsky.social"
]
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

Unfollows run once per day within the **11:00–13:00 UTC window (6:00–8:00 AM CDT)** to account for GitHub Actions scheduling delays.

A monthly keep-alive commit fires on the 1st of every month to prevent GitHub disabling the workflow after 60 days.

---

## Troubleshooting

**Missing BLUESKY_HANDLE or BLUESKY_PASSWORD**
Check secrets are named exactly `BLUESKY_HANDLE` and `BLUESKY_PASSWORD`.

**Duplicate runs / spam liking**
Don't cancel runs mid-execution. Let runs finish naturally — the concurrency lock handles overlapping triggers.

**Hit daily cap too fast**
Open `stats.json`, find `dailyActions`, delete today's date entry and commit. Or raise `DAILY_ACTION_CAP` temporarily in `bot.js`.

**NSFW/political filter too aggressive or missing content**
Edit `NSFW_TAGS` or `POLITICAL_TAGS` at the top of `bot.js`. Check the Filter Hit Log panel in the dashboard to see which keywords are triggering the most blocks and tune accordingly.

**Bot engaging with non-English accounts**
The AI bio language check requires `ANTHROPIC_API_KEY` to be set. Without it, only non-Latin-script languages (Cyrillic, Arabic, Chinese, etc.) are caught by the fallback script-based check.

**Unfollow check not running**
The unfollow window is 11:00–13:00 UTC. GitHub Actions crons can fire up to 30–60 minutes late — the 3-hour window accounts for this.

**Workflow not running automatically**
Go to Actions tab and manually enable the workflow. The monthly keepalive prevents the 60-day deactivation.

**404 on manual trigger from dashboard**
Check `GITHUB_USER` and `GITHUB_REPO` constants at the top of `index.html` match your actual repo.

**stats.json growing too large**
`lastLikedAt` auto-prunes every 30 days. If still large, manually delete old entries from `followedAt` for accounts older than 90 days.

**Rate limit errors**
The bot automatically retries up to 3× on 429 responses with escalating backoff. If rate limits persist, reduce `ACTIONS_PER_RUN` or `DAILY_ACTION_CAP`.

---

## Links

- Dashboard: [dexteritycs.github.io/Bluesky-autolike](https://dexteritycs.github.io/Bluesky-autolike)
- Twitch: [twitch.tv/dexterity_cs](https://twitch.tv/dexterity_cs)
- Bluesky: [@dexteritycs.bsky.social](https://bsky.app/profile/dexteritycs.bsky.social)
- GitHub: [github.com/dexteritycs](https://github.com/dexteritycs)
