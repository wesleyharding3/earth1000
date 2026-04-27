/**
 * Image Fallback — bucket-only.
 *
 * Finds an article/thread/timeline hero image from our own curated
 * image_assets catalog when no scraped publisher image is available.
 *
 * (The live Wikimedia Commons fallback was removed — it was slow,
 * thematically off, and blocked requests on an external API.)
 */

// Concurrency cap: imageFallback runs PER ARTICLE during ingestion bursts,
// and at peak the articleListener processes 30+ articles in parallel.
// Each lookup does up to 3 sequential pool.query() calls, so without a
// limit a single burst would request ~90 pool slots simultaneously and
// starve every other API consumer (this was the root cause of the Render
// "remaining connection slots are reserved" / "sorry, too many clients
// already" / "timeout exceeded when trying to connect" log spam). Cap to
// 4 concurrent lookups — well below the web pool's headroom. Hand-rolled
// semaphore because the project's installed p-limit is ESM-only and this
// file is CommonJS.
function makeConcurrencyLimit(n) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < n && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => { active--; drain(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}
const _bucketLimit = makeConcurrencyLimit(4);

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
  return _bucketLimit(() => _findBucketImageInner(item, pool));
}

async function _findBucketImageInner(item, pool) {
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

/**
 * FINAL-LINE fallback. Guarantees `hero_image_url` is never null/empty for a
 * thread or timeline. Runs AFTER findBucketImage (which may still miss if
 * the bucket has no matching row, or the 6s race times out).
 *
 * Priority:
 *   1. item.hero_image_url already set → no change
 *   2. item.hero_iso_code               → https://flagcdn.com/w320/{iso}.png
 *   3. first ISO in item.primary_nations → same flag URL (also fills hero_iso_code)
 *   4. generic globe SVG data URL       → absolute last resort
 *
 * Synchronous — no DB calls. Mutates and returns the item.
 *
 * @param {Object} item - any object carrying hero_image_url / hero_iso_code / primary_nations
 * @returns {Object} the same item, with hero_image_url guaranteed non-null
 */
const FLAG_CDN_W320 = 'https://flagcdn.com/w320/';

// Generic globe SVG — small, neutral, always renders. Used only when a
// country flag can't be resolved. Matches the #1e293b slate-800 theme.
const GLOBE_PLACEHOLDER_DATA_URL =
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <rect width="120" height="120" fill="#1e293b"/>
  <circle cx="60" cy="60" r="34" fill="none" stroke="#64748b" stroke-width="2"/>
  <ellipse cx="60" cy="60" rx="34" ry="14" fill="none" stroke="#475569" stroke-width="1.4"/>
  <line x1="60" y1="26" x2="60" y2="94" stroke="#475569" stroke-width="1.4"/>
  <path d="M32 52 Q46 56 60 52 T88 52" fill="none" stroke="#475569" stroke-width="1.4"/>
  <path d="M32 68 Q46 72 60 68 T88 68" fill="none" stroke="#475569" stroke-width="1.4"/>
</svg>`
  );

function guaranteeHeroImage(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.hero_image_url) return item;

  // Tier 2: explicit ISO
  if (item.hero_iso_code) {
    const iso = String(item.hero_iso_code).trim().toLowerCase();
    if (iso && /^[a-z]{2,3}$/.test(iso)) {
      item.hero_image_url = FLAG_CDN_W320 + iso + '.png';
      return item;
    }
  }

  // Tier 3: primary_nations[0]
  if (Array.isArray(item.primary_nations) && item.primary_nations.length) {
    const first = String(item.primary_nations[0] || '').trim().toLowerCase();
    if (first && /^[a-z]{2,3}$/.test(first)) {
      item.hero_image_url = FLAG_CDN_W320 + first + '.png';
      if (!item.hero_iso_code) item.hero_iso_code = first.toUpperCase();
      return item;
    }
  }

  // Tier 4: generic globe — never empty
  item.hero_image_url = GLOBE_PLACEHOLDER_DATA_URL;
  return item;
}

module.exports = { findBucketImage, guaranteeHeroImage };
