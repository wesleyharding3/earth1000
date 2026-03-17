const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 15  // increased from 5 — need headroom for listener + fetcher + web requests
});

pool.on('error', (err) => {
  console.error('🚨 Unexpected DB pool error:', err);
});

// Connection monitoring — logs pool state every 60s
setInterval(() => {
  console.log(`[pool] total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
}, 60000);

// Log when pool is under pressure
pool.on('connect', () => {
  if (pool.waitingCount > 0) {
    console.warn(`[pool] ⚠️ ${pool.waitingCount} queries waiting for connection`);
  }
});

module.exports = pool;