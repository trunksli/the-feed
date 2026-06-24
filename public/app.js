/* ═══════════════════════════════════════════════════════════════════════════
   The Feed — Frontend Application
   Fetches /api/feed, renders categorized cards, handles refresh
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Configuration ────────────────────────────────────────────────────────────

const AUTO_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const STORAGE_KEY = 'thefeed_last_refresh';

const CATEGORY_CONFIG = {
  news:   { emoji: '📰', label: 'Top News' },
  local:  { emoji: '📍', label: 'Local — West LA' },
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
const lastUpdatedEl = document.getElementById('last-updated');

// ─── Fetch Feed ───────────────────────────────────────────────────────────────

async function loadFeed(forceRefresh = false) {
  showLoading();

  try {
    const url = forceRefresh ? '/api/refresh' : '/api/feed';
    const options = forceRefresh ? { method: 'POST' } : {};
    const response = await fetch(url, options);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    renderFeed(data);
    updateLastRefreshed(data.fetchedAt);
    localStorage.setItem(STORAGE_KEY, Date.now().toString());
  } catch (err) {
    console.error('Failed to load feed:', err);
    showError();
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderFeed(data) {
  feedContainer.innerHTML = '';

  for (const catKey of CATEGORY_ORDER) {
    const items = data.categories[catKey];
    if (!items || items.length === 0) continue;

    const config = CATEGORY_CONFIG[catKey] || { emoji: '📄', label: catKey };
    const section = createCategorySection(catKey, config, items);
    feedContainer.appendChild(section);
  }

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
  card.href = item.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';

  const imageHtml = item.image
    ? `<img class="card-image" src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';

  card.innerHTML = `
    ${imageHtml}
    <div class="card-body">
      <div class="card-meta">
        <span class="source-badge" data-category="${item.category}">${escapeHtml(item.source)}</span>
        <span class="card-timestamp">${formatTime(item.timestamp)}</span>
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
  loadingState.classList.remove('hidden');
  errorState.classList.add('hidden');
  feedContainer.classList.add('hidden');
  refreshBtn.classList.add('loading');
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
  refreshBtn.classList.remove('loading');
}

function updateLastRefreshed(isoDate) {
  const date = new Date(isoDate);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  lastUpdatedEl.textContent = `Updated ${dateStr} at ${timeStr}`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(isoDate) {
  if (!isoDate) return '';

  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── Auto-Refresh Logic ──────────────────────────────────────────────────────

function shouldAutoRefresh() {
  const lastRefresh = localStorage.getItem(STORAGE_KEY);
  if (!lastRefresh) return true;
  return (Date.now() - parseInt(lastRefresh, 10)) > AUTO_REFRESH_INTERVAL;
}

function scheduleAutoRefresh() {
  setInterval(() => {
    if (shouldAutoRefresh()) {
      console.log('[Auto-Refresh] Refreshing feed…');
      loadFeed(true);
    }
  }, 60 * 60 * 1000); // Check every hour
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', () => loadFeed(true));

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadFeed(shouldAutoRefresh());
  scheduleAutoRefresh();
});
