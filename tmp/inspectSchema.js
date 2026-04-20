require('dotenv').config();
const pool = require('../db');

(async () => {
  const { rows } = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'story_timelines'
    ORDER BY ordinal_position
  `);
  console.log('story_timelines columns:');
  rows.forEach(r => console.log(`  ${r.column_name.padEnd(30)} ${r.data_type}`));

  const { rows: r2 } = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'story_threads'
    ORDER BY ordinal_position
  `);
  console.log('\nstory_threads columns:');
  r2.forEach(r => console.log(`  ${r.column_name.padEnd(30)} ${r.data_type}`));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
