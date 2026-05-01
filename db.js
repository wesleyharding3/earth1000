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

// Kill runaway queries after 45 seconds so they release their connection instead
// of blocking the pool for 90-120s during heavy fetch runs.
pool.on("connect", (client) => {
  client.query("SET statement_timeout = 45000").catch(() => {});
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