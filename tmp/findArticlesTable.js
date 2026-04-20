require('dotenv').config();
const pool = require('../db');

(async () => {
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name ILIKE '%article%'
    ORDER BY table_name
  `);
  rows.forEach(r => console.log(r.table_name));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
