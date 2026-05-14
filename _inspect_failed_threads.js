#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');

const FAILED = [9837, 9957, 9898, 9867, 9751, 8969];

(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.status, t.article_count,
              (SELECT COUNT(*)::int FROM story_thread_articles sta WHERE sta.thread_id = t.id) AS joined_count
         FROM story_threads t
        WHERE t.id = ANY($1::int[])
        ORDER BY t.id`,
      [FAILED],
    );
    console.table(rows);
  } catch (e) {
    console.error(e.message);
  } finally {
    await pool.end();
  }
})();
