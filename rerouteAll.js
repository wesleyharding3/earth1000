// rerouteAll.js
require("dotenv").config();
const pool = require("./db");
const { routeArticle } = require("./locationRouter");

// Prevent dropped-connection events from crashing the process
process.on('unhandledRejection', (err) => {
  console.error('[rerouteAll] Unhandled rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[rerouteAll] Uncaught exception:', err?.message || err);
});

const RESET    = process.argv.includes('--reset');
const LOG_EVERY = 100;
const BATCH_SIZE = 200;
const PAUSE_MS   = 100;

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

// ── Progress tracking (reuses keyword_backfill_progress pattern but in a dedicated table)
async function ensureProgressTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reroute_progress (
      id            SERIAL PRIMARY KEY,
      last_article_id BIGINT  NOT NULL DEFAULT 0,
      total_processed INT     NOT NULL DEFAULT 0,
      total_articles  INT     NOT NULL DEFAULT 0,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    )
  `);
  const { rows } = await pool.query(`SELECT id FROM reroute_progress ORDER BY id DESC LIMIT 1`);
  if (rows.length === 0) {
    await pool.query(`INSERT INTO reroute_progress DEFAULT VALUES`);
  }
}

async function getProgress() {
  const { rows } = await pool.query(
    `SELECT last_article_id, total_processed, total_articles
     FROM reroute_progress ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || { last_article_id: 0, total_processed: 0, total_articles: 0 };
}

async function updateProgress(lastId, done, total) {
  await pool.query(
    `UPDATE reroute_progress
     SET last_article_id=$1, total_processed=$2, total_articles=$3, updated_at=NOW()
     WHERE id=(SELECT id FROM reroute_progress ORDER BY id DESC LIMIT 1)`,
    [lastId, done, total]
  );
}

async function resetProgress(total) {
  await pool.query(
    `UPDATE reroute_progress
     SET last_article_id=0, total_processed=0, total_articles=$1,
         started_at=NOW(), updated_at=NOW(), completed_at=NULL
     WHERE id=(SELECT id FROM reroute_progress ORDER BY id DESC LIMIT 1)`,
    [total]
  );
}

async function markComplete() {
  await pool.query(
    `UPDATE reroute_progress SET completed_at=NOW()
     WHERE id=(SELECT id FROM reroute_progress ORDER BY id DESC LIMIT 1)`
  );
}

async function fetchBatch(afterId, limit) {
  const { rows } = await pool.query(
    `SELECT id FROM news_articles
     WHERE id > $1
     ORDER BY id ASC
     LIMIT $2`,
    [afterId, limit]
  );
  return rows;
}

async function rerouteAll() {
  await ensureProgressTable();

  const { rows: cr } = await pool.query(`SELECT COUNT(*) FROM news_articles`);
  const totalArticles = parseInt(cr[0].count);
  console.log(`[rerouteAll] Total articles: ${totalArticles.toLocaleString()}`);

  if (RESET) {
    console.log('[rerouteAll] --reset: restarting from 0');
    await resetProgress(totalArticles);
  }

  const progress = await getProgress();
  let lastId    = progress.last_article_id || 0;
  let totalDone = progress.total_processed  || 0;

  if (totalDone > 0) {
    console.log(`[rerouteAll] Resuming from article ID ${lastId} (${totalDone.toLocaleString()} already done)`);
  } else {
    console.log(`[rerouteAll] Starting from the beginning`);
    await resetProgress(totalArticles);
  }

  console.log(`[rerouteAll] Starting main loop...`);

  const startMs = Date.now();
  let success = totalDone;
  let failed  = 0;

  while (true) {
    const batch = await fetchBatch(lastId, BATCH_SIZE);
    if (batch.length === 0) break;

    for (const row of batch) {
      let retries = 3;
      while (retries > 0) {
        try {
          await pool.query(`DELETE FROM article_locations WHERE article_id = $1`, [row.id]);
          await routeArticle(row.id);
          success++;
          lastId = row.id;
          break;
        } catch (err) {
          retries--;
          const isConnection = err.message?.includes('Connection terminated') ||
                               err.message?.includes('connect ECONNREFUSED') ||
                               err.code === 'ECONNRESET';
          if (retries > 0 && isConnection) {
            console.warn(`[rerouteAll] Connection error on article ${row.id}, retrying in 3s... (${retries} left)`);
            await sleep(3000);
          } else {
            failed++;
            console.error(`❌ Failed ${row.id}: ${err.message}`);
            lastId = row.id; // still advance past it
            break;
          }
        }
      }

      if (success % LOG_EVERY === 0) {
        const pct = ((success / totalArticles) * 100).toFixed(1);
        console.log(
          `✅ ${success.toLocaleString()} / ${totalArticles.toLocaleString()} ` +
          `(${pct}%) | elapsed: ${elapsed(startMs)} | eta: ${eta(startMs, success, totalArticles)} | failed: ${failed}`
        );
      }
    }

    await updateProgress(lastId, success, totalArticles);
    await sleep(PAUSE_MS);
  }

  await markComplete();
  console.log('');
  console.log(`[rerouteAll] Done. ${success.toLocaleString()} routed, ${failed} failed. Time: ${elapsed(startMs)}`);
  await pool.end();
  process.exit(0);
}

rerouteAll();