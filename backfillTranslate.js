require("dotenv").config();
const pool = require("./db");
const { translateText } = require("./translator");

/* =========================================
   Config — tweak these before running
========================================= */
const BATCH_SIZE          = 20;    // articles per DB batch
const DELAY_MS            = 1200;  // ms between each article (DeepL rate limit safety)
const TRANSLATE_TITLES    = true;
const TRANSLATE_SUMMARIES = true;
const MAX_ARTICLES        = null;  // set to e.g. 500 to cap a run, null = no cap
const TARGET_LANG         = "EN-US";

/* =========================================
   Utilities
========================================= */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function translateWithTimeout(text, lang, timeoutMs = 12000) {
  if (!text) return null;
  return Promise.race([
    translateText(text, lang),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Translation timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

/* =========================================
   Main
========================================= */
async function backfillTranslations() {
  console.log("🚀 Starting translation backfill...", new Date().toISOString());

  const countRes = await pool.query(`
    SELECT COUNT(*) AS total
    FROM news_articles
    WHERE language IS NOT NULL
      AND language NOT ILIKE 'en%'
      AND (
        (translated_title   IS NULL OR translated_title   = title)
        OR
        (translated_summary IS NULL OR translated_summary = summary)
      )
  `);

  const total = parseInt(countRes.rows[0].total);
  console.log(`📋 Articles needing translation: ${total}`);

  if (total === 0) {
    console.log("✅ Nothing to translate. Exiting.");
    await pool.end();
    return;
  }

  let offset = 0;
  let totalTranslated = 0;
  let totalFailed = 0;
  const startTime = Date.now();

  while (true) {
    const batchRes = await pool.query(`
      SELECT id, title, summary, translated_title, translated_summary, language
      FROM news_articles
      WHERE language IS NOT NULL
        AND language NOT ILIKE 'en%'
        AND (
          (translated_title   IS NULL OR translated_title   = title)
          OR
          (translated_summary IS NULL OR translated_summary = summary)
        )
      ORDER BY ingested_at DESC
      LIMIT $1 OFFSET $2
    `, [BATCH_SIZE, offset]);

    const articles = batchRes.rows;
    if (articles.length === 0) break;

    for (const article of articles) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const progress = totalTranslated + totalFailed + 1;
      const tag = `[${progress}/${total}] [${elapsed}s] ID:${article.id} (${article.language})`;

      let newTitle   = article.translated_title;
      let newSummary = article.translated_summary;
      let changed    = false;

      try {
        if (
          TRANSLATE_TITLES &&
          article.title &&
          (!article.translated_title || article.translated_title === article.title)
        ) {
          console.log(`${tag} 🌍 Translating title...`);
          newTitle = await translateWithTimeout(article.title, TARGET_LANG);
          changed = true;
        }

        if (
          TRANSLATE_SUMMARIES &&
          article.summary &&
          (!article.translated_summary || article.translated_summary === article.summary)
        ) {
          console.log(`${tag} 🌍 Translating summary...`);
          newSummary = await translateWithTimeout(article.summary, TARGET_LANG);
          changed = true;
        }

        if (changed) {
          await pool.query(
            `UPDATE news_articles
             SET translated_title   = $1,
                 translated_summary = $2
             WHERE id = $3`,
            [newTitle, newSummary, article.id]
          );
          console.log(`${tag} ✅ Done`);
          totalTranslated++;
        } else {
          console.log(`${tag} ⏭️  Skipped (nothing to update)`);
        }

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

    if (MAX_ARTICLES && (totalTranslated + totalFailed) >= MAX_ARTICLES) break;

    offset += BATCH_SIZE;
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n🏁 Backfill complete in ${totalTime}s`);
  console.log(`   ✅ Translated: ${totalTranslated}`);
  console.log(`   ❌ Failed:     ${totalFailed}`);

  await pool.end();
}

backfillTranslations().catch(err => {
  console.error("🚨 Fatal error:", err);
  process.exit(1);
});