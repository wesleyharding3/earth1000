require('dotenv').config();
const pool = require('../db');

(async () => {
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='news_articles' ORDER BY ordinal_position
  `);
  console.log('news_articles columns:');
  rows.forEach(r => console.log('  '+r.column_name));

  const { rows: r2 } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='story_timeline_articles' ORDER BY ordinal_position
  `);
  console.log('\nstory_timeline_articles:');
  r2.forEach(r => console.log('  '+r.column_name));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
