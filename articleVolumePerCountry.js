/**
 * articleVolumePerCountry.js — one-off / periodic cadence calibrator.
 *
 * Computes each country's average daily article count over the last
 * SAMPLE_WINDOW_DAYS and bucket-assigns a threading tier:
 *
 *   tier     | avg articles/day | localStoryBuilder cadence
 *   ---------+------------------+---------------------------
 *   daily    | >= 30            | once per day
 *   2day     | 10–29            | every 2 days
 *   weekly   | 3–9              | every 7 days
 *   monthly  | 1–2              | every 30 days
 *   skip     | < 1 (or 0)       | never scheduled
 *
 * Writes one row per country to country_threading_cadence.
 *
 * Usage:
 *   node articleVolumePerCountry.js              — recompute all countries
 *   node articleVolumePerCountry.js --days=60    — wider sample window
 *   node articleVolumePerCountry.js --dry-run    — print plan, no DB write
 *
 * Recommended schedule: monthly (or after adding new sources). Cadence
 * is relatively stable — no need to run this hourly.
 */

'use strict';
// Cap this script's share of Postgres connections BEFORE db.js loads. Without
// this cap it defaults to DB_POOL_MAX=60. Sequential per-country queries; 2
// is plenty.
process.env.DB_POOL_MAX = "2";

require('dotenv').config({ override: true });

const pool = require('./db');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const DRY_RUN             = !!ARGV.get('dry-run');
const SAMPLE_WINDOW_DAYS  = parseInt(ARGV.get('days') || '30', 10);

// Tier thresholds — in daily average article count. Re-tuneable.
const TIER_DAILY   = 30;
const TIER_2DAY    = 10;
const TIER_WEEKLY  = 3;
const TIER_MONTHLY = 1;

function tierFor(avgPerDay) {
  if (avgPerDay >= TIER_DAILY)   return 'daily';
  if (avgPerDay >= TIER_2DAY)    return '2day';
  if (avgPerDay >= TIER_WEEKLY)  return 'weekly';
  if (avgPerDay >= TIER_MONTHLY) return 'monthly';
  return 'skip';
}

async function main() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  console.log(`\n📊 Country Threading Cadence Calibrator — ${new Date().toISOString()}`);
  console.log(`   sample=${SAMPLE_WINDOW_DAYS}d ${DRY_RUN ? '[DRY-RUN]' : '[WRITE]'}\n`);

  // Aggregate article counts per country over the sample window, using
  // news_articles.country_id (the source / publisher country) since
  // "domestic threads" is about a country's own press-corpus activity.
  console.log(`   [${elapsed()}] Computing per-country volume...`);
  const { rows } = await pool.query(`
    WITH counts AS (
      SELECT a.country_id, COUNT(*)::int AS n
        FROM news_articles a
       WHERE a.published_at >= NOW() - ($1 || ' days')::interval
         AND a.country_id IS NOT NULL
       GROUP BY a.country_id
    )
    SELECT co.id            AS country_id,
           co.iso_code,
           co.name,
           COALESCE(c.n, 0)::int AS sample_count,
           ROUND(COALESCE(c.n, 0)::numeric / ($1::int)::numeric, 2) AS avg_per_day
      FROM countries co
      LEFT JOIN counts c ON c.country_id = co.id
     ORDER BY avg_per_day DESC, co.name
  `, [SAMPLE_WINDOW_DAYS]);
  console.log(`   [${elapsed()}] ${rows.length} countries scanned`);

  // Bucket + write.
  const tallies = { daily: 0, '2day': 0, weekly: 0, monthly: 0, skip: 0 };
  const plan = rows.map(r => {
    const avg = Number(r.avg_per_day) || 0;
    const tier = tierFor(avg);
    tallies[tier]++;
    return { ...r, avg, tier };
  });

  // Print a preview of the top-20 and the tier distribution.
  console.log(`\n   Top 20 by volume:`);
  console.log(`   ${'ISO'.padEnd(5)} ${'Country'.padEnd(28)} ${'avg/day'.padStart(9)}  tier`);
  for (const p of plan.slice(0, 20)) {
    console.log(`   ${String(p.iso_code || '—').padEnd(5)} ${String(p.name || '—').slice(0, 28).padEnd(28)} ${String(p.avg).padStart(9)}  ${p.tier}`);
  }
  console.log(`\n   Tier distribution:`);
  for (const [tier, n] of Object.entries(tallies)) {
    console.log(`     ${tier.padEnd(8)} ${String(n).padStart(4)}`);
  }

  if (DRY_RUN) {
    console.log(`\n   (dry run — no DB write)\n`);
    await pool.end();
    return;
  }

  // Filter out countries with no iso_code (data gap — can't build threads
  // without a stable identifier). Usually supranational rows or "Unknown".
  const writable = plan.filter(p => p.iso_code && String(p.iso_code).trim());
  if (writable.length !== plan.length) {
    console.log(`\n   Skipping ${plan.length - writable.length} country rows with no iso_code`);
  }
  console.log(`\n   [${elapsed()}] Upserting ${writable.length} cadence rows...`);
  // Preserve existing last_ran_at on update — we're only recalibrating
  // tier/volume. A country that ran yesterday keeps that timestamp
  // regardless of tier change.
  for (const p of writable) {
    await pool.query(`
      INSERT INTO country_threading_cadence
        (country_id, iso_code, avg_articles_per_day, tier, sample_window_days,
         sample_article_count, recalibrated_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (country_id) DO UPDATE SET
        iso_code             = EXCLUDED.iso_code,
        avg_articles_per_day = EXCLUDED.avg_articles_per_day,
        tier                 = EXCLUDED.tier,
        sample_window_days   = EXCLUDED.sample_window_days,
        sample_article_count = EXCLUDED.sample_article_count,
        recalibrated_at      = EXCLUDED.recalibrated_at,
        updated_at           = NOW()
    `, [p.country_id, p.iso_code, p.avg, p.tier, SAMPLE_WINDOW_DAYS, p.sample_count]);
  }

  console.log(`\n✅ Done in ${elapsed()}. Cadence written for ${plan.length} countries.\n`);
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
