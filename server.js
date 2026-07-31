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

// Raise an alert when this many sources fail in one cycle, not counting the
// ones we already know are blocked. Two flaky feeds is normal; five is a signal.
const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD) || 3;

// Optional. Any endpoint that accepts a JSON POST — a Slack or Discord
// incoming webhook works as-is. Unset means log-only alerting.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || null;

// ─── Feed Sources Configuration ──────────────────────────────────────────────

// Sources marked `knownBlocked` fail from Render's datacenter IP (Google News
// times out there, though it responds in under a second from a home
// connection). They're kept so /api/status shows if they ever come back, and
// so the alert threshold isn't permanently tripped by a known condition.
const FEED_SOURCES = [
  // 📰 Major News
  { url: 'http://feeds.bbci.co.uk/news/rss.xml', category: 'news', sourceName: 'BBC News', maxItems: 3 },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', category: 'news', sourceName: 'New York Times', maxItems: 3 },
  // CNN retired their own RSS feeds (they still serve, but the newest item is
  // from 2023). Google News is the only working path to CNN content.
  { url: 'https://news.google.com/rss/search?q=site:cnn.com&hl=en-US&gl=US&ceid=US:en', category: 'news', sourceName: 'CNN', maxItems: 3, knownBlocked: true },
  { url: 'https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en', category: 'news', sourceName: 'AP News', maxItems: 2, knownBlocked: true },
  { url: 'https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en', category: 'news', sourceName: 'Reuters', maxItems: 2, knownBlocked: true },
  { url: 'https://feeds.npr.org/1001/rss.xml', category: 'news', sourceName: 'NPR', maxItems: 2 },
  // Direct-RSS stand-ins for the wire services lost to the Google News block.
  { url: 'https://www.theguardian.com/us-news/rss', category: 'news', sourceName: 'Guardian US', maxItems: 2 },
  { url: 'https://feeds.nbcnews.com/nbcnews/public/news', category: 'news', sourceName: 'NBC News', maxItems: 2 },

  // 📍 Local — West LA
  { url: 'https://www.latimes.com/california/rss2.0.xml', category: 'local', sourceName: 'LA Times', maxItems: 3 },
  { url: 'https://ktla.com/news/local-news/feed/', category: 'local', sourceName: 'KTLA', maxItems: 3 },
  { url: 'https://abc7.com/feed/', category: 'local', sourceName: 'ABC7 LA', maxItems: 2 },
  { url: 'https://laist.com/index.rss', category: 'local', sourceName: 'LAist', maxItems: 3 },
  { url: 'https://news.google.com/rss/search?q=west+los+angeles+OR+%22west+LA%22+when:7d&hl=en-US&gl=US&ceid=US:en', category: 'local', sourceName: 'West LA News', maxItems: 3, knownBlocked: true },

  // 🏆 Sports
  { url: 'https://www.espn.com/espn/rss/news', category: 'sports', sourceName: 'ESPN', maxItems: 4 },
  { url: 'https://news.google.com/rss/search?q=site:espn.com&hl=en-US&gl=US&ceid=US:en', category: 'sports', sourceName: 'ESPN (via Google)', maxItems: 3, knownBlocked: true },

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
let lastCycle = null;           // summary of the most recent refresh cycle
let alerting = false;           // edge-trigger guard so we alert on change only
const lastGoodBySource = new Map(); // sourceName -> items, for stale fallback

// sourceName -> { status, lastSuccessAt, lastFailureAt, consecutiveFailures,
//                 lastError, itemCount }
// status: 'ok'    fetched fresh items this cycle
//         'stale' fetch failed but we're serving its last known-good items
//         'down'  fetch failed and we have nothing cached for it
const sourceHealth = new Map();

function recordSuccess(source, itemCount) {
  sourceHealth.set(source.sourceName, {
    status: 'ok',
    category: source.category,
    knownBlocked: Boolean(source.knownBlocked),
    lastSuccessAt: new Date().toISOString(),
    lastFailureAt: sourceHealth.get(source.sourceName)?.lastFailureAt || null,
    consecutiveFailures: 0,
    lastError: null,
    itemCount,
  });
}

function recordFailure(source, error, servingStale) {
  const prev = sourceHealth.get(source.sourceName);
  sourceHealth.set(source.sourceName, {
    status: servingStale ? 'stale' : 'down',
    category: source.category,
    knownBlocked: Boolean(source.knownBlocked),
    lastSuccessAt: prev?.lastSuccessAt || null,
    lastFailureAt: new Date().toISOString(),
    consecutiveFailures: (prev?.consecutiveFailures || 0) + 1,
    lastError: error,
    itemCount: servingStale ? (prev?.itemCount || 0) : 0,
  });
}

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
  let failure = 'unknown error';
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
      recordSuccess(source, items.length);
      return items;
    }
    failure = 'returned no usable items';
    console.warn(`[Feed Empty] ${source.sourceName} ${failure}`);
  } catch (err) {
    failure = err.message;
    console.error(`[Feed Error] ${source.sourceName}: ${failure}`);
  }

  // Fail gracefully — reuse the last known-good items if we have any.
  const stale = lastGoodBySource.get(source.sourceName);
  recordFailure(source, failure, Boolean(stale));
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
 * Roll per-source health up into a summary of the cycle that just finished.
 */
function summarizeCycle(durationMs, totalItems) {
  const entries = FEED_SOURCES.map(s => ({
    source: s.sourceName,
    ...(sourceHealth.get(s.sourceName) || { status: 'down', knownBlocked: Boolean(s.knownBlocked) }),
  }));

  const failures = entries.filter(e => e.status !== 'ok');
  // Known-blocked sources are excluded from the alert count — they'd otherwise
  // hold the alert permanently on and drown out anything new.
  const unexpected = failures.filter(e => !e.knownBlocked);

  return {
    at: new Date().toISOString(),
    durationMs,
    totalItems,
    sourcesTotal: FEED_SOURCES.length,
    ok: entries.filter(e => e.status === 'ok').length,
    stale: entries.filter(e => e.status === 'stale').length,
    down: entries.filter(e => e.status === 'down').length,
    knownBlocked: failures.filter(e => e.knownBlocked).map(e => e.source),
    unexpectedFailures: unexpected.map(e => ({
      source: e.source,
      status: e.status,
      error: e.lastError,
      consecutiveFailures: e.consecutiveFailures,
    })),
  };
}

/**
 * Post an alert to the webhook, if one is configured. Shaped so a Slack or
 * Discord incoming webhook renders it without any extra mapping.
 */
async function sendWebhook(title, lines) {
  if (!ALERT_WEBHOOK_URL) return;
  const message = [title, ...lines].join('\n');
  try {
    const res = await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`[Alert] Webhook returned HTTP ${res.status}`);
  } catch (err) {
    // Never let alerting break a refresh cycle.
    console.error(`[Alert] Webhook failed: ${err.message}`);
  }
}

/**
 * Alert when the number of unexpected failures crosses the threshold, and again
 * when it recovers. Edge-triggered: a sustained outage alerts once, not every
 * cycle.
 */
async function evaluateAlert(cycle) {
  const count = cycle.unexpectedFailures.length;

  if (count >= ALERT_THRESHOLD && !alerting) {
    alerting = true;
    const lines = cycle.unexpectedFailures.map(
      f => `• ${f.source} — ${f.status} (${f.consecutiveFailures}x): ${f.error}`
    );
    console.error(`[ALERT] ${count} sources failing:\n${lines.join('\n')}`);
    await sendWebhook(`🚨 The Feed: ${count} sources failing`, [
      ...lines,
      `Serving ${cycle.totalItems} items from ${cycle.ok}/${cycle.sourcesTotal} sources.`,
    ]);
    return;
  }

  if (count < ALERT_THRESHOLD && alerting) {
    alerting = false;
    console.log(`[ALERT] Recovered — ${count} sources failing, below threshold of ${ALERT_THRESHOLD}`);
    await sendWebhook('✅ The Feed: recovered', [
      `${cycle.ok}/${cycle.sourcesTotal} sources OK, ${cycle.totalItems} items.`,
    ]);
  }
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

  const durationMs = Date.now() - startTime;
  const cycle = summarizeCycle(durationMs, allItems.length);
  lastCycle = cycle;

  const feed = {
    fetchedAt: cycle.at,
    fetchDurationMs: durationMs,
    totalItems: allItems.length,
    categories,
    // Small enough for the frontend to show a degraded banner without a
    // second request.
    health: {
      ok: cycle.ok,
      total: cycle.sourcesTotal,
      degraded: cycle.unexpectedFailures.length >= ALERT_THRESHOLD,
      failing: cycle.unexpectedFailures.map(f => f.source),
    },
  };

  console.log(
    `[Fetch] Done — ${allItems.length} items in ${durationMs}ms | ` +
    `sources ok=${cycle.ok} stale=${cycle.stale} down=${cycle.down}` +
    (cycle.knownBlocked.length ? ` (known-blocked: ${cycle.knownBlocked.join(', ')})` : '')
  );
  if (cycle.unexpectedFailures.length) {
    console.warn(
      `[Fetch] Unexpected failures: ` +
      cycle.unexpectedFailures.map(f => `${f.source} (${f.error})`).join('; ')
    );
  }

  // Fire and forget — alerting must never delay or break a refresh.
  evaluateAlert(cycle).catch(err => console.error('[Alert] Failed:', err.message));

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
    sourcesOk: lastCycle ? lastCycle.ok : null,
    sourcesTotal: FEED_SOURCES.length,
    degraded: lastCycle ? lastCycle.unexpectedFailures.length >= ALERT_THRESHOLD : false,
  });
});

// Per-source status report. `?format=text` returns a plain-text table that's
// readable in a terminal or browser without tooling.
app.get('/api/status', (req, res) => {
  const sources = FEED_SOURCES.map(s => {
    const h = sourceHealth.get(s.sourceName);
    return {
      source: s.sourceName,
      category: s.category,
      knownBlocked: Boolean(s.knownBlocked),
      status: h ? h.status : 'unknown',
      items: h ? h.itemCount : 0,
      consecutiveFailures: h ? h.consecutiveFailures : 0,
      lastSuccessAt: h ? h.lastSuccessAt : null,
      lastError: h ? h.lastError : null,
    };
  });

  const payload = {
    checkedAt: new Date().toISOString(),
    alerting,
    alertThreshold: ALERT_THRESHOLD,
    webhookConfigured: Boolean(ALERT_WEBHOOK_URL),
    refreshIntervalMinutes: REFRESH_INTERVAL_MS / 60000,
    lastCycle,
    sources,
  };

  if (req.query.format !== 'text') return res.json(payload);

  const icon = { ok: 'OK  ', stale: 'STALE', down: 'DOWN', unknown: '?   ' };
  const lines = [
    `The Feed — source status @ ${payload.checkedAt}`,
    lastCycle
      ? `Last cycle: ${lastCycle.totalItems} items in ${lastCycle.durationMs}ms — ` +
        `ok=${lastCycle.ok} stale=${lastCycle.stale} down=${lastCycle.down}`
      : 'No refresh cycle has completed yet.',
    `Alerting: ${alerting ? 'ACTIVE' : 'clear'} (threshold ${ALERT_THRESHOLD}, ` +
      `webhook ${ALERT_WEBHOOK_URL ? 'configured' : 'not configured'})`,
    '',
    ...sources.map(s =>
      `${(icon[s.status] || '?').padEnd(6)} ${s.source.padEnd(20)} ` +
      `${String(s.items).padStart(2)} items  ${s.knownBlocked ? '[known-blocked] ' : ''}` +
      `${s.lastError ? '- ' + s.lastError : ''}`
    ),
  ];
  res.type('text/plain').send(lines.join('\n'));
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
