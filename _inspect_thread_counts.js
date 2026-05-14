#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');

(async () => {
  try {
    const totals = await pool.query(`
      SELECT status, COUNT(*)::int AS n
        FROM story_threads
       GROUP BY status
       ORDER BY n DESC
    `);
    console.log('thread counts by status:');
    console.table(totals.rows);

    const audited = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE last_audited_at IS NULL)              AS never_audited,
        COUNT(*) FILTER (WHERE last_audited_at < now() - interval '7 days') AS stale_gt_7d,
        COUNT(*) FILTER (WHERE last_audited_at < now() - interval '1 day')  AS stale_gt_1d
        FROM story_threads
       WHERE status IN ('active','cooling')
    `);
    console.log('audit coverage (active+cooling):');
    console.table(audited.rows);

    const recent = await pool.query(`
      SELECT COUNT(*)::int AS n
        FROM story_threads
       WHERE last_updated_at >= now() - interval '7 days'
    `);
    console.log(`threads touched in last 7d: ${recent.rows[0].n}`);
  } catch (e) {
    console.error(e.message);
  } finally {
    await pool.end();
  }
})();
