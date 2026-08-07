/* ═══════════════════════════════════════════════════════════════════════════
   The Feed — Frontend Application
   Fetches /api/feed, renders categorized cards, polls for server-side updates
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Configuration ────────────────────────────────────────────────────────────

// The server refreshes feeds on its own schedule. We just poll the cached
// payload and re-render when its fetchedAt changes — cheap, no network fanout.
const POLL_INTERVAL = 5 * 60 * 1000;   // 5 minutes
const CLOCK_INTERVAL = 60 * 1000;      // re-tick "3m ago" labels
const REGION_KEY = 'thefeed_region';   // remembers an explicit choice

const CATEGORY_CONFIG = {
  news:   { emoji: '📰', label: 'Top News' },
  local:  { emoji: '📍', label: 'Local' },
  sports: { emoji: '🏆', label: 'Sports' },
  reddit: { emoji: '💬', label: 'Reddit' },
  video:  { emoji: '🎥', label: 'Video' },
  more:   { emoji: '🔗', label: 'More' },
};

// Category display order
const CATEGORY_ORDER = ['news', 'local', 'sports', 'reddit', 'video', 'more'];

// ─── DOM References ───────────────────────────────────────────────────────────

const loadingState = document.getElementById('loading-state');
const errorState = document.getElementById('error-state');
const feedContainer = document.getElementById('feed-container');
const refreshBtn = document.getElementById('refresh-btn');
const retryBtn = document.getElementById('retry-btn');
const lastUpdatedEl = document.getElementById('last-updated');
const statusBanner = document.getElementById('status-banner');
const regionSelect = document.getElementById('region-select');

// ─── State ────────────────────────────────────────────────────────────────────

let renderedAt = null;   // fetchedAt of what's currently on screen
let hasRendered = false; // have we ever painted the feed?
let region = null;       // active region id, or null until resolved
let renderedRegion = null; // region of what's currently on screen

// ─── Region ───────────────────────────────────────────────────────────────────

/**
 * Pick a starting region without asking permission or making a network call.
 *
 * An explicit choice always wins. Otherwise we guess from the browser's IANA
 * timezone, which is synchronous, needs no permission, and is already exposed
 * to every site. It identifies a zone rather than a city — Pacific can't
 * distinguish LA from Seattle — so it only ever resolves to the metro that
 * claims that zone, and the picker corrects the rest.
 */
function resolveRegion(regions, serverDefault) {
  const stored = localStorage.getItem(REGION_KEY);
  if (stored && regions.some(r => r.id === stored)) return stored;

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const match = regions.find(r => (r.primaryFor || []).includes(tz));
    if (match) return match.id;
  } catch {
    // Intl is unavailable or threw — fall through to the default.
  }
  return serverDefault;
}

function populatePicker(regions, active) {
  regionSelect.replaceChildren();
  for (const r of regions) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.label;
    if (r.id === active) opt.selected = true;
    regionSelect.appendChild(opt);
  }
}

async function initRegion() {
  try {
    const res = await fetch('/api/regions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    region = resolveRegion(data.regions, data.default);
    populatePicker(data.regions, region);
  } catch (err) {
    console.error('Failed to load regions:', err);
    // The feed still works without a picker — the server falls back on its own.
  }
}

// ─── Fetch Feed ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {boolean} opts.force    ask the server to re-pull from source feeds
 * @param {boolean} opts.silent   background poll — don't blank the page
 */
async function loadFeed({ force = false, silent = false } = {}) {
  if (!silent) showLoading();

  try {
    const query = region ? `?region=${encodeURIComponent(region)}` : '';
    const response = force
      ? await fetch(`/api/refresh${query}`, { method: 'POST' })
      : await fetch(`/api/feed${query}`);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const activeRegion = data.region ? data.region.id : null;

    // Nothing new upstream — leave the DOM alone. A region switch always
    // repaints even when the timestamp is unchanged, since the local section
    // differs while the rest of the payload doesn't.
    if (data.fetchedAt === renderedAt && activeRegion === renderedRegion && hasRendered) {
      hideLoading();
      return;
    }

    renderFeed(data);
    renderedAt = data.fetchedAt;
    renderedRegion = activeRegion;
    updateLastRefreshed();
  } catch (err) {
    console.error('Failed to load feed:', err);
    // A failed background poll shouldn't tear down a page that's already good.
    if (!silent || !hasRendered) showError();
    else hideLoading();
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

/**
 * Surface a notice only once enough sources are failing for the server to
 * consider itself degraded. One flaky feed is normal and stays quiet.
 */
function renderStatusBanner(health) {
  if (!health || !health.degraded) {
    statusBanner.classList.add('hidden');
    return;
  }

  const failing = health.failing || [];
  statusBanner.replaceChildren();

  const icon = document.createElement('span');
  icon.className = 'status-banner-icon';
  icon.textContent = '⚠️';

  const text = document.createElement('span');
  text.textContent =
    `Showing ${health.ok} of ${health.total} sources.` +
    (failing.length ? ` Currently unavailable: ${failing.join(', ')}.` : '');

  statusBanner.append(icon, text);
  statusBanner.classList.remove('hidden');
}

function renderFeed(data) {
  const fragment = document.createDocumentFragment();

  for (const catKey of CATEGORY_ORDER) {
    const items = data.categories[catKey];
    if (!items || items.length === 0) continue;

    let config = CATEGORY_CONFIG[catKey] || { emoji: '📄', label: catKey };
    // The local heading names whichever metro is active.
    if (catKey === 'local' && data.region) {
      config = { ...config, label: `Local — ${data.region.label}` };
    }
    fragment.appendChild(createCategorySection(catKey, config, items));
  }

  feedContainer.replaceChildren(fragment);
  renderStatusBanner(data.health);
  hasRendered = true;
  hideLoading();
  feedContainer.classList.remove('hidden');
}

function createCategorySection(categoryKey, config, items) {
  const section = document.createElement('section');
  section.className = 'category-section';
  section.dataset.category = categoryKey;

  section.innerHTML = `
    <div class="category-header">
      <span class="category-emoji">${config.emoji}</span>
      <h2 class="category-title">${config.label}</h2>
      <span class="category-count">${items.length} items</span>
    </div>
    <div class="card-grid" id="grid-${categoryKey}"></div>
  `;

  const grid = section.querySelector('.card-grid');
  for (const item of items) {
    grid.appendChild(createCard(item));
  }

  return section;
}

function createCard(item) {
  const card = document.createElement('a');
  card.className = 'feed-card';
  card.href = safeUrl(item.url) || '#';
  card.target = '_blank';
  card.rel = 'noopener noreferrer';

  const imageUrl = safeUrl(item.image);
  const imageHtml = imageUrl
    ? `<img class="card-image" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';

  card.innerHTML = `
    ${imageHtml}
    <div class="card-body">
      <div class="card-meta">
        <span class="source-badge" data-category="${escapeHtml(item.category)}">${escapeHtml(item.source)}</span>
        <span class="card-timestamp" data-timestamp="${escapeHtml(item.timestamp)}">${formatTime(item.timestamp)}</span>
      </div>
      <h3 class="card-title">${escapeHtml(item.title)}</h3>
      ${item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : ''}
      <span class="card-link">
        Read more
        <span class="card-link-arrow">→</span>
      </span>
    </div>
  `;

  return card;
}

// ─── UI State Helpers ─────────────────────────────────────────────────────────

function showLoading() {
  errorState.classList.add('hidden');
  refreshBtn.classList.add('loading');
  // Only blank the page if there's nothing worth keeping on screen.
  if (!hasRendered) {
    loadingState.classList.remove('hidden');
    feedContainer.classList.add('hidden');
  }
}

function hideLoading() {
  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
  refreshBtn.classList.remove('loading');
}

function showError() {
  loadingState.classList.add('hidden');
  errorState.classList.remove('hidden');
  feedContainer.classList.add('hidden');
  statusBanner.classList.add('hidden');
  refreshBtn.classList.remove('loading');
}

function updateLastRefreshed() {
  if (!renderedAt) return;
  lastUpdatedEl.textContent = `Updated ${formatTime(renderedAt)}`;
}

/** Re-tick every relative timestamp on the page without refetching. */
function retickTimestamps() {
  updateLastRefreshed();
  for (const el of document.querySelectorAll('.card-timestamp')) {
    el.textContent = formatTime(el.dataset.timestamp);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Feed content is untrusted; never hand a javascript: URL to href or src. */
function safeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function formatTime(isoDate) {
  if (!isoDate) return '';

  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';

  const diffMs = Date.now() - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', () => loadFeed({ force: true }));
retryBtn.addEventListener('click', () => loadFeed());

// Switching region only re-assembles a cached payload server-side, so this is
// a fast repaint rather than a refetch of anyone's feeds.
regionSelect.addEventListener('change', () => {
  region = regionSelect.value;
  localStorage.setItem(REGION_KEY, region);
  loadFeed();
});

// Catch up whenever the tab comes back to the foreground — a laptop that was
// asleep for six hours should not show six-hour-old headlines.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadFeed({ silent: true });
});

// ─── Init ─────────────────────────────────────────────────────────────────────

// Resolve the region first so the very first paint already has the right local
// section — otherwise the reader sees LA flash before their own metro loads.
initRegion().finally(() => {
  loadFeed();
  setInterval(() => loadFeed({ silent: true }), POLL_INTERVAL);
  setInterval(retickTimestamps, CLOCK_INTERVAL);
});
