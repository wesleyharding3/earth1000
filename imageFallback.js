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

  const results = await searchWikimediaCommons(query, 5);
  if (!results.length) return null;

  // Prefer landscape images (better for cards)
  const landscape = results.filter(r => r.width > r.height);
  return (landscape[0] || results[0]).url;
}

module.exports = { findFallbackImage, searchWikimediaCommons, buildSearchQuery };
