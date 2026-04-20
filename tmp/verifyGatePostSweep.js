require('dotenv').config();
const pool = require('../db');

(async () => {
  const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS n FROM story_timelines`);
  const { rows: [d] } = await pool.query(`SELECT COUNT(*)::int AS n FROM story_threads WHERE timeline_id IS NULL`);
  const { rows: [a] } = await pool.query(`SELECT COUNT(*)::int AS n FROM story_threads WHERE timeline_id IS NOT NULL`);
  const { rows: [ta] } = await pool.query(`SELECT COUNT(*)::int AS n FROM story_timeline_articles`);
  const { rows: [te] } = await pool.query(`SELECT COUNT(*)::int AS n FROM story_timeline_events`);

  console.log(`Post-sweep state:`);
  console.log(`  story_timelines:          ${t.n}`);
  console.log(`  story_threads attached:   ${a.n}`);
  console.log(`  story_threads detached:   ${d.n}`);
  console.log(`  story_timeline_articles:  ${ta.n}`);
  console.log(`  story_timeline_events:    ${te.n}`);

  const { rows: top } = await pool.query(`
    SELECT t.id, t.title,
      (SELECT COUNT(*) FROM story_threads WHERE timeline_id = t.id) AS threads,
      t.article_count
    FROM story_timelines t
    ORDER BY threads DESC NULLS LAST, t.article_count DESC
    LIMIT 20
  `);
  console.log(`\nTop 20 surviving Lines:`);
  top.forEach(r => console.log(`  ${String(r.threads).padStart(3)}t  ${String(r.article_count||0).padStart(5)}art  id=${r.id}  ${r.title}`));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
