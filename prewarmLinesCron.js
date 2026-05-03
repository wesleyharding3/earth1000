#!/usr/bin/env node
'use strict';

/**
 * prewarmLinesCron.js
 *
 * Owns ALL line/timeline surface warming. The line builder cron runs
 * once daily at midnight UTC, so this prewarmer should run shortly
 * after — ~00:30 UTC — to fill the cache with fresh data for the
 * entire day.
 *
 * What it warms (per top 20 active line):
 *   • /api/timelines/latest               (the cards list)
 *   • /api/timelines/:id/articles         (article list)
 *   • /api/timelines/:id/events           (event spine)
 *   • /api/timelines/:id/density          (density chart)
 *   • /api/timelines/:id/threads          (child threads)
 *   • /api/timelines/:id/panels           (data panels / pie graph)
 *   • /api/flows/timeline/:id             (flow arcs)
 *
 * Pure HTTP — no DB. Discovers top lines via /api/timelines/latest.
 *
 * Env vars:
 *   API_URL                   base URL of the API (default: http://localhost:3000)
 *   PREWARM_TIMELINE_LIMIT    override top-N timelines (default: 20)
 *   PREWARM_TIMEOUT_MS        per-request timeout (default: 95000)
 *   PREWARM_CONCURRENCY       parallel requests per line (default: 1)
 *
 * Run:
 *   node prewarmLinesCron.js
 *
 * Wire to a daily Render Cron (~30 min after timeline builder finishes):
 *   `30 0 * * *`  (00:30 UTC, daily)
 */

require('dotenv').config({ override: true });

const API_URL        = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const TIMEOUT_MS     = parseInt(process.env.PREWARM_TIMEOUT_MS || '95000', 10);
const CONCURRENCY    = Math.max(1, parseInt(process.env.PREWARM_CONCURRENCY || '1', 10));
const TIMELINE_LIMIT = Math.max(1, parseInt(process.env.PREWARM_TIMELINE_LIMIT || '20', 10));

const TAG = '[prewarm-lines]';

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

async function pickTopTimelines(n) {
  const data = await fetchJSON(`${API_URL}/api/timelines/latest?limit=${n}`);
  const arr = Array.isArray(data) ? data : (data?.timelines || data?.data || []);
  return arr.slice(0, n).map(t => ({
    id: t.timeline_id || t.id,
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

const PER_LINE_ENDPOINTS = [
  { label: 'articles', path: 'articles' },
  { label: 'events',   path: 'events'   },
  { label: 'density',  path: 'density'  },
  { label: 'threads',  path: 'threads'  },
  { label: 'panels',   path: 'panels'   },
  { label: 'flows',    path: '__flows'  },  // special-case: /api/flows/timeline/:id
];

async function processLine(t) {
  // Run all 6 sub-requests in parallel for this line — they hit
  // different routes, no pool collision (server enforces per-route
  // statement timeouts).
  const tasks = PER_LINE_ENDPOINTS.map(ep => {
    const url = ep.path === '__flows'
      ? `${API_URL}/api/flows/timeline/${t.id}`
      : `${API_URL}/api/timelines/${t.id}/${ep.path}`;
    return warm(ep.label, url);
  });
  const results = await Promise.all(tasks);
  return { t, results };
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} api=${API_URL} timelines=${TIMELINE_LIMIT} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms`);

  // Phase 0 — /api/timelines/latest (the list)
  console.log(`${TAG} phase 0: warming /api/timelines/latest…`);
  const listResult = await warm('timelines/latest', `${API_URL}/api/timelines/latest`);
  console.log(`${TAG}   /api/timelines/latest [${listResult.err ? 'ERR ' + listResult.err : listResult.ms + 'ms'}]`);
  console.log('');

  // Phase 1 — discover top N + warm all detail endpoints per line
  let timelines = [];
  try {
    timelines = await pickTopTimelines(TIMELINE_LIMIT);
  } catch (err) {
    console.error(`${TAG} fatal: discovery failed (${err.message}). Verify API_URL is reachable.`);
    process.exit(1);
  }
  console.log(`${TAG} phase 1: warming ${PER_LINE_ENDPOINTS.length} detail endpoints for ${timelines.length} timelines…`);

  const allResults = [];
  for (let i = 0; i < timelines.length; i += CONCURRENCY) {
    const batch = timelines.slice(i, i + CONCURRENCY);
    const out = await Promise.all(batch.map(processLine));
    allResults.push(...out);
    for (const r of out) {
      const tags = r.results.map(x => x.err
        ? `${x.label}=ERR(${String(x.err).slice(0, 30)})`
        : `${x.label}=${x.ms}ms`).join(' ');
      const titleTrim = (r.t.title || '').slice(0, 50);
      console.log(`${TAG}   #${String(r.t.id).padStart(5)} imp=${r.t.importance} arts=${String(r.t.article_count).padStart(4)} ${tags}  ${titleTrim}`);
    }
  }

  // Aggregate
  const subRequests = allResults.flatMap(r => r.results);
  const ok = subRequests.filter(r => !r.err).length;
  const total = subRequests.length + 1; // + the list warm
  const totalOk = ok + (listResult.err ? 0 : 1);
  const totalMs = subRequests.reduce((s, r) => s + (r.ms || 0), 0) + (listResult.ms || 0);

  // Per-endpoint breakdown
  const byLabel = {};
  for (const r of subRequests) {
    byLabel[r.label] = byLabel[r.label] || { ok: 0, total: 0 };
    byLabel[r.label].total++;
    if (!r.err) byLabel[r.label].ok++;
  }
  const breakdown = Object.entries(byLabel).map(([k, v]) => `${k}=${v.ok}/${v.total}`).join(' ');

  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${totalOk}/${total} ok (list=${listResult.err ? 'ERR' : 'OK'}, ${breakdown}) total_query_ms=${totalMs}`);

  if (total > 0 && totalOk === 0) process.exit(1);
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
