require('dotenv').config();
const pool = require('../db');
(async () => {
  const { rows } = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name='article_keywords' ORDER BY ordinal_position
  `);
  console.log('article_keywords columns:');
  rows.forEach(r => console.log('  '+r.column_name+' '+r.data_type));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
