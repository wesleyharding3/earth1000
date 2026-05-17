'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');

const threadId = parseInt(process.argv[2] || '10022', 10);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  const { rows } = await pool.query(`
    SELECT thread_id, arc_video, octet_length(arc_video) AS sz, status
      FROM social_post_queue
     WHERE thread_id = $1 AND arc_video IS NOT NULL
     ORDER BY id DESC LIMIT 1
  `, [threadId]);
  if (!rows.length) {
    console.error(`no arc_video row for thread_id=${threadId}`);
    process.exit(1);
  }
  const r = rows[0];
  console.log(`thread=${threadId} status=${r.status} size=${r.sz}`);
  const out = `/tmp/arc-${threadId}-db.mp4`;
  fs.writeFileSync(out, r.arc_video);
  console.log(`written ${out}`);
  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });
