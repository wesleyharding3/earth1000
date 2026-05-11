'use strict';
require('dotenv').config({ override: true });
process.env.DB_POOL_MAX = '1';
const pool = require('./db');

(async () => {
  // Find the most recent briefing
  const { rows: eps } = await pool.query(
    `SELECT id, target_date, status FROM briefing_episodes
      WHERE status = 'ready' AND user_id IS NULL
      ORDER BY target_date DESC LIMIT 3`
  );
  console.log('--- recent ready briefings ---');
  console.table(eps);
  if (!eps.length) { await pool.end(); return; }

  const epId = eps[0].id;

  // Show segment types
  const { rows: segs } = await pool.query(
    `SELECT segment_index, type, thread_id, headline
       FROM briefing_segments
      WHERE episode_id = $1
      ORDER BY segment_index`,
    [epId]
  );
  console.log(`\n--- segments for episode ${epId} (${eps[0].target_date}) ---`);
  console.table(segs);

  // For each story segment's thread, check whether a "source country" pie panel exists
  console.log('\n--- panel availability per story thread ---');
  for (const s of segs.filter(x => x.type === 'story' && x.thread_id)) {
    const { rows: panels } = await pool.query(
      `SELECT chart_type, title FROM story_thread_panels WHERE thread_id = $1`,
      [s.thread_id]
    );
    const pies = panels.filter(p => p.chart_type === 'pie');
    const sourcePie = pies.find(p => (p.title || '').toLowerCase().includes('source country'));
    console.log(`  seg ${s.segment_index} thread ${s.thread_id}:`);
    console.log(`    total panels: ${panels.length}, pies: ${pies.length}`);
    console.log(`    source-country pie? ${sourcePie ? `YES ("${sourcePie.title}")` : 'NO'}`);
    if (pies.length && !sourcePie) {
      console.log(`    pie titles found: ${pies.map(p => `"${p.title}"`).join(', ')}`);
    }
  }

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
