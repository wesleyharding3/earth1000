#!/usr/bin/env node
'use strict';

/**
 * analyzeThreadOrigins.js
 *
 * One-off read-only analysis: for each thread created in the last 7 days,
 * test whether its earliest 3 articles would have been caught by the
 * SQL Jaccard pre-clustering pass in storyThreadBuilder.js. If yes,
 * the thread is almost certainly SQL-cluster-origin. If no, Claude
 * must have discovered it from a singleton batch — that's the cost we
 * pay $0.85/run per batch for.
 *
 * Method (mirrors sqlCluster()'s graph criterion):
 *   - Pull each thread's 3 earliest articles by story_thread_articles.added_at
 *   - For each pair of those articles, count shared NORMALIZED keywords
 *     (same length>=4 + SKIP_KEYWORDS filter the builder uses)
 *   - Edge passes if pair_score >= MIN_SHARED_KW (3)
 *   - All-3-connected iff ≥2 of 3 edges pass (a path or triangle in 3 nodes)
 *   - That's our SQL-clusterability test
 *
 * Caveat: threads with <3 articles total are excluded (mostly Claude
 * "extend existing thread" decisions, not relevant for cluster ROI).
 */

require('dotenv').config();
const pool = require('./db');

const LOOKBACK_DAYS  = parseInt(process.env.LOOKBACK_DAYS || '7', 10);
const MIN_SHARED_KW  = 3;  // SQL pre-cluster edge threshold
const SAMPLE_TOP_N   = 3;  // how many examples to show per category

// Same generic-keyword filter sqlCluster() uses (length<4 + stopwords).
const SKIP_KEYWORDS = new Set([
  'said','says','new','first','last','year','years','years-old','people',
  'also','make','made','many','most','more','time','times','day','days',
  'week','weeks','month','months','today','tomorrow','yesterday','plan',
  'plans','one','two','three','five','six','seven','eight','nine','ten',
]);

function normalizeKeyword(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function jaccardEligibleKeywords(rows) {
  // rows = [{ article_id, kw }]; filter to length>=4 + non-skip; return Map<aid, Set<kw>>.
  const byArticle = new Map();
  for (const r of rows) {
    const kw = normalizeKeyword(r.kw);
    if (kw.length < 4 || SKIP_KEYWORDS.has(kw)) continue;
    if (!byArticle.has(r.article_id)) byArticle.set(r.article_id, new Set());
    byArticle.get(r.article_id).add(kw);
  }
  return byArticle;
}

function pairScore(a, b) {
  if (!a || !b) return 0;
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (big.has(v)) n++;
  return n;
}

async function run() {
  const t0 = Date.now();
  console.log(`\nanalyzeThreadOrigins — last ${LOOKBACK_DAYS}d — ${new Date().toISOString()}\n`);

  // 1. Eligible threads: created in window, ≥3 articles total (so the
  //    3-article test is meaningful).
  const { rows: threads } = await pool.query(`
    SELECT st.id, st.title, st.first_seen_at, st.article_count
      FROM story_threads st
     WHERE st.first_seen_at > NOW() - ($1::int * INTERVAL '1 day')
       AND st.article_count >= 3
     ORDER BY st.first_seen_at DESC
  `, [LOOKBACK_DAYS]);

  console.log(`Loaded ${threads.length} threads (created in last ${LOOKBACK_DAYS}d, ≥3 articles).`);
  if (!threads.length) { await pool.end(); return; }

  // 2. For each thread, get its 3 EARLIEST attached articles.
  const threadIds = threads.map(t => t.id);
  const { rows: earliestRows } = await pool.query(`
    SELECT thread_id, article_id, added_at
    FROM (
      SELECT sta.thread_id, sta.article_id, sta.added_at,
             ROW_NUMBER() OVER (
               PARTITION BY sta.thread_id
               ORDER BY sta.added_at ASC, sta.article_id ASC
             ) AS rn
      FROM story_thread_articles sta
      WHERE sta.thread_id = ANY($1::int[])
    ) ranked
    WHERE rn <= 3
  `, [threadIds]);

  const earliestByThread = new Map();
  for (const r of earliestRows) {
    if (!earliestByThread.has(r.thread_id)) earliestByThread.set(r.thread_id, []);
    earliestByThread.get(r.thread_id).push(Number(r.article_id));
  }

  // 3. Bulk-fetch keywords for ALL earliest article IDs.
  const allArticleIds = [...new Set([...earliestByThread.values()].flat())];
  console.log(`Fetching keywords for ${allArticleIds.length} earliest-articles...`);
  const { rows: kwRows } = await pool.query(`
    SELECT article_id, COALESCE(normalized_keyword, LOWER(keyword)) AS kw
      FROM article_keywords
     WHERE article_id = ANY($1::int[])
  `, [allArticleIds]);
  const kwByArticle = jaccardEligibleKeywords(kwRows);

  // Also fetch article titles for nicer printing.
  const { rows: titleRows } = await pool.query(`
    SELECT id, title FROM news_articles WHERE id = ANY($1::int[])
  `, [allArticleIds]);
  const titleById = new Map(titleRows.map(r => [Number(r.id), r.title]));

  // 4. Score each thread.
  const scored = [];
  for (const t of threads) {
    const ids = earliestByThread.get(t.id) || [];
    if (ids.length < 3) continue; // shouldn't happen given the WHERE clause but skip defensively

    const [a, b, c] = ids.map(i => kwByArticle.get(i) || new Set());
    const s_ab = pairScore(a, b);
    const s_ac = pairScore(a, c);
    const s_bc = pairScore(b, c);
    const pairs = [s_ab, s_ac, s_bc];
    pairs.sort((x, y) => y - x); // desc
    const passingEdges = pairs.filter(p => p >= MIN_SHARED_KW).length;

    // SQL would have caught it iff at least 2 of 3 edges pass — that's
    // enough for a path through the 3 nodes (or a triangle).
    const sqlClusterable = passingEdges >= 2;

    // Confidence scores for ranking:
    //   sql_confidence: min pair score (strongest if even the weakest edge passes)
    //   singleton_confidence: how thin the keyword overlap is overall
    const minPair = pairs[2];
    const maxPair = pairs[0];
    const sumPairs = pairs.reduce((s, v) => s + v, 0);

    scored.push({
      thread_id: t.id,
      title: t.title,
      first_seen_at: t.first_seen_at,
      article_count_now: t.article_count,
      earliest_ids: ids,
      pairs: { ab: s_ab, ac: s_ac, bc: s_bc },
      passingEdges,
      sqlClusterable,
      minPair,
      maxPair,
      sumPairs,
    });
  }

  // 5. Summary.
  const sqlOrigin       = scored.filter(s => s.sqlClusterable);
  const singletonOrigin = scored.filter(s => !s.sqlClusterable);

  console.log(`\n━━━ Summary ━━━`);
  console.log(`Total scored threads:                    ${scored.length}`);
  console.log(`SQL-clusterable (≥2 of 3 pairs ≥${MIN_SHARED_KW} shared kw): ${sqlOrigin.length}  (${(100 * sqlOrigin.length / Math.max(1, scored.length)).toFixed(1)}%)`);
  console.log(`Singleton-discovered (Claude-only):      ${singletonOrigin.length}  (${(100 * singletonOrigin.length / Math.max(1, scored.length)).toFixed(1)}%)`);

  // 6. Print top samples per category.
  function printSample(s) {
    const ids = s.earliest_ids;
    console.log(`  #${s.thread_id}  "${(s.title || '').slice(0, 80)}"  (created ${s.first_seen_at.toISOString().slice(0,16)}, ${s.article_count_now} arts now)`);
    console.log(`     pair scores: a-b=${s.pairs.ab}  a-c=${s.pairs.ac}  b-c=${s.pairs.bc}   (passingEdges=${s.passingEdges})`);
    console.log(`     [a] ${ids[0]}: "${(titleById.get(ids[0]) || '?').slice(0, 90)}"`);
    console.log(`     [b] ${ids[1]}: "${(titleById.get(ids[1]) || '?').slice(0, 90)}"`);
    console.log(`     [c] ${ids[2]}: "${(titleById.get(ids[2]) || '?').slice(0, 90)}"`);
    console.log('');
  }

  // Highest singleton confidence = lowest min/max/sum pair scores.
  console.log(`\n━━━ Top ${SAMPLE_TOP_N}: highest-confidence SINGLETON-ORIGIN ━━━`);
  console.log(`(weakest keyword overlap — these would never cluster via SQL)\n`);
  const singletonStrong = [...singletonOrigin].sort((a, b) => a.sumPairs - b.sumPairs).slice(0, SAMPLE_TOP_N);
  for (const s of singletonStrong) printSample(s);

  // Highest SQL confidence = highest min pair score.
  console.log(`\n━━━ Top ${SAMPLE_TOP_N}: highest-confidence SQL-CLUSTER-ORIGIN ━━━`);
  console.log(`(all pairs strongly share keywords — Jaccard would have caught these easily)\n`);
  const sqlStrong = [...sqlOrigin].sort((a, b) => b.minPair - a.minPair).slice(0, SAMPLE_TOP_N);
  for (const s of sqlStrong) printSample(s);

  // Borderline: threads where exactly 1 of 3 pairs passes (i.e. ALMOST
  // SQL-clusterable but not quite — Claude's job to bridge that gap).
  const borderline = scored.filter(s => s.passingEdges === 1);
  if (borderline.length) {
    console.log(`\n━━━ Top ${SAMPLE_TOP_N}: BORDERLINE (1 of 3 pairs passes) ━━━`);
    console.log(`(${borderline.length} total borderline threads — these are the genuine ambiguity cases)\n`);
    const borderlineSample = [...borderline].sort((a, b) => b.sumPairs - a.sumPairs).slice(0, SAMPLE_TOP_N);
    for (const s of borderlineSample) printSample(s);
  } else {
    console.log(`\n(No borderline threads — every thread is either solid SQL or pure singleton.)\n`);
  }

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

run().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
