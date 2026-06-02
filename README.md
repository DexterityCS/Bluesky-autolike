# dexterityCS — Bluesky CS2 Auto-Liker/Follower

Automatically likes posts tagged **#CS2** and **#CounterStrike** on Bluesky and follows their authors. Runs every 4 hours via GitHub Actions. Includes a GitHub Pages dashboard for manual triggers.

## Features
- Searches for search terms you specify 
- Likes posts and follows authors automatically
- Skips accounts you already follow
- Moderate pace: 20–30 actions per run (rate-limit safe)
- Runs every 4 hours via GitHub Actions (free)
- Manual trigger dashboard via GitHub Pages

## Setup

### 1. Clone & push to a new GitHub repo
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/bluesky-cs2-bot.git
git push -u origin main
```

### 2. Add Repository Secrets
Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `BLUESKY_HANDLE` | Your full handle e.g. `dexterity-cs.bsky.social` |
| `BLUESKY_PASSWORD` | An App Password from bsky.app → Settings → App Passwords |

### 3. Enable GitHub Actions
Go to the **Actions** tab and enable workflows if prompted.

### 4. Enable GitHub Pages (for dashboard)
Go to **Settings → Pages**, set source to `main` branch, root folder.

### 5. Update dashboard config
In `index.html`, update the top of the script:
```js
const GITHUB_USER = "your-username";
const GITHUB_REPO = "bluesky-autolike";
```

## Manual Trigger
You'll need a GitHub Personal Access Token with `actions:write` scope to trigger runs from the dashboard. Create one at github.com/settings/tokens.

## Schedule
Runs automatically at: `0 */4 * * *` (every 4 hours, 6× per day)

## Adjusting Aggressiveness
Edit `ACTIONS_PER_RUN` in `bot.js`:
- Conservative: `10`
- Moderate: `25` (default)
- Aggressive: `50`
