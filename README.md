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
| `ALERT_THRESHOLD` | `3` | Alert when this many *national* sources fail in one cycle. A metro alerts when it loses more than half its sources. Known-blocked sources don't count |
| `ALERT_WEBHOOK_URL` | *(unset)* | Any endpoint accepting a JSON POST. Slack and Discord incoming webhooks work as-is. Unset = log-only |

## API

| Route | Purpose |
|---|---|
| `GET /api/feed` | Cached feed payload. `?region=<id>` selects the local section; an unknown id falls back to the default rather than guessing |
| `GET /api/regions` | Regions available to the picker, and the timezones each claims as its default |
| `POST /api/refresh` | Force a re-pull. Requires `?token=` or `x-refresh-token` when `REFRESH_TOKEN` is set. Rate-limited to once per minute |
| `GET /healthz` | Health check — cache warmth, source counts, degraded flag |
| `GET /api/status` | Per-source health: status, item count, consecutive failures, last error. Add `?format=text` for a readable table |

### Monitoring

`/api/status?format=text` is the fastest way to see what's actually working:

```
OK     BBC News              3 items
DOWN   r/news                0 items  - Status code 429
OK     CNN                   3 items  [known-blocked]
```

Each source is `ok` (fetched fresh), `stale` (fetch failed, serving last known-good items), or `down` (failed with nothing cached). Output is grouped by collection, so a broken metro reads as one block.

Health is judged **per collection**, not globally — a flat count across ~46 sources would be meaningless. National trips at `ALERT_THRESHOLD`; a metro trips when it loses more than half of what it could serve, so 2 of 3 Seattle feeds going down still registers.

Alerts are **edge-triggered** — crossing the threshold fires once, not every cycle, and a second alert fires on recovery. Set `ALERT_WEBHOOK_URL` to get them pushed; otherwise they appear in the logs as `[ALERT]`.

## Content Sources

Sources live in two kinds of collection. **National** is shared by every reader; **metros** supply the local section and vary by region.

| Category | Sources |
|----------|---------|
| 📰 Top News | BBC, NYT, NPR, Guardian US, NBC News, CNN\*, AP News\*, Reuters\* |
| 🏆 Sports | ESPN, ESPN via Google\* |
| 💬 Reddit | r/popular, r/news |
| 🎥 Video | CNN, BBC, NBC News (YouTube) |
| 🔗 More | Fark |

\* Google News sources — **currently blocked from Render's IP.** See below.

### Regions

| Region | Sources |
|---|---|
| Los Angeles | LA Times, KTLA, ABC7 LA, LAist, Google News West LA\* |
| New York | Gothamist, ABC7 NY, NBC New York, NY Daily News, amNY |
| Chicago | Tribune, ABC7 Chicago, NBC Chicago, Block Club, Sun-Times |
| San Francisco Bay Area | SFGate, ABC7 SF, KQED, Mercury News, SF Standard |
| Washington DC | NBC Washington, WTOP, WAMU, DC News Now |
| Seattle | Seattle Times, KING5, MyNorthwest |
| Boston | Boston.com, NBC Boston, Boston Herald |

Every region is fetched on the same refresh cycle, so switching is a cache
lookup rather than a fetch — serving latency doesn't grow as regions are added.

**Picking a region.** An explicit choice wins and persists in localStorage.
Otherwise the browser's IANA timezone picks the default: a timezone identifies
a *zone*, not a city, so Pacific resolves to LA, Eastern to New York, and
Central to Chicago. Everything else falls back to LA. No permission prompt, no
network call, no geo-IP dependency. `?region=<id>` overrides both, which makes
regions linkable.

To add a region, add an entry to `METROS` in `server.js`. Nothing else needs to
change — the fetch, health, and alerting machinery treats every collection the
same way.

### Notes on sources

- **Google News is blocked from Render.** All five Google News feeds time out from the deployed service while responding in under a second from a home connection — datacenter-IP blocking. They're flagged `knownBlocked` in `FEED_SOURCES`: still fetched, still reported by `/api/status`, but excluded from the alert threshold so they don't mask new problems. Guardian US, NBC News, and LAist were added as direct-RSS stand-ins for the coverage lost.
- **CNN** killed its own RSS feeds — they still respond, but the newest item is from 2023. Google News was the only path to CNN content, so CNN is currently unavailable in production.
- **Reddit** rate-limits datacenter IPs (HTTP 429). Expect intermittent failures; the stale-cache fallback keeps the last good items on screen.
- Any source that fails is retried next cycle and falls back to its last known-good items, so one broken feed never empties a section.

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
