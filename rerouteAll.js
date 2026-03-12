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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rerouteAll() {
  const { rows } = await pool.query(`
    SELECT id FROM news_articles
    ORDER BY published_at DESC
  `);

  console.log(`🔄 Re-routing ${rows.length} articles...`);
  let success = 0, failed = 0;

  for (const row of rows) {
    let retries = 3;
    while (retries > 0) {
      try {
        await pool.query(`DELETE FROM article_locations WHERE article_id = $1`, [row.id]);
        await routeArticle(row.id);
        success++;
        if (success % 100 === 0) console.log(`✅ Progress: ${success}/${rows.length}`);
        break; // success
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
          console.error(`❌ Failed ${row.id}:`, err.message);
          break;
        }
      }
    }
  }

  console.log(`Done. ${success} routed, ${failed} failed.`);
  await pool.end();
  process.exit(0);
}

rerouteAll();