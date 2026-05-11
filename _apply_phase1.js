'use strict';
/**
 * Phase 1 — repair country_location_keywords mis-attribution.
 *
 * Moves 240 stolen rows from hoarder countries to their rightful
 * victims, all in a single transaction. If any sub-update returns a
 * row count that doesn't match the expected number, we ROLLBACK and
 * print a diagnostic — the run is treated as a failure even if it's
 * "close." Expected counts were verified by an earlier dry-run
 * (_diag_bb.js).
 *
 * BB (id=3)  → FR (id=37):   91 rows
 *   - id IN (23, 24)
 *   - id BETWEEN 1009 AND 1099 (skips gaps; 82 rows)
 *   - id BETWEEN 2761 AND 2768 (skips gap at 2767; 7 rows)
 *
 * PE (id=22) → BE (id=31):   71 rows
 *   - id BETWEEN 2109 AND 2200 (has gaps; 71 rows total)
 *
 * AL (id=26) → LU (id=46):   78 rows
 *   - id BETWEEN 7008 AND 7107 (has gaps; 78 rows total)
 */

require('dotenv').config({ override: true });
process.env.DB_POOL_MAX = '1';
const pool = require('./db');

const MOVES = [
  {
    label: 'BB → FR  (91 expected)',
    fromCountryId: 3,
    toCountryId:   37,
    whereSql:      '(id IN (23, 24) OR id BETWEEN 1009 AND 1099 OR id BETWEEN 2761 AND 2768)',
    expected:      91,
  },
  {
    label: 'PE → BE  (71 expected)',
    fromCountryId: 22,
    toCountryId:   31,
    whereSql:      'id BETWEEN 2109 AND 2200',
    expected:      71,
  },
  {
    label: 'AL → LU  (78 expected)',
    fromCountryId: 26,
    toCountryId:   46,
    whereSql:      'id BETWEEN 7008 AND 7107',
    expected:      78,
  },
];

(async () => {
  const client = await pool.connect();
  let didCommit = false;
  try {
    await client.query('BEGIN');

    // Snapshot counts BEFORE so we can show a clean diff
    const beforeCounts = {};
    for (const m of MOVES) {
      const { rows: [r] } = await client.query(
        `SELECT COUNT(*)::int AS c FROM country_location_keywords WHERE country_id = $1`,
        [m.fromCountryId]
      );
      beforeCounts[m.fromCountryId] = r.c;
    }
    // Capture victim counts too
    const victimBefore = {};
    for (const m of MOVES) {
      const { rows: [r] } = await client.query(
        `SELECT COUNT(*)::int AS c FROM country_location_keywords WHERE country_id = $1`,
        [m.toCountryId]
      );
      victimBefore[m.toCountryId] = r.c;
    }

    let totalMoved = 0;
    for (const m of MOVES) {
      const sql = `
        UPDATE country_location_keywords
           SET country_id = $1
         WHERE country_id = $2
           AND ${m.whereSql}
      `;
      const { rowCount } = await client.query(sql, [m.toCountryId, m.fromCountryId]);
      console.log(`   ${m.label.padEnd(28)}  moved=${rowCount}`);
      if (rowCount !== m.expected) {
        throw new Error(
          `Row count mismatch for ${m.label}: expected ${m.expected}, got ${rowCount}. Rolling back.`
        );
      }
      totalMoved += rowCount;
    }

    // Re-snapshot after
    const afterCounts = {};
    for (const m of MOVES) {
      const { rows: [r] } = await client.query(
        `SELECT COUNT(*)::int AS c FROM country_location_keywords WHERE country_id = $1`,
        [m.fromCountryId]
      );
      afterCounts[m.fromCountryId] = r.c;
    }
    const victimAfter = {};
    for (const m of MOVES) {
      const { rows: [r] } = await client.query(
        `SELECT COUNT(*)::int AS c FROM country_location_keywords WHERE country_id = $1`,
        [m.toCountryId]
      );
      victimAfter[m.toCountryId] = r.c;
    }

    await client.query('COMMIT');
    didCommit = true;

    console.log(`\n✅ committed. Total rows moved: ${totalMoved}\n`);
    console.log('   Hoarder country row counts (before → after):');
    for (const m of MOVES) {
      console.log(`     country_id=${m.fromCountryId}:  ${beforeCounts[m.fromCountryId]} → ${afterCounts[m.fromCountryId]}`);
    }
    console.log('\n   Victim country row counts (before → after):');
    for (const m of MOVES) {
      console.log(`     country_id=${m.toCountryId}:  ${victimBefore[m.toCountryId]} → ${victimAfter[m.toCountryId]}`);
    }
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
