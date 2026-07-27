# 🗞️ The Feed

A clean, modern content aggregation dashboard that curates the latest from top news, local West LA, sports, Reddit, YouTube, and more — all in one scannable page.

## Quick Start

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000)

## Architecture

- **Backend**: Node.js + Express — fetches ~18 RSS sources concurrently, holds the result in memory
- **Frontend**: Vanilla HTML/CSS/JS — dark-themed card-based dashboard
- **Refresh**: the server re-pulls every source on a background timer; the browser polls the cached payload every 5 min and only re-renders when it actually changed

No database, no build step, two dependencies.

## Configuration

All optional — the defaults work.

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `REFRESH_INTERVAL_MINUTES` | `20` | How often the server re-pulls every feed. `15` = 4×/hour, `20` = 3×/hour, `30` = 2×/hour |
| `REFRESH_TOKEN` | *(unset)* | If set, `POST /api/refresh` requires it. Leave unset locally; set it in production |

## API

| Route | Purpose |
|---|---|
| `GET /api/feed` | Cached feed payload. Never blocks on the network except on a cold start |
| `POST /api/refresh` | Force a re-pull. Requires `?token=` or `x-refresh-token` when `REFRESH_TOKEN` is set. Rate-limited to once per minute |
| `GET /healthz` | Health check — reports whether the cache is warm and how old it is |

## Content Sources

| Category | Sources |
|----------|---------|
| 📰 Top News | BBC, NYT, CNN, AP News, Reuters, NPR |
| 📍 Local (West LA) | LA Times, KTLA, ABC7, Google News (West LA) |
| 🏆 Sports | ESPN |
| 💬 Reddit | r/popular, r/news |
| 🎥 Video | CNN, BBC, NBC News (YouTube) |
| 🔗 More | Fark |

### Notes on sources

- **CNN** killed its own RSS feeds — they still respond, but the newest item is from 2023. CNN content is pulled through Google News instead.
- **Reddit** rate-limits datacenter IPs (HTTP 429). Expect the Reddit section to fail intermittently once deployed; the stale-cache fallback keeps the last good items on screen.
- Any source that fails is retried on the next cycle and falls back to its last known-good items, so one broken feed never empties a section.

## Deployment

Deploys to any always-on Node host. `render.yaml` is included for Render.

**Important on free tiers:** most free plans (including Render's) spin the service down after ~15 minutes of inactivity. A sleeping process runs no timers, so the background refresh stops. Keep it awake with an external pinger hitting `/healthz` every 10 minutes, or use an always-on plan.

To drive refreshes externally instead of (or on top of) the built-in timer, have a cron service POST to:

```
https://YOUR-APP.onrender.com/api/refresh?token=YOUR_REFRESH_TOKEN
```

## Development

```bash
# Auto-restart on file changes
npm run dev
```
