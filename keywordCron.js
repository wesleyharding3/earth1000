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

// ── Trending ────────────────────────────────────────────────────────────────
// Top keywords by total mention volume over the last N days (global only).
async function computeTrending({ days = 7, limit = 50, stopwords = [] } = {}) {
  // Bumped 90s → 300s. Original 90s was scoped to prevent overlapping cron
  // invocations from compounding slot occupation, but trending/rising are
  // already sequenced (and run at independent schedules), so the overlap
  // concern doesn't apply. 300s gives headroom for the GROUP BY across a
  // full week's global window.
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '300s'");
    const swTable = await ensureStopwordsTable(client, stopwords);
    const t0 = Date.now();
    const { rows } = await client.query(`
      SELECT
        k.keyword,
        SUM(k.total_count)::bigint  AS mentions,
        COUNT(DISTINCT k.date)::int AS days_active
      FROM keyword_daily_stats k
      WHERE k.date              >= CURRENT_DATE - $1::int
        AND k.source_country_id IS NULL
        AND k.about_country_id  IS NULL
        AND NOT EXISTS (SELECT 1 FROM ${swTable} sw WHERE sw.word = k.keyword)
      GROUP BY k.keyword
      HAVING SUM(k.total_count) >= 3
      ORDER BY mentions DESC, k.keyword ASC
      LIMIT $2
    `, [days, limit]);
    console.log(`[keywordCron] trending query: ${rows.length} rows in ${elapsed(t0)}`);
    return rows;
  } finally {
    client.release();
  }
}

// ── Rising ──────────────────────────────────────────────────────────────────
// Keywords whose recent velocity is significantly above their baseline rate.
async function computeRising({ days = 3, baselineDays = 14, limit = 30, stopwords = [] } = {}) {
  // Same 300s bound as computeTrending — see comment there.
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '300s'");
    const swTable = await ensureStopwordsTable(client, stopwords);
    const t0 = Date.now();
    // Single 17-day scan with FILTER aggregates instead of two CTEs that
    // each scanned + grouped independently and then joined. Cuts the work
    // roughly in half — one index scan, one HashAggregate, one anti-join,
    // no JOIN. Same semantics as the old recent/baseline split.
    const { rows } = await client.query(`
    WITH combined AS (
      SELECT
        k.keyword,
        SUM(k.total_count) FILTER (WHERE k.date >= CURRENT_DATE - $1::int)::bigint AS recent_count,
        SUM(k.total_count) FILTER (WHERE k.date <  CURRENT_DATE - $1::int)::bigint AS baseline_count
      FROM keyword_daily_stats k
      WHERE k.date              >= CURRENT_DATE - ($1::int + $2::int)
        AND k.source_country_id IS NULL
        AND k.about_country_id  IS NULL
        AND NOT EXISTS (SELECT 1 FROM ${swTable} sw WHERE sw.word = k.keyword)
      GROUP BY k.keyword
      HAVING SUM(k.total_count) FILTER (WHERE k.date >= CURRENT_DATE - $1::int) >= 2
    )
    SELECT
      c.keyword,
      c.recent_count,
      COALESCE(c.baseline_count, 0) AS baseline_count,
      CASE
        WHEN COALESCE(c.baseline_count, 0) = 0
          THEN c.recent_count * 10
        ELSE ROUND(
          (c.recent_count::numeric / c.baseline_count::numeric)
          * ($2::numeric / $1::numeric) * 100
        ) / 100
      END AS momentum
    FROM combined c
    ORDER BY momentum DESC, c.recent_count DESC, c.keyword ASC
    LIMIT $3
    `, [days, baselineDays, limit]);
    console.log(`[keywordCron] rising query: ${rows.length} rows in ${elapsed(t0)}`);
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
