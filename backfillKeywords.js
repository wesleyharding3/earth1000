/**
 * backfillKeywords.js
 *
 * One-time script to extract and store keywords for all existing articles.
 * Picks up where it left off if interrupted (via keyword_backfill_progress).
 *
 * Usage:
 *   node backfillKeywords.js
 *   node backfillKeywords.js --batch 200    (override batch size)
 *   node backfillKeywords.js --reset        (restart from article 0)
 *
 * Safe to re-run — all DB writes use ON CONFLICT DO NOTHING.
 */

'use strict';

const pool                         = require('./db');
const { loadStopwords,
        extractKeywords,
        saveKeywords }             = require('./keywordExtractor');

// ─── Config ─────────────────────────────────────────────────────────────────

const BATCH_SIZE      = parseInt(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] || '100');
const RESET           = process.argv.includes('--reset');
const LOG_EVERY       = 10;    // print progress every N articles
const PAUSE_MS        = 50;    // ms pause between batches (be kind to DB)

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function elapsed(startMs) {
  const s = Math.floor((Date.now() - startMs) / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function eta(startMs, done, total) {
  if (done === 0) return '?';
  const msPerItem = (Date.now() - startMs) / done;
  const remaining = Math.floor((total - done) * msPerItem / 1000);
  return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
}

// ─── Progress tracking ────────────────────────────────────────────────────────

async function getProgress() {
  const { rows } = await pool.query(
    `SELECT last_article_id, total_processed, total_articles
     FROM keyword_backfill_progress
     ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || { last_article_id: 0, total_processed: 0, total_articles: 0 };
}

async function updateProgress(lastArticleId, totalProcessed, totalArticles) {
  await pool.query(
    `UPDATE keyword_backfill_progress
     SET last_article_id = $1,
         total_processed = $2,
         total_articles  = $3,
         updated_at      = NOW()
     WHERE id = (SELECT id FROM keyword_backfill_progress ORDER BY id DESC LIMIT 1)`,
    [lastArticleId, totalProcessed, totalArticles]
  );
}

async function markComplete() {
  await pool.query(
    `UPDATE keyword_backfill_progress
     SET completed_at = NOW()
     WHERE id = (SELECT id FROM keyword_backfill_progress ORDER BY id DESC LIMIT 1)`
  );
}

async function resetProgress(totalArticles) {
  await pool.query(
    `UPDATE keyword_backfill_progress
     SET last_article_id = 0,
         total_processed = 0,
         total_articles  = $1,
         started_at      = NOW(),
         updated_at      = NOW(),
         completed_at    = NULL
     WHERE id = (SELECT id FROM keyword_backfill_progress ORDER BY id DESC LIMIT 1)`,
    [totalArticles]
  );
}

// ─── Fetch a batch of articles ────────────────────────────────────────────────

async function fetchBatch(afterId, limit) {
  const { rows } = await pool.query(
    `SELECT
       a.id,
       a.title,
       a.summary,
       a.published_at,
       l.iso_code_2          AS language,
       ns.country_id         AS source_country_id,
       al.country_id         AS about_country_id
     FROM news_articles a
     JOIN news_sources  ns ON ns.id = a.source_id
     LEFT JOIN languages l  ON l.id  = ns.language_id
     LEFT JOIN LATERAL (
       SELECT country_id FROM article_locations
       WHERE article_id = a.id
       LIMIT 1
     ) al ON true
     WHERE a.id > $1
     ORDER BY a.id ASC
     LIMIT $2`,
    [afterId, limit]
  );
  return rows;
}

// ─── Process one article ──────────────────────────────────────────────────────

async function processArticle(article, cache) {
  const lang = article.language || 'en';
  if (totalDone < 3) console.log(`[backfill] processing article ${article.id} lang=${lang} title=${(article.title||'').slice(0,40)}`);

  const keywords = extractKeywords(
    { title: article.title, summary: article.summary },
    lang,
    cache
  );

  if (totalDone < 3) console.log(`[backfill] extracted ${keywords.length} keywords for article ${article.id}`);
  if (keywords.length === 0) return;

  await saveKeywords(
    article.id,
    keywords,
    lang,
    article.published_at,
    article.source_country_id,
    article.about_country_id
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[backfill] Starting keyword backfill...');
  console.log(`[backfill] Batch size: ${BATCH_SIZE}`);

  // Count total articles
  const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM news_articles');
  const totalArticles = parseInt(countRows[0].count);
  console.log(`[backfill] Total articles in DB: ${totalArticles.toLocaleString()}`);

  // Handle --reset flag
  if (RESET) {
    console.log('[backfill] --reset flag: restarting from article 0');
    await resetProgress(totalArticles);
  }

  // Load progress
  const progress = await getProgress();
  let lastId        = progress.last_article_id || 0;
  let totalDone     = progress.total_processed  || 0;
  console.log('[backfill] Starting main loop...');

  if (totalDone > 0) {
    console.log(`[backfill] Resuming from article ID ${lastId} (${totalDone.toLocaleString()} already processed)`);
  }

  // Load stopwords once
  console.log('[backfill] Loading stopwords...');
  const cache = await loadStopwords();
  const langCount = Object.keys(cache).length;
  console.log(`[backfill] Stopwords loaded for ${langCount} languages`);

  const startMs = Date.now();
  let batchCount = 0;
  let errors     = 0;

  // ── Main loop
  while (true) {
    const batch = await fetchBatch(lastId, BATCH_SIZE);
    if (batch.length === 0) break;

    for (const article of batch) {
      try {
        await processArticle(article, cache);
        totalDone++;
        lastId = article.id;
      } catch (err) {
        errors++;
        console.error(`[backfill] Error on article ${article.id}: ${err.message}`);
      }

      if (totalDone % LOG_EVERY === 0) {
        const pct = ((totalDone / totalArticles) * 100).toFixed(1);
        console.log(
          `[backfill] ${totalDone.toLocaleString()} / ${totalArticles.toLocaleString()} ` +
          `(${pct}%) | elapsed: ${elapsed(startMs)} | eta: ${eta(startMs, totalDone, totalArticles)} | errors: ${errors}`
        );
      }
    }

    batchCount++;
    await updateProgress(lastId, totalDone, totalArticles);
    await sleep(PAUSE_MS);
  }

  await markComplete();

  console.log('');
  console.log('[backfill] ✓ Complete!');
  console.log(`[backfill]   Articles processed : ${totalDone.toLocaleString()}`);
  console.log(`[backfill]   Errors skipped     : ${errors}`);
  console.log(`[backfill]   Total time         : ${elapsed(startMs)}`);

  await pool.end();
}

main().catch(err => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});