# dexterityCS — Bluesky CS2 Auto-Liker/Follower

An intelligent GitHub Actions bot that grows your Bluesky presence by engaging with CS2 content creators automatically. Runs every 4 hours, fully configurable via a GitHub Pages dashboard.

---

## Features

### Engagement
- Searches configurable hashtags and keywords (default: `#CS2`, `#CounterStrike`, `#CounterStrike2`, `#CS2clips`, `CS2`, `counter-strike`)
- Likes the most recent post per author — never spams multiple posts from the same account
- Follows authors not already in your following list
- Likes back anyone who follows you and has a recent post
- AI-generated replies via Claude — every 5 likes, reads the post and replies as Dexterity with a genuine contextual response

### Smart Filtering
- Skips accounts with fewer than 10 followers (bot signal)
- Skips accounts created less than 30 days ago (new/spam accounts)
- Skips posts older than 7 days (keeps engagement fresh)
- Skips accounts with a following/followers ratio above 10x (spam signal)

### Unfollow Management
- Automatically unfollows accounts that are **both** inactive for 60+ days **and** not following you back
- Always keeps accounts that follow you back regardless of activity

### Safety & Rate Limiting
- Daily action cap: 200 actions across all runs
- Hourly limit: 60 actions per hour
- 800ms delay between actions to avoid API rate limiting
- Concurrency lock — prevents parallel runs from duplicating actions

### Reporting & Analytics
- Cumulative stats tracked in `stats.json`: likes, follows, unfollows, replies
- Follow-back rate — tracks what % of followed accounts follow back over time
- Growth velocity — logs your follower count daily, shows average gain per day
- Best performing search terms — tracks which terms drive the most engagement across runs
- Filtered accounts counter — shows how many accounts were skipped by quality filters per run

### Dashboard (GitHub Pages)
- Manual trigger with 60-second cooldown to prevent double dispatch
- Inline GitHub token input — saved to localStorage, persists across reloads
- Search term editor — add/remove terms without touching GitHub secrets
- Actions per run slider (10–100) — persists to localStorage
- Live stat cards: Likes, Follows, Unfollows, Replies, Follow-back Rate, Last Run
- Upcoming run times in your local timezone with live countdown
- Cron expression visual breakdown
- Auto-schedule display (every 4 hours, 6× per day)

---

## Repo Structure

```
Bluesky-autolike/
├── bot.js                          — core bot logic
├── index.html                      — GitHub Pages dashboard
├── package.json
├── stats.json                      — auto-generated, tracks cumulative stats
├── README.md
├── RELEASE_NOTES.md
└── .github/
    └── workflows/
        ├── schedule.yml            — main bot workflow (every 4 hours)
        ├── keepalive.yml           — monthly commit to prevent workflow deactivation
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
| `ANTHROPIC_API_KEY` | Optional | Enables AI-generated replies via Claude |
| `SEARCH_TERMS` | Optional | Comma-separated override for scheduled runs |
| `ACTIONS_PER_RUN` | Optional | Default actions for scheduled runs (default: 25) |

### 3. Enable GitHub Actions
Actions tab → enable workflows if prompted.

### 4. Enable GitHub Pages
Settings → Pages → Source: `main` branch, `/ (root)` folder.

Dashboard will be live at: `dexteritycs.github.io/Bluesky-autolike`

### 5. Add your GitHub PAT to the dashboard
- Go to `github.com/settings/tokens` → Generate new token (classic)
- Check `repo` scope
- Open the dashboard, paste your token, check "Remember on this device"

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

A monthly keep-alive commit fires on the 1st of every month to prevent GitHub from disabling the scheduled workflow after 60 days of inactivity.

---

## Configuration

All thresholds are at the top of `bot.js`:

```js
const INACTIVE_DAYS      = 60;   // days before unfollowing inactive non-followers
const MIN_FOLLOWERS      = 10;   // minimum followers to engage with
const MIN_ACCOUNT_DAYS   = 30;   // minimum account age to engage with
const MAX_POST_AGE_DAYS  = 7;    // only like posts this many days old or newer
const MAX_FOLLOW_RATIO   = 10;   // max following/followers ratio (spam filter)
const DAILY_ACTION_CAP   = 200;  // max actions per day across all runs
const HOURLY_LIMIT       = 60;   // max actions per hour
const REPLY_FREQUENCY    = 5;    // reply every N likes (requires ANTHROPIC_API_KEY)
```

---

## Links

- Dashboard: [dexteritycs.github.io/Bluesky-autolike](https://dexteritycs.github.io/Bluesky-autolike)
- Twitch: [twitch.tv/dexterity_cs](https://twitch.tv/dexterity_cs)
- Bluesky: [@dexteritycs.bsky.social](https://bsky.app/profile/dexteritycs.bsky.social)
