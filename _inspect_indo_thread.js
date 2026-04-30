// One-shot inspection — safe (read-only). Find the Indonesia train
// thread + list its articles so we can identify the Colombia bleed.
require("dotenv").config();
const pool = require("./db");

(async () => {
  try {
    const { rows: threads } = await pool.query(`
      SELECT id, title, primary_category, status, article_count,
             primary_nations, secondary_nations, keywords,
             first_seen_at, last_updated_at
        FROM story_threads
       WHERE title ILIKE '%indonesia%train%'
          OR title ILIKE '%train%collision%'
       ORDER BY article_count DESC NULLS LAST
       LIMIT 10
    `);
    console.log(`\nMatched ${threads.length} candidate thread(s):\n`);
    for (const t of threads) {
      console.log(`#${t.id} [${t.status}] "${t.title}"`);
      console.log(`   category=${t.primary_category} articles=${t.article_count}`);
      console.log(`   primary=${JSON.stringify(t.primary_nations)}`);
      console.log(`   secondary=${JSON.stringify(t.secondary_nations)}`);
      console.log(`   keywords=${JSON.stringify(t.keywords)}`);
      console.log(`   first_seen=${t.first_seen_at?.toISOString?.()} updated=${t.last_updated_at?.toISOString?.()}`);
      console.log('');
    }
    if (!threads.length) {
      console.log('(no match — check title spelling)');
      await pool.end(); return;
    }
    for (const t of threads) {
      const { rows: arts } = await pool.query(`
        SELECT a.id, a.title, a.translated_title,
               co.iso_code AS country_iso, co.name AS country_name,
               a.published_at
          FROM story_thread_articles sta
          JOIN news_articles a       ON a.id = sta.article_id
          LEFT JOIN countries co     ON co.id = a.country_id
         WHERE sta.thread_id = $1
         ORDER BY a.published_at DESC
      `, [t.id]);
      console.log(`──── thread #${t.id} "${t.title}" — ${arts.length} articles ────`);
      for (const a of arts) {
        const title = a.translated_title || a.title || '';
        const iso = a.country_iso || '??';
        const date = a.published_at?.toISOString?.()?.slice(0,10) || '??';
        console.log(`  [${a.id}] ${date}  ${iso}  ${title.slice(0, 110)}`);
      }
      console.log('');
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
