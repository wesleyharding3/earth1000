// rerouteAll.js
require("dotenv").config();
const pool = require("./db");
const { routeArticle } = require("./locationRouter");

async function rerouteAll() {
  const { rows } = await pool.query(`
    SELECT id FROM news_articles
    ORDER BY published_at ASC
  `);

  console.log(`🔄 Re-routing ${rows.length} articles...`);
  let success = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    try {
      // Skip if already routed
      const { rows: existing } = await pool.query(`
        SELECT 1 FROM article_locations
        WHERE article_id = $1
        LIMIT 1
      `, [row.id]);

      if (existing.length > 0) {
        skipped++;
        if (skipped % 1000 === 0) console.log(`⏭️  Skipped ${skipped} so far (processed ${skipped + success + failed}/${rows.length})`);
        continue;
      }

      await pool.query(`DELETE FROM article_locations WHERE article_id = $1`, [row.id]);
      await routeArticle(row.id);
      success++;
      if (success % 100 === 0) console.log(`✅ Progress: ${success}/${rows.length} (skipped: ${skipped})`);
    } catch (err) {
      failed++;
      console.error(`❌ Failed ${row.id}:`, err.message);
    }
  }

  console.log(`Done. ${success} routed, ${skipped} skipped, ${failed} failed.`);
  await pool.end();
  process.exit(0);
}

rerouteAll();