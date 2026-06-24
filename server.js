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
      ['enclosure', 'enclosure', { keepArray: false }],
    ]
  }
});

const PORT = process.env.PORT || 3000;

// ─── Feed Sources Configuration ──────────────────────────────────────────────

const FEED_SOURCES = [
  // 📰 Major News
  { url: 'http://feeds.bbci.co.uk/news/rss.xml', category: 'news', sourceName: 'BBC News', maxItems: 3 },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', category: 'news', sourceName: 'New York Times', maxItems: 3 },
  { url: 'http://rss.cnn.com/rss/cnn_topstories.rss', category: 'news', sourceName: 'CNN', maxItems: 3 },
  { url: 'https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en', category: 'news', sourceName: 'AP News', maxItems: 2 },
  { url: 'https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en', category: 'news', sourceName: 'Reuters', maxItems: 2 },

  // 📍 Local — West LA
  { url: 'https://www.latimes.com/california/rss2.0.xml', category: 'local', sourceName: 'LA Times', maxItems: 3 },
  { url: 'https://ktla.com/news/local-news/feed/', category: 'local', sourceName: 'KTLA', maxItems: 3 },
  { url: 'https://news.google.com/rss/search?q=west+los+angeles+OR+%22west+LA%22+when:7d&hl=en-US&gl=US&ceid=US:en', category: 'local', sourceName: 'West LA News', maxItems: 3 },

  // 🏆 Sports
  { url: 'https://www.espn.com/espn/rss/news', category: 'sports', sourceName: 'ESPN', maxItems: 4 },
  { url: 'https://news.google.com/rss/search?q=site:espn.com&hl=en-US&gl=US&ceid=US:en', category: 'sports', sourceName: 'ESPN (via Google)', maxItems: 3 },

  // 💬 Reddit
  { url: 'https://www.reddit.com/r/popular/.rss', category: 'reddit', sourceName: 'r/popular', maxItems: 4 },
  { url: 'https://www.reddit.com/r/news/.rss', category: 'reddit', sourceName: 'r/news', maxItems: 3 },

  // 🎥 Video — YouTube channels via RSS
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCupvZG-5ko_eiXAupbDfxWw', category: 'video', sourceName: 'CNN (YouTube)', maxItems: 2 },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC16niRr50-MSBwiO3YDb3RA', category: 'video', sourceName: 'BBC (YouTube)', maxItems: 2 },
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCYfdidRxbB8Qhf0Nx7ioOYw', category: 'video', sourceName: 'NBC News (YouTube)', maxItems: 2 },

  // 🔗 More
  { url: 'https://www.fark.com/fark.rss', category: 'more', sourceName: 'Fark', maxItems: 4 },
];

// ─── Cache ────────────────────────────────────────────────────────────────────

let cachedFeed = null;
let cacheTimestamp = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ─── Feed Fetching & Normalization ────────────────────────────────────────────

/**
 * Extract the best available image URL from a feed item.
 */
function extractImage(item) {
  // media:content
  if (item.mediaContent) {
    const url = item.mediaContent.$ ? item.mediaContent.$.url : item.mediaContent.url;
    if (url) return url;
  }
  // media:thumbnail
  if (item.mediaThumbnail) {
    const url = item.mediaThumbnail.$ ? item.mediaThumbnail.$.url : item.mediaThumbnail.url;
    if (url) return url;
  }
  // enclosure
  if (item.enclosure && item.enclosure.url && item.enclosure.type && item.enclosure.type.startsWith('image')) {
    return item.enclosure.url;
  }
  // Try to find an image in content
  if (item.content) {
    const match = item.content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];
  }
  if (item['content:encoded']) {
    const match = item['content:encoded'].match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];
  }
  return null;
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
 * Fetch a single feed source and return normalized items.
 */
async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const items = (feed.items || []).slice(0, source.maxItems).map(item => ({
      title: item.title || 'Untitled',
      summary: cleanSummary(item.contentSnippet || item.content || item.description || ''),
      url: item.link || item.guid || '#',
      image: extractImage(item),
      source: source.sourceName,
      category: source.category,
      timestamp: item.isoDate || item.pubDate || new Date().toISOString(),
    }));
    return items;
  } catch (err) {
    console.error(`[Feed Error] ${source.sourceName}: ${err.message}`);
    return []; // Fail gracefully — don't break other sources
  }
}

/**
 * Fetch all feed sources concurrently.
 */
async function fetchAllFeeds() {
  const now = Date.now();

  // Return cache if fresh
  if (cachedFeed && (now - cacheTimestamp) < CACHE_TTL) {
    console.log('[Cache] Serving cached feed');
    return cachedFeed;
  }

  console.log('[Fetch] Fetching all feeds...');
  const startTime = Date.now();

  const results = await Promise.allSettled(
    FEED_SOURCES.map(source => fetchSource(source))
  );

  const allItems = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // Sort by timestamp descending (newest first) within each category
  const categories = {};
  for (const item of allItems) {
    if (!categories[item.category]) {
      categories[item.category] = [];
    }
    categories[item.category].push(item);
  }

  // Sort each category by date
  for (const cat of Object.keys(categories)) {
    categories[cat].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  const feed = {
    fetchedAt: new Date().toISOString(),
    fetchDurationMs: Date.now() - startTime,
    totalItems: allItems.length,
    categories,
  };

  // Update cache
  cachedFeed = feed;
  cacheTimestamp = now;

  console.log(`[Fetch] Done — ${allItems.length} items in ${feed.fetchDurationMs}ms`);
  return feed;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint
app.get('/api/feed', async (req, res) => {
  try {
    const feed = await fetchAllFeeds();
    res.json(feed);
  } catch (err) {
    console.error('[API Error]', err);
    res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

// Force refresh endpoint (bypasses cache)
app.post('/api/refresh', async (req, res) => {
  cachedFeed = null;
  cacheTimestamp = 0;
  try {
    const feed = await fetchAllFeeds();
    res.json(feed);
  } catch (err) {
    console.error('[API Error]', err);
    res.status(500).json({ error: 'Failed to refresh feeds' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🗞️  The Feed is running on port ${PORT}\n`);
  // Pre-warm the cache on startup
  fetchAllFeeds().catch(err => console.error('[Startup] Pre-warm failed:', err));
});
