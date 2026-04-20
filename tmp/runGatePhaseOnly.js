// Runs ONLY the Line quality gate phase — no promotion, no event extraction,
// no cooldown. Lets us do a one-time sweep (or verify dry-run) without
// needing to run the full pipeline.
//
// Usage:
//   node tmp/runGatePhaseOnly.js --dry-run-gate    # simulate, no writes
//   node tmp/runGatePhaseOnly.js                   # SWEEP for real
require('dotenv').config();
const pool = require('../db');

const GATE_MIN_THREADS_MULTI   = 2;
const GATE_MIN_SPAN_DAYS       = 14;
const GATE_MIN_WEEKS_MULTI     = 3;
const GATE_CARVEOUT_MIN_ART    = 50;
const GATE_CARVEOUT_MIN_WEEKS  = 4;
const GATE_GRACE_HOURS         = 72;

const DRY = process.argv.includes('--dry-run-gate');

async function main() {
  const { rows } = await pool.query(`
    WITH tl AS (
      SELECT id, title, status, first_seen_at, last_updated_at
      FROM story_timelines
    ),
    thr AS (
      SELECT
        timeline_id,
        COUNT(*)::int AS thread_count,
        MIN(first_seen_at) AS earliest_thread_at
      FROM story_threads
      WHERE timeline_id IS NOT NULL
      GROUP BY timeline_id
    ),
    arts AS (
      SELECT
        st.timeline_id,
        COUNT(DISTINCT a.id)::int AS article_count,
        MIN(a.published_at) AS earliest_article,
        MAX(a.published_at) AS latest_article,
        COUNT(DISTINCT date_trunc('week', a.published_at)) FILTER (
          WHERE a.published_at >= NOW() - INTERVAL '60 days'
        )::int AS active_weeks_60d
      FROM story_threads st
      JOIN story_thread_articles sta ON sta.thread_id = st.id
      JOIN news_articles a ON a.id = sta.article_id
      WHERE st.timeline_id IS NOT NULL
      GROUP BY st.timeline_id
    )
    SELECT
      tl.id, tl.title, tl.status, tl.first_seen_at,
      EXTRACT(EPOCH FROM (NOW() - tl.first_seen_at)) / 3600.0 AS age_hours,
      COALESCE(thr.thread_count, 0) AS thread_count,
      COALESCE(arts.article_count, 0) AS article_count,
      COALESCE(arts.active_weeks_60d, 0) AS active_weeks_60d,
      EXTRACT(EPOCH FROM (
        COALESCE(arts.latest_article, tl.last_updated_at, tl.first_seen_at)
        - COALESCE(thr.earliest_thread_at, arts.earliest_article, tl.first_seen_at)
      )) / 86400.0 AS span_days
    FROM tl
    LEFT JOIN thr  ON thr.timeline_id  = tl.id
    LEFT JOIN arts ON arts.timeline_id = tl.id
  `);

  const toDelete = [];
  let kept = 0;
  const graceHeld = [];
  for (const r of rows) {
    const tc = Number(r.thread_count || 0);
    const ac = Number(r.article_count || 0);
    const aw = Number(r.active_weeks_60d || 0);
    const sd = Number(r.span_days || 0);
    const ageH = Number(r.age_hours || 0);

    const passesMulti =
      tc >= GATE_MIN_THREADS_MULTI &&
      sd >= GATE_MIN_SPAN_DAYS &&
      aw >= GATE_MIN_WEEKS_MULTI;

    const passesCarveout =
      tc >= 1 &&
      ac >= GATE_CARVEOUT_MIN_ART &&
      aw >= GATE_CARVEOUT_MIN_WEEKS &&
      sd >= GATE_MIN_SPAN_DAYS;

    if (passesMulti || passesCarveout) { kept++; continue; }

    if (tc >= 1 && ageH < GATE_GRACE_HOURS) {
      graceHeld.push({ id: r.id, title: r.title, age: ageH.toFixed(1) });
      kept++;
      continue;
    }

    toDelete.push({
      id: r.id, title: r.title,
      threads: tc, articles: ac, weeks60: aw,
      span: Number(sd.toFixed(1)),
    });
  }

  console.log(`Evaluated ${rows.length} Lines → keep ${kept}, delete ${toDelete.length}, grace-held ${graceHeld.length}`);
  if (graceHeld.length) {
    console.log(`\nGrace-held (young, below gate but age<${GATE_GRACE_HOURS}h):`);
    graceHeld.forEach(g => console.log(`  id=${g.id}  ${g.age}h  ${String(g.title).slice(0, 70)}`));
  }

  if (!toDelete.length) {
    console.log(`\nNothing to delete. Exiting.`);
    await pool.end();
    return;
  }

  console.log(`\nSample to delete (first 15):`);
  toDelete.slice(0, 15).forEach(d =>
    console.log(`  id=${d.id} t=${d.threads} a=${d.articles} wk60=${d.weeks60} span=${d.span}d  ${String(d.title).slice(0, 80)}`)
  );
  if (toDelete.length > 15) console.log(`  ... + ${toDelete.length - 15} more`);

  if (DRY) {
    console.log(`\n[DRY RUN] Would delete ${toDelete.length} Lines. No changes made.`);
    await pool.end();
    return;
  }

  const ids = toDelete.map(d => d.id);
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM story_threads WHERE timeline_id = ANY($1::int[])`,
    [ids]
  );
  console.log(`\nExecuting DELETE on ${ids.length} Lines (will detach ${n} thread(s))...`);
  const { rowCount } = await pool.query(
    `DELETE FROM story_timelines WHERE id = ANY($1::int[])`,
    [ids]
  );
  console.log(`✔ Deleted ${rowCount} row(s).`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
