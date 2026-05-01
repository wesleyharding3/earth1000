#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');

(async () => {
  try {
    // All thenews.com.pk records, plus Pakistan country_id for reference.
    const country = await pool.query(`SELECT id, name FROM countries WHERE iso_code = 'PK'`);
    console.log('Pakistan country row:', country.rows);

    const records = await pool.query(`
      SELECT s.id, s.name, s.site_url, s.rss_url, s.scrape_url,
             s.source_type, s.is_active, s.country_id, s.city_id,
             s.language, s.popularity_tier,
             s.last_success_at, s.failure_count,
             ci.name AS city_name
        FROM news_sources s
        LEFT JOIN cities ci ON ci.id = s.city_id
       WHERE s.site_url ILIKE '%thenews.com.pk%'
          OR s.rss_url  ILIKE '%thenews.com.pk%'
          OR s.scrape_url ILIKE '%thenews.com.pk%'
          OR s.name ILIKE '%The News%' AND s.country_id = (SELECT id FROM countries WHERE iso_code='PK')
       ORDER BY s.id
    `);
    console.log(`\nthenews.com.pk records (${records.rows.length}):`);
    console.table(records.rows);
  } catch (e) {
    console.error('Inspect failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
