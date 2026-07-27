const express = require('express');
const Parser = require('rss-parser');
const path = require('path');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'TheFeed/1.0 (Content Aggregator)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['media:group', 'mediaGroup', { keepArray: false }],
      ['enclosure', 'enclosure', { keepArray: false }],
    ]
  }
});

const PORT = process.env.PORT || 3000;

// How often the server refreshes feeds in the background.
// Default 20 min = 3 refreshes/hour. Override with REFRESH_INTERVAL_MINUTES.
const REFRESH_INTERVAL_MS =
  (Number(process.env.REFRESH_INTERVAL_MINUTES) || 20) * 60 * 1000;

// If set, POST /api/refresh requires this token. Leave unset for local dev.
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || null;

// Don't let forced refreshes hammer upstream feeds.
const MIN_FORCED_REFRESH_MS = 60 * 1000;

// ─── Feed Sources Configuration ──────────────────────────────────────────────

const FEED_SOURCES = [
  // 📰 Major News
  { url: 'http://feeds.bbci.co.uk/news/rss.xml', category: 'news', sourceName: 'BBC News', maxItems: 3 },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', category: 'news', sourceName: 'New York Times', maxItems: 3 },
  // CNN retired their own RSS feeds (they still serve, but the newest item is
  // from 2023). Google News is the working path to CNN content.
  { url: 'https://news.google.com/rss/search?q=site:cnn.com&hl=en-US&gl=US&ceid=US:en', category: 'news', sourceName: 'CNN', maxItems: 3 },
  { url: 'https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en', category: 'news', sourceName: 'AP News', maxItems: 2 },
  { url: 'https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en', category: 'news', sourceName: 'Reuters', maxItems: 2 },
  { url: 'https://feeds.npr.org/1001/rss.xml', category: 'news', sourceName: 'NPR', maxItems: 2 },

  // 📍 Local — West LA
  { url: 'https://www.latimes.com/california/rss2.0.xml', category: 'local', sourceName: 'LA Times', maxItems: 3 },
  { url: 'https://ktla.com/news/local-news/feed/', category: 'local', sourceName: 'KTLA', maxItems: 3 },
  { url: 'https://abc7.com/feed/', category: 'local', sourceName: 'ABC7 LA', maxItems: 2 },
  { url: 'https://news.google.com/rss/search?q=west+los+angeles+OR+%22west+LA%22+when:7d&hl=en-US&gl=US&ceid=US:en', category: 'local', sourceName: 'West LA News', maxItems: 3 },

  // 🏆 Sports
  { url: 'https://www.espn.com/espn/rss/news', category: 'sports', sourceName: 'ESPN', maxItems: 4 },
  { url: 'https://news.google.com/rss/search?q=site:espn.com&hl=en-US&gl=US&ceid=US:en', category: 'sports', sourceName: 'ESPN (via Google)', maxItems: 3 },

  // 💬 Reddit — note: Reddit rate-limits datacenter IPs, so these may fail
  // intermittently once deployed. Stale-cache fallback covers the gaps.
  { url: 'https://www.reddit.com/r/popular/.rss', category: 'reddit', sourceName: 'r/popular', maxItems: 4 },
  { url: 'https://www.reddit.com/r/news/.rss', category: 'reddit', sourceName: 'r/news', maxItems: 3 },

  // 🎥 Video — YouTube channels via RSS
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCupvZG-5ko_eiXAupbDfxWw', category: 'video', sourceName: 'CNN (YouTube)', maxItems: 2 },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC16niRr50-MSBwiO3YDb3RA', category: 'video', sourceName: 'BBC (YouTube)', maxItems: 2 },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCeY0bbntWzzVIaj2z3QigXg', category: 'video', sourceName: 'NBC News (YouTube)', maxItems: 2 },

  // 🔗 More
  { url: 'https://www.fark.com/fark.rss', category: 'more', sourceName: 'Fark', maxItems: 4 },
];

// ─── State ────────────────────────────────────────────────────────────────────

let cachedFeed = null;          // last successfully built feed
let lastForcedRefresh = 0;      // rate-limit guard for POST /api/refresh
let inFlight = null;            // de-dupes concurrent fetches
const lastGoodBySource = new Map(); // sourceName -> items, for stale fallback

// ─── Feed Fetching & Normalization ────────────────────────────────────────────

/**
 * Only allow links we're willing to put in an href or img src. Feed content is
 * untrusted — a `javascript:` URL in a <link> would otherwise reach the DOM.
 */
function safeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Extract the best available image URL from a feed item.
 */
function extractImage(item) {
  // media:content
  if (item.mediaContent) {
    const url = item.mediaContent.$ ? item.mediaContent.$.url : item.mediaContent.url;
    if (url) return safeUrl(url);
  }
  // media:thumbnail
  if (item.mediaThumbnail) {
    const url = item.mediaThumbnail.$ ? item.mediaThumbnail.$.url : item.mediaThumbnail.url;
    if (url) return safeUrl(url);
  }
  // enclosure
  if (item.enclosure && item.enclosure.url && item.enclosure.type && item.enclosure.type.startsWith('image')) {
    return safeUrl(item.enclosure.url);
  }
  // Try to find an image in content
  if (item.content) {
    const match = item.content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return safeUrl(match[1]);
  }
  if (item['content:encoded']) {
    const match = item['content:encoded'].match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return safeUrl(match[1]);
  }
  // YouTube nests its thumbnail inside <media:group>.
  if (item.mediaGroup && item.mediaGroup['media:thumbnail']) {
    const thumb = [].concat(item.mediaGroup['media:thumbnail'])[0];
    const url = thumb && thumb.$ ? thumb.$.url : null;
    if (url) return safeUrl(url);
  }
  // Last resort for YouTube: derive the thumbnail from the video id.
  const ytMatch = (item.link || '').match(/[?&]v=([\w-]{11})/);
  if (ytMatch) return `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;

  return null;
}

/**
 * YouTube puts its blurb in <media:group><media:description>, not <description>.
 */
function extractMediaDescription(item) {
  if (item.mediaGroup && item.mediaGroup['media:description']) {
    const desc = [].concat(item.mediaGroup['media:description'])[0];
    if (typeof desc === 'string') return desc;
  }
  return '';
}

/**
 * Strip HTML tags and truncate to a clean summary.
 */
function cleanSummary(text, maxLength = 180) {
  if (!text) return '';
  // Strip HTML tags
  let clean = text.replace(/<[^>]*>/g, '');
  // Decode common HTML entities
  clean = clean.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();
  if (clean.length > maxLength) {
    clean = clean.substring(0, maxLength).replace(/\s+\S*$/, '') + '…';
  }
  return clean;
}

/**
 * Google News wraps every headline as "Real Headline - Publisher". Strip the
 * trailing publisher so those cards read like the rest.
 */
function cleanTitle(title, sourceUrl) {
  if (!title) return 'Untitled';
  if (!sourceUrl.includes('news.google.com')) return title;
  return title.replace(/\s+-\s+[^-]{2,40}$/, '').trim() || title;
}

/**
 * Fetch a single feed source and return normalized items. On failure, falls
 * back to the last good items for that source so one flaky feed doesn't leave
 * a hole in the page.
 */
async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const items = (feed.items || [])
      .map(item => ({
        title: cleanTitle(item.title, source.url),
        summary: cleanSummary(
          item.contentSnippet || item.content || item.description || extractMediaDescription(item)
        ),
        url: safeUrl(item.link || item.guid),
        image: extractImage(item),
        source: source.sourceName,
        category: source.category,
        timestamp: item.isoDate || item.pubDate || new Date().toISOString(),
      }))
      .filter(item => item.url)
      .slice(0, source.maxItems);

    if (items.length > 0) {
      lastGoodBySource.set(source.sourceName, items);
      return items;
    }
    console.warn(`[Feed Empty] ${source.sourceName} returned no usable items`);
  } catch (err) {
    console.error(`[Feed Error] ${source.sourceName}: ${err.message}`);
  }

  // Fail gracefully — reuse the last known-good items if we have any.
  const stale = lastGoodBySource.get(source.sourceName);
  if (stale) {
    console.warn(`[Feed Stale] ${source.sourceName}: serving ${stale.length} cached items`);
    return stale;
  }
  return [];
}

/**
 * Drop items that point at the same article. Google News aggregation means the
 * same story often arrives via two sources.
 */
function dedupe(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  return items.filter(item => {
    const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seenUrls.has(item.url) || (titleKey && seenTitles.has(titleKey))) return false;
    seenUrls.add(item.url);
    seenTitles.add(titleKey);
    return true;
  });
}

/**
 * Fetch every source concurrently and build the response payload.
 */
async function buildFeed() {
  console.log('[Fetch] Fetching all feeds…');
  const startTime = Date.now();

  const results = await Promise.allSettled(
    FEED_SOURCES.map(source => fetchSource(source))
  );

  const allItems = dedupe(
    results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
  );

  // Group into categories, newest first within each.
  const categories = {};
  for (const item of allItems) {
    if (!categories[item.category]) {
      categories[item.category] = [];
    }
    categories[item.category].push(item);
  }
  for (const cat of Object.keys(categories)) {
    categories[cat].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  const feed = {
    fetchedAt: new Date().toISOString(),
    fetchDurationMs: Date.now() - startTime,
    totalItems: allItems.length,
    categories,
  };

  console.log(`[Fetch] Done — ${allItems.length} items in ${feed.fetchDurationMs}ms`);
  return feed;
}

/**
 * Refresh the cache. Concurrent callers share one in-flight fetch rather than
 * each kicking off their own. If the refresh produces nothing, the previous
 * cache is kept.
 */
async function refreshFeed() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const feed = await buildFeed();
      if (feed.totalItems > 0 || !cachedFeed) {
        cachedFeed = feed;
      } else {
        console.warn('[Fetch] Refresh produced 0 items — keeping previous cache');
      }
      return cachedFeed;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check — used by hosts and uptime pingers.
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    hasCache: Boolean(cachedFeed),
    fetchedAt: cachedFeed ? cachedFeed.fetchedAt : null,
    totalItems: cachedFeed ? cachedFeed.totalItems : 0,
  });
});

// Feed data. Always served from cache — the background loop keeps it fresh, so
// this never blocks on the network except on a cold start.
app.get('/api/feed', async (req, res) => {
  try {
    const feed = cachedFeed || await refreshFeed();
    res.json(feed);
  } catch (err) {
    console.error('[API Error]', err);
    res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

// Force a refresh. Protected by REFRESH_TOKEN when that env var is set, and
// rate-limited so it can't be used to hammer upstream feeds.
app.post('/api/refresh', async (req, res) => {
  if (REFRESH_TOKEN) {
    const supplied = req.get('x-refresh-token') || req.query.token;
    if (supplied !== REFRESH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const now = Date.now();
  if (now - lastForcedRefresh < MIN_FORCED_REFRESH_MS && cachedFeed) {
    return res.json(cachedFeed); // too soon — hand back what we have
  }
  lastForcedRefresh = now;

  try {
    res.json(await refreshFeed());
  } catch (err) {
    console.error('[API Error]', err);
    res.status(500).json({ error: 'Failed to refresh feeds' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  const perHour = (60 / (REFRESH_INTERVAL_MS / 60000)).toFixed(1);
  console.log(`\n  🗞️  The Feed is running on port ${PORT}`);
  console.log(`  ⏱️  Refreshing every ${REFRESH_INTERVAL_MS / 60000} min (~${perHour}/hour)\n`);

  // Warm the cache immediately, then keep it fresh in the background.
  refreshFeed().catch(err => console.error('[Startup] Pre-warm failed:', err));
  setInterval(() => {
    refreshFeed().catch(err => console.error('[Background] Refresh failed:', err));
  }, REFRESH_INTERVAL_MS);
});
