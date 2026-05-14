#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');

(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'story_threads'
       ORDER BY ordinal_position
    `);
    console.log('story_threads columns:');
    console.table(rows);
  } catch (e) {
    console.error(e.message);
  } finally {
    await pool.end();
  }
})();
