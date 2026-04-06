const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("Fatal: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

// DB_POOL_MAX lets different processes cap their share of Postgres connections.
// worker.js sets this to 8 so the fetcher can't crowd out the web server.
// The web server defaults to 25.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: parseInt(process.env.DB_POOL_MAX || "25", 10),
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