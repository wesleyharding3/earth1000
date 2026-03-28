require("dotenv").config();

const pool = require("./db");

async function run() {
  console.log(`[resetFetchBootstrap] starting ${new Date().toISOString()}`);

  const result = await pool.query(`
    UPDATE news_sources
       SET fetch_tier = 4,
           fetch_tier_updated_at = NOW(),
           fetch_tier_last_changed_at = NOW(),
           fetch_bootstrap_phase = 'baseline',
           fetch_bootstrap_baseline_runs = 0,
           fetch_bootstrap_baseline_empty_runs = 0,
           fetch_bootstrap_tier3_runs = 0,
           fetch_bootstrap_tier3_empty_runs = 0,
           fetch_bootstrap_tier4_runs = 0,
           fetch_bootstrap_tier4_empty_runs = 0,
           last_checked_at = NULL
     WHERE is_active = true
  `);

  console.log(`[resetFetchBootstrap] reset ${result.rowCount} active sources to baseline`);
  await pool.end();
}

run().catch(async (err) => {
  console.error("[resetFetchBootstrap] fatal:", err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
