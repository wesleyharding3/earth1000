require('dotenv').config({ override: true });
const pool = require('../db');

(async () => {
  const q = async (sql) => (await pool.query(sql)).rows;

  // Population stats
  const [tStats] = await q(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE COALESCE(array_length(primary_nations,1),0) > 0)::int AS has_primary,
      COUNT(*) FILTER (WHERE COALESCE(array_length(secondary_nations,1),0) > 0)::int AS has_secondary,
      AVG(COALESCE(array_length(primary_nations,1),0))::numeric(4,2) AS avg_primary,
      AVG(COALESCE(array_length(secondary_nations,1),0))::numeric(4,2) AS avg_secondary
    FROM story_threads
  `);
  console.log('── THREADS ──');
  console.log(`  total rows:           ${tStats.total}`);
  console.log(`  rows w/ primary:      ${tStats.has_primary}`);
  console.log(`  rows w/ secondary:    ${tStats.has_secondary}`);
  console.log(`  avg primary count:    ${tStats.avg_primary}`);
  console.log(`  avg secondary count:  ${tStats.avg_secondary}`);

  const [lStats] = await q(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE COALESCE(array_length(primary_nations,1),0) > 0)::int AS has_primary,
      COUNT(*) FILTER (WHERE COALESCE(array_length(secondary_nations,1),0) > 0)::int AS has_secondary,
      AVG(COALESCE(array_length(primary_nations,1),0))::numeric(4,2) AS avg_primary,
      AVG(COALESCE(array_length(secondary_nations,1),0))::numeric(4,2) AS avg_secondary
    FROM story_timelines
  `);
  console.log('\n── LINES ──');
  console.log(`  total rows:           ${lStats.total}`);
  console.log(`  rows w/ primary:      ${lStats.has_primary}`);
  console.log(`  rows w/ secondary:    ${lStats.has_secondary}`);
  console.log(`  avg primary count:    ${lStats.avg_primary}`);
  console.log(`  avg secondary count:  ${lStats.avg_secondary}`);

  console.log('\n── ALL LINES — new tier split ──');
  const lines = await q(`
    SELECT id, title, status, article_count, primary_nations, secondary_nations
    FROM story_timelines
    ORDER BY article_count DESC NULLS LAST
  `);
  for (const l of lines) {
    const p = (l.primary_nations || []).join(',');
    const s = (l.secondary_nations || []).join(',');
    console.log(`  [${l.status}] #${l.id}  art=${String(l.article_count||0).padStart(5)}  p=[${p}]  s=[${s}]  ${(l.title||'').slice(0,55)}`);
  }

  console.log('\n── TOP 10 active threads — new tier split ──');
  const threads = await q(`
    SELECT id, title, status, article_count, primary_nations, secondary_nations
    FROM story_threads
    WHERE status = 'active'
    ORDER BY article_count DESC NULLS LAST
    LIMIT 10
  `);
  for (const t of threads) {
    const p = (t.primary_nations || []).join(',');
    const s = (t.secondary_nations || []).join(',');
    console.log(`  #${t.id}  art=${String(t.article_count||0).padStart(4)}  p=[${p}]  s=[${s}]  ${(t.title||'').slice(0,55)}`);
  }

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
