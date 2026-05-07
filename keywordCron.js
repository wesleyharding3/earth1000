#!/usr/bin/env node
'use strict';

// Cap DB pool before any module loads ./db. dotenv.config() does not
// override already-set env vars, so this sticks. Crons only need 1–2
// connections at a time; defaulting to 60 (the web server's value) was
// letting a single nightly run starve the API pool — see Render logs
// 2026-04-26 ("[pool] total=1 idle=0 waiting=0", "remaining connection
// slots are reserved for roles with the SUPERUSER attribute").
process.env.DB_POOL_MAX = "2";

/**
 * keywordCron.js
 *
 * Pre-computes trending and rising keyword intelligence and writes results
 * to keyword_intelligence_cache for instant (<1ms) API serving.
 *
 * Recommended cron schedule:
 *   Trending:  0 2 * * *    — nightly 2am (stable, changes slowly)
 *   Rising:    0 *\/4 * * *  — every 4 hours (momentum is time-sensitive)
 *
 * Usage:
 *   node keywordCron.js              # refresh both trending + rising
 *   node keywordCron.js --trending   # trending only
 *   node keywordCron.js --rising     # rising only
 */

require('dotenv').config();
const pool = require('./db');

const ONLY_TRENDING = process.argv.includes('--trending');
const ONLY_RISING   = process.argv.includes('--rising');
const DO_TRENDING   = !ONLY_RISING;
const DO_RISING     = !ONLY_TRENDING;

const DATE_LIKE_KEYWORD_PATTERNS = [
  /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/i,
  /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/i,
  /^(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?$/i,
  /^\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:\s+\d{4})?$/i,
];

function elapsed(t0) { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

function isDateLikeKeyword(keyword) {
  const value = typeof keyword === 'string' ? keyword.trim() : '';
  return value ? DATE_LIKE_KEYWORD_PATTERNS.some((pattern) => pattern.test(value)) : false;
}

// Stopwords: prefetched once per cron run.
async function loadStopwords() {
  const { rows } = await pool.query(`SELECT word FROM stopwords`);
  return rows.map(r => r.word).filter(Boolean);
}

// Materialise stopwords into a session temp table with a PK index. Originally
// tried `WHERE NOT (k.keyword = ANY($::text[]))` with the array as a param,
// but with 26k stopwords Postgres treated it as a giant per-row OR list and
// blew the statement_timeout. The temp-table form is a real hash anti-join
// — 26k hash entries built once, O(1) probe per keyword_daily_stats row.
// Uses a per-pid table name so trending/rising can share the pool without
// stepping on each other if Postgres reuses the same backend.
async function ensureStopwordsTable(client, stopwords) {
  const tableName = `_kw_stopwords_${process.pid}`;
  await client.query(`DROP TABLE IF EXISTS ${tableName}`);
  await client.query(`CREATE TEMP TABLE ${tableName} (word text PRIMARY KEY)`);
  // Bulk insert via unnest — single round-trip, server-side expansion.
  if (stopwords.length) {
    await client.query(
      `INSERT INTO ${tableName}(word) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,
      [stopwords]
    );
  }
  // ANALYZE so the planner knows the real row count (~26k). Without this it
  // assumes the default ~10 rows for an empty pg_statistic entry and picks
  // a nested-loop anti-join — that was the dominant cost in rising
  // (the table is genuinely big enough that the planner needs accurate stats
  // to choose a hash anti-join over a per-row index probe).
  await client.query(`ANALYZE ${tableName}`);
  return tableName;
}

// ── MV refresh helper ───────────────────────────────────────────────────────
// REFRESH MATERIALIZED VIEW does the heavy aggregation that used to live
// inline in computeTrending/computeRising. The cron path now reads from
// the MV — see migrations/20260503_keyword_intel_materialized_views.sql.
//
// statement_timeout is disabled for the refresh since this is a once-daily
// maintenance operation off the user-facing path. The previous 300s
// ceiling on the in-cron query was the proximate cause of the rising
// failures; here we let the refresh run to completion.
async function refreshMV(client, viewName) {
  const t0 = Date.now();
  // SET (no LOCAL) so the value persists for the rest of this session
  // without needing an explicit transaction. The previous `SET LOCAL`
  // form silently no-op'd because we weren't inside BEGIN/COMMIT, so
  // the server default (300s for this client / db) still applied and
  // REFRESH timed out at the same place the in-cron query did before.
  // 0 = no limit; this connection is short-lived and dedicated to the
  // refresh, so a runaway can't leak.
  await client.query("SET statement_timeout = 0");
  await client.query(`REFRESH MATERIALIZED VIEW public.${viewName}`);
  console.log(`[keywordCron] refreshed ${viewName} in ${elapsed(t0)}`);
}

// ── Trending ────────────────────────────────────────────────────────────────
// Top keywords by total mention volume over the last N days (global only).
// Reads from the keyword_trending_global MV; refreshes it first so each
// daily run sees a CURRENT_DATE-anchored window. Stopwords filter is
// applied at read time (not baked into the MV) so we can update the
// stopwords list without a migration.
async function computeTrending({ limit = 50, stopwords = [] } = {}) {
  const client = await pool.connect();
  try {
    await refreshMV(client, 'keyword_trending_global');
    const swTable = await ensureStopwordsTable(client, stopwords);
    const t0 = Date.now();
    // Translation pass mirrors server.js's live-fallback query (the path
    // that runs on cache miss and previously was the only one that
    // applied translation). The cron used to write raw `m.keyword` to
    // the cache, so the cache served untranslated keywords until it
    // happened to be evicted and the live-fallback wrote translated
    // rows through. Now the cron writes translated rows directly so
    // both paths are consistent.
    //
    // Stopwords filter runs TWICE: once on the raw form (saves work
    // and matches existing per-language stopword entries like Russian
    // "понедельник") and once on the translated form (catches cases
    // where a non-English word translates to an English stopword like
    // "monday"). Both reuse the same materialised temp table.
    //
    // GROUP BY COALESCE merges language variants — "выборы" + "election"
    // → single "election" row with summed mentions. days_active is
    // collapsed via MAX (approximation; exact COUNT(DISTINCT date) across
    // merged variants would require a third pass over keyword_daily_stats).
    const { rows } = await client.query(`
      WITH translated AS (
        SELECT
          COALESCE(kt.normalized_keyword, m.keyword) AS keyword,
          SUM(m.mentions)::bigint                    AS mentions,
          MAX(m.days_active)::int                    AS days_active
        FROM public.keyword_trending_global m
        LEFT JOIN public.keyword_translations kt
          ON kt.original_keyword = m.keyword
        WHERE NOT EXISTS (SELECT 1 FROM ${swTable} sw WHERE sw.word = m.keyword)
        GROUP BY COALESCE(kt.normalized_keyword, m.keyword)
      )
      SELECT t.keyword, t.mentions, t.days_active
      FROM translated t
      WHERE NOT EXISTS (SELECT 1 FROM ${swTable} sw WHERE sw.word = t.keyword)
      ORDER BY t.mentions DESC, t.keyword ASC
      LIMIT $1
    `, [limit]);
    console.log(`[keywordCron] trending read: ${rows.length} rows in ${elapsed(t0)}`);
    return rows;
  } finally {
    client.release();
  }
}

// ── Rising ──────────────────────────────────────────────────────────────────
// Keywords whose recent velocity is significantly above their baseline rate.
// Reads from the keyword_rising_global MV (same MV-refresh pattern as
// trending). Window constants (3d recent / 14d baseline) are baked into
// the MV definition — change them in the migration, not here.
async function computeRising({ limit = 30, stopwords = [] } = {}) {
  const client = await pool.connect();
  try {
    await refreshMV(client, 'keyword_rising_global');
    const swTable = await ensureStopwordsTable(client, stopwords);
    const t0 = Date.now();
    // Translation pass — see computeTrending for the rationale. Same
    // pattern: COALESCE-join keyword_translations, GROUP BY translated
    // form so language variants merge, double stopwords filter (raw +
    // translated). Momentum is RECOMPUTED from the merged recent/baseline
    // counts because two language variants merging changes the ratio:
    // e.g. raw "election" mentions (5) + raw "выборы" mentions (3) →
    // translated "election" mentions (8). We must recompute momentum
    // from the merged numerator/denominator, not naively sum or average
    // the per-variant momentum values from the MV.
    //
    // The 14/3 baseline-to-recent window ratio matches the MV definition
    // (14-day baseline window, 3-day recent window) — keep this in sync
    // with migrations/20260503_keyword_intel_materialized_views.sql.
    const { rows } = await client.query(`
      WITH translated AS (
        SELECT
          COALESCE(kt.normalized_keyword, m.keyword) AS keyword,
          SUM(m.recent_count)::bigint                AS recent_count,
          SUM(m.baseline_count)::bigint              AS baseline_count
        FROM public.keyword_rising_global m
        LEFT JOIN public.keyword_translations kt
          ON kt.original_keyword = m.keyword
        WHERE NOT EXISTS (SELECT 1 FROM ${swTable} sw WHERE sw.word = m.keyword)
        GROUP BY COALESCE(kt.normalized_keyword, m.keyword)
      )
      SELECT
        t.keyword,
        t.recent_count,
        t.baseline_count,
        CASE
          WHEN t.baseline_count = 0
            THEN t.recent_count * 10
          ELSE ROUND(
            (t.recent_count::numeric / NULLIF(t.baseline_count, 0)::numeric)
            * (14::numeric / 3::numeric) * 100
          ) / 100
        END AS momentum
      FROM translated t
      WHERE NOT EXISTS (SELECT 1 FROM ${swTable} sw WHERE sw.word = t.keyword)
      ORDER BY momentum DESC, t.recent_count DESC, t.keyword ASC
      LIMIT $1
    `, [limit]);
    console.log(`[keywordCron] rising read: ${rows.length} rows in ${elapsed(t0)}`);
    return rows.filter((row) => !isDateLikeKeyword(row && row.keyword));
  } finally {
    client.release();
  }
}

// ── Cache writer ─────────────────────────────────────────────────────────────
async function writeCache(mode, filterKey, results) {
  await pool.query(`
    INSERT INTO keyword_intelligence_cache (mode, filter_key, results)
    VALUES ($1, $2, $3)
  `, [mode, filterKey, JSON.stringify(results)]);

  // Prune: keep the 6 most recent rows per mode+filter (safety net for rollback)
  await pool.query(`
    DELETE FROM keyword_intelligence_cache
    WHERE mode = $1 AND filter_key = $2
      AND id NOT IN (
        SELECT id FROM keyword_intelligence_cache
        WHERE mode = $1 AND filter_key = $2
        ORDER BY computed_at DESC
        LIMIT 6
      )
  `, [mode, filterKey]);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  console.log(`[keywordCron] ${new Date().toISOString()} — starting`);

  // Prefetch stopwords once and pass to both queries as text[]. Replaces
  // a per-row NOT EXISTS subquery that was the dominant cost (and the
  // reason both sections were tripping the 90s statement_timeout).
  let stopwords = [];
  try {
    stopwords = await loadStopwords();
    console.log(`[keywordCron] loaded ${stopwords.length} stopwords`);
  } catch (err) {
    console.error(`[keywordCron] stopwords load failed: ${err.message} (continuing with empty list)`);
  }

  // Trending and rising are independent — if one trips the 90s
  // statement_timeout, the other should still try. We track per-section
  // success and only exit non-zero when BOTH fail (so cache freshness
  // for the surviving section is preserved on Render).
  let okCount = 0, attempted = 0;
  if (DO_TRENDING) {
    attempted++;
    try {
      const results = await computeTrending({ stopwords });
      await writeCache('trending', 'global', { keywords: results });
      console.log(`[keywordCron] trending: ${results.length} keywords cached (${elapsed(t0)})`);
      okCount++;
    } catch (err) {
      console.error(`[keywordCron] trending failed: ${err.message}`);
    }
  }
  if (DO_RISING) {
    attempted++;
    try {
      const results = await computeRising({ stopwords });
      await writeCache('rising', 'global', { keywords: results });
      console.log(`[keywordCron] rising:   ${results.length} keywords cached (${elapsed(t0)})`);
      okCount++;
    } catch (err) {
      console.error(`[keywordCron] rising failed: ${err.message}`);
    }
  }
  await pool.end().catch(() => {});
  if (attempted > 0 && okCount === 0) {
    console.error('[keywordCron] all sections failed');
    process.exit(1);
  }
  console.log(`[keywordCron] done in ${elapsed(t0)} (${okCount}/${attempted} sections refreshed)`);
}

run();
