#!/usr/bin/env node
'use strict';
// One-shot diagnostic: who is holding Postgres connections right now?
// Run: node _inspect_pg_activity.js
// Cap the pool to 1 so this script itself only consumes one slot —
// crucial when investigating a saturation event.
process.env.DB_POOL_MAX = "1";
require('dotenv').config({ override: true });
const pool = require('./db');

(async () => {
  try {
    // 1) Headline: connections per application_name
    const byApp = await pool.query(`
      SELECT application_name, count(*) AS n
        FROM pg_stat_activity
       GROUP BY application_name
       ORDER BY n DESC
    `);
    console.log('\n── Connections by application_name ──');
    console.table(byApp.rows.map(r => ({ application_name: r.application_name || '(blank)', n: Number(r.n) })));

    // 2) State breakdown: how many are actively running vs idle
    const byState = await pool.query(`
      SELECT state, count(*) AS n
        FROM pg_stat_activity
       GROUP BY state
       ORDER BY n DESC
    `);
    console.log('\n── Connections by state ──');
    console.table(byState.rows.map(r => ({ state: r.state || '(none)', n: Number(r.n) })));

    // 3) Long-idle / abandoned connections: idle in transaction is the
    //    classic killer. anything > 5 min idle here is suspect.
    const longIdle = await pool.query(`
      SELECT pid,
             application_name,
             state,
             usename,
             client_addr::text AS client_addr,
             EXTRACT(EPOCH FROM (NOW() - state_change))::int AS idle_secs,
             LEFT(query, 80) AS query_head
        FROM pg_stat_activity
       WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
          OR (state = 'idle' AND state_change < NOW() - INTERVAL '5 minutes')
       ORDER BY state_change ASC
       LIMIT 25
    `);
    console.log('\n── Long-idle / idle-in-tx connections (potential leaks) ──');
    if (!longIdle.rows.length) console.log('(none — clean)');
    else console.table(longIdle.rows.map(r => ({
      pid: r.pid,
      app: r.application_name || '(blank)',
      state: r.state,
      user: r.usename,
      client: r.client_addr || '(local)',
      idle_s: r.idle_secs,
      query: (r.query_head || '').replace(/\s+/g, ' '),
    })));

    // 4) Currently-running queries (active state) — what's working RIGHT NOW
    const active = await pool.query(`
      SELECT pid,
             application_name,
             usename,
             EXTRACT(EPOCH FROM (NOW() - query_start))::int AS run_secs,
             LEFT(query, 100) AS query_head
        FROM pg_stat_activity
       WHERE state = 'active'
         AND pid <> pg_backend_pid()
       ORDER BY query_start ASC
       LIMIT 25
    `);
    console.log('\n── Currently-active queries ──');
    if (!active.rows.length) console.log('(none active)');
    else console.table(active.rows.map(r => ({
      pid: r.pid,
      app: r.application_name || '(blank)',
      user: r.usename,
      run_s: r.run_secs,
      query: (r.query_head || '').replace(/\s+/g, ' '),
    })));

    // 5) Server-side limits — what's max_connections and how close are we?
    const limits = await pool.query(`
      SELECT
        (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS max_connections,
        (SELECT setting::int FROM pg_settings WHERE name='superuser_reserved_connections') AS reserved_for_superuser,
        (SELECT count(*)::int FROM pg_stat_activity) AS current_connections
    `);
    const lim = limits.rows[0];
    const usable = lim.max_connections - lim.reserved_for_superuser;
    const pct = ((lim.current_connections / usable) * 100).toFixed(0);
    console.log('\n── Server limits ──');
    console.table([{
      max_connections: lim.max_connections,
      reserved_for_superuser: lim.reserved_for_superuser,
      usable_for_us: usable,
      current: lim.current_connections,
      pct_of_usable: `${pct}%`,
    }]);
  } catch (e) {
    console.error('Inspect failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
