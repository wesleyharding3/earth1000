'use strict';
require('dotenv').config({ override: true });
process.env.DB_POOL_MAX = '1';
const pool = require('./db');

(async () => {
  // Show both Czechia rows
  const { rows: czRows } = await pool.query(
    `SELECT id, name, iso_code FROM countries WHERE id IN (7, 206) ORDER BY id`
  );
  console.log('--- countries rows ---');
  console.table(czRows);

  // Count FK references for each id, across every table that references countries
  const tables = [
    { table: 'country_location_keywords', col: 'country_id' },
    { table: 'city_location_keywords',    col: 'country_id' },
    { table: 'cities',                    col: 'country_id' },
    { table: 'news_articles',             col: 'country_id' },
    { table: 'news_sources',              col: 'country_id' },
    { table: 'youtube_sources',           col: 'country_id' },
    { table: 'article_locations',         col: 'country_id' },
  ];
  console.log('\n--- FK reference counts (id=7 "Czechia" NULL iso  vs  id=206 "Czech Republic" CZ) ---');
  const summary = [];
  for (const t of tables) {
    // Some tables may not exist or column may be missing — wrap each.
    try {
      const { rows: [r] } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE ${t.col} = 7)::int   AS for_7,
           COUNT(*) FILTER (WHERE ${t.col} = 206)::int AS for_206
         FROM ${t.table}`
      );
      summary.push({ table: t.table, for_7: r.for_7, for_206: r.for_206 });
    } catch (err) {
      summary.push({ table: t.table, for_7: 'ERR', for_206: err.code || err.message.slice(0, 40) });
    }
  }
  console.table(summary);

  // Also: cities table — which row do cities point at?
  const { rows: citiesByCountry } = await pool.query(`
    SELECT country_id, COUNT(*)::int AS cities
      FROM cities
     WHERE country_id IN (7, 206)
     GROUP BY country_id
     ORDER BY country_id
  `);
  console.log('\n--- cities pointing at each Czechia row ---');
  console.table(citiesByCountry);

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
