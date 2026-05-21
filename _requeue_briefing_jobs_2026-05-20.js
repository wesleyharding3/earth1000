// Flip briefing_segment_render_queue rows for 2026-05-20 episodes back
// to 'pending' so the worker re-renders them with the latest code
// (softer globe easing + post-arcs camera_followup).
//
// Two-phase usage:
//   1. node _requeue_briefing_jobs_2026-05-20.js
//        → flips 'completed' + 'failed' to 'pending'; leaves 'claimed'
//          alone so the worker isn't yanked mid-render.
//   2. After the worker drains its current claims, run again with --force
//        → flips ANY non-pending row (claimed too).
require('dotenv').config();
const pool = require('./db');

const TARGET_DATE = '2026-05-20';
const FORCE = process.argv.includes('--force');

(async () => {
  const { rows: episodes } = await pool.query(`
    SELECT id FROM briefing_episodes WHERE target_date = $1
  `, [TARGET_DATE]);
  if (!episodes.length) { console.log('No episodes for ' + TARGET_DATE); await pool.end(); return; }
  const epIds = episodes.map(e => e.id);
  const allowed = FORCE
    ? ['completed', 'failed', 'claimed']
    : ['completed', 'failed'];
  const { rowCount, rows } = await pool.query(`
    UPDATE briefing_segment_render_queue
       SET status = 'pending',
           claimed_at = NULL,
           completed_at = NULL,
           bytes_out = NULL,
           error_text = NULL
     WHERE episode_id = ANY($1::int[])
       AND status = ANY($2::text[])
     RETURNING id, episode_id, segment_idx
  `, [epIds, allowed]);
  console.log(`Re-queued ${rowCount} job(s) for ${TARGET_DATE} (force=${FORCE}, allowed=${allowed.join(',')})`);
  for (const r of rows) {
    console.log(`  ep=${r.episode_id} seg=${r.segment_idx} → pending`);
  }
  await pool.end();
})().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
