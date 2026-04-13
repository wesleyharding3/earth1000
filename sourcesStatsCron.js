#!/usr/bin/env node
'use strict';
/**
 * sourcesStatsCron.js
 *
 * Pre-computes source intelligence statistics and writes results
 * to keyword_intelligence_cache for instant API serving.
 *
 * Recommended cron schedule: twice daily
 *   0 3,15 * * *   — 3 AM and 3 PM UTC
 *
 * Environment variables:
 *   DATABASE_URL   — PostgreSQL connection string (required)
 *   DB_POOL_MAX    — Max pool connections (optional, defaults to 5)
 *
 * Usage:
 *   node sourcesStatsCron.js
 */

require('dotenv').config();
const pool = require('./db');

function elapsed(t0) { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

// ── Query 1: Country distribution — total articles per country (last 30 days)
async function computeCountryDistribution(client) {
  const { rows } = await client.query(`
    SELECT co.name AS country, co.iso_code, COUNT(*)::int AS articles
    FROM news_articles a
    JOIN countries co ON co.id = a.country_id
    WHERE a.published_at > NOW() - INTERVAL '30 days'
      AND a.country_id IS NOT NULL
    GROUP BY co.id, co.name, co.iso_code
    ORDER BY articles DESC
    LIMIT 200
  `);
  return rows;
}

// ── Query 2: Country rankings — avg articles per day (last 30 days)
async function computeCountryRankings(client) {
  const { rows } = await client.query(`
    SELECT co.name AS country, co.iso_code,
           COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
    FROM news_articles a
    JOIN countries co ON co.id = a.country_id
    WHERE a.published_at > NOW() - INTERVAL '30 days'
      AND a.country_id IS NOT NULL
    GROUP BY co.id, co.name, co.iso_code
    HAVING COUNT(*) >= 5
    ORDER BY "avgPerDay" DESC
    LIMIT 200
  `);
  return rows.map(r => ({ ...r, avgPerDay: parseFloat(r.avgPerDay) }));
}

// ── Query 3: City rankings — avg articles per day (last 30 days)
async function computeCityRankings(client) {
  const { rows } = await client.query(`
    SELECT ci.name AS city, co.name AS country,
           COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
    FROM news_articles a
    JOIN cities ci ON ci.id = a.city_id
    JOIN countries co ON co.id = ci.country_id
    WHERE a.published_at > NOW() - INTERVAL '30 days'
      AND a.city_id IS NOT NULL
    GROUP BY ci.id, ci.name, co.name
    HAVING COUNT(*) >= 3
    ORDER BY "avgPerDay" DESC
    LIMIT 200
  `);
  return rows.map(r => ({ ...r, avgPerDay: parseFloat(r.avgPerDay) }));
}

// ── Query 4: Source rankings — avg articles per day (last 30 days)
async function computeSourceRankings(client) {
  const { rows } = await client.query(`
    SELECT COALESCE(ns.name, ys.name) AS source,
           COALESCE(ns.site_url, ys.site_url) AS site_url,
           COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
    FROM news_articles a
    LEFT JOIN news_sources ns ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    WHERE a.published_at > NOW() - INTERVAL '30 days'
    GROUP BY COALESCE(ns.name, ys.name), COALESCE(ns.site_url, ys.site_url)
    HAVING COUNT(*) >= 3
    ORDER BY "avgPerDay" DESC
    LIMIT 200
  `);
  return rows.map(r => ({ ...r, avgPerDay: parseFloat(r.avgPerDay) }));
}

// ── Query 5: Countries by distinct source count (last 30 days)
async function computeCountriesBySourceCount(client) {
  const { rows } = await client.query(`
    SELECT co.name AS country, co.iso_code,
           COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id))::int AS "sourceCount"
    FROM news_articles a
    JOIN countries co ON co.id = a.country_id
    WHERE a.published_at > NOW() - INTERVAL '30 days'
      AND a.country_id IS NOT NULL
    GROUP BY co.id, co.name, co.iso_code
    HAVING COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id)) >= 1
    ORDER BY "sourceCount" DESC
    LIMIT 200
  `);
  return rows;
}

// ── Cache writer (reuses keyword_intelligence_cache table) ──────────────────
async function writeCache(mode, filterKey, results) {
  await pool.query(`
    INSERT INTO keyword_intelligence_cache (mode, filter_key, results)
    VALUES ($1, $2, $3)
  `, [mode, filterKey, JSON.stringify(results)]);

  // Prune: keep the 6 most recent rows per mode+filter
  await pool.query(`
    DELETE FROM keyword_intelligence_cache
    WHERE mode = $1 AND filter_key = $2
      AND id NOT IN (
        SELECT id FROM keyword_intelligence_cache
        WHERE mode = $1 AND filter_key = $2
        ORDER BY computed_at DESC
        LIMIT 6
      )
  `, [mode, filterKey]);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  console.log(`[sourcesStatsCron] ${new Date().toISOString()} — starting`);

  const client = await pool.connect();
  try {
    // Disable statement_timeout for these heavy aggregation queries
    await client.query('SET statement_timeout = 0');

    console.log(`[sourcesStatsCron] running 5 aggregation queries in parallel...`);

    const [countryDist, countryRank, cityRank, sourceRank, sourceCountry] =
      await Promise.all([
        computeCountryDistribution(client),
        computeCountryRankings(client),
        computeCityRankings(client),
        computeSourceRankings(client),
        computeCountriesBySourceCount(client),
      ]);

    console.log(`[sourcesStatsCron] queries done (${elapsed(t0)}) — countries: ${countryDist.length}, countryRank: ${countryRank.length}, cityRank: ${cityRank.length}, sourceRank: ${sourceRank.length}, sourceCountry: ${sourceCountry.length}`);

    const payload = {
      countryDistribution: countryDist,
      countryRankings: countryRank,
      cityRankings: cityRank,
      sourceRankings: sourceRank,
      countriesBySourceCount: sourceCountry,
    };

    await writeCache('sources-stats', 'global', payload);
    console.log(`[sourcesStatsCron] cached to DB (${elapsed(t0)})`);

    console.log(`[sourcesStatsCron] done in ${elapsed(t0)}`);
  } catch (err) {
    console.error('[sourcesStatsCron] fatal:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
