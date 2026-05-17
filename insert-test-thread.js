'use strict';
require('dotenv').config();
const pool = require('./db');
const { composeDrafts } = require('./socialDraftComposer');

(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, description, primary_category, primary_nations, secondary_nations,
             article_count, last_updated_at
        FROM story_threads
       WHERE status IN ('active','cooling')
         AND title IS NOT NULL AND description IS NOT NULL
         AND article_count >= 5
         AND last_updated_at > NOW() - INTERVAL '7 days'
         AND array_length(primary_nations, 1) >= 2
         AND NOT EXISTS (
           SELECT 1 FROM social_post_queue q
            WHERE q.thread_id = story_threads.id
              AND q.scheduled_for > NOW() - INTERVAL '7 days'
         )
       ORDER BY importance DESC, last_updated_at DESC
       LIMIT 1
    `);
    if (!rows.length) {
      console.log('No eligible thread found.');
      await pool.end();
      return;
    }
    const t = rows[0];
    console.log(`Picking thread=${t.id} "${t.title.slice(0, 80)}"`);
    console.log(`  primary=${t.primary_nations?.join(',')}  articles=${t.article_count}`);
    const drafts = composeDrafts(t);
    const platforms_enabled = { x: false, reddit: false, linkedin: false, bluesky: true, instagram: true, threads: true };
    const { rows: [r] } = await pool.query(`
      INSERT INTO social_post_queue
        (thread_id, drafts, platforms_enabled, status, scheduled_for, selection_reason)
      VALUES ($1, $2::jsonb, $3::jsonb, 'pending_video', NOW(),
              'manual test insert via Claude — bypassing picker for video pipeline test')
      RETURNING id, thread_id, status
    `, [t.id, JSON.stringify(drafts), JSON.stringify(platforms_enabled)]);
    console.log(`Inserted queue_id=${r.id} thread_id=${r.thread_id} status=${r.status}`);
    await pool.end();
  } catch (err) {
    console.error('FATAL:', err.message);
    process.exit(1);
  }
})();
