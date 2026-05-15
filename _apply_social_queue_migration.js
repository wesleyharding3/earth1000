#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const pool = require('./db');

(async () => {
  try {
    const sqlPath = path.join(__dirname, 'migrations', '20260515_social_post_queue.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log(`Applying ${path.basename(sqlPath)}…`);
    await pool.query(sql);
    console.log('OK');
    const { rows } = await pool.query(`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='social_post_queue'
       ORDER BY ordinal_position`);
    console.table(rows);
  } catch (e) { console.error(e.message); process.exit(1); }
  finally { await pool.end(); }
})();
