#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');

const PATTERNS = [
  '%beijing%paraguay%taiwan%',
  '%paraguay%taiwan%',
  '%iran%us%war%conduct%',
  '%trump%no longer%nato%',
  '%us no longer needs nato%',
];

(async () => {
  try {
    for (const pat of PATTERNS) {
      const res = await pool.query(
        `SELECT id, title, status, primary_category, article_count,
                primary_nations, geographic_scope, last_updated_at
           FROM story_threads
          WHERE title ILIKE $1
          ORDER BY last_updated_at DESC
          LIMIT 5`,
        [pat],
      );
      console.log(`\n── pattern: ${pat} (${res.rows.length} hits) ──`);
      if (!res.rows.length) continue;
      for (const r of res.rows) {
        console.log({
          id: r.id,
          title: r.title,
          status: r.status,
          category: r.primary_category,
          articles: r.article_count,
          scope: r.geographic_scope,
          primary_nations: r.primary_nations,
          last: r.last_updated_at?.toISOString?.() || r.last_updated_at,
        });
      }
    }
  } catch (e) {
    console.error('Inspect failed:', e.message);
  } finally {
    await pool.end();
  }
})();
