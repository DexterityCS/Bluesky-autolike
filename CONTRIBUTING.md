# Contributing / Forking Guide

This bot was built for the **dexterityCS** Bluesky account but is fully open source and easy to adapt for your own streaming brand.

---

## Forking for your own account

### 1. Fork the repo
Click **Fork** on GitHub and clone it to your account.

### 2. Update your identity
Edit the top of `bot.js` — no hardcoded handles, everything comes from secrets so nothing to change in the code itself.

### 3. Update `post-release.mjs`
Add your repo to the `REPO_CONTEXT` map so Claude knows what your tool does when writing release announcements:

```js
const REPO_CONTEXT = {
  // ... existing entries ...
  "your-repo-name": "a short description of what your tool does",
};
```

### 4. Customize your search terms
Edit `DEFAULT_TERMS` at the top of `bot.js` to match your game/niche:

```js
const DEFAULT_TERMS = [
  "#YourGame", "#YourNiche", "your keyword",
];
```

Or set the `SEARCH_TERMS` GitHub secret to a comma-separated list without touching the code.

### 5. Add your secrets
Follow the setup guide in `README.md` — at minimum you need `BLUESKY_HANDLE` and `BLUESKY_PASSWORD`.

### 6. Update the dashboard
At the top of `index.html`, update:

```js
const GITHUB_USER = "your-github-username";
const GITHUB_REPO = "your-repo-name";
```

And update `DEFAULT_TERMS` in the same file to match your game terms so the tag editor shows the right defaults.

---

## Adjusting filters for your niche

All thresholds are at the top of `bot.js` — no hunting through the code:

```js
const MIN_FOLLOWERS     = 10;   // raise for more established accounts only
const MIN_ACCOUNT_DAYS  = 30;   // raise to avoid newer accounts
const MAX_POST_AGE_DAYS = 7;    // lower for faster-moving communities
const REPLY_FREQUENCY   = 5;    // lower to reply more often
const DAILY_ACTION_CAP  = 200;  // raise if your niche has more content
```

---

## Adding a new game

1. Add search terms to `DEFAULT_TERMS` in `bot.js`
2. Add the same terms to `DEFAULT_TERMS` in `index.html`
3. Add game detection to `generateReply()` in `bot.js`:

```js
else if (text.includes("your game")) gameContext = "Your Game";
```

---

## Issues & suggestions

Open an issue on GitHub or reach out on Bluesky: [@dexteritycs.bsky.social](https://bsky.app/profile/dexteritycs.bsky.social)
