#!/usr/bin/env node
'use strict';

/**
 * prewarmThreadsCron.js
 *
 * Owns ALL thread surface warming. Runs every 4h; thread builder also
 * runs every 4h (6×/day). Per-thread caches (TTL 3h45m) stay continuously
 * warm — TTL stays just under cycle so the cache expires ~15min before
 * the next prewarm fires, eliminating the window where users see stale
 * post-builder data.
 * Schedule this cron ~30min AFTER the builder so each warm picks up the
 * latest build (otherwise users see stale data for up to a full cycle).
 *
 * What it warms (per top 50 active+cooling thread):
 *   • /api/threads/:id/articles        (article list inside the thread)
 *   • /api/threads/:id/timeline        (event spine)
 *   • /api/threads/:id/panels          (data panels / pie graph)
 *   • /api/flows/thread/:id            (flow arcs)
 *
 * Plus core feeds whose TTL exceeds this cron's cadence:
 *   • /api/threads/latest              (the cards list, TTL 3h45m)
 *   • /api/news/sources-stats          (source stats, TTL 11h)
 *
 * Pure HTTP — no DB. Discovers top threads via /api/threads/latest,
 * which is itself cached, so no direct PG connection. This avoids the
 * 53300 connection-cap errors we hit when crons opened their own pools.
 *
 * Note: timeline (line) flow arcs and line detail endpoints are NOT
 * warmed here — those are the line builder's domain (daily, midnight UTC)
 * and live in prewarmLinesCron.js. Warming them here at 2h cadence
 * would waste 12 cycles a day on data that only changes once.
 *
 * Env vars:
 *   API_URL                    base URL of the API (default: http://localhost:3000)
 *   PREWARM_THREAD_LIMIT       override top-N threads (default: 50)
 *   PREWARM_TIMEOUT_MS         per-request timeout (default: 95000)
 *   PREWARM_CONCURRENCY        parallel threads (default: 1)
 *
 * Run:
 *   node prewarmThreadsCron.js
 *
 * Wire to a 4h Render Cron — schedule: 5 past every 4th hour
 *   (cron expression: 5  STAR/4  STAR  STAR  STAR  — STAR = literal asterisk)
 */

require('dotenv').config({ override: true });

const API_URL      = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TIMEOUT_MS   = parseInt(process.env.PREWARM_TIMEOUT_MS  || '95000', 10);
const CONCURRENCY  = Math.max(1, parseInt(process.env.PREWARM_CONCURRENCY || '1', 10));
const THREAD_LIMIT = Math.max(1, parseInt(process.env.PREWARM_THREAD_LIMIT || '50', 10));

const TAG = '[prewarm-threads]';

if (!process.env.API_URL) {
  console.warn(`${TAG} WARNING: API_URL not set — defaulting to http://localhost:3000.`);
  console.warn(`${TAG}          On Render Cron, set API_URL=https://earth-wjr6.onrender.com.`);
}

function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function fetchJSON(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Retry wrapper for the discovery call only. The thread builder runs on the
// same DB and can leave it briefly saturated; a single 500 from
// /api/threads/latest right after a builder pass shouldn't kill the prewarm.
// 3 attempts with 5s → 15s backoff (~20s total wait worst case).
async function fetchJSONWithRetry(url, attempts = 3, baseDelayMs = 5000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJSON(url);
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const delayMs = baseDelayMs * Math.pow(3, i);
      console.warn(`${TAG} retry ${i + 1}/${attempts - 1} for ${url}: ${e.message} — waiting ${delayMs / 1000}s`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function pickTopThreads(n) {
  let data;
  try {
    data = await fetchJSONWithRetry(`${API_URL}/api/threads/latest?limit=${n}`);
  } catch (e) {
    throw new Error(`/api/threads/latest?limit=${n}: ${e.message}`);
  }
  const arr = Array.isArray(data) ? data : (data?.threads || data?.data || []);
  return arr.slice(0, n).map(t => ({
    id: t.thread_id || t.id,
    title: t.title,
    importance: t.importance,
    article_count: t.article_count,
  })).filter(t => t.id);
}

async function warm(label, url) {
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(url);
    const ms = Date.now() - t0;
    // Cancel body — server cache is populated before res.json() runs,
    // so we don't need to download the response (would OOM on big feeds).
    try { await r.body?.cancel?.(); } catch {}
    if (!r.ok) return { label, ms, err: `HTTP ${r.status}` };
    return { label, ms };
  } catch (e) {
    return { label, ms: Date.now() - t0, err: e.message };
  }
}

const PER_THREAD_ENDPOINTS = [
  { label: 'articles', path: 'articles' },
  { label: 'timeline', path: 'timeline' },
  { label: 'panels',   path: 'panels'   },
  { label: 'flows',    path: '__flows'  },     // /api/flows/thread/:id
  { label: 'sources',  path: '__sources' },    // /api/articles/by-thread?thread_id=:id&limit=100
];

async function processThread(t) {
  // Run all sub-requests in parallel for this thread — different routes,
  // no pool collision (server enforces per-route timeouts). The 'sources'
  // entry warms the EXACT URL the Sources tab on the thread detail panel
  // calls (/api/articles/by-thread?thread_id=X&limit=100 — see
  // www/index.html:48400). Without this entry the thread detail panel's
  // Sources tab cold-reads on every open even when /api/threads/:id
  // /articles is warm — they're separate endpoints with separate caches.
  const tasks = PER_THREAD_ENDPOINTS.map(ep => {
    let url;
    if (ep.path === '__flows') {
      url = `${API_URL}/api/flows/thread/${t.id}`;
    } else if (ep.path === '__sources') {
      url = `${API_URL}/api/articles/by-thread?thread_id=${t.id}&limit=100`;
    } else {
      url = `${API_URL}/api/threads/${t.id}/${ep.path}`;
    }
    return warm(ep.label, url);
  });
  const results = await Promise.all(tasks);
  return { t, results };
}

// Core feeds warmed alongside per-thread surfaces.
//   /api/threads/latest      TTL 3h45m, builder + this cron both every 4h
//   /api/news/sources-stats  TTL 11h, source stats cron runs 2x/day
const CORE_FEEDS = [
  '/api/threads/latest',
  '/api/news/sources-stats',
];

async function warmCoreFeeds() {
  console.log(`${TAG} core feeds: warming ${CORE_FEEDS.length} base endpoints…`);
  const out = [];
  for (const path of CORE_FEEDS) {
    const url = `${API_URL}${path}`;
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeout(url);
      const ms = Date.now() - t0;
      try { await r.body?.cancel?.(); } catch {}
      const tag = r.ok ? `${ms}ms` : `ERR HTTP ${r.status} (${ms}ms)`;
      console.log(`${TAG}   ${path.padEnd(28)} [${tag}]`);
      out.push({ path, ok: r.ok, ms });
    } catch (e) {
      const ms = Date.now() - t0;
      console.log(`${TAG}   ${path.padEnd(28)} [ERR ${e.message} (${ms}ms)]`);
      out.push({ path, ok: false, ms, err: e.message });
    }
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} api=${API_URL} threads=${THREAD_LIMIT} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms`);

  // Phase 0 — core feeds (threads/latest, sources-stats)
  const coreResults = await warmCoreFeeds();
  const coreOk = coreResults.filter(r => r.ok).length;
  console.log('');

  // Phase 1 — discover top N + warm all detail endpoints per thread
  let threads = [];
  let discoveryFailed = false;
  try {
    threads = await pickTopThreads(THREAD_LIMIT);
  } catch (err) {
    // Don't bail hard. Core feeds may have warmed successfully; let the
    // final summary decide exit status (exit(1) only if literally nothing
    // succeeded). Render alerts on exit(1) — a transient DB-saturation 500
    // here, recoverable next cycle, shouldn't page.
    console.error(`${TAG} discovery failed (${err.message}). Skipping phase 1; will rely on next cycle.`);
    discoveryFailed = true;
  }
  if (!discoveryFailed) {
    console.log(`${TAG} phase 1: warming ${PER_THREAD_ENDPOINTS.length} detail endpoints for ${threads.length} threads…`);
  }

  const allResults = [];
  for (let i = 0; i < threads.length; i += CONCURRENCY) {
    const batch = threads.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map(processThread));
    allResults.push(...out);
    for (const r of out) {
      // Surface the actual error string (truncated) instead of bare "ERR" —
      // the previous compact format hid whether failures were HTTP 5xx,
      // HTTP 504, network resets, or the 95s client abort.
      const tags = r.results.map(x => x.err
        ? `${x.label}=ERR(${String(x.err).slice(0, 30)})`
        : `${x.label}=${x.ms}ms`).join(' ');
      const titleTrim = (r.t.title || '').slice(0, 50);
      console.log(`${TAG}   #${String(r.t.id).padStart(6)} imp=${r.t.importance} arts=${String(r.t.article_count).padStart(4)} ${tags}  ${titleTrim}`);
    }
  }

  // Aggregate
  const subRequests = allResults.flatMap(r => r.results);
  const ok = subRequests.filter(r => !r.err).length;
  const totalMs = subRequests.reduce((s, r) => s + (r.ms || 0), 0);

  // Per-endpoint breakdown
  const byLabel = {};
  for (const r of subRequests) {
    byLabel[r.label] = byLabel[r.label] || { ok: 0, total: 0 };
    byLabel[r.label].total++;
    if (!r.err) byLabel[r.label].ok++;
  }
  const breakdown = Object.entries(byLabel).map(([k, v]) => `${k}=${v.ok}/${v.total}`).join(' ');

  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — core_ok=${coreOk}/${coreResults.length} threads_ok=${ok}/${subRequests.length} (${breakdown}) total_query_ms=${totalMs}`);

  // Non-zero exit only on catastrophic failure
  const totalCount = coreResults.length + subRequests.length;
  const totalOk    = coreOk + ok;
  if (totalCount > 0 && totalOk === 0) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
