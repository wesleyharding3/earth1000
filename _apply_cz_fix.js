'use strict';
/**
 * Czechia dual-row repair.
 *
 * Before:
 *   countries.id=7   name='Czechia'         iso_code=NULL    ← all the FK references
 *   countries.id=206 name='Czech Republic'  iso_code='CZ'    ← near-orphan, blocks tagging
 *
 * FK reference counts confirm row 7 is the real one (47,860 articles,
 * 95 sources, 16,293 article_locations all point at id=7). Row 206 has
 * 1,240 stray articles + 6 stray news_sources we'll redirect, then
 * remove row 206. Row 7 gets iso_code='CZ' so article_locations
 * aggregation can finally include Czech mentions.
 *
 * Single transaction. Each step has an expected row count that we
 * assert against to catch any surprise.
 *
 * Expected row counts (from _diag_cz.js):
 *   news_articles WHERE country_id = 206 → 1240
 *   news_sources  WHERE country_id = 206 → 6
 *   youtube_sources WHERE country_id = 206 → 0
 *   cities        WHERE country_id = 206 → 0
 *
 * The name stays 'Czechia' on row 7 — both 'Czechia' and
 * 'Czech Republic' are accepted aliases (see nationExtractor.js
 * COUNTRY_ALIASES) so either canonical name works downstream.
 */

require('dotenv').config({ override: true });
process.env.DB_POOL_MAX = '1';
const pool = require('./db');

(async () => {
  const client = await pool.connect();
  let didCommit = false;
  try {
    await client.query('BEGIN');

    // 1. Stamp iso_code='CZ' on row 7 — this is THE fix that unblocks
    //    article_locations aggregation for Czech mentions.
    const { rowCount: setIso } = await client.query(
      `UPDATE countries SET iso_code = 'CZ' WHERE id = 7 AND iso_code IS NULL`
    );
    if (setIso !== 1) throw new Error(`Expected 1 countries row updated (id=7 iso_code), got ${setIso}`);
    console.log(`   ✓ countries.id=7  iso_code=NULL → 'CZ'`);

    // 2. Redirect the 1240 stray articles from row 206 to row 7.
    const { rowCount: artMig } = await client.query(
      `UPDATE news_articles SET country_id = 7 WHERE country_id = 206`
    );
    console.log(`   ✓ news_articles  206 → 7  (${artMig} rows)`);
    if (artMig !== 1240) throw new Error(`Expected 1240 news_articles, got ${artMig}`);

    // 3. Redirect 6 stray news_sources.
    const { rowCount: srcMig } = await client.query(
      `UPDATE news_sources SET country_id = 7 WHERE country_id = 206`
    );
    console.log(`   ✓ news_sources   206 → 7  (${srcMig} rows)`);
    if (srcMig !== 6) throw new Error(`Expected 6 news_sources, got ${srcMig}`);

    // 4. Belt-and-suspenders: no-op tables that should have 0 rows.
    const { rowCount: ytMig } = await client.query(
      `UPDATE youtube_sources SET country_id = 7 WHERE country_id = 206`
    );
    if (ytMig !== 0) throw new Error(`Expected 0 youtube_sources, got ${ytMig}`);

    const { rowCount: ciMig } = await client.query(
      `UPDATE cities SET country_id = 7 WHERE country_id = 206`
    );
    if (ciMig !== 0) throw new Error(`Expected 0 cities, got ${ciMig}`);

    // 5. Also check article_locations — should be 0 (verified earlier).
    const { rowCount: alMig } = await client.query(
      `UPDATE article_locations SET country_id = 7 WHERE country_id = 206`
    );
    if (alMig !== 0) console.log(`   ! article_locations  206 → 7  (${alMig} rows — unexpected but migrated)`);

    // 6. Final delete of orphaned row 206.
    const { rowCount: delCount } = await client.query(
      `DELETE FROM countries WHERE id = 206`
    );
    if (delCount !== 1) throw new Error(`Expected 1 countries row deleted (id=206), got ${delCount}`);
    console.log(`   ✓ countries.id=206  deleted`);

    await client.query('COMMIT');
    didCommit = true;
    console.log(`\n✅ Czechia repair committed. Czech articles will now be content-tagged correctly.`);

    // Verify post-state
    const { rows } = await client.query(
      `SELECT id, name, iso_code FROM countries WHERE id IN (7, 206) ORDER BY id`
    );
    console.log(`\n   Post-state:`);
    console.table(rows);
  } catch (err) {
    if (!didCommit) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error(`\n❌ FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
})();
