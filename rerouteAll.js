// rerouteAll.js
require("dotenv").config();
const pool = require("./db");
const { routeArticle } = require("./locationRouter");

async function rerouteAll() {
  const { rows } = await pool.query(`
    SELECT id FROM news_articles
    WHERE published_at > NOW() - INTERVAL '7 days'
    ORDER BY published_at DESC
  `);

  console.log(`🔄 Re-routing ${rows.length} articles...`);

  for (const row of rows) {
    try {
      // Clear old routing first
      await pool.query(`DELETE FROM article_locations WHERE article_id = $1`, [row.id]);
      await routeArticle(row.id);
      console.log(`✅ Routed ${row.id}`);
    } catch (err) {
      console.error(`❌ Failed ${row.id}:`, err.message);
    }
  }

  console.log("Done.");
  process.exit(0);
}

rerouteAll();