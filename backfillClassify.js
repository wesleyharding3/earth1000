require("dotenv").config();
const pool = require("./db");
const { classifyArticle } = require("./scoringEngine");

/* =========================================
   Config
========================================= */
const BATCH_SIZE   = 50;
const DELAY_MS     = 50;
const MAX_ARTICLES = null;
const JOB_NAME     = "backfill_classify_v1"; // bump this to force a fresh run

/* =========================================
   Utilities
========================================= */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================
   Checkpoint helpers
   Stores progress in the DB so shell restarts resume from the
   last processed article ID, not from offset 0.
=========================================*/
async function ensureCheckpointTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backfill_progress (
      job_name    TEXT PRIMARY KEY,
      last_id     BIGINT NOT NULL DEFAULT 0,
      done        INTEGER NOT NULL DEFAULT 0,
      failed      INTEGER NOT NULL DEFAULT 0,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadCheckpoint() {
  const { rows } = await pool.query(
    `SELECT last_id, done, failed FROM backfill_progress WHERE job_name = $1`,
    [JOB_NAME]
  );
  if (rows.length) return rows[0];
  await pool.query(
    `INSERT INTO backfill_progress (job_name, last_id, done, failed)
     VALUES ($1, 0, 0, 0)`,
    [JOB_NAME]
  );
  return { last_id: 0, done: 0, failed: 0 };
}

async function saveCheckpoint(lastId, done, failed) {
  await pool.query(
    `UPDATE backfill_progress
     SET last_id = $1, done = $2, failed = $3, updated_at = NOW()
     WHERE job_name = $4`,
    [lastId, done, failed, JOB_NAME]
  );
}

/* =========================================
   Main
========================================= */
async function backfillClassify() {
  await ensureCheckpointTable();

  const checkpoint = await loadCheckpoint();
  let lastId      = parseInt(checkpoint.last_id);
  let totalDone   = parseInt(checkpoint.done);
  let totalFailed = parseInt(checkpoint.failed);

  const countRes = await pool.query(`
    SELECT COUNT(*) AS total
    FROM news_articles a
    LEFT JOIN article_tags at ON at.article_id = a.id
    WHERE at.article_id IS NULL
      AND a.id > $1
  `, [lastId]);
  const remaining = parseInt(countRes.rows[0].total);

  console.log(`\n🚀 Classification backfill — ${new Date().toISOString()}`);
  console.log(`   Resuming from article ID > ${lastId}`);
  console.log(`   Previously done: ${totalDone} | failed: ${totalFailed}`);
  console.log(`   Remaining: ${remaining}\n`);

  if (remaining === 0) {
    console.log("✅ All articles classified. Exiting.");
    await pool.end();
    return;
  }

  const startTime = Date.now();

  while (true) {
    // ID-cursor pagination — immune to offset drift on restart.
    // Always fetches the next untagged batch strictly after lastId.
    const batchRes = await pool.query(`
      SELECT a.id, COALESCE(a.language, 'en') AS language,
             COALESCE(ns.popularity_tier, ys.popularity_tier, 1) AS popularity_tier
      FROM news_articles a
      LEFT JOIN article_tags at ON at.article_id = a.id
      LEFT JOIN news_sources    ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE at.article_id IS NULL
        AND a.id > $1
      ORDER BY a.id ASC
      LIMIT $2
    `, [lastId, BATCH_SIZE]);

    const articles = batchRes.rows;
    if (!articles.length) break;

    for (const article of articles) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const tag     = `[done:${totalDone} fail:${totalFailed}] [${elapsed}s] ID:${article.id} (${article.language} tier:${article.popularity_tier})`;

      try {
        await classifyArticle(article.id);
        console.log(`${tag} ✅`);
        totalDone++;
      } catch (err) {
        console.error(`${tag} ❌ ${err.message}`);
        totalFailed++;
      }

      // Always advance cursor past this article — failed ones are skipped this run,
      // restart with a fresh JOB_NAME to retry them.
      lastId = article.id;

      await sleep(DELAY_MS);

      if (MAX_ARTICLES && (totalDone + totalFailed) >= MAX_ARTICLES) {
        console.log(`\n🛑 Reached MAX_ARTICLES cap. Stopping.`);
        break;
      }
    }

    // Save after every batch — worst case a crash loses BATCH_SIZE articles
    await saveCheckpoint(lastId, totalDone, totalFailed);
    console.log(`   💾 Checkpoint — last_id: ${lastId} | done: ${totalDone} | failed: ${totalFailed}`);

    if (MAX_ARTICLES && (totalDone + totalFailed) >= MAX_ARTICLES) break;
  }

  await saveCheckpoint(lastId, totalDone, totalFailed);

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n🏁 Session complete in ${totalTime}s`);
  console.log(`   ✅ Classified: ${totalDone}`);
  console.log(`   ❌ Failed:     ${totalFailed}`);
  console.log(`   📍 Last ID:    ${lastId}`);

  await pool.end();
}

backfillClassify().catch(err => {
  console.error("🚨 Fatal error:", err);
  process.exit(1);
});