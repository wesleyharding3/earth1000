require('dotenv').config();
const pool = require('../db');

(async () => {
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name ILIKE '%thread%'
    ORDER BY table_name
  `);
  console.log('thread-related tables:');
  rows.forEach(r => console.log(`  ${r.table_name}`));

  const { rows: r2 } = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'story_thread_articles' ORDER BY ordinal_position
  `);
  console.log('\nstory_thread_articles:');
  r2.forEach(r => console.log(`  ${r.column_name}  ${r.data_type}`));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
