require('dotenv').config();
const pool = require('../db');
(async () => {
  const { rows } = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name='article_locations' ORDER BY ordinal_position
  `);
  console.log('article_locations columns:');
  rows.forEach(r => console.log('  '+r.column_name+' '+r.data_type));
  const { rows: r2 } = await pool.query(`
    SELECT DISTINCT routing_type FROM article_locations LIMIT 20
  `);
  console.log('\nrouting_type values:');
  r2.forEach(r => console.log('  '+r.routing_type));
  const { rows: r3 } = await pool.query(`
    SELECT indexname FROM pg_indexes WHERE tablename='article_locations'
  `);
  console.log('\nindexes:');
  r3.forEach(r => console.log('  '+r.indexname));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
