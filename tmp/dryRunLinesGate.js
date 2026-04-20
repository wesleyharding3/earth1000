#!/usr/bin/env node
// Dry-run for strict multi-thread-only Line gate.
// Criteria to KEEP:
//   - thread_count >= 2
//   - span_days (between earliest attached thread.created_at and latest article.published_at) >= 14
//   - active_weeks_60d (# of distinct ISO-weeks with at least one attached article) >= 3
// Otherwise DEMOTE (except thread_count == 0 → PRUNE).
//
// No writes. Prints KEEP / DEMOTE / PRUNE lists, sorted by thread_count desc then articles desc.

require('dotenv').config();
const pool = require('../db');

async function main() {
  const q = `
    WITH tl AS (
      SELECT
        t.id,
        t.title,
        t.status,
        t.first_seen_at,
        t.last_updated_at
      FROM story_timelines t
    ),
    thr AS (
      SELECT
        timeline_id,
        COUNT(*)::int AS thread_count,
        MIN(first_seen_at) AS earliest_thread_at,
        MAX(last_updated_at) AS latest_thread_update
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
      tl.id,
      tl.title,
      tl.status,
      COALESCE(thr.thread_count, 0) AS thread_count,
      COALESCE(arts.article_count, 0) AS article_count,
      COALESCE(arts.active_weeks_60d, 0) AS active_weeks_60d,
      EXTRACT(EPOCH FROM (
        COALESCE(arts.latest_article, tl.last_updated_at, tl.first_seen_at)
        - COALESCE(thr.earliest_thread_at, arts.earliest_article, tl.first_seen_at)
      )) / 86400.0 AS span_days,
      arts.earliest_article,
      arts.latest_article
    FROM tl
    LEFT JOIN thr  ON thr.timeline_id  = tl.id
    LEFT JOIN arts ON arts.timeline_id = tl.id
    ORDER BY COALESCE(thr.thread_count,0) DESC, COALESCE(arts.article_count,0) DESC;
  `;

  const { rows } = await pool.query(q);

  // Gate:
  //   Primary rule:  threads>=2 AND span>=14d AND active_weeks_60d>=3
  //   Carve-out:     threads>=1 AND articles>=50 AND active_weeks_60d>=4 AND span>=14d
  //                  (i.e. a single strong thread that has sustained coverage
  //                   across ≥4 weeks in the last 60 days and >=14 day span)
  const MIN_THREADS_MULTI = 2;
  const MIN_SPAN_DAYS     = 14;
  const MIN_WEEKS_MULTI   = 3;

  const CARVEOUT_MIN_ARTICLES = 50;
  const CARVEOUT_MIN_WEEKS    = 4;

  const keep = [];
  const demote = [];
  const prune = [];

  for (const r of rows) {
    const tc = Number(r.thread_count || 0);
    const ac = Number(r.article_count || 0);
    const aw = Number(r.active_weeks_60d || 0);
    const sd = Number(r.span_days || 0);

    if (tc === 0) { prune.push({ ...r, reason: 'no attached threads' }); continue; }

    // Primary multi-thread rule
    const passesMulti =
      tc >= MIN_THREADS_MULTI &&
      sd >= MIN_SPAN_DAYS &&
      aw >= MIN_WEEKS_MULTI;

    // Single-thread carve-out: strong, sustained coverage
    const passesCarveout =
      tc >= 1 &&
      ac >= CARVEOUT_MIN_ARTICLES &&
      aw >= CARVEOUT_MIN_WEEKS &&
      sd >= MIN_SPAN_DAYS;

    if (passesMulti) {
      keep.push({ ...r, reason: 'multi-thread' });
    } else if (passesCarveout) {
      keep.push({ ...r, reason: 'single-thread carve-out' });
    } else {
      const reasons = [];
      if (tc < MIN_THREADS_MULTI)  reasons.push(`threads=${tc}<${MIN_THREADS_MULTI}`);
      if (sd < MIN_SPAN_DAYS)      reasons.push(`span=${sd.toFixed(1)}d<${MIN_SPAN_DAYS}d`);
      if (aw < MIN_WEEKS_MULTI)    reasons.push(`wk60=${aw}<${MIN_WEEKS_MULTI}`);
      // If single-thread carve-out was close, show what it'd need
      if (tc === 1) {
        const co = [];
        if (ac < CARVEOUT_MIN_ARTICLES) co.push(`art=${ac}<${CARVEOUT_MIN_ARTICLES}`);
        if (aw < CARVEOUT_MIN_WEEKS)    co.push(`wk60=${aw}<${CARVEOUT_MIN_WEEKS}`);
        if (sd < MIN_SPAN_DAYS)         co.push(`span=${sd.toFixed(1)}d<${MIN_SPAN_DAYS}d`);
        if (co.length) reasons.push(`carveout: ${co.join(',')}`);
      }
      demote.push({ ...r, reason: reasons.join(' · ') });
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  const fmtRow = (r) => {
    const tc  = String(r.thread_count).padStart(3);
    const ac  = String(r.article_count).padStart(4);
    const aw  = String(r.active_weeks_60d).padStart(2);
    const sd  = Number(r.span_days || 0).toFixed(1).padStart(6);
    const st  = pad(r.status || '—', 8);
    const ttl = (r.title || '').slice(0, 70);
    const why = r.reason ? `   ⤷ ${r.reason}` : '';
    return `  ${tc}t  ${ac}art  ${aw}wk  ${sd}d  ${st}  ${ttl}${why}`;
  };

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║ Multi-thread gate WITH single-thread carve-out — DRY RUN                 ║');
  console.log('║   KEEP (multi)     ⇔  threads≥2  AND  span≥14d  AND  weeks60≥3          ║');
  console.log('║   KEEP (carve-out) ⇔  threads≥1  AND  articles≥50  AND  weeks60≥4       ║');
  console.log('║                       AND span≥14d                                        ║');
  console.log('║   DEMOTE           ⇔  fails both (threads≥1)                             ║');
  console.log('║   PRUNE            ⇔  threads==0                                         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');

  console.log(`\nTotal Lines: ${rows.length}    KEEP: ${keep.length}    DEMOTE: ${demote.length}    PRUNE: ${prune.length}\n`);

  const keepMulti    = keep.filter(r => r.reason === 'multi-thread');
  const keepCarveout = keep.filter(r => r.reason === 'single-thread carve-out');

  console.log(`─── KEEP (${keep.length}) ──────────────────────────────────────────────────`);
  console.log(`  threads  articles  wk60  span    status    title`);
  console.log(`\n  · multi-thread (${keepMulti.length})`);
  keepMulti.forEach(r => console.log(fmtRow({ ...r, reason: '' })));
  console.log(`\n  · single-thread carve-out (${keepCarveout.length})`);
  keepCarveout.forEach(r => console.log(fmtRow({ ...r, reason: '' })));

  console.log(`\n─── DEMOTE (${demote.length}) ────────────────────────────────────────────`);
  console.log(`  threads  articles  wk60  span    status    title`);
  // Sub-sort demotes: single-thread first, then multi-thread weak
  const singles = demote.filter(r => Number(r.thread_count) <= 1);
  const multiWeak = demote.filter(r => Number(r.thread_count) >= 2);
  console.log(`\n  · single-thread (${singles.length})`);
  singles.forEach(r => console.log(fmtRow(r)));
  console.log(`\n  · multi-thread but fails span / activity (${multiWeak.length})`);
  multiWeak.forEach(r => console.log(fmtRow(r)));

  if (prune.length) {
    console.log(`\n─── PRUNE (${prune.length}) ──────────────────────────────────────────────`);
    console.log(`  threads  articles  wk60  span    status    title`);
    prune.forEach(r => console.log(fmtRow(r)));
  }

  console.log('');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
