'use strict';

/**
 * prewarmCommon.js
 *
 * Shared helpers for the prewarm-* crons.
 *
 * forceRefreshCaches({ apiUrl, prefixes, keys, tag, timeoutMs }):
 *   POSTs to /internal/cache/evict on the API server to invalidate cache
 *   entries by prefix or exact key. Without this, a warmer that runs while
 *   the in-memory ttlCache is still fresh just touches the cache without
 *   refreshing — every endpoint short-circuits and returns the stale value.
 *
 *   This call should fire BEFORE the warmer's GET requests so the
 *   subsequent fetches cache-miss and repopulate from current DB state.
 *
 *   Auth: shared secret in CACHE_EVICT_SECRET env var (must be set on
 *   BOTH the API service and the cron service). Missing-or-wrong secret
 *   is a soft failure — the warmer continues without eviction so a misconfig
 *   doesn't break the entire run; it just doesn't refresh.
 */

async function forceRefreshCaches({ apiUrl, prefixes = [], keys = [], tag = '[prewarm]', timeoutMs = 30000 }) {
  if (!apiUrl) {
    console.warn(`${tag} forceRefreshCaches: no apiUrl, skipping eviction`);
    return { evicted: 0, skipped: true, reason: 'no-apiUrl' };
  }
  const secret = process.env.CACHE_EVICT_SECRET;
  if (!secret) {
    console.warn(`${tag} forceRefreshCaches: CACHE_EVICT_SECRET not set, skipping eviction (warmer will only touch existing cache, not refresh stale values)`);
    return { evicted: 0, skipped: true, reason: 'no-secret' };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/internal/cache/evict`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-cache-secret': secret,
      },
      body: JSON.stringify({ prefixes, keys }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`${tag} forceRefreshCaches: HTTP ${res.status} ${text.slice(0, 120)}`);
      return { evicted: 0, skipped: false, status: res.status };
    }
    const j = await res.json();
    console.log(`${tag} forceRefreshCaches: evicted ${j.evicted} key(s) (cache size ${j.before} → ${j.after})`);
    return { evicted: j.evicted, skipped: false };
  } catch (err) {
    console.warn(`${tag} forceRefreshCaches: ${err.message}`);
    return { evicted: 0, skipped: false, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * cacheBust(url):
 *   Returns the URL with a `?_warm=<timestamp>` (or `&_warm=`) appended.
 *   Cloudflare keys cache by full URL — adding a unique param per request
 *   means the warmer's GETs always cache-miss at the CDN and actually
 *   reach origin. Without this, the warmer's request is served stale from
 *   CF and the eviction-then-warm cycle does nothing useful (origin never
 *   gets re-hit, in-memory cache stays empty).
 *
 *   The CF cache entry under `?_warm=<ts>` is leaked memory at the edge
 *   but never user-visible — users hit the canonical URL.
 */
function cacheBust(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_warm=${Date.now()}`;
}

/**
 * purgeCloudflareUrls({ urls, tag, timeoutMs }):
 *   Calls Cloudflare's purge_cache API to evict specific user-facing URLs
 *   from the CDN edge. Used by warmer crons AFTER they've populated
 *   origin's in-memory cache — so the next user request to a canonical
 *   URL cache-misses at CF, hits origin (which now has fresh in-memory
 *   data from the warmer's GETs), and CF re-caches the fresh response.
 *
 *   Without this, the user-facing URLs at the CDN edge keep returning
 *   the pre-builder cached response for s-maxage seconds even after our
 *   in-memory cache is fresh.
 *
 *   Auth: CLOUDFLARE_API_TOKEN (with "Cache Purge" permission) +
 *   CLOUDFLARE_ZONE_ID env vars must both be set on the cron service.
 *   Either missing → soft skip with a warning.
 *
 *   Limits: CF Free plan = 30 URLs per request, 1000/day. Pro = 500/req.
 *   We chunk to 30 to be safe across plans.
 */
async function purgeCloudflareUrls({ urls, tag = '[prewarm]', timeoutMs = 8000 }) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId   = process.env.CLOUDFLARE_ZONE_ID;
  if (!apiToken || !zoneId) {
    console.warn(`${tag} purgeCloudflareUrls: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID not set, skipping CDN purge (frontend will see CDN-cached values until s-maxage expires)`);
    return { purged: 0, skipped: true };
  }
  const arr = (Array.isArray(urls) ? urls : []).filter(Boolean);
  if (!arr.length) return { purged: 0, skipped: true };

  const CHUNK_SIZE = 30; // safe across CF Free / Pro / Business plans
  let purged = 0;
  let chunks = 0;
  let failed = 0;
  for (let i = 0; i < arr.length; i += CHUNK_SIZE) {
    const batch = arr.slice(i, i + CHUNK_SIZE);
    chunks++;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ files: batch }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.success) {
        purged += batch.length;
      } else {
        failed++;
        const errMsg = j?.errors?.[0]?.message || `HTTP ${res.status}`;
        console.warn(`${tag} CF purge batch ${chunks} failed: ${errMsg}`);
      }
    } catch (err) {
      failed++;
      console.warn(`${tag} CF purge batch ${chunks}: ${err.message}`);
    } finally {
      clearTimeout(t);
    }
  }
  console.log(`${tag} CF purged ${purged}/${arr.length} URL(s) across ${chunks} batch(es)${failed ? ` (${failed} batch failure[s])` : ''}`);
  return { purged, skipped: false };
}

module.exports = { forceRefreshCaches, cacheBust, purgeCloudflareUrls };
