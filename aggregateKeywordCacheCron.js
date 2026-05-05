#!/usr/bin/env node
'use strict';

/**
 * aggregateKeywordCacheCron.js
 *
 * Maintains per-keyword daily aggregates for the heatmap and flows
 * endpoints. Replaces the brute-force "warm the response cache by
 * re-running the full live query" approach in prewarmKeywordCacheCron.js
 * for the keyword-filtered case.
 *
 * Tables maintained:
 *   • keyword_country_daily   — heatmap country layer
 *   • keyword_city_daily      — heatmap city layer
 *   • keyword_flows_daily     — flows aggregate country-view
 *
 * Update model:
 *   • Today + yesterday: re-aggregated on every run. Captures late-
 *     arriving articles (article_keywords inserts can lag the article
 *     itself by minutes), sentiment re-scoring, classification fixes.
 *   • Day-2 through day-13: aggregated once on first encounter, then
 *     left frozen. The amount of news mentioning "trump" 5 days ago
 *     does not change today.
 *   • Days older than WINDOW_DAYS: pruned at the end of each run.
 *
 * The keyword-match predicate mirrors the live endpoint exactly:
 *   ak.normalized_keyword = $exact
 *   OR to_tsvector('simple', ak.keyword) @@ to_tsquery('simple', $tsq)
 * so cached results are byte-for-byte equivalent to a live query.
 *
 * Env vars:
 *   DATABASE_URL                Postgres connection (required, via db.js)
 *   KEYWORD_AGG_KEYWORDS        comma list (overrides DEFAULT_KEYWORDS)
 *   KEYWORD_AGG_HOT_DAYS        days at the leading edge always refreshed (default 2)
 *   KEYWORD_AGG_WINDOW_DAYS     total rolling window kept in cache (default 14)
 *   KEYWORD_AGG_TIMEOUT_MS      per-keyword statement_timeout (default 180000)
 *
 * Run: node aggregateKeywordCacheCron.js
 *
 * Render Cron: every 5 minutes. Order does not matter relative to
 * prewarmKeywordCacheCron.js — once this cron runs, the prewarm cron
 * effectively becomes a no-op for keyword-filtered queries because the
 * server falls through to the cache table fast-path.
 */

require('dotenv').config({ override: true });

process.env.DB_APPLICATION_NAME = process.env.DB_APPLICATION_NAME || 'earth-cron-keyword-agg';
const pool = require('./db');

const TAG = '[keyword-agg]';

const DEFAULT_KEYWORDS = [
  'trump', 'biden', 'putin', 'xi jinping',
  'ukraine', 'russia', 'china', 'israel', 'gaza', 'iran',
  'north korea', 'taiwan', 'india', 'pakistan',
  'climate', 'ai', 'bitcoin', 'crypto',
  'election', 'inflation', 'fed', 'interest rates',
  'immigration', 'border',
  'supreme court', 'congress',
  'nato', 'eu',
  'oil', 'opec',
];

const KEYWORDS = (process.env.KEYWORD_AGG_KEYWORDS
  ? process.env.KEYWORD_AGG_KEYWORDS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_KEYWORDS);

const HOT_DAYS    = Math.max(1, parseInt(process.env.KEYWORD_AGG_HOT_DAYS    || '2',  10));
const WINDOW_DAYS = Math.max(HOT_DAYS, parseInt(process.env.KEYWORD_AGG_WINDOW_DAYS || '14', 10));
const TIMEOUT_MS  = Math.max(30_000, parseInt(process.env.KEYWORD_AGG_TIMEOUT_MS || '180000', 10));

// ──────────────────────────────────────────────────────────────────────────
// Keyword-match helpers — must match the live endpoint's predicate exactly.
// See server.js /api/flows and /api/heatmap keyword filter for the source.
// ──────────────────────────────────────────────────────────────────────────
function buildKeywordMatch(keyword) {
  const exact = keyword.toLowerCase().trim();
  const tsTokens = exact.replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const tsq = tsTokens.length ? tsTokens.map(w => w + ':*').join(' & ') : null;
  return { exact, tsq };
}

// Returns the SQL fragment + params for "article matches keyword". Caller
// supplies $1 = exact, $2 = tsq (or null). When tsq is null, the prefix
// branch is omitted.
function keywordMatchSql(exactParamIdx, tsqParamIdx, hasTsq) {
  if (hasTsq) {
    return `(ak.normalized_keyword = $${exactParamIdx}
        OR to_tsvector('simple', ak.keyword) @@ to_tsquery('simple', $${tsqParamIdx}))`;
  }
  return `ak.normalized_keyword = $${exactParamIdx}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-day aggregations. Each runs in its own transaction so a failure on
// one day doesn't poison the others, and we can SET LOCAL the timeout.
// ──────────────────────────────────────────────────────────────────────────
async function aggregateDay(client, keyword, daysAgo) {
  const { exact, tsq } = buildKeywordMatch(keyword);
  const hasTsq = !!tsq;

  // Build params: $1 = exact, $2 = tsq (if present), $N = daysAgo
  const params = [exact];
  if (hasTsq) params.push(tsq);
  params.push(daysAgo);
  const exactIdx = 1;
  const tsqIdx   = hasTsq ? 2 : null;
  const daysIdx  = params.length;

  const matchPredicate = keywordMatchSql(exactIdx, tsqIdx, hasTsq);
  const dayBucketExpr  = `(CURRENT_DATE - $${daysIdx}::int)::date`;
  const dayStartExpr   = `(CURRENT_DATE - $${daysIdx}::int)::timestamp`;
  const dayEndExpr     = `(CURRENT_DATE - ($${daysIdx}::int - 1))::timestamp`;

  // ── 1. Country layer (heatmap) ─────────────────────────────────────────
  await client.query(
    `DELETE FROM keyword_country_daily WHERE keyword = $1 AND day_bucket = ${dayBucketExpr}`,
    [exact, daysAgo]
  );
  await client.query(
    `INSERT INTO keyword_country_daily
       (keyword, day_bucket, country_id, n, sent_n, sent_sum, refreshed_at)
     SELECT
       $${exactIdx}::text                           AS keyword,
       ${dayBucketExpr}                             AS day_bucket,
       a.country_id                                 AS country_id,
       COUNT(*)::int                                AS n,
       COUNT(a.sentiment_score)::int                AS sent_n,
       COALESCE(SUM(a.sentiment_score), 0)::float8  AS sent_sum,
       NOW()
     FROM news_articles a
     WHERE a.id IN (
       SELECT ak.article_id FROM article_keywords ak
       JOIN news_articles na ON na.id = ak.article_id
       WHERE ${matchPredicate}
         AND na.published_at >= ${dayStartExpr}
         AND na.published_at <  ${dayEndExpr}
     )
       AND a.published_at >= ${dayStartExpr}
       AND a.published_at <  ${dayEndExpr}
       AND a.country_id IS NOT NULL
       AND a.city_id    IS NULL
     GROUP BY a.country_id`,
    params
  );

  // ── 2. City layer (heatmap) ────────────────────────────────────────────
  await client.query(
    `DELETE FROM keyword_city_daily WHERE keyword = $1 AND day_bucket = ${dayBucketExpr}`,
    [exact, daysAgo]
  );
  await client.query(
    `INSERT INTO keyword_city_daily
       (keyword, day_bucket, city_id, country_id, n, sent_n, sent_sum, refreshed_at)
     SELECT
       $${exactIdx}::text,
       ${dayBucketExpr},
       a.city_id,
       ci.country_id,
       COUNT(*)::int,
       COUNT(a.sentiment_score)::int,
       COALESCE(SUM(a.sentiment_score), 0)::float8,
       NOW()
     FROM news_articles a
     JOIN cities ci ON ci.id = a.city_id
     WHERE a.id IN (
       SELECT ak.article_id FROM article_keywords ak
       JOIN news_articles na ON na.id = ak.article_id
       WHERE ${matchPredicate}
         AND na.published_at >= ${dayStartExpr}
         AND na.published_at <  ${dayEndExpr}
     )
       AND a.published_at >= ${dayStartExpr}
       AND a.published_at <  ${dayEndExpr}
       AND a.city_id IS NOT NULL
     GROUP BY a.city_id, ci.country_id`,
    params
  );

  // ── 3. Flows aggregate country-view ────────────────────────────────────
  // Mirrors server.js flows aggregate query's groupings exactly:
  //   COALESCE(a.city_id, 0), a.country_id, COALESCE(al.city_id, 0), al.country_id
  // src_city_id = 0 sentinel = "no source city" (country-only article).
  await client.query(
    `DELETE FROM keyword_flows_daily WHERE keyword = $1 AND day_bucket = ${dayBucketExpr}`,
    [exact, daysAgo]
  );
  await client.query(
    `INSERT INTO keyword_flows_daily
       (keyword, day_bucket,
        src_country_id, src_city_id, dst_country_id, dst_city_id,
        n, sent_n, sent_sum, source_routes, content_routes, refreshed_at)
     SELECT
       $${exactIdx}::text,
       ${dayBucketExpr},
       a.country_id                                       AS src_country_id,
       COALESCE(a.city_id, 0)                             AS src_city_id,
       al.country_id                                      AS dst_country_id,
       COALESCE(al.city_id, 0)                            AS dst_city_id,
       COUNT(*)::int                                      AS n,
       COUNT(a.sentiment_score)::int                      AS sent_n,
       COALESCE(SUM(a.sentiment_score), 0)::float8        AS sent_sum,
       COUNT(*) FILTER (WHERE al.routing_type = 'source')::int  AS source_routes,
       COUNT(*) FILTER (WHERE al.routing_type = 'content')::int AS content_routes,
       NOW()
     FROM article_locations al
     JOIN news_articles a ON a.id = al.article_id
     WHERE a.id IN (
       SELECT ak.article_id FROM article_keywords ak
       JOIN news_articles na ON na.id = ak.article_id
       WHERE ${matchPredicate}
         AND na.published_at >= ${dayStartExpr}
         AND na.published_at <  ${dayEndExpr}
     )
       AND a.published_at >= ${dayStartExpr}
       AND a.published_at <  ${dayEndExpr}
       AND al.routing_type IN ('content', 'source')
       AND a.country_id  != al.country_id
     GROUP BY
       a.country_id, COALESCE(a.city_id, 0),
       al.country_id, COALESCE(al.city_id, 0)`,
    params
  );
}

async function refreshKeywordHotEdge(keyword) {
  // Re-aggregate today + yesterday inside one transaction per day. We DO
  // NOT collapse all hot days into one transaction — long transactions
  // hold pg locks and risk the per-keyword timeout for hot terms.
  for (let d = 0; d < HOT_DAYS; d++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
      await aggregateDay(client, keyword, d);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }
}

async function backfillMissingDays(keyword) {
  // For days [HOT_DAYS .. WINDOW_DAYS-1], aggregate only days that are
  // NOT already represented in keyword_country_daily for this keyword.
  // Once aggregated, those days never need to be touched again.
  const exact = keyword.toLowerCase().trim();
  const { rows } = await pool.query(
    `SELECT (CURRENT_DATE - day_bucket)::int AS days_ago
       FROM keyword_country_daily
       WHERE keyword = $1
         AND day_bucket >= CURRENT_DATE - $2::int
         AND day_bucket <= CURRENT_DATE - $3::int`,
    [exact, WINDOW_DAYS - 1, HOT_DAYS]
  );
  // Build the set of days that ALREADY have rows. Even one country row
  // for that keyword/day means we successfully ran the aggregation
  // (an empty result-set for a known low-traffic day is also valid:
  // we'd just have no rows, which is indistinguishable from "missing".
  // To handle that edge case we'd need a separate "I aggregated this
  // day" marker table — overkill for now since hot keywords always
  // produce country rows on every day in the window).
  const have = new Set(rows.map(r => r.days_ago));

  for (let d = HOT_DAYS; d < WINDOW_DAYS; d++) {
    if (have.has(d)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
      await aggregateDay(client, keyword, d);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      // Backfill failures for individual past days are non-fatal — we'll
      // try again next run. Don't tank the whole keyword for one day.
      console.warn(`${TAG}   ${keyword} backfill day-${d} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

async function processKeyword(keyword) {
  const t0 = Date.now();
  try {
    await refreshKeywordHotEdge(keyword);
    await backfillMissingDays(keyword);
    return { keyword, ms: Date.now() - t0, ok: true };
  } catch (e) {
    return { keyword, ms: Date.now() - t0, ok: false, err: e.message };
  }
}

async function pruneStaleRows() {
  // Trim anything that fell off the back of the window. Done once per run
  // (cheap — primary key is keyword-prefixed, not date-prefixed, so this
  // is a partial index range scan).
  const cutoff = WINDOW_DAYS;
  const tables = ['keyword_country_daily', 'keyword_city_daily', 'keyword_flows_daily'];
  for (const t of tables) {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM ${t} WHERE day_bucket < CURRENT_DATE - $1::int`,
        [cutoff]
      );
      if (rowCount > 0) console.log(`${TAG} pruned ${rowCount} stale rows from ${t}`);
    } catch (e) {
      console.warn(`${TAG} prune ${t} failed: ${e.message}`);
    }
  }
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()} keywords=${KEYWORDS.length} hot_days=${HOT_DAYS} window_days=${WINDOW_DAYS} timeout=${TIMEOUT_MS}ms`);

  const results = [];
  // Serial: each keyword's hot-edge refresh is bounded but flows aggregation
  // for "trump" can hold a connection for tens of seconds. Running serially
  // keeps the cron's pool usage to 1 connection at a time so it can coexist
  // with the article fetcher and the web server without contention.
  for (const kw of KEYWORDS) {
    const r = await processKeyword(kw);
    results.push(r);
    const status = r.ok ? 'ok' : `FAIL ${r.err}`;
    console.log(`${TAG}   ${kw.padEnd(16)} ${status.padEnd(40)} ${r.ms}ms`);
  }

  await pruneStaleRows();

  const okCount = results.filter(r => r.ok).length;
  const totalMs = Date.now() - t0;
  console.log(`${TAG} done in ${(totalMs / 1000).toFixed(1)}s — ok=${okCount}/${results.length}`);

  // Non-zero exit only if EVERY keyword failed — single-keyword failures
  // are non-fatal because the live endpoint will still serve correct
  // results from the un-cached path; we just won't have the speed-up.
  if (results.length > 0 && okCount === 0) process.exit(1);
}

main()
  .catch(err => {
    console.error(`${TAG} fatal:`, err);
    process.exit(1);
  })
  .finally(() => {
    pool.end().catch(() => {});
  });
