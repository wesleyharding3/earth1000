#!/usr/bin/env node
'use strict';
process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });
const pool = require('./db');

(async () => {
  try {
    console.log('Total DB size:');
    const { rows: total } = await pool.query(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`
    );
    console.table(total);

    console.log('\nTop 25 tables by total size (table + indexes + toast):');
    const { rows: tables } = await pool.query(`
      SELECT
        schemaname || '.' || tablename AS table,
        pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total,
        pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS table_only,
        pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) AS indexes,
        pg_total_relation_size(schemaname || '.' || tablename) AS bytes
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
      LIMIT 25
    `);
    console.table(tables.map(r => ({
      table: r.table.replace(/^public\./, ''),
      total: r.total,
      table_only: r.table_only,
      indexes: r.indexes,
    })));

    console.log('\nRow counts for biggest tables:');
    const tops = tables.slice(0, 10).map(r => r.table.replace(/^public\./, ''));
    for (const t of tops) {
      try {
        const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::bigint AS n FROM public."${t}"`);
        console.log(`  ${t.padEnd(40)} ${Number(n).toLocaleString()} rows`);
      } catch (e) {
        console.log(`  ${t.padEnd(40)} (error: ${e.message})`);
      }
    }

    console.log('\nDate ranges for time-series tables (looking for old data not being pruned):');
    const dateChecks = [
      ['news_articles', 'published_at'],
      ['article_keywords', null],
      ['keyword_daily_stats', 'date'],
      ['image_usage_log', 'created_at'],
      ['rss_error_logs', 'created_at'],
      ['article_locations', null],
      ['briefing_episodes', 'generated_at'],
    ];
    for (const [t, c] of dateChecks) {
      if (!c) continue;
      try {
        const { rows: [r] } = await pool.query(
          `SELECT MIN(${c})::text AS earliest, MAX(${c})::text AS latest,
                  COUNT(*) FILTER (WHERE ${c} < NOW() - INTERVAL '90 days')::bigint AS old_count
             FROM public."${t}"`
        );
        console.log(`  ${t.padEnd(28)} earliest=${(r.earliest||'').slice(0,10)}  latest=${(r.latest||'').slice(0,10)}  >90d_old=${Number(r.old_count).toLocaleString()}`);
      } catch (e) {
        console.log(`  ${t.padEnd(28)} (error: ${e.message.slice(0, 80)})`);
      }
    }

    console.log('\nbriefing_episodes audio_data + music_data bloat:');
    try {
      const { rows: [r] } = await pool.query(`
        SELECT
          COUNT(*) AS episodes,
          pg_size_pretty(SUM(octet_length(audio_data)))::text AS total_audio,
          pg_size_pretty(SUM(octet_length(music_data)))::text AS total_music,
          pg_size_pretty(AVG(octet_length(audio_data)))::text AS avg_audio,
          MAX(target_date)::text AS newest
        FROM briefing_episodes
      `);
      console.log(`  ${r.episodes} episodes, audio total=${r.total_audio}, music total=${r.total_music}, avg audio=${r.avg_audio}`);
    } catch (e) {
      console.log(`  (error: ${e.message})`);
    }

  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
})();
