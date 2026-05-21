// Inspect briefing_segment_render_queue rows for 2026-05-20 episodes
// so we can confirm what gets re-rendered before flipping rows.
require('dotenv').config();
const pool = require('./db');

const TARGET_DATE = '2026-05-20';

(async () => {
  const { rows: episodes } = await pool.query(`
    SELECT id, target_date, headline, status
      FROM briefing_episodes
     WHERE target_date = $1
     ORDER BY id ASC
  `, [TARGET_DATE]);
  console.log(`Episodes for ${TARGET_DATE}:`);
  for (const e of episodes) {
    console.log(`  #${e.id}  status=${e.status}  "${(e.headline || '').slice(0, 60)}"`);
  }
  if (!episodes.length) { console.log('(none)'); await pool.end(); return; }
  const epIds = episodes.map(e => e.id);
  const { rows: jobs } = await pool.query(`
    SELECT episode_id, segment_idx, status, bytes_out, error_text,
           created_at, claimed_at, completed_at
      FROM briefing_segment_render_queue
     WHERE episode_id = ANY($1::int[])
     ORDER BY episode_id ASC, segment_idx ASC
  `, [epIds]);
  console.log(`\nRender-queue rows: ${jobs.length}`);
  const tally = {};
  for (const j of jobs) {
    tally[j.status] = (tally[j.status] || 0) + 1;
  }
  console.log('Status tally:', tally);
  for (const j of jobs) {
    console.log(
      `  ep=${j.episode_id} seg=${String(j.segment_idx).padStart(2,' ')} ` +
      `status=${j.status.padEnd(10,' ')} ` +
      `bytes=${j.bytes_out || '—'} ` +
      `${j.error_text ? `err=${j.error_text.slice(0, 60)}` : ''}`
    );
  }
  await pool.end();
})().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
