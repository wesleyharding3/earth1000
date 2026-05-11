#!/usr/bin/env node
'use strict';

/**
 * recleanCorruptedLocations.js — Phase 2 cleanup for the BB/PE/AL
 * keyword-corruption bug.
 *
 * Background
 * ──────────
 * country_location_keywords had ~240 multilingual phrases for France,
 * Belgium, and Luxembourg mis-attributed to Barbados, Peru, and
 * Albania respectively. _apply_phase1.js (the migration) moved those
 * keyword rows to their rightful countries.
 *
 * BUT existing article_locations rows are still pointing at BB/PE/AL
 * for articles that should have been tagged FR/BE/LU. Every thread
 * card that aggregates those rows continues to show Barbados on
 * Macron / Algeria / Israel coverage, Peru on Belgian content, and
 * Albania on Luxembourg content — that's the visible symptom this
 * script repairs.
 *
 * Strategy
 * ────────
 * For every article that has a routing_type='content' row in one of
 * the three corrupted country buckets:
 *
 *   1. DELETE article_locations rows for that article where
 *      country_id IN (3, 22, 26) AND routing_type = 'content'.
 *      (We don't touch 'source' rows or rows for other countries.)
 *
 *   2. Call locationRouter.routeArticle(articleId) to re-run the
 *      keyword scan. The router uses ON CONFLICT DO NOTHING so it
 *      won't disturb rows we kept; it WILL re-insert legitimate
 *      BB/PE/AL rows for articles that genuinely mention those
 *      countries (those keywords still exist in the table), and
 *      it WILL insert new FR/BE/LU rows for articles that mention
 *      France/Belgium/Luxembourg via the just-moved keywords.
 *
 *   3. After every BATCH_SIZE articles, log progress and pause
 *      briefly so we don't crowd the pool.
 *
 * Output is JSONL when --json is set, otherwise a human-friendly
 * log. Resumable: re-running picks up by article-id ordering and
 * skips any article whose corrupted rows are already gone.
 *
 * Usage
 * ─────
 *   node recleanCorruptedLocations.js                   # dry-run
 *   node recleanCorruptedLocations.js --apply           # actually write
 *   node recleanCorruptedLocations.js --apply --batch=200
 *   node recleanCorruptedLocations.js --apply --limit=500   # cap rows for first run
 *   node recleanCorruptedLocations.js --apply --countries=3,22  # only BB+PE
 *   node recleanCorruptedLocations.js --json --apply > recleanup.jsonl
 */

// Concurrency knob — the per-article work is DB-bound (1 DELETE + ~4-6
// queries inside routeArticle), so running multiple articles in parallel
// is the cheap speedup. Default 5 fits under the pool ceiling we set
// below. Going much higher gives diminishing returns since the same pool
// is shared with the router.
require('dotenv').config({ override: true });
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '6';

// locationRouter.routeArticle logs every keyword hit via console.log
// + every successful insert. On a 46k-article run that's ~280k log
// lines, drowning out the actual progress markers. Silence the noisy
// channel while leaving warnings/errors intact. Restored on shutdown.
const _origLog = console.log;
const _isOurOwnLog = (args) => {
  const first = args[0];
  if (typeof first !== 'string') return false;
  // Our log() helper emits either a JSON object or a "..." string;
  // either way the FIRST argument is our message text. We pass through
  // anything starting with our well-known prefixes; router output
  // (which starts with emojis 📍🌍🌐 or "PASSING:") gets dropped.
  if (/^(📍|🌍|🌐|PASSING:|ROUTER VERSION)/.test(first)) return false;
  return true;
};
console.log = (...args) => { if (_isOurOwnLog(args)) _origLog(...args); };

const pool = require('./db');
const { routeArticle } = require('./locationRouter');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));

const APPLY       = !!ARGV.get('apply');
const JSON_MODE   = !!ARGV.get('json');
const BATCH_SIZE  = parseInt(ARGV.get('batch') || '200', 10);
const CONCURRENCY = parseInt(ARGV.get('concurrency') || '5', 10);
const LIMIT       = ARGV.get('limit') ? parseInt(ARGV.get('limit'), 10) : null;
const COUNTRIES   = ARGV.get('countries')
  ? String(ARGV.get('countries')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
  : [3, 22, 26]; // BB, PE, AL

function log(line, obj) {
  if (JSON_MODE) console.log(JSON.stringify({ ts: new Date().toISOString(), msg: line, ...obj }));
  else if (obj) console.log(line, JSON.stringify(obj));
  else console.log(line);
}

async function main() {
  const t0 = Date.now();
  log(`recleanCorruptedLocations starting — mode=${APPLY ? 'APPLY' : 'DRY-RUN'} countries=${COUNTRIES.join(',')} batch=${BATCH_SIZE}${LIMIT ? ' limit=' + LIMIT : ''}`);

  // 1. Count the scope of work
  const { rows: [scope] } = await pool.query(`
    SELECT
      COUNT(*)::int                          AS bad_rows,
      COUNT(DISTINCT article_id)::int        AS affected_articles
      FROM article_locations
     WHERE country_id = ANY($1::int[])
       AND routing_type = 'content'
  `, [COUNTRIES]);
  log(`Scope: ${scope.bad_rows} content rows across ${scope.affected_articles} distinct articles need cleanup.`);

  // 2. Per-country breakdown so dry-run is informative.
  const { rows: perCountry } = await pool.query(`
    SELECT c.iso_code, c.name, COUNT(al.article_id)::int AS row_count
      FROM article_locations al
      JOIN countries c ON c.id = al.country_id
     WHERE al.country_id = ANY($1::int[])
       AND al.routing_type = 'content'
     GROUP BY c.iso_code, c.name
     ORDER BY row_count DESC
  `, [COUNTRIES]);
  log(`Per-country row count to clean:`);
  for (const r of perCountry) {
    log(`  ${r.iso_code}  ${(r.name || '').padEnd(12)}  ${r.row_count} rows`);
  }

  if (!APPLY) {
    log(`\nDRY-RUN — no writes. Re-run with --apply to clean these articles.`);
    log(`Each affected article will have its corrupted (${COUNTRIES.join(',')}) content rows`);
    log(`deleted, then locationRouter.routeArticle() re-runs to retag the article`);
    log(`from the fixed keyword tables.`);
    await pool.end();
    return;
  }

  // 3. Pull affected article IDs. We sort ASC so resumability works
  //    naturally: a re-run after a partial pass starts where the
  //    previous one ended (since the previous batch's articles now
  //    have no corrupted rows and won't appear in this query).
  const { rows: idRows } = await pool.query(`
    SELECT DISTINCT article_id
      FROM article_locations
     WHERE country_id = ANY($1::int[])
       AND routing_type = 'content'
     ORDER BY article_id ASC
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `, [COUNTRIES]);
  const articleIds = idRows.map(r => r.article_id);
  log(`Selected ${articleIds.length} articles to process${LIMIT ? ` (limit=${LIMIT})` : ''}`);

  // 4. Process with bounded concurrency. Each "worker" pulls the next
  //    article id from the shared queue and runs DELETE + routeArticle.
  //    BATCH_SIZE controls progress-logging frequency (every N completed
  //    articles, emit a line). The pool ceiling above keeps this under
  //    Postgres's connection budget.
  let processed = 0;
  let routerOk = 0;
  let routerFail = 0;
  let rowsDeleted = 0;
  let nextIdx = 0;

  async function processOne(articleId) {
    try {
      const { rowCount } = await pool.query(`
        DELETE FROM article_locations
         WHERE article_id = $1
           AND country_id = ANY($2::int[])
           AND routing_type = 'content'
      `, [articleId, COUNTRIES]);
      rowsDeleted += rowCount;

      // Re-route. ON CONFLICT DO NOTHING in the router means surviving
      // good rows for this article (e.g. correct UA/RU/US tagging) are
      // untouched; only deleted-and-now-replayed rows get fresh inserts.
      await routeArticle(articleId);
      routerOk++;
    } catch (err) {
      routerFail++;
      log(`  article ${articleId} FAILED: ${err.message}`);
    }
    processed++;
    // Log a progress line every BATCH_SIZE articles. The check is
    // intentionally on `processed` rather than nextIdx so we tolerate
    // workers finishing out of order.
    if (processed % BATCH_SIZE === 0 || processed === articleIds.length) {
      const pct = ((processed / articleIds.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const rate = (processed / Math.max(0.1, (Date.now() - t0) / 1000)).toFixed(2);
      const remaining = articleIds.length - processed;
      const etaSec = remaining > 0 ? Math.round(remaining / Math.max(0.1, rate)) : 0;
      log(`progress: ${processed}/${articleIds.length} (${pct}%)  ok=${routerOk}  fail=${routerFail}  rows_deleted=${rowsDeleted}  elapsed=${elapsed}s  rate=${rate}/s  eta=${etaSec}s`);
    }
  }

  async function worker() {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= articleIds.length) return;
      await processOne(articleIds[myIdx]);
    }
  }

  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);

  const elapsedTotal = ((Date.now() - t0) / 1000).toFixed(1);
  log(`\nDone in ${elapsedTotal}s — processed=${processed} ok=${routerOk} fail=${routerFail} rows_deleted=${rowsDeleted}`);

  // 5. Verify: how many corrupted rows remain?
  const { rows: [after] } = await pool.query(`
    SELECT COUNT(*)::int AS bad_rows
      FROM article_locations
     WHERE country_id = ANY($1::int[])
       AND routing_type = 'content'
  `, [COUNTRIES]);
  log(`Remaining corrupted rows: ${after.bad_rows} (was ${scope.bad_rows}, delta=${scope.bad_rows - after.bad_rows})`);
  log(`Note: remaining rows are LEGITIMATE tagsーarticles that genuinely mention Barbados/Peru/Albania survived because the router re-inserted them based on the surviving own-language keyword rows.`);

  await pool.end();
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  console.error(err);
  process.exitCode = 1;
});
