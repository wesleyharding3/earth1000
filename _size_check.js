#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');
(async () => {
  try {
    const t = await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS s");
    console.log('Total DB:', t.rows[0].s);
    const r = await pool.query(`
      SELECT schemaname||'.'||tablename AS t,
             pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS sz,
             pg_total_relation_size(schemaname||'.'||tablename) AS b
        FROM pg_tables WHERE schemaname='public'
        ORDER BY b DESC LIMIT 8
    `);
    console.table(r.rows.map(r => ({ table: r.t.replace('public.',''), size: r.sz })));
  } catch (e) { console.error(e.message); }
  finally { await pool.end(); }
})();
