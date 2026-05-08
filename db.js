const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("Fatal: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

// DB_POOL_MAX lets different processes cap their share of Postgres connections.
// worker.js sets this to 8 so the fetcher can't crowd out the web server.
// The web server defaults to 25.
//
// DB_APPLICATION_NAME (optional) is reported in pg_stat_activity.application_name
// so the next "who's holding all the slots?" investigation can tell services
// apart instead of seeing a wall of "(blank)". Each entry-point sets its own
// before requiring this module:
//   server.js              → 'earth-server'
//   worker.js              → 'earth-worker'
//   keywordCron.js         → 'earth-cron-keyword'
//   storyThreadBuilder.js  → 'earth-cron-threads'
//   globeStatsCron.js      → 'earth-cron-globestats'
// Falls back to the node script's basename so unset processes still surface
// usefully (e.g. "earth-_inspect_pg_activity").
const _appNameFallback = `earth-${(require('path').basename(process.argv[1] || 'unknown', '.js')) || 'node'}`;
const APP_NAME = process.env.DB_APPLICATION_NAME || _appNameFallback;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: parseInt(process.env.DB_POOL_MAX || "60", 10),
  application_name: APP_NAME,
});

// Per-connection statement_timeout. The 45s ceiling protects the web
// server from runaway queries hogging connection slots during fetch
// storms. But long-running cron processes (storyThreadBuilder,
// keywordNormalizerCron, audit/dedup scripts, etc.) legitimately need
// minutes for heavy joins or bulk updates against story_thread_articles
// — capping their queries at 45s breaks them mid-pipeline.
//
// Branch on the entry script: server.js keeps 45s; everything else
// (crons, workers, one-off scripts) gets 10 min by default. Either can
// be overridden by setting DB_STATEMENT_TIMEOUT_MS in the environment
// — useful for tightening (e.g. a known-fast cron) or loosening (a
// data-migration script that needs to run for an hour).
//
// keywordNormalizer.js already grabs a dedicated client and overrides
// to its own 90s ceiling for the heavy aggregation, so this default
// only changes the floor underneath that — its tight self-imposed
// timeout still wins for its specific query.
const _scriptName = require('path').basename(process.argv[1] || '', '.js');
const _isWebServer = _scriptName === 'server';
const STATEMENT_TIMEOUT_MS = process.env.DB_STATEMENT_TIMEOUT_MS != null
  ? parseInt(process.env.DB_STATEMENT_TIMEOUT_MS, 10)
  : (_isWebServer ? 45_000 : 600_000);

pool.on("connect", (client) => {
  client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`).catch(() => {});
});

pool.on('error', (err) => {
  console.error('🚨 Unexpected DB pool error:', err);
});

// Connection monitoring — logs pool state every 60s.
// unref() so one-shot scripts (briefingGenerator, storyThreadBuilder, etc.)
// can exit naturally without this interval keeping the process alive.
setInterval(() => {
  console.log(`[pool] total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
}, 60000).unref();

// Log when pool is under pressure
pool.on('connect', () => {
  if (pool.waitingCount > 0) {
    console.warn(`[pool] ⚠️ ${pool.waitingCount} queries waiting for connection`);
  }
});

module.exports = pool;