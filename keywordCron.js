#!/usr/bin/env node
'use strict';
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

// ── Trending ────────────────────────────────────────────────────────────────
// Top keywords by total mention volume over the last N days (global only).
async function computeTrending({ days = 7, limit = 50 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      k.keyword,
      SUM(k.total_count)::bigint  AS mentions,
      COUNT(DISTINCT k.date)::int AS days_active
    FROM keyword_daily_stats k
    WHERE k.date              >= CURRENT_DATE - $1::int
      AND k.source_country_id IS NULL
      AND k.about_country_id  IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword
      )
    GROUP BY k.keyword
    HAVING SUM(k.total_count) >= 3
    ORDER BY mentions DESC, k.keyword ASC
    LIMIT $2
  `, [days, limit]);
  return rows;
}

// ── Rising ──────────────────────────────────────────────────────────────────
// Keywords whose recent velocity is significantly above their baseline rate.
async function computeRising({ days = 3, baselineDays = 14, limit = 30 } = {}) {
  const { rows } = await pool.query(`
    WITH recent AS (
      SELECT k.keyword, SUM(k.total_count)::bigint AS recent_count
      FROM keyword_daily_stats k
      WHERE k.date              >= CURRENT_DATE - $1::int
        AND k.source_country_id IS NULL
        AND k.about_country_id  IS NULL
        AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)
      GROUP BY k.keyword
      HAVING SUM(k.total_count) >= 2
    ),
    baseline AS (
      SELECT k.keyword, SUM(k.total_count)::bigint AS baseline_count
      FROM keyword_daily_stats k
      WHERE k.date              >= CURRENT_DATE - ($1::int + $2::int)
        AND k.date               < CURRENT_DATE - $1::int
        AND k.source_country_id IS NULL
        AND k.about_country_id  IS NULL
        AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)
      GROUP BY k.keyword
    )
    SELECT
      r.keyword,
      r.recent_count,
      COALESCE(b.baseline_count, 0) AS baseline_count,
      CASE
        WHEN COALESCE(b.baseline_count, 0) = 0
          THEN r.recent_count * 10
        ELSE ROUND(
          (r.recent_count::numeric / b.baseline_count::numeric)
          * ($2::numeric / $1::numeric) * 100
        ) / 100
      END AS momentum
    FROM recent r
    LEFT JOIN baseline b USING (keyword)
    WHERE r.recent_count >= 2
    ORDER BY momentum DESC, r.recent_count DESC, r.keyword ASC
    LIMIT $3
  `, [days, baselineDays, limit]);
  return rows.filter((row) => !isDateLikeKeyword(row && row.keyword));
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

  try {
    if (DO_TRENDING) {
      const results = await computeTrending();
      await writeCache('trending', 'global', results);
      console.log(`[keywordCron] trending: ${results.length} keywords cached (${elapsed(t0)})`);
    }

    if (DO_RISING) {
      const results = await computeRising();
      await writeCache('rising', 'global', results);
      console.log(`[keywordCron] rising:   ${results.length} keywords cached (${elapsed(t0)})`);
    }

    console.log(`[keywordCron] done in ${elapsed(t0)}`);
  } catch (err) {
    console.error('[keywordCron] fatal:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
