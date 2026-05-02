#!/usr/bin/env node
'use strict';

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');

async function main() {
  const totals = await pool.query(`
    SELECT
      COUNT(*)::int                                                      AS rows_total,
      COUNT(*) FILTER (WHERE source = 'claude')::int                     AS rows_claude,
      COUNT(*) FILTER (WHERE source = 'curated')::int                    AS rows_curated,
      COUNT(*) FILTER (WHERE is_pinned)::int                             AS rows_pinned,
      COUNT(*) FILTER (WHERE refusal IS NOT NULL)::int                   AS rows_refused,
      COUNT(*) FILTER (WHERE hit_count > 0)::int                         AS rows_with_hits,
      COUNT(*) FILTER (WHERE last_hit_at > NOW() - INTERVAL '7 days')::int AS rows_hit_last_7d,
      SUM(hit_count)::int                                                AS total_hits,
      MAX(hit_count)::int                                                AS max_hits_one_row,
      AVG(hit_count)::numeric(10,2)                                      AS avg_hits,
      MIN(created_at)                                                    AS earliest_row,
      MAX(created_at)                                                    AS latest_row
    FROM heatmap_qa_cache
  `);
  console.log('── heatmap_qa_cache totals ──────────────────────────────');
  for (const [k, v] of Object.entries(totals.rows[0])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  console.log('\n── by mode ──────────────────────────────────────────────');
  const byMode = await pool.query(`
    SELECT mode, COUNT(*)::int AS rows, SUM(hit_count)::int AS hits
      FROM heatmap_qa_cache GROUP BY mode ORDER BY rows DESC
  `);
  for (const r of byMode.rows) console.log(`  ${r.mode.padEnd(10)} rows=${r.rows} hits=${r.hits}`);

  console.log('\n── top 12 most-hit cache entries ────────────────────────');
  const top = await pool.query(`
    SELECT question_text, mode, hit_count, source, is_pinned,
           jsonb_array_length(values) AS values_n,
           refusal IS NOT NULL AS refused,
           created_at, last_hit_at
      FROM heatmap_qa_cache
     ORDER BY hit_count DESC, created_at DESC
     LIMIT 12
  `);
  for (const r of top.rows) {
    const flags = [r.source, r.is_pinned ? 'pinned' : '', r.refused ? 'refused' : ''].filter(Boolean).join(',');
    console.log(`  hits=${String(r.hit_count).padStart(4)} mode=${r.mode.padEnd(7)} n=${String(r.values_n).padStart(3)} [${flags}]`);
    console.log(`    "${(r.question_text || '').slice(0, 90)}"`);
    console.log(`    created=${r.created_at?.toISOString?.() || r.created_at}  lastHit=${r.last_hit_at?.toISOString?.() || r.last_hit_at}`);
  }

  console.log('\n── 5 most recent entries (any hit count) ────────────────');
  const recent = await pool.query(`
    SELECT question_text, mode, hit_count, source, is_pinned, refusal IS NOT NULL AS refused, created_at
      FROM heatmap_qa_cache
     ORDER BY created_at DESC
     LIMIT 5
  `);
  for (const r of recent.rows) {
    const flags = [r.source, r.is_pinned ? 'pinned' : '', r.refused ? 'refused' : ''].filter(Boolean).join(',');
    console.log(`  ${r.created_at?.toISOString?.() || r.created_at} mode=${r.mode} hits=${r.hit_count} [${flags}]`);
    console.log(`    "${(r.question_text || '').slice(0, 90)}"`);
  }

  console.log('\n── hit_count distribution ───────────────────────────────');
  const dist = await pool.query(`
    SELECT bucket, COUNT(*)::int AS rows FROM (
      SELECT CASE
        WHEN hit_count = 0 THEN '0 (never hit)'
        WHEN hit_count = 1 THEN '1'
        WHEN hit_count BETWEEN 2 AND 5 THEN '2-5'
        WHEN hit_count BETWEEN 6 AND 20 THEN '6-20'
        WHEN hit_count BETWEEN 21 AND 100 THEN '21-100'
        ELSE '100+' END AS bucket
      FROM heatmap_qa_cache
    ) t
    GROUP BY bucket
    ORDER BY MIN(CASE
        WHEN bucket = '0 (never hit)' THEN 0
        WHEN bucket = '1' THEN 1
        WHEN bucket = '2-5' THEN 2
        WHEN bucket = '6-20' THEN 3
        WHEN bucket = '21-100' THEN 4
        ELSE 5 END)
  `);
  for (const r of dist.rows) console.log(`  ${r.bucket.padEnd(15)} ${r.rows} rows`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
