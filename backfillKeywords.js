/**
 * backfillKeywords.js
 *
 * One-time script to extract and store keywords for all existing articles.
 * Picks up where it left off if interrupted (via keyword_backfill_progress).
 *
 * Usage:
 *   node backfillKeywords.js
 *   node backfillKeywords.js --batch=200   (override batch size)
 *   node backfillKeywords.js --reset       (restart from article 0)
 */

'use strict';

require('dotenv').config();
const pool                         = require('./db');
const { loadStopwords,
        extractKeywords,
        saveKeywords }             = require('./keywordExtractor');

// ─── Config ──────────────────────────────────────────────────────────────────

const BATCH_SIZE = parseInt((process.argv.find(a => a.startsWith('--batch=')) || '--batch=100').split('=')[1]);
const RESET           = process.argv.includes('--reset');
const NO_COOCCURRENCE = process.argv.includes('--no-cooccurrence');
const LOG_EVERY  = 100;
const PAUSE_MS   = 200;

process.on('unhandledRejection', (err) => { console.error('[backfill] Unhandled rejection:', err?.message || err); });
process.on('uncaughtException',  (err) => { console.error('[backfill] Uncaught exception:',  err?.message || err); });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function elapsed(startMs) {
  const s = Math.floor((Date.now() - startMs) / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function eta(startMs, done, total) {
  if (done === 0) return '?';
  const remaining = Math.floor((total - done) * ((Date.now() - startMs) / done) / 1000);
  return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

async function getProgress() {
  const { rows } = await pool.query(
    `SELECT last_article_id, total_processed, total_articles
     FROM keyword_backfill_progress ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || { last_article_id: 0, total_processed: 0, total_articles: 0 };
}

async function updateProgress(lastId, done, total) {
  await pool.query(
    `UPDATE keyword_backfill_progress
     SET last_article_id=$1, total_processed=$2, total_articles=$3, updated_at=NOW()
     WHERE id=(SELECT id FROM keyword_backfill_progress ORDER BY id DESC LIMIT 1)`,
    [lastId, done, total]
  );
}

async function markComplete() {
  await pool.query(
    `UPDATE keyword_backfill_progress SET completed_at=NOW()
     WHERE id=(SELECT id FROM keyword_backfill_progress ORDER BY id DESC LIMIT 1)`
  );
}

async function resetProgress(total) {
  await pool.query(
    `UPDATE keyword_backfill_progress
     SET last_article_id=0, total_processed=0, total_articles=$1,
         started_at=NOW(), updated_at=NOW(), completed_at=NULL
     WHERE id=(SELECT id FROM keyword_backfill_progress ORDER BY id DESC LIMIT 1)`,
    [total]
  );
}

// ─── Fetch batch ──────────────────────────────────────────────────────────────

async function fetchBatch(afterId, limit) {
  const { rows } = await pool.query(
    `SELECT
       a.id,
       a.title,
       a.summary,
       a.published_at,
       l.iso_code_2        AS language,
       ns.country_id       AS source_country_id,
       al.country_id       AS about_country_id
     FROM news_articles a
     JOIN news_sources ns ON ns.id = a.source_id
     LEFT JOIN languages l ON l.id = ns.language_id
     LEFT JOIN LATERAL (
       SELECT country_id FROM article_locations
       WHERE article_id = a.id LIMIT 1
     ) al ON true
     WHERE a.id > $1
     ORDER BY a.id ASC
     LIMIT $2`,
    [afterId, limit]
  );
  return rows;
}


// ─── Prune keyword_daily_stats ────────────────────────────────────────────────
// Keeps only the top 100 keywords per day (by total_count), deletes the rest.
async function pruneKeywordStats() {
  await pool.query(`
    DELETE FROM keyword_daily_stats
    WHERE (keyword, date, COALESCE(source_country_id::text,''), COALESCE(about_country_id::text,''))
    NOT IN (
      SELECT keyword, date, COALESCE(source_country_id::text,''), COALESCE(about_country_id::text,'')
      FROM (
        SELECT keyword, date, source_country_id, about_country_id,
               ROW_NUMBER() OVER (PARTITION BY date ORDER BY total_count DESC) AS rn
        FROM keyword_daily_stats
      ) ranked
      WHERE rn <= 100
    )
  `);
  console.log('[backfill] keyword_daily_stats pruned.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[backfill] Starting keyword backfill...');
  console.log(`[backfill] Batch size: ${BATCH_SIZE}`);

  const { rows: cr } = await pool.query('SELECT COUNT(*) FROM news_articles');
  const totalArticles = parseInt(cr[0].count);
  console.log(`[backfill] Total articles: ${totalArticles.toLocaleString()}`);

  if (RESET) {
    console.log('[backfill] --reset: restarting from 0');
    await resetProgress(totalArticles);
  }

  const progress = await getProgress();
  let lastId     = progress.last_article_id || 0;
  let totalDone  = progress.total_processed  || 0;

  if (totalDone > 0) {
    console.log(`[backfill] Resuming from article ID ${lastId} (${totalDone.toLocaleString()} already done)`);
  }

  console.log('[backfill] Loading stopwords...');
  const cache = await loadStopwords();
  console.log(`[backfill] Stopwords loaded for ${Object.keys(cache).length} languages`);
  console.log('[backfill] Starting main loop...');

  const startMs = Date.now();
  let errors    = 0;

  while (true) {
    const batch = await fetchBatch(lastId, BATCH_SIZE);
    if (batch.length === 0) break;

    for (const article of batch) {
      let retries = 3;
      while (retries > 0) {
        try {
          const lang     = article.language || 'en';
          const keywords = extractKeywords(
            { title: article.title, summary: article.summary },
            lang,
            cache
          );
          if (keywords.length > 0) {
            await saveKeywords(
              article.id,
              keywords,
              lang,
              article.published_at,
              article.source_country_id,
              article.about_country_id,
              undefined,        // client
              NO_COOCCURRENCE   // skip cooccurrence table
            );
          }
          totalDone++;
          lastId = article.id;
          break;
        } catch (err) {
          retries--;
          const isConnection = err.message?.includes('Connection terminated') ||
                               err.message?.includes('connect ECONNREFUSED') ||
                               err.code === 'ECONNRESET';
          if (retries > 0 && isConnection) {
            console.warn(`[backfill] Connection error on article ${article.id}, retrying in 3s... (${retries} left)`);
            await sleep(3000);
          } else {
            errors++;
            console.error(`[backfill] Error on article ${article.id}: ${err.message}`);
            break;
          }
        }
      }

      if (totalDone % LOG_EVERY === 0) {
        const pct = ((totalDone / totalArticles) * 100).toFixed(1);
        console.log(
          `[backfill] ${totalDone.toLocaleString()} / ${totalArticles.toLocaleString()} ` +
          `(${pct}%) | elapsed: ${elapsed(startMs)} | eta: ${eta(startMs, totalDone, totalArticles)} | errors: ${errors}`
        );
      }
    }

    await updateProgress(lastId, totalDone, totalArticles);
    await sleep(PAUSE_MS);
  }

  console.log('[backfill] Pruning keyword_daily_stats to top 100 per day...');
  await pruneKeywordStats();
  await markComplete();
  console.log('');
  console.log('[backfill] Complete!');
  console.log(`[backfill]   Processed : ${totalDone.toLocaleString()}`);
  console.log(`[backfill]   Errors    : ${errors}`);
  console.log(`[backfill]   Time      : ${elapsed(startMs)}`);

  await pool.end();
}

main().catch(err => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});