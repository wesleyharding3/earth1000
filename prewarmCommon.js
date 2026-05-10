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

async function forceRefreshCaches({ apiUrl, prefixes = [], keys = [], tag = '[prewarm]', timeoutMs = 8000 }) {
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

module.exports = { forceRefreshCaches };
