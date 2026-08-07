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
//
// Sources are split into two kinds of collection: NATIONAL_SOURCES, shared by
// every reader, and one per-metro collection in METROS. Both are just named
// lists of the same source shape — the fetch, health and alerting machinery
// treats them identically.
const NATIONAL_SOURCES = [
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

// Per-metro local sources. `primaryFor` lists the IANA timezones this metro
// should win as the first-visit default — a timezone identifies the zone, not
// the city, so Pacific resolves to LA and Eastern to New York. Metros without
// it (SF, Seattle, Boston, DC) are reachable only by picking them, which the
// reader's choice then persists.
const METROS = {
  la: {
    label: 'Los Angeles',
    primaryFor: ['America/Los_Angeles', 'America/Tijuana', 'America/Vancouver'],
    sources: [
      { url: 'https://www.latimes.com/california/rss2.0.xml', sourceName: 'LA Times', maxItems: 3 },
      { url: 'https://ktla.com/news/local-news/feed/', sourceName: 'KTLA', maxItems: 3 },
      { url: 'https://abc7.com/feed/', sourceName: 'ABC7 LA', maxItems: 2 },
      { url: 'https://laist.com/index.rss', sourceName: 'LAist', maxItems: 3 },
      { url: 'https://news.google.com/rss/search?q=west+los+angeles+OR+%22west+LA%22+when:7d&hl=en-US&gl=US&ceid=US:en', sourceName: 'West LA News', maxItems: 3, knownBlocked: true },
    ],
  },
  nyc: {
    label: 'New York',
    primaryFor: ['America/New_York', 'America/Detroit', 'America/Toronto'],
    sources: [
      { url: 'https://gothamist.com/feed', sourceName: 'Gothamist', maxItems: 3 },
      { url: 'https://abc7ny.com/feed/', sourceName: 'ABC7 NY', maxItems: 2 },
      { url: 'https://www.nbcnewyork.com/?rss=y', sourceName: 'NBC New York', maxItems: 2 },
      { url: 'https://www.nydailynews.com/feed/', sourceName: 'NY Daily News', maxItems: 2 },
      { url: 'https://www.amny.com/feed/', sourceName: 'amNY', maxItems: 2 },
    ],
  },
  chi: {
    label: 'Chicago',
    primaryFor: ['America/Chicago', 'America/Winnipeg'],
    sources: [
      { url: 'https://www.chicagotribune.com/feed/', sourceName: 'Chicago Tribune', maxItems: 3 },
      { url: 'https://abc7chicago.com/feed/', sourceName: 'ABC7 Chicago', maxItems: 2 },
      { url: 'https://www.nbcchicago.com/?rss=y', sourceName: 'NBC Chicago', maxItems: 2 },
      { url: 'https://blockclubchicago.org/feed/', sourceName: 'Block Club Chicago', maxItems: 2 },
      { url: 'https://chicago.suntimes.com/rss/index.xml', sourceName: 'Chicago Sun-Times', maxItems: 2 },
    ],
  },
  sf: {
    label: 'San Francisco Bay Area',
    sources: [
      { url: 'https://www.sfgate.com/rss/feed/Bay-Area-News-429.php', sourceName: 'SFGate', maxItems: 3 },
      { url: 'https://abc7news.com/feed/', sourceName: 'ABC7 News SF', maxItems: 2 },
      // KQED's documented /news/feed path 404s; ww2 is the one that serves.
      { url: 'https://ww2.kqed.org/news/feed/', sourceName: 'KQED', maxItems: 2 },
      { url: 'https://www.mercurynews.com/feed/', sourceName: 'Mercury News', maxItems: 2 },
      { url: 'https://sfstandard.com/feed/', sourceName: 'SF Standard', maxItems: 2 },
    ],
  },
  sea: {
    label: 'Seattle',
    sources: [
      { url: 'https://www.seattletimes.com/feed/', sourceName: 'Seattle Times', maxItems: 4 },
      { url: 'https://www.king5.com/feeds/syndication/rss/news/local', sourceName: 'KING5', maxItems: 3 },
      { url: 'https://mynorthwest.com/feed/', sourceName: 'MyNorthwest', maxItems: 3 },
    ],
  },
  bos: {
    label: 'Boston',
    sources: [
      { url: 'https://www.boston.com/feed/', sourceName: 'Boston.com', maxItems: 4 },
      { url: 'https://www.nbcboston.com/?rss=y', sourceName: 'NBC Boston', maxItems: 3 },
      { url: 'https://www.bostonherald.com/feed/', sourceName: 'Boston Herald', maxItems: 3 },
    ],
  },
  dc: {
    label: 'Washington DC',
    sources: [
      { url: 'https://www.nbcwashington.com/?rss=y', sourceName: 'NBC Washington', maxItems: 3 },
      { url: 'https://wtop.com/feed/', sourceName: 'WTOP', maxItems: 3 },
      { url: 'https://wamu.org/feed/', sourceName: 'WAMU', maxItems: 2 },
      { url: 'https://www.dcnewsnow.com/feed/', sourceName: 'DC News Now', maxItems: 2 },
    ],
  },
};

const DEFAULT_REGION = 'la';

// Metro sources carry category 'local' implicitly — set it once here rather
// than repeating it on every entry above.
for (const metro of Object.values(METROS)) {
  for (const source of metro.sources) source.category = 'local';
}

// Every source across every collection, for health reporting and iteration.
const ALL_SOURCES = [
  ...NATIONAL_SOURCES,
  ...Object.values(METROS).flatMap(m => m.sources),
];

// ─── State ────────────────────────────────────────────────────────────────────

let nationalCache = null;       // { fetchedAt, categories } shared by everyone
let lastForcedRefresh = 0;      // rate-limit guard for POST /api/refresh
let inFlight = null;            // de-dupes concurrent fetches
let lastCycle = null;           // summary of the most recent refresh cycle
let alerting = false;           // edge-trigger guard so we alert on change only
const metroCache = new Map();   // regionId -> { fetchedAt, items }
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
 * Summarize one named collection's health from the per-source records.
 */
function summarizeCollection(name, sources) {
  const entries = sources.map(s => ({
    source: s.sourceName,
    ...(sourceHealth.get(s.sourceName) || { status: 'down', knownBlocked: Boolean(s.knownBlocked) }),
  }));

  const failures = entries.filter(e => e.status !== 'ok');
  // Known-blocked sources are excluded from the alert count — they'd otherwise
  // hold the alert permanently on and drown out anything new.
  const unexpected = failures.filter(e => !e.knownBlocked);
  const eligible = sources.filter(s => !s.knownBlocked).length;

  return {
    collection: name,
    total: sources.length,
    eligible,
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
 * Roll every collection up into a summary of the cycle that just finished.
 *
 * A flat failure count across ~45 sources would be meaningless, so each
 * collection is judged on its own: national trips at ALERT_THRESHOLD, and a
 * metro trips when it loses more than half of what it could serve — losing 2
 * of 3 Seattle feeds matters even though 2 is under the national threshold.
 */
function summarizeCycle(durationMs, totalItems) {
  const collections = [
    summarizeCollection('national', NATIONAL_SOURCES),
    ...Object.entries(METROS).map(([id, m]) => summarizeCollection(id, m.sources)),
  ];

  const breached = collections.filter(c => {
    const n = c.unexpectedFailures.length;
    if (!n) return false;
    return c.collection === 'national'
      ? n >= ALERT_THRESHOLD
      : n > c.eligible / 2;
  });

  return {
    at: new Date().toISOString(),
    durationMs,
    totalItems,
    sourcesTotal: ALL_SOURCES.length,
    ok: collections.reduce((a, c) => a + c.ok, 0),
    stale: collections.reduce((a, c) => a + c.stale, 0),
    down: collections.reduce((a, c) => a + c.down, 0),
    knownBlocked: collections.flatMap(c => c.knownBlocked),
    collections,
    breached,
    // Kept flat for the frontend banner and for /healthz.
    unexpectedFailures: collections.flatMap(c => c.unexpectedFailures),
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
  const breached = cycle.breached;

  if (breached.length && !alerting) {
    alerting = true;
    const lines = breached.flatMap(c => [
      `${c.collection}: ${c.unexpectedFailures.length}/${c.eligible} sources failing`,
      ...c.unexpectedFailures.map(
        f => `  • ${f.source} — ${f.status} (${f.consecutiveFailures}x): ${f.error}`
      ),
    ]);
    console.error(`[ALERT] ${breached.length} collection(s) degraded:\n${lines.join('\n')}`);
    await sendWebhook(
      `🚨 The Feed: ${breached.map(c => c.collection).join(', ')} degraded`,
      [...lines, `Serving ${cycle.totalItems} items from ${cycle.ok}/${cycle.sourcesTotal} sources.`]
    );
    return;
  }

  if (!breached.length && alerting) {
    alerting = false;
    console.log('[ALERT] Recovered — every collection back within threshold');
    await sendWebhook('✅ The Feed: recovered', [
      `${cycle.ok}/${cycle.sourcesTotal} sources OK, ${cycle.totalItems} items.`,
    ]);
  }
}

/**
 * Fetch one collection's sources concurrently and return deduped items.
 */
async function fetchCollection(sources) {
  const results = await Promise.allSettled(sources.map(source => fetchSource(source)));
  return dedupe(results.filter(r => r.status === 'fulfilled').flatMap(r => r.value));
}

/**
 * Refresh national and every metro in a single pass. All sources go out
 * concurrently, so wall-clock time is the slowest feed, not the sum.
 */
async function buildAll() {
  console.log(`[Fetch] Fetching ${ALL_SOURCES.length} feeds across ${Object.keys(METROS).length + 1} collections…`);
  const startTime = Date.now();

  const metroIds = Object.keys(METROS);
  const [nationalItems, ...metroItemLists] = await Promise.all([
    fetchCollection(NATIONAL_SOURCES),
    ...metroIds.map(id => fetchCollection(METROS[id].sources)),
  ]);

  // Group national items into categories, newest first within each.
  const categories = {};
  for (const item of nationalItems) {
    if (!categories[item.category]) categories[item.category] = [];
    categories[item.category].push(item);
  }
  for (const cat of Object.keys(categories)) {
    categories[cat].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  const durationMs = Date.now() - startTime;
  const totalItems = nationalItems.length + metroItemLists.reduce((a, l) => a + l.length, 0);
  const cycle = summarizeCycle(durationMs, totalItems);
  lastCycle = cycle;

  const national = { fetchedAt: cycle.at, categories, itemCount: nationalItems.length };
  const metros = new Map(
    metroIds.map((id, i) => [
      id,
      {
        fetchedAt: cycle.at,
        items: [...metroItemLists[i]].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
      },
    ])
  );

  console.log(
    `[Fetch] Done — ${totalItems} items in ${durationMs}ms | ` +
    `sources ok=${cycle.ok} stale=${cycle.stale} down=${cycle.down}` +
    (cycle.knownBlocked.length ? ` (known-blocked: ${cycle.knownBlocked.join(', ')})` : '')
  );
  if (cycle.unexpectedFailures.length) {
    console.warn(
      '[Fetch] Unexpected failures: ' +
      cycle.unexpectedFailures.map(f => `${f.source} (${f.error})`).join('; ')
    );
  }

  // Fire and forget — alerting must never delay or break a refresh.
  evaluateAlert(cycle).catch(err => console.error('[Alert] Failed:', err.message));

  return { national, metros };
}

/**
 * Refresh every cache. Concurrent callers share one in-flight fetch rather than
 * each kicking off their own. A collection that comes back empty keeps its
 * previous contents rather than blanking the section.
 */
async function refreshFeed() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { national, metros } = await buildAll();

      if (national.itemCount > 0 || !nationalCache) {
        nationalCache = national;
      } else {
        console.warn('[Fetch] National refresh produced 0 items — keeping previous cache');
      }

      for (const [id, entry] of metros) {
        if (entry.items.length > 0 || !metroCache.has(id)) {
          metroCache.set(id, entry);
        } else {
          console.warn(`[Fetch] ${id} refresh produced 0 items — keeping previous cache`);
        }
      }
      return nationalCache;
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
    hasCache: Boolean(nationalCache),
    fetchedAt: nationalCache ? nationalCache.fetchedAt : null,
    totalItems: lastCycle ? lastCycle.totalItems : 0,
    sourcesOk: lastCycle ? lastCycle.ok : null,
    sourcesTotal: ALL_SOURCES.length,
    regions: Object.keys(METROS).length,
    degraded: lastCycle ? lastCycle.breached.length > 0 : false,
  });
});

// Regions available to the picker, with the timezones each one claims as its
// first-visit default.
app.get('/api/regions', (req, res) => {
  res.json({
    default: DEFAULT_REGION,
    regions: Object.entries(METROS).map(([id, m]) => ({
      id,
      label: m.label,
      primaryFor: m.primaryFor || [],
      sources: m.sources.length,
    })),
  });
});

// Per-source status report. `?format=text` returns a plain-text table that's
// readable in a terminal or browser without tooling.
app.get('/api/status', (req, res) => {
  const describe = (s, collection) => {
    const h = sourceHealth.get(s.sourceName);
    return {
      source: s.sourceName,
      collection,
      category: s.category,
      knownBlocked: Boolean(s.knownBlocked),
      status: h ? h.status : 'unknown',
      items: h ? h.itemCount : 0,
      consecutiveFailures: h ? h.consecutiveFailures : 0,
      lastSuccessAt: h ? h.lastSuccessAt : null,
      lastError: h ? h.lastError : null,
    };
  };
  const sources = [
    ...NATIONAL_SOURCES.map(s => describe(s, 'national')),
    ...Object.entries(METROS).flatMap(([id, m]) => m.sources.map(s => describe(s, id))),
  ];

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
    `Alerting: ${alerting ? 'ACTIVE' : 'clear'} (national threshold ${ALERT_THRESHOLD}, ` +
      `metro threshold >half, webhook ${ALERT_WEBHOOK_URL ? 'configured' : 'not configured'})`,
  ];

  // Group by collection so a broken metro reads as one block, not scattered rows.
  for (const collection of ['national', ...Object.keys(METROS)]) {
    const rows = sources.filter(s => s.collection === collection);
    if (!rows.length) continue;
    const summary = lastCycle && lastCycle.collections.find(c => c.collection === collection);
    const label = collection === 'national' ? 'NATIONAL' : `${collection.toUpperCase()} — ${METROS[collection].label}`;
    lines.push('', `── ${label}` + (summary ? `  (ok ${summary.ok}/${summary.total})` : ''));
    lines.push(...rows.map(s =>
      `  ${(icon[s.status] || '?').padEnd(6)} ${s.source.padEnd(20)} ` +
      `${String(s.items).padStart(2)} items  ${s.knownBlocked ? '[known-blocked] ' : ''}` +
      `${s.lastError ? '- ' + s.lastError : ''}`
    ));
  }
  res.type('text/plain').send(lines.join('\n'));
});

/**
 * Assemble a reader's payload: the shared national cache plus one metro's
 * local items. Both sides are already in memory, so this is a couple of object
 * spreads — serving cost doesn't grow with the number of regions.
 */
function assembleFeed(regionId) {
  const metro = metroCache.get(regionId);
  const categories = { ...nationalCache.categories };
  if (metro && metro.items.length) categories.local = metro.items;

  const localCount = categories.local ? categories.local.length : 0;
  const cycle = lastCycle;

  return {
    fetchedAt: nationalCache.fetchedAt,
    fetchDurationMs: cycle ? cycle.durationMs : 0,
    totalItems: nationalCache.itemCount + localCount,
    region: { id: regionId, label: METROS[regionId].label },
    regions: Object.entries(METROS).map(([id, m]) => ({ id, label: m.label })),
    categories,
    health: {
      ok: cycle ? cycle.ok : 0,
      total: ALL_SOURCES.length,
      // Only surface a banner for problems that affect what this reader sees.
      degraded: cycle
        ? cycle.breached.some(c => c.collection === 'national' || c.collection === regionId)
        : false,
      failing: cycle
        ? cycle.breached
            .filter(c => c.collection === 'national' || c.collection === regionId)
            .flatMap(c => c.unexpectedFailures.map(f => f.source))
        : [],
    },
  };
}

// Feed data. Always served from cache — the background loop keeps it fresh, so
// this never blocks on the network except on a cold start.
app.get('/api/feed', async (req, res) => {
  try {
    if (!nationalCache) await refreshFeed();

    // An unrecognised region falls back to the default rather than guessing —
    // better to show LA and let the picker correct it than invent a match.
    const requested = String(req.query.region || '');
    const regionId = Object.prototype.hasOwnProperty.call(METROS, requested)
      ? requested
      : DEFAULT_REGION;

    res.json(assembleFeed(regionId));
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

  const requested = String(req.query.region || '');
  const regionId = Object.prototype.hasOwnProperty.call(METROS, requested)
    ? requested
    : DEFAULT_REGION;

  const now = Date.now();
  if (now - lastForcedRefresh < MIN_FORCED_REFRESH_MS && nationalCache) {
    return res.json(assembleFeed(regionId)); // too soon — hand back what we have
  }
  lastForcedRefresh = now;

  try {
    await refreshFeed();
    res.json(assembleFeed(regionId));
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
