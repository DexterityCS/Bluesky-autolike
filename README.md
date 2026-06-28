# dexterityCS — Bluesky Auto-Engagement Bot

An intelligent GitHub Actions bot that grows your Bluesky presence by engaging with gaming content creators automatically. Runs every 4 hours, fully configurable via a GitHub Pages dashboard. Includes a content bot that posts CS2, OW2, and incremental game content twice daily, and detects Steam 100% completions automatically.

---

## Supported Games

- **CS2 / Counter-Strike** — primary focus (disambiguation from Cities Skylines 2 built in)
- **Apex Legends**
- **Rainbow Six Siege**
- **Overwatch / OW2**
- **Minecraft**
- **Terraria**

Search terms are fully customizable from the dashboard without touching secrets.

---

## Features

### Engagement Bot (`bot.js`)

#### Engagement
- Searches configurable hashtags and keywords across all supported games
- Deduplicates to the **most recent post per author** per run
- Skips image-only posts — requires readable text to filter and reply to
- Likes and follows authors not already engaged with recently
- Profile fetch fallback — if search result is stale, fetches the author's actual latest post
- Engagement scoring — sorts authors by likes × replies × reposts before processing
- Mutual network boost — accounts in your extended network get +10 priority score
- Likes back anyone who follows you with a recent post
- AI-generated contextual replies via Claude — reads each post, detects the game, replies as Dexterity
- **Thread-aware replies** — fetches the full post thread before replying so context is never lost
- Reply persona rotation — cycles between `hype`, `analytical`, and `friendly` each run
- English-only replies — AI language detection before replying
- Skips reposts and quote posts — only engages with original content

#### Smart Filtering
- Skips accounts with fewer than **25 followers**
- Skips accounts created less than 30 days ago
- Skips posts older than 7 days
- Skips accounts with following/followers ratio above 10× (spam signal)
- **Post text language check** — AI English detection before liking, skips non-English posts entirely
- **Post text NSFW/political check** — filters post content before liking, not just profile bios
- **CS2 / Cities Skylines 2 disambiguation** — keyword exclusion list + AI disambiguation prevents engaging with city-builder content
- **Gist-powered filters** — `filters.json` in Gist is the source of truth; no filter lists in the repo
- **Leet speak normalization** — converts `0nlyf4ns` → `onlyfans` before checking
- NSFW filter — checks Bluesky content labels, post text, profile bio, display name, handle, and emoji
- Political filter — skips political, identity politics, and gender identity content
- Block list — permanently skip specific accounts
- **Auto-unfollow on block** — if an auto-blocked account is currently being followed, it gets unfollowed immediately
- **Filter hit log** — last 100 filter blocks recorded with handle, reason, keyword, and timestamp
- Three-layer reply guard — keyword check → AI gaming check → explicit CS2/Cities Skylines AI disambiguation

#### Unfollow Management
- **Once-per-day unfollow** — runs on the first cycle of each day
- 7-day follow-back window — unfollows accounts that haven't followed back
- **Follow-back rate recalculates from scratch** each run based on current following list — always accurate
- Unfollowing decrements the followed count so the rate never drifts
- Always keeps accounts that follow you back
- Whitelist support — add accounts to `data/whitelist.json` to protect them from unfollowing

#### Safety & Rate Limiting
- Pause mode — toggle in dashboard to skip all scheduled runs
- Daily action cap: 200 actions across all runs
- Hourly limit: 60 actions per hour
- **Rate limit backoff** — retries up to 3× on Bluesky 429 responses with escalating delays
- Spike detector — halts if actions are 3× the historical average
- 800ms delay between actions

#### Automated Posts
- **Follower milestones** — auto-posts to Bluesky at 100, 250, 500, 1K, 2.5K, 5K, 10K followers
- **Weekly Monday summary** — auto-posts weekly stats recap every Monday
- **Monthly Discord recap** — fires on the 1st of each month with full growth breakdown
- All posts use Claude to write genuine content if `ANTHROPIC_API_KEY` is set

#### Term Management
- **Smarter follow budget** — per-term follow allocation weighted by follow-back rate (50%), velocity (30%), engagement (20%)
- **Auto-trim dead terms** — terms averaging <0.5 engagements/run over 15 runs are removed automatically
- **Candidate discovery** — discovers new gaming hashtags from real posts and queues them for testing
- **Term graduation** — high-performing candidates (1.0+ avg/run over 15 runs) become permanently active
- **Follow-back rate alert** — Discord alert when rate drops below 2% with 50+ follows tracked

#### Analytics & Reporting
- Cumulative stats synced to a **GitHub Gist after every run** — no commit required
- Growth velocity — 30-day follower history, daily average gain
- Best performing search terms — tracks which terms drive the most engagement
- **Term follow-back rate** — tracks which search terms produce accounts that actually follow back
- **Average days to follow-back** per term — velocity tracking
- Follow-back rate — % of currently-followed accounts that have followed back
- Reply engagement tracker — tracks how many AI replies got liked or replied to
- **Reply persona × game performance** — engagement rate per persona per game combination
- **Filter hit log** — last 100 blocks with reason and keyword
- Net follower gain per run
- Run history — last 10 runs with full stats
- Discord run summary webhook after every run
- Discord follow-back notification when new accounts follow back
- Discord term lifecycle notifications — trim, graduate, discover, cycle

---

### Content Bot (`content_bot.js`)

Posts CS2, OW2, and incremental game content to Bluesky twice daily at 6pm and 9pm CST.

#### Content Types
- **CS2** — Premier grind updates, Nuke tips, gameplay observations (MG2 / 13,500 rating context)
- **OW2** — Silver climb content, Kiriko/Moira support tips, Soldier/Bastion/Junkrat damage takes
- **Incremental games** — Genuine honest thoughts on completed games from a rotating list of 120+ titles
- **Steam 100% celebrations** — Auto-detects new completions and posts immediately

#### Steam Integration
- Checks Steam achievement API each run for newly 100%'d games
- **Completion cutoff** — only celebrates games completed after the bot was set up (no retroactive posts)
- Only celebrates games in the incremental games list (prevents non-incremental games like CS2 triggering)
- **Auto-adds** newly celebrated games to `incremental_games.json` in Gist for future genuine-thoughts posts
- `incremental_games.json` lives in Gist — add new games without touching code

#### Rotation
Content types rotate: CS2 (3×) → OW2 (2×) → Incremental (2×) → repeat

#### Notifications
- Discord notification on every post with post text and content type
- Discord crash alert if the bot fails

---

### Dashboard (`index.html`)

#### Overview Tab
- Follower milestone tracker with progress bar (100 → 10K)
- Stat cards: Likes, Follows, Unfollows, Replies, Follow-back Rate, Last Run
- Run history table — last 10 runs color-coded
- Follower growth chart — 30-day canvas line chart

#### Engagement Tab
- Search term performance table — all terms ranked by cumulative engagement
- Follow-back leaderboard — top terms by follow-back rate with 🥇🥈🥉 medals
- Candidate term queue — discovered / testing / graduated status
- Graduated terms panel
- Reply engagement panel — persona × game like rates color-coded
- Trimmed terms panel

#### Controls Tab
- Manual trigger with 60-second cooldown
- Pause / Resume toggle
- Export stats as CSV
- Search term editor — add/remove terms, persists to localStorage
- Actions per run slider (10–100)
- GitHub token input with remember option
- Auto schedule panel — cron breakdown, upcoming run times with live countdown

#### Network Tab
- Blocklist manager — view, add, remove entries (read from Gist)
- Pagination on all list panels (10 per page)

---

## Repo Structure

```
Bluesky-autolike/
├── bot.js                          — engagement bot
├── content_bot.js                  — content posting bot
├── index.html                      — GitHub Pages dashboard
├── README.md
└── .github/
    └── workflows/
        ├── schedule.yml            — engagement bot (every 4 hours)
        ├── content-bot.yml         — content bot (6pm + 9pm CST)
        ├── keepalive.yml           — monthly commit to prevent deactivation
        └── post-release.yml        — auto-posts release notes to Bluesky
```

### Gist Files (not in repo)

| File | Description |
|------|-------------|
| `stats.json` | Live bot stats — updated every run |
| `blocklist.json` | Auto-blocked accounts |
| `trimmed_terms.json` | Auto-trimmed dead search terms |
| `candidate_terms.json` | Discovered candidate terms and status |
| `graduated_terms.json` | Permanently active graduated terms |
| `filters.json` | NSFW/political filter lists — source of truth |
| `content_stats.json` | Content bot state — rotation index, celebrated games |
| `incremental_games.json` | List of completed incremental games for content posts |

---

## Setup

### 1. Create a GitHub repo and push all files

### 2. Add Repository Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `BLUESKY_HANDLE` | ✅ | Your full handle e.g. `dexteritycs.bsky.social` |
| `BLUESKY_PASSWORD` | ✅ | App Password from bsky.app → Settings → App Passwords |
| `ANTHROPIC_API_KEY` | Optional | Enables AI replies, language detection, milestone posts, weekly summaries, content bot |
| `DISCORD_WEBHOOK_URL` | Optional | Discord channel webhook for run summaries and notifications |
| `SEARCH_TERMS` | Optional | Comma-separated override for scheduled runs |
| `ACTIONS_PER_RUN` | Optional | Default actions for scheduled runs (default: 25) |
| `GIST_TOKEN` | ✅ Recommended | PAT with `gist` scope — enables live dashboard and Gist data |
| `GIST_ID` | ✅ Recommended | ID of the Gist to write stats to (get from gist.github.com URL) |
| `STEAM_API_KEY` | Optional | Enables Steam 100% completion detection in content bot |

### 3. Set up your Gist

- Go to [gist.github.com](https://gist.github.com) → New secret gist
- Create the following files (all with content `{}`):
  - `stats.json`
  - `content_stats.json`
- Create with content `[]`:
  - `incremental_games.json`
- Create `filters.json` — paste the full filters JSON (see repo for template)
- Copy the Gist ID from the URL and add as `GIST_ID` secret
- Generate a PAT with only `gist` scope and add as `GIST_TOKEN` secret

### 4. Enable GitHub Actions

Actions tab → enable workflows if prompted.

### 5. Enable GitHub Pages

Settings → Pages → Source: `main` branch, `/ (root)` folder.
Dashboard: `dexteritycs.github.io/Bluesky-autolike`

### 6. Add your GitHub PAT to the dashboard

- `github.com/settings/tokens` → Generate new token (classic) → check `repo` scope
- Open the dashboard, paste your token, check "Remember on this device"

### 7. Run the one-time Steam scan (optional)

If you want the content bot to only celebrate future completions (not retroactively post about every game you've ever 100%'d), run the scan script once locally:

```bash
STEAM_API_KEY=your_key GIST_TOKEN=your_token node mark_existing_completions.js
```

Alternatively the content bot uses a **cutoff date** — any game where the last achievement was unlocked before the setup date is automatically skipped.

---

## Configuration

All thresholds are at the top of `bot.js`:

```js
const MIN_FOLLOWERS        = 25;    // minimum followers to engage with
const MIN_ACCOUNT_DAYS     = 30;    // minimum account age in days
const MAX_POST_AGE_DAYS    = 7;     // only like posts this many days old or newer
const MAX_FOLLOW_RATIO     = 10;    // max following/followers ratio (spam filter)
const DAILY_ACTION_CAP     = 200;   // max actions per day
const HOURLY_LIMIT         = 60;    // max actions per hour
const REPLY_FREQUENCY      = 3;     // reply every N likes (requires ANTHROPIC_API_KEY)
const REPLY_COOLDOWN_DAYS  = 7;     // days before replying to same account again
const MIN_REPLY_TEXT_LEN   = 30;    // min post length to attempt reply
const SPIKE_THRESHOLD      = 3;     // halt if actions are Nx the average
const FOLLOW_BACK_DAYS     = 7;     // unfollow if not followed back within this many days
const MIN_ENGAGEMENT_SCORE = 0;     // min post score to engage (0 = all posts)
const MUTUAL_NETWORK_BOOST = true;  // boost accounts in your mutual network
const FOLLOWER_MILESTONES  = [100, 250, 500, 1000, 2500, 5000, 10000];
```

### Filters

NSFW and political filters live in `filters.json` in your Gist — **not in the repo**. Edit them directly in the Gist and changes take effect on the next bot run. No commit needed.

The filter system uses:
- **Stem matching** — root words catch all variants
- **Exact matching** — for terms that need precision
- **Leet speak normalization** — catches `0nlyf4ns`, `p0rn` etc
- **Emoji detection** — flags suggestive emoji clusters in profiles

### Whitelist

Add handles to `data/whitelist.json` to protect accounts from being unfollowed:

```json
[
  "ign.com",
  "eslcs.bsky.social"
]
```

### Incremental Games List

Add games to `incremental_games.json` in your Gist. Any game you 100% on Steam after the setup date gets added automatically when the content bot celebrates it.

---

## Schedule

### Engagement Bot (`schedule.yml`)

Runs at `0 */4 * * *` UTC — every 4 hours, 6× per day:

| UTC | CST |
|-----|-----|
| 12:00 AM | 6:00 PM |
| 4:00 AM | 10:00 PM |
| 8:00 AM | 2:00 AM |
| 12:00 PM | 6:00 AM |
| 4:00 PM | 10:00 AM |
| 8:00 PM | 2:00 PM |

Unfollows run **once per day** on the first cycle of each day.

### Content Bot (`content-bot.yml`)

Runs twice daily:

| UTC | CST |
|-----|-----|
| 11:00 PM | 6:00 PM |
| 3:00 AM | 9:00 PM |

Steam completion checks run on every content bot run — if a new 100% is detected, a celebration post fires immediately regardless of the scheduled time.

---

## Troubleshooting

**Missing BLUESKY_HANDLE or BLUESKY_PASSWORD**
Check secrets are named exactly `BLUESKY_HANDLE` and `BLUESKY_PASSWORD`.

**Bot replying to Cities Skylines 2 posts instead of CS2**
Push the latest `bot.js` — it includes a Cities Skylines exclusion keyword list and AI disambiguation. Check the Actions log for `🎯 Skipped` messages to confirm it's working.

**NSFW/political content slipping through**
Edit `filters.json` directly in your Gist — add new stems or exact terms. Changes take effect on the next run. Check the Actions log for `🔒 Filters loaded from Gist` to confirm filters are loading.

**Filters not loading from Gist**
Check the Actions log — you should see `🔒 Filters loaded from Gist` early in the run. If you see a warning instead, verify `filters.json` exists in your Gist and is valid JSON.

**Follow-back rate looks wrong**
The rate now recalculates from scratch each run based on who you're currently following. After the first run with the new bot it should reset to an accurate number.

**Content bot celebrating games you already had 100%'d**
The bot uses a cutoff date (June 28, 2026) — games where the last achievement was unlocked before that date are automatically skipped. If a non-incremental game is being celebrated, make sure it's not in `incremental_games.json` in your Gist.

**Content bot not posting incremental thoughts**
Check that `incremental_games.json` exists in your Gist and has at least one entry. The bot logs `🎮 Loaded N incremental games from Gist` at startup.

**Bot engaging with non-English accounts**
The AI bio and post language checks require `ANTHROPIC_API_KEY` to be set. Without it, only non-Latin-script languages are caught by the fallback check.

**Hit daily cap too fast**
Open `stats.json` in your Gist, find `dailyActions`, delete today's date entry and save. Or raise `DAILY_ACTION_CAP` in `bot.js`.

**Dashboard not showing latest stats**
Stats update after every run via Gist. Check `GIST_TOKEN` and `GIST_ID` are set correctly as repo secrets.

**Workflow not running automatically**
Go to Actions tab and manually enable the workflow. The monthly keepalive prevents the 60-day deactivation.

**404 on manual trigger from dashboard**
Check `GITHUB_USER` and `GITHUB_REPO` constants at the top of `index.html` match your actual repo.

**Rate limit errors**
The bot automatically retries up to 3× on 429 responses with escalating backoff. If rate limits persist, reduce `ACTIONS_PER_RUN` or `DAILY_ACTION_CAP`.

---

## Links

- Dashboard: [dexteritycs.github.io/Bluesky-autolike](https://dexteritycs.github.io/Bluesky-autolike)
- Twitch: [twitch.tv/dexterity_cs](https://twitch.tv/dexterity_cs)
- Bluesky: [@dexteritycs.bsky.social](https://bsky.app/profile/dexteritycs.bsky.social)
- GitHub: [github.com/dexteritycs](https://github.com/dexteritycs)
