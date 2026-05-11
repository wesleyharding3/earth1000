'use strict';
require('dotenv').config({ override: true });
process.env.DB_POOL_MAX = '1';
const pool = require('./db');

(async () => {
  // Search threads with Olivares + Chile context
  const { rows } = await pool.query(`
    SELECT id, title, primary_nations, secondary_nations, status,
           article_count, last_updated_at
      FROM story_threads
     WHERE LOWER(title) LIKE '%olivares%'
        OR LOWER(title) LIKE '%chilean deputy%'
        OR (LOWER(title) LIKE '%chile%' AND LOWER(title) LIKE '%attack%')
        OR (LOWER(title) LIKE '%chile%' AND LOWER(title) LIKE '%deputy%')
     ORDER BY last_updated_at DESC
     LIMIT 10
  `);
  console.log('--- matching threads ---');
  console.table(rows);

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
