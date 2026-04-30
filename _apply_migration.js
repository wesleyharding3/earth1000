// One-shot migration runner. Reads a single .sql file and executes it
// against $DATABASE_URL from the local .env. Idempotent migrations only
// (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) — re-running
// is safe.
require("dotenv").config();
const fs   = require("fs");
const pool = require("./db");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node _apply_migration.js <path-to-sql>");
  process.exit(1);
}

(async () => {
  try {
    const sql = fs.readFileSync(file, "utf8");
    console.log(`Applying ${file} (${sql.length} bytes)…`);
    await pool.query(sql);
    console.log("✓ Migration applied.");
  } catch (err) {
    console.error("✗ Failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
