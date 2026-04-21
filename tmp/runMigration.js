require('dotenv').config({ override: true });
const fs = require('fs');
const pool = require('../db');

(async () => {
  const sqlFile = process.argv[2];
  if (!sqlFile) { console.error('usage: node tmp/runMigration.js <sql-file>'); process.exit(1); }
  const sql = fs.readFileSync(sqlFile, 'utf8');
  console.log(`Applying ${sqlFile} (${sql.length} bytes)...`);
  try {
    await pool.query(sql);
    console.log('✔ migration applied');
  } catch (e) {
    console.error('✖ failed:', e.message);
    process.exit(1);
  }
  // Verify columns exist
  const r = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE column_name = 'secondary_nations'
    ORDER BY table_name
  `);
  console.log('Post-migration columns:');
  r.rows.forEach(row => console.log(`  ${row.table_name}.${row.column_name}  ${row.data_type}`));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
