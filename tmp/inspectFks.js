require('dotenv').config();
const pool = require('./../db');

(async () => {
  // FKs that reference story_timelines
  const { rows } = await pool.query(`
    SELECT
      tc.table_name,
      kcu.column_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'story_timelines'
    ORDER BY tc.table_name, kcu.column_name
  `);
  console.log('Tables with FK to story_timelines:');
  rows.forEach(r => console.log(`  ${r.table_name}.${r.column_name}  (on_delete=${r.delete_rule})`));

  // Tables that look like they reference timelines but may lack FK
  const { rows: r2 } = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE column_name IN ('timeline_id','storyline_id')
      AND table_schema='public'
    ORDER BY table_name
  `);
  console.log('\nAll columns named timeline_id / storyline_id:');
  r2.forEach(r => console.log(`  ${r.table_name}.${r.column_name}`));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
