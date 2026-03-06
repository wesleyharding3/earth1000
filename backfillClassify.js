require("dotenv").config();
const pool = require("./db");
const { classifyArticle } = require("./scoringEngine");

/* =========================================
   Config
========================================= */
const BATCH_SIZE   = 50;    // higher than translate backfill — classify is CPU not API
const DELAY_MS     = 50;    // just enough to avoid hammering the DB
const MAX_ARTICLES = null;  // set to e.g. 1000 to cap a run, null = no cap

/* =========================================
   Utilities
========================================= */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================
   Main
========================================= */
async function backfillClassify() {
  console.log("🚀 Starting classification backfill...", new Date().toISOString());

  // Target articles that have been translated but whose classification
  // was computed before translation existed (title matches suggest
  // classification ran on raw/untranslated text, or no tags at all).
  const countRes = await pool.query(`
    SELECT COUNT(*) AS total
    FROM news_articles a
    WHERE a.translated_title IS NOT NULL
      AND a.translated_title != a.title
      AND a.language NOT ILIKE 'en%'
  `);

  const total = parseInt(countRes.rows[0].total);
  console.log(`📋 Translated articles to reclassify: ${total}`);

  if (total === 0) {
    console.log("✅ Nothing to reclassify. Exiting.");
    await pool.end();
    return;
  }

  let offset = 0;
  let totalDone   = 0;
  let totalFailed = 0;
  const startTime = Date.now();

  while (true) {
    const batchRes = await pool.query(`
      SELECT a.id, a.language, ns.popularity_tier
      FROM news_articles a
      JOIN news_sources ns ON ns.id = a.source_id
      WHERE a.translated_title IS NOT NULL
        AND a.translated_title != a.title
        AND a.language NOT ILIKE 'en%'
      ORDER BY ns.popularity_tier DESC NULLS LAST, a.ingested_at DESC
      LIMIT $1 OFFSET $2
    `, [BATCH_SIZE, offset]);

    const articles = batchRes.rows;
    if (!articles.length) break;

    for (const article of articles) {
      const elapsed  = Math.round((Date.now() - startTime) / 1000);
      const progress = totalDone + totalFailed + 1;
      const tag      = `[${progress}/${total}] [${elapsed}s] ID:${article.id} (${article.language})`;

      try {
        await classifyArticle(article.id);
        console.log(`${tag} ✅ Classified`);
        totalDone++;
      } catch (err) {
        console.error(`${tag} ❌ Failed: ${err.message}`);
        totalFailed++;
      }

      await sleep(DELAY_MS);

      if (MAX_ARTICLES && progress >= MAX_ARTICLES) {
        console.log(`\n🛑 Reached MAX_ARTICLES cap (${MAX_ARTICLES}). Stopping.`);
        break;
      }
    }

    if (MAX_ARTICLES && (totalDone + totalFailed) >= MAX_ARTICLES) break;

    offset += BATCH_SIZE;
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n🏁 Classification backfill complete in ${totalTime}s`);
  console.log(`   ✅ Classified: ${totalDone}`);
  console.log(`   ❌ Failed:     ${totalFailed}`);

  await pool.end();
}

backfillClassify().catch(err => {
  console.error("🚨 Fatal error:", err);
  process.exit(1);
});