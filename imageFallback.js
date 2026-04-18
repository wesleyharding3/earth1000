/**
 * Image Fallback — bucket-only.
 *
 * Finds an article/thread/timeline hero image from our own curated
 * image_assets catalog when no scraped publisher image is available.
 *
 * (The live Wikimedia Commons fallback was removed — it was slow,
 * thematically off, and blocked requests on an external API.)
 */

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

module.exports = { findBucketImage };
