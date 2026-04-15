/**
 * Image Fallback — searches free image sources when no article/catalog image
 * is available for a thread or timeline card.
 *
 * Strategy:
 *   1. Extract search keywords from thread title + category + geographic_scope
 *   2. Query Wikimedia Commons (free, no API key) for relevant images
 *   3. Return the best candidate URL
 */

const WIKI_API = 'https://commons.wikimedia.org/w/api.php';

/* ── In-memory cache ── */
const _fallbackCache = new Map();   // query -> url|null
const CACHE_TTL = 30 * 60 * 1000;  // 30 min
const MAX_CACHE = 500;

function _cacheGet(key) {
  const entry = _fallbackCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) { _fallbackCache.delete(key); return undefined; }
  return entry.val;
}
function _cacheSet(key, val) {
  if (_fallbackCache.size >= MAX_CACHE) {
    // evict oldest
    const oldest = _fallbackCache.keys().next().value;
    _fallbackCache.delete(oldest);
  }
  _fallbackCache.set(key, { val, ts: Date.now() });
}

/* ── Concurrency limiter ── */
let _activeRequests = 0;
const MAX_CONCURRENT = 3;
const _queue = [];

function _acquireSlot() {
  if (_activeRequests < MAX_CONCURRENT) {
    _activeRequests++;
    return Promise.resolve();
  }
  return new Promise(resolve => _queue.push(resolve));
}
function _releaseSlot() {
  _activeRequests--;
  if (_queue.length > 0) {
    _activeRequests++;
    _queue.shift()();
  }
}

/**
 * Build a search query from thread/timeline metadata.
 * Prioritises geographic + topic keywords for relevance.
 */
function buildSearchQuery(title, category, geoScope, keywords) {
  const parts = [];

  // Geographic scope first (most distinctive)
  if (Array.isArray(geoScope)) {
    parts.push(...geoScope.slice(0, 2));
  } else if (geoScope) {
    parts.push(geoScope);
  }

  // Title words (drop short/common words)
  if (title) {
    const stopwords = new Set(['the','a','an','in','on','at','to','for','of','and','or','is','are','was','were','has','have','had','with','from','by','as','it','its','that','this','be','been','being','will','would','could','should','may','might','can','shall','do','does','did','not','no','but','if','so','than','too','very','just','about','over','after','before','between','under','during','without','within','against','into','through','new','says','say','said']);
    const words = title.split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w.toLowerCase()));
    parts.push(...words.slice(0, 4));
  }

  // Category as context
  if (category && !['story', 'default'].includes(category.toLowerCase())) {
    parts.push(category);
  }

  return parts.slice(0, 6).join(' ');
}

/**
 * Search Wikimedia Commons for images matching the query.
 * Returns array of { url, title, width, height }.
 */
async function searchWikimediaCommons(query, limit = 5) {
  if (!query) return [];
  try {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: `${query} filetype:bitmap`,
      gsrnamespace: '6',  // File namespace
      gsrlimit: String(limit),
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      iiurlwidth: '640',
      format: 'json',
      origin: '*'
    });

    const res = await fetch(`${WIKI_API}?${params}`, {
      headers: { 'User-Agent': 'EarthApp/1.0 (news aggregator)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const data = await res.json();

    const pages = data?.query?.pages;
    if (!pages) return [];

    const results = [];
    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      // Only accept actual images
      if (!info.mime?.startsWith('image/')) continue;
      // Skip SVGs and tiny images
      if (info.mime === 'image/svg+xml') continue;
      if ((info.width || 0) < 200 || (info.height || 0) < 150) continue;

      results.push({
        url: info.thumburl || info.url,
        title: page.title?.replace(/^File:/, '') || '',
        width: info.thumbwidth || info.width,
        height: info.thumbheight || info.height
      });
    }

    return results;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('[imageFallback] Wikimedia search failed:', err.message);
    }
    return [];
  }
}

/**
 * Find a fallback image for a thread/timeline.
 * @param {Object} item - { title, primary_category, geographic_scope, keywords }
 * @returns {string|null} Image URL or null
 */
async function findFallbackImage(item) {
  const query = buildSearchQuery(
    item.title,
    item.primary_category,
    item.geographic_scope,
    item.keywords
  );
  if (!query.trim()) return null;

  // Check cache first
  const cached = _cacheGet(query);
  if (cached !== undefined) return cached;

  // Acquire concurrency slot
  await _acquireSlot();
  try {
    // Double-check cache (another request may have filled it while we waited)
    const cached2 = _cacheGet(query);
    if (cached2 !== undefined) return cached2;

    const results = await searchWikimediaCommons(query, 5);
    if (!results.length) { _cacheSet(query, null); return null; }

    // Prefer landscape images (better for cards)
    const landscape = results.filter(r => r.width > r.height);
    const url = (landscape[0] || results[0]).url;
    _cacheSet(query, url);
    return url;
  } finally {
    _releaseSlot();
  }
}

/**
 * Bucket-first fallback: find an image from our own image_assets catalog
 * that matches the thread/timeline by country, keyword, or category.
 *
 * Match priority (first non-empty wins):
 *   1. country — any ISO in item.primary_nations maps to a country-tagged image
 *   2. keywords — item.keywords overlaps with image_assets.keywords
 *   3. primary_category — exact match
 *
 * Within each tier, we pick by (priority DESC, usage_count ASC, random()) so
 * well-curated images win and low-usage variants get rotated in.
 *
 * @param {Object} item - { primary_nations, keywords, feature_keywords, primary_category }
 * @param {Pool}   pool - pg Pool
 * @returns {Promise<string|null>} public_url or null
 */
async function findBucketImage(item, pool) {
  try {
    const isoCodes = Array.isArray(item.primary_nations) ? item.primary_nations.filter(Boolean) : [];
    const keywords = Array.isArray(item.keywords)
      ? item.keywords.filter(Boolean)
      : (Array.isArray(item.feature_keywords) ? item.feature_keywords.filter(Boolean) : []);
    const category = item.primary_category || null;

    // 1. Country-specific image from the bucket
    if (isoCodes.length) {
      const { rows } = await pool.query(`
        SELECT ia.public_url
        FROM image_assets ia
        JOIN countries co ON co.id = ia.country_id
        WHERE co.iso_code = ANY($1)
          AND ia.is_active = true
          AND ia.public_url IS NOT NULL
        ORDER BY ia.priority DESC, ia.usage_count ASC, random()
        LIMIT 1
      `, [isoCodes]);
      if (rows[0]?.public_url) return rows[0].public_url;
    }

    // 2. Keyword overlap
    if (keywords.length) {
      const { rows } = await pool.query(`
        SELECT public_url
        FROM image_assets
        WHERE keywords && $1::text[]
          AND is_active = true
          AND public_url IS NOT NULL
        ORDER BY priority DESC, usage_count ASC, random()
        LIMIT 1
      `, [keywords]);
      if (rows[0]?.public_url) return rows[0].public_url;
    }

    // 3. Category match
    if (category) {
      const { rows } = await pool.query(`
        SELECT public_url
        FROM image_assets
        WHERE primary_category = $1
          AND is_active = true
          AND public_url IS NOT NULL
        ORDER BY priority DESC, usage_count ASC, random()
        LIMIT 1
      `, [category]);
      if (rows[0]?.public_url) return rows[0].public_url;
    }

    return null;
  } catch (err) {
    console.warn('[imageFallback] bucket lookup failed:', err.message);
    return null;
  }
}

module.exports = { findFallbackImage, findBucketImage, searchWikimediaCommons, buildSearchQuery };
