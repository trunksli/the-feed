# 🗞️ The Feed

A clean, modern content aggregation dashboard that curates the latest from top news, local West LA, sports, Reddit, YouTube, and more — all in one scannable page.

## Quick Start

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000)

## Architecture

- **Backend**: Node.js + Express — fetches and caches RSS feeds from 15+ sources
- **Frontend**: Vanilla HTML/CSS/JS — dark-themed card-based dashboard
- **Cache**: In-memory, 15-minute TTL

## Content Sources

| Category | Sources |
|----------|---------|
| 📰 Top News | BBC, NYT, CNN, AP News, Reuters |
| 📍 Local (West LA) | LA Times, KTLA, Google News (West LA) |
| 🏆 Sports | ESPN |
| 💬 Reddit | r/popular, r/news |
| 🎥 Video | CNN, BBC, NBC News (YouTube) |
| 🔗 More | Fark |

## Development

```bash
# Run with auto-restart on file changes (Node.js 18+)
npm run dev
```

## Deployment

This app is ready to deploy to any Node.js hosting platform:

- **Render**: Connect GitHub repo → auto-deploys on push
- **Railway**: Connect GitHub repo → auto-deploys on push
- **Fly.io**: `fly launch` → `fly deploy`

Set the `PORT` environment variable if needed (defaults to 3000).
