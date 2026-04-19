/**
 * keywordNormalizerCron.js — DECOUPLED KEYWORD NORMALIZER
 *
 * Standalone entrypoint. Scheduled as a Render cron hourly (or tighter).
 * Populates article_keywords.normalized_keyword + keyword_translations with
 * the English form of non-English keywords so that storyThreadBuilder's
 * SQL clustering can bridge languages BEFORE any article reaches Claude.
 *
 * Why this exists:
 *
 *   The normalizer used to run inside storyThreadBuilder (4× / day), capped
 *   at 800 keywords / 80 000 chars / run, wrapped in a silent-catch that
 *   masked any failure. Real-world coverage over 48 h of ingest:
 *
 *     lang    rows       normalized   pct
 *     ru      205 550       32         0.0%
 *     ar      140 115      280         0.2%
 *     zh       22 500        1         0.0%
 *     ja       23 100        0         0.0%
 *     (every non-English language at 0–0.8%)
 *
 *   At that coverage the COALESCE(normalized_keyword, keyword) in
 *   getUnthreadedArticles falls through to the raw source-language keyword
 *   on nearly every non-English row, and the cross-language bridge
 *   effectively does not exist. Non-English articles silo into their own
 *   un-clusterable corner of the dataset.
 *
 * Sizing (as of 2026-04-19):
 *
 *   uncached non-English uniques, 48h, >=3 articles:   ~120 000
 *   per day (≈ 60 000 / day steady state)              ~ 60 000
 *
 *   Budget at keyword_limit=5 000 / run × 24 runs/day = 120 000/day
 *   which keeps us ahead of incoming backlog with headroom.
 *
 * Cost (Claude Haiku 4.5):
 *
 *   ~$0.00003 per keyword × 60 000 / day ≈ $1.80 / day ($54 / mo).
 *   ~8.7× cheaper than the DeepL fallback at the same scope.
 *
 * Loudness:
 *
 *   Errors propagate via process.exit(1) so Render cron logs surface them.
 *   No silent-catch. If ANTHROPIC_API_KEY is missing we refuse to run
 *   rather than silently falling back to DeepL at $12+/day.
 *
 * Usage:
 *   node keywordNormalizerCron.js                 — default 48h lookback
 *   node keywordNormalizerCron.js --hours=24      — custom window
 *
 * Environment knobs (all optional):
 *   NORMALIZER_KEYWORD_LIMIT   default 5000
 *   NORMALIZER_CHAR_CAP        default 400000
 *   NORMALIZER_MIN_ROWS        default 2
 *   NORMALIZER_MIN_FREQUENCY   default 3
 */

'use strict';

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');
const { normalizeRecentKeywords } = require('./keywordNormalizer');

const LOOKBACK_HOURS = parseInt(
  process.argv.find(a => a.startsWith('--hours='))?.split('=')[1] || '48',
  10
);
const KEYWORD_LIMIT  = parseInt(process.env.NORMALIZER_KEYWORD_LIMIT || '5000', 10);
const CHAR_CAP       = parseInt(process.env.NORMALIZER_CHAR_CAP      || '400000', 10);
const MIN_ROWS       = parseInt(process.env.NORMALIZER_MIN_ROWS      || '2', 10);
const MIN_FREQUENCY  = parseInt(process.env.NORMALIZER_MIN_FREQUENCY || '3', 10);
const STATEMENT_TIMEOUT_MS = 300_000; // 5 min — candidate query is heavy

async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`\n🌐 Keyword Normalizer (standalone) — ${new Date().toISOString()}`);
  console.log(`   lookback=${LOOKBACK_HOURS}h  kw_limit=${KEYWORD_LIMIT}  char_cap=${CHAR_CAP}  min_rows=${MIN_ROWS}  min_freq=${MIN_FREQUENCY}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    // Fail loud. Earlier pipeline fell back to DeepL silently when Claude
    // was unavailable; DeepL at this cap would run ~$25+/day — blow the
    // whole translation budget. Easier to surface the missing key in
    // Render logs and fix it than to pay for it.
    throw new Error('ANTHROPIC_API_KEY is not set — refusing to run (DeepL fallback too expensive at this cap).');
  }

  const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Dedicated connection with extended statement_timeout. The candidate
  // query joins article_keywords ⨝ news_articles ⨝ keyword_translations
  // over the lookback window + anti-join filter; on a warm index it
  // returns in 30–60s, but cold it can push 3 min. Give it 5.
  const client = await pool.connect();
  await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

  let result;
  try {
    console.log(`   [${elapsed()}] starting normalizer pass...`);
    result = await normalizeRecentKeywords({
      pool: client,
      anthropicClient,
      logger: console,
      keywordLimit: KEYWORD_LIMIT,
      charCap:      CHAR_CAP,
      minRows:      MIN_ROWS,
      minFrequency: MIN_FREQUENCY,
      scope:        { hours: LOOKBACK_HOURS }
    });
  } finally {
    client.release();
  }

  console.log(`\n   [${elapsed()}] === SUMMARY ===`);
  console.log(`   provider           : ${result.provider}`);
  console.log(`   candidate_keywords : ${result.candidateKeywords}`);
  console.log(`   translated_chars   : ${result.translatedChars}`);
  console.log(`   updated_keywords   : ${result.updatedKeywords}`);
  console.log(`   updated_rows       : ${result.updatedRows}`);
  console.log(`   [${elapsed()}] DONE\n`);

  await pool.end();
}

run().catch(err => {
  // Propagate non-zero exit so Render marks the run failed and alerts fire.
  console.error(`\n[keywordNormalizerCron] FATAL: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
