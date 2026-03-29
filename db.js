const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("Fatal: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 40  // bumped from 25 — fetcher + listener + concurrent web requests need headroom
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