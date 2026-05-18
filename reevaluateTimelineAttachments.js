#!/usr/bin/env node
'use strict';

/**
 * reevaluateTimelineAttachments.js
 *
 * Periodic self-healing cron with two passes:
 *
 *   PASS 1: (thread_id, timeline_id) pairs from story_threads.timeline_id.
 *           Re-scores under decideAttachOrCreate's weights and the
 *           entity/core-phrase gate (ATTACH_THRESHOLD=6.0).
 *
 *   PASS 2: PURE-UMBRELLA (article_id, timeline_id) pairs from
 *           story_timeline_articles where the article isn't already
 *           justified by a thread attached to the same timeline.
 *           Re-scores under the umbrella weights and gate
 *           (UMBRELLA_ATTACH_THRESHOLD=2.5 + entity-or-phrase
 *           requirement). Catches the pre-fix leak where a pure
 *           publisher-nation match (2.5 pts alone) attached every
 *           US-wire article to every US-tagged Line.
 *
 * Why it exists:
 *
 *   The 2026-05-12 audit revealed ~176 threads attached to
 *   timelines they don't actually belong to — mostly artifacts
 *   from the pre-April-20 ATTACH_THRESHOLD=2.5 era (now 6.0)
 *   plus a handful of post-Apr-20 nation-overlap-only false
 *   matches that slipped through because nation overlap was
 *   uncapped. The builder was tightened in lockstep with this
 *   cron (NATION_CAP=2 + entity/core-phrase gate), but the
 *   tightening doesn't automatically un-do bad historical
 *   attachments — it only prevents new ones. This cron is the
 *   retroactive cleanup pass: anything that wouldn't pass the
 *   current gate gets detached, regardless of when it was
 *   originally attached.
 *
 *   Long-term, this also protects against future code regressions.
 *   If someone accidentally lowers the threshold or weakens the
 *   gate, false matches start landing. Running this cron daily
 *   means those bad matches get detached within 24h instead of
 *   compounding into another 176-row manual audit.
 *
 * Behavior:
 *
 *   - DRY RUN by default (no DB writes). Set REEVAL_APPLY=1 to
 *     actually detach.
 *   - For each (thread, timeline) pair, compute the score the
 *     way decideAttachOrCreate would today. If score < threshold
 *     OR entity/core-phrase gate fails: queue a detach.
 *   - At the end, apply detaches in a single UPDATE.
 *   - Logs each proposed detach with score + breakdown so you
 *     can audit before committing.
 *
 * Env:
 *
 *   REEVAL_APPLY=1           Actually run the detaches (default: dry run)
 *   REEVAL_BATCH_SIZE=200    Threads per loadContext batch (default: 200)
 *   REEVAL_LIMIT=0           Cap total threads evaluated (0 = all)
 *
 * Wire to a Render Cron daily, e.g.:
 *   `0 5 * * *  node reevaluateTimelineAttachments.js`
 * (5am UTC — after the timeline builder's main run.)
 */

// Match the builder's pool budget so this cron doesn't crowd the web
// server during overlap windows. Builder uses 4; we use 3 (smaller
// workload, mostly reads).
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '3';

require('dotenv').config();
const pool = require('./db');

// ── Constants — KEEP IN SYNC with storyTimelineBuilder.js ────────────────
// Any change to the builder's weights/thresholds must be mirrored here.
// A divergence would cause the reeval to either detach legit matches
// (false positives) or fail to detach broken ones (false negatives).
const W_ENTITY_OVERLAP   = 2.5;
const W_NATION_OVERLAP   = 2.5;
const W_KEYWORD_OVERLAP  = 1.0;
const W_TITLE_TOKEN      = 0.4;
const ENTITY_CAP         = 6;
const NATION_CAP         = 2;
const KEYWORD_CAP        = 8;
const ATTACH_THRESHOLD   = 6.0;

// Umbrella article-attach (pass 2). Lower threshold than thread→line
// because single articles are lighter signal. Phrase bonus is the
// per-article core-phrase title-hit reward. KEEP IN SYNC with the
// matching constants in storyTimelineBuilder.js.
const UMBRELLA_ATTACH_THRESHOLD = 2.5;
const UMBRELLA_PHRASE_BONUS     = 2.0;

const TAG = '[reeval-timeline-attach]';
const APPLY = process.env.REEVAL_APPLY === '1';
const BATCH_SIZE = Math.max(50, parseInt(process.env.REEVAL_BATCH_SIZE || '200', 10));
const LIMIT = Math.max(0, parseInt(process.env.REEVAL_LIMIT || '0', 10));

// Tokenizer for title-token signal — match the builder's tokenization
// rules exactly. Mostly low-signal (W_TITLE_TOKEN=0.4) but contributes
// to the final score, so accuracy matters for borderline cases.
const TITLE_STOPWORDS = new Set([
  'the','a','an','and','or','but','of','in','on','at','to','for','from','by',
  'with','as','is','are','was','were','be','been','being','it','its','this',
  'that','these','those','his','her','their','our','your','my','i','we','they',
  'he','she','him','them','us','you','me','about','after','before','over','out',
  'up','down','off','into','through','during','until','while','than','then',
  'so','if','not','no','yes','too','very','more','most','some','any','all',
  'new','says','said','will','would','could','should','may','might','can',
  'has','have','had','do','does','did','amid','amidst','vs','versus','plus',
]);
function tokenizeTitle(s) {
  if (!s) return new Set();
  return new Set(
    String(s).toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t && t.length >= 3 && !TITLE_STOPWORDS.has(t))
  );
}

function normalizeKeyword(s) {
  if (!s) return '';
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

function intersectCount(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let n = 0;
  // Iterate the smaller set for efficiency.
  const [small, big] = (a.size <= b.size) ? [a, b] : [b, a];
  for (const v of small) if (big.has(v)) n++;
  return n;
}

// loadContextForArticles — minimal version. We only need the entity
// text for each article's deep-context row, not the full structure.
async function loadContextForArticles(articleIds) {
  if (!articleIds.length) return new Map();
  const { rows } = await pool.query(`
    SELECT article_id, entities
      FROM article_deep_context
     WHERE article_id = ANY($1::int[])
  `, [articleIds]);
  const out = new Map();
  for (const r of rows) {
    let parsed = null;
    try {
      parsed = typeof r.entities === 'string' ? JSON.parse(r.entities) : r.entities;
    } catch (_) {}
    out.set(Number(r.article_id), { entities: Array.isArray(parsed) ? parsed : (parsed?.entities || []) });
  }
  return out;
}

// ─── Pass 1: Thread → Timeline re-evaluation ──────────────────────────────
async function runThreadPass() {
  console.log(`\n${TAG} ═══ PASS 1: Thread → Timeline ═══`);

  // 1. Pull every (thread, timeline) pair where timeline_id IS NOT NULL.
  //    Also pull per-timeline thread-count so we can preserve single-
  //    thread timelines (often manually-seeded). Detaching a timeline's
  //    only thread effectively orphans the timeline — too aggressive.
  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : '';
  const { rows: pairs } = await pool.query(`
    WITH thread_counts AS (
      SELECT timeline_id, COUNT(*) AS thread_count
        FROM story_threads
       WHERE timeline_id IS NOT NULL
       GROUP BY timeline_id
    )
    SELECT st.id AS thread_id,
           st.title AS thread_title,
           st.timeline_id,
           st.keywords AS thread_keywords,
           st.primary_nations AS thread_nations,
           tl.title AS timeline_title,
           tl.keywords AS timeline_keywords,
           tl.primary_nations AS timeline_nations,
           tl.core_phrases AS timeline_core_phrases,
           tl.status AS timeline_status,
           COALESCE(tc.thread_count, 0)::int AS timeline_thread_count
      FROM story_threads st
      JOIN story_timelines tl ON tl.id = st.timeline_id
      LEFT JOIN thread_counts tc ON tc.timeline_id = st.timeline_id
     WHERE st.timeline_id IS NOT NULL
     ORDER BY st.id
     ${limitClause}
  `);
  console.log(`${TAG} ${pairs.length} (thread, timeline) pairs to re-evaluate.`);

  if (!pairs.length) {
    console.log(`${TAG} nothing to do.`);
    await pool.end();
    return;
  }

  // 2. Build the per-timeline feature map — same shape the builder uses.
  //    Pull each timeline's top-10 articles' deep-context entities so we
  //    can score thread-side entities against it. Done in one pass.
  const timelineIds = [...new Set(pairs.map(p => p.timeline_id))];
  console.log(`${TAG} loading entities for ${timelineIds.length} timelines...`);
  const { rows: tlArticleLinks } = await pool.query(`
    SELECT timeline_id, article_id
    FROM (
      SELECT sta.timeline_id, sta.article_id,
             ROW_NUMBER() OVER (
               PARTITION BY sta.timeline_id
               ORDER BY sta.relevance_score DESC NULLS LAST, sta.added_at DESC
             ) AS rn
      FROM story_timeline_articles sta
      WHERE sta.timeline_id = ANY($1::int[])
    ) ranked
    WHERE rn <= 10
  `, [timelineIds]);
  const articlesByTimeline = new Map();
  const allTlArticleIds = new Set();
  for (const r of tlArticleLinks) {
    if (!articlesByTimeline.has(r.timeline_id)) articlesByTimeline.set(r.timeline_id, []);
    articlesByTimeline.get(r.timeline_id).push(Number(r.article_id));
    allTlArticleIds.add(Number(r.article_id));
  }
  const tlCtxMap = await loadContextForArticles([...allTlArticleIds]);
  const timelineFeatures = new Map();
  const tlMetaById = new Map();
  for (const p of pairs) {
    if (timelineFeatures.has(p.timeline_id)) continue;
    const arts = articlesByTimeline.get(p.timeline_id) || [];
    const entitySet = new Set();
    for (const id of arts) {
      const ctx = tlCtxMap.get(id);
      if (!ctx) continue;
      for (const e of (ctx.entities || [])) {
        if (!e?.text) continue;
        entitySet.add(String(e.text).toLowerCase().trim());
      }
    }
    timelineFeatures.set(p.timeline_id, {
      entities:    entitySet,
      nations:     new Set((p.timeline_nations || []).map(n => String(n).toUpperCase())),
      keywords:    new Set((p.timeline_keywords || []).map(normalizeKeyword).filter(Boolean)),
      titleTokens: tokenizeTitle(p.timeline_title),
      corePhrases: Array.isArray(p.timeline_core_phrases) ? p.timeline_core_phrases : [],
    });
    tlMetaById.set(p.timeline_id, {
      title: p.timeline_title,
      status: p.timeline_status,
    });
  }

  // 3. For each (thread, timeline) pair, load thread entities + score.
  //    We batch thread-entity loads to keep DB roundtrips low.
  const toDetach = [];   // [{ thread_id, timeline_id, score, breakdown, reason, thread_title, timeline_title }]
  const kept     = [];

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const threadIds = batch.map(p => p.thread_id);

    // Top-5 articles per thread → load their entities → union per thread.
    const { rows: thArticleLinks } = await pool.query(`
      SELECT thread_id, article_id
      FROM (
        SELECT sta.thread_id, sta.article_id,
               ROW_NUMBER() OVER (
                 PARTITION BY sta.thread_id
                 ORDER BY sta.is_anchor DESC NULLS LAST, sta.relevance_score DESC NULLS LAST
               ) AS rn
        FROM story_thread_articles sta
        WHERE sta.thread_id = ANY($1::int[])
      ) ranked
      WHERE rn <= 5
    `, [threadIds]);
    const articlesByThread = new Map();
    const allThArticleIds = new Set();
    for (const r of thArticleLinks) {
      if (!articlesByThread.has(r.thread_id)) articlesByThread.set(r.thread_id, []);
      articlesByThread.get(r.thread_id).push(Number(r.article_id));
      allThArticleIds.add(Number(r.article_id));
    }
    const thCtxMap = await loadContextForArticles([...allThArticleIds]);

    for (const p of batch) {
      const feat = timelineFeatures.get(p.timeline_id);
      if (!feat) continue;

      // Compose thread-side feature set.
      const arts = articlesByThread.get(p.thread_id) || [];
      const candEntities = new Set();
      for (const id of arts) {
        const ctx = thCtxMap.get(id);
        if (!ctx) continue;
        for (const e of (ctx.entities || [])) {
          if (!e?.text) continue;
          candEntities.add(String(e.text).toLowerCase().trim());
        }
      }
      const candNations  = new Set((p.thread_nations  || []).map(n => String(n).toUpperCase()));
      const candKeywords = new Set((p.thread_keywords || []).map(normalizeKeyword).filter(Boolean));
      const candTitleTokens = tokenizeTitle(p.thread_title);

      // Score — identical formula to decideAttachOrCreate.
      const entShared = Math.min(ENTITY_CAP,  intersectCount(candEntities,  feat.entities));
      const natShared = Math.min(NATION_CAP,  intersectCount(candNations,   feat.nations));
      const kwShared  = Math.min(KEYWORD_CAP, intersectCount(candKeywords,  feat.keywords));
      const ttkShared = intersectCount(candTitleTokens, feat.titleTokens);
      const score =
        entShared  * W_ENTITY_OVERLAP +
        natShared  * W_NATION_OVERLAP +
        kwShared   * W_KEYWORD_OVERLAP +
        ttkShared  * W_TITLE_TOKEN;

      // Entity / core-phrase / title-token gate (CONSERVATIVE for cron).
      //
      // Two-tier policy based on data availability:
      //
      //   1) Timeline has entity feature data (deep-context loaded
      //      for at least some of its top articles) → apply the
      //      STRICT builder gate: entity overlap OR core_phrase
      //      OR title-token ≥ 2. We have enough signal to make a
      //      confident detach call.
      //
      //   2) Timeline entities EMPTY → SKIP the gate entirely. The
      //      cron will only detach pairs whose SCORE falls below
      //      ATTACH_THRESHOLD; gate-only flags are deferred until
      //      deep-context-enrichment catches up. This is
      //      intentionally conservative: when we can't see the
      //      timeline's specific entity subjects, "high score but
      //      no entity overlap" is ambiguous (could be legit
      //      attach with unenriched articles, could be drift) —
      //      err toward keeping. Future runs will re-evaluate once
      //      entities load.
      //
      // NATION_CAP=2 (applied to the score above) already does the
      // heavy lifting against pure-geographic false matches: an
      // unrelated thread sharing 3 nations used to clear 7.5; now
      // 2 nations max 5.0 means the thread needs real keyword or
      // entity overlap to reach 6.0. Most pre-Apr-20 artifacts
      // fall below threshold under the new cap and get detached
      // by leg (1) of the threshold check alone.
      //
      // The builder's strict gate stays strict for NEW attaches —
      // this softening is only for the retro cron. The builder
      // always loads entities for every candidate before attach,
      // so it doesn't hit the data-sparsity case.
      const titleLower = String(p.thread_title || '').toLowerCase();
      const hasCorePhrase = feat.corePhrases.some(phrase =>
        phrase && titleLower.includes(String(phrase).toLowerCase())
      );
      const timelineHasEntities = feat.entities.size > 0;
      // Gate only applies when timeline entities ARE loaded. When
      // they're not, treat all above-threshold pairs as "pass" and
      // wait for enrichment.
      const passesGate = !timelineHasEntities
                      || entShared > 0
                      || hasCorePhrase
                      || ttkShared >= 2;

      const breakdown = { ent: entShared, nat: natShared, kw: kwShared, ttk: ttkShared };

      let reason = null;
      if (score < ATTACH_THRESHOLD) {
        reason = `below_threshold (score=${score.toFixed(1)} < ${ATTACH_THRESHOLD})`;
      } else if (!passesGate) {
        reason = `failed_gate (no entity, core_phrase, or title-token overlap)`;
      }

      // Safety net: don't detach a timeline's ONLY thread. Many of
      // these are manually-seeded "scaffold" timelines where the
      // attached thread IS the timeline's defining content (e.g.
      // "Keir Starmer Labour cabinet revolt" → "Starmer Battles for
      // Political Survival"). The scoring formula sometimes scores
      // these < 6.0 due to keyword-list sparsity even though the
      // attachment is correct. Detaching would orphan the timeline
      // and lose meaningful curation. Skip the detach but keep the
      // pair in the audit log so the user can see what was preserved.
      if (reason && p.timeline_thread_count === 1) {
        kept.push({
          thread_id:   p.thread_id,
          timeline_id: p.timeline_id,
          score,
          preserved_as: 'single_thread_timeline',
          would_have_been_detached: reason,
          thread_title:  p.thread_title,
          timeline_title: p.timeline_title,
        });
        reason = null;
      }

      if (reason) {
        toDetach.push({
          thread_id:     p.thread_id,
          timeline_id:   p.timeline_id,
          score,
          breakdown,
          reason,
          thread_title:  p.thread_title,
          timeline_title: p.timeline_title,
        });
      } else {
        kept.push({ thread_id: p.thread_id, timeline_id: p.timeline_id, score });
      }
    }

    if ((i / BATCH_SIZE) % 5 === 0) {
      console.log(`${TAG} progress: scored ${Math.min(i + BATCH_SIZE, pairs.length)}/${pairs.length}, queued ${toDetach.length} for detach so far`);
    }
  }

  const preservedSingletons = kept.filter(k => k.preserved_as === 'single_thread_timeline');
  console.log(`\n${TAG} re-evaluation complete: ${kept.length} kept (${preservedSingletons.length} preserved as singleton timelines), ${toDetach.length} flagged for detach`);

  if (preservedSingletons.length) {
    console.log(`\n${TAG} singleton timelines preserved (would have been detached on score alone, but they're the timeline's only thread):`);
    for (const k of preservedSingletons) {
      console.log(`     # tl=${k.timeline_id} thread=${k.thread_id} score=${k.score.toFixed(1)}  "${(k.thread_title || '').slice(0, 70)}" → "${(k.timeline_title || '').slice(0, 50)}"`);
      console.log(`         would have been: ${k.would_have_been_detached}`);
    }
    console.log('');
  }

  // 4. Print the detach list grouped by timeline for easy review.
  if (toDetach.length) {
    const byTimeline = new Map();
    for (const d of toDetach) {
      if (!byTimeline.has(d.timeline_id)) byTimeline.set(d.timeline_id, []);
      byTimeline.get(d.timeline_id).push(d);
    }
    console.log(`\n${TAG} proposed detaches by timeline:\n`);
    for (const [tlId, items] of byTimeline) {
      const tlMeta = tlMetaById.get(tlId);
      console.log(`──── Timeline #${tlId} "${tlMeta?.title || '?'}" — ${items.length} thread(s) to detach`);
      for (const d of items) {
        const bd = d.breakdown;
        console.log(`     # ${String(d.thread_id).padStart(6)}  score=${d.score.toFixed(1)} (e=${bd.ent} n=${bd.nat} k=${bd.kw} t=${bd.ttk}) ${d.reason}`);
        console.log(`                                     "${(d.thread_title || '').slice(0, 100)}"`);
      }
      console.log('');
    }
  }

  // 5. Apply detaches (if APPLY mode) in a single transaction.
  if (toDetach.length && APPLY) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = toDetach.map(d => d.thread_id);
      const res = await client.query(`
        UPDATE story_threads
           SET timeline_id = NULL
         WHERE id = ANY($1::int[])
           AND timeline_id IS NOT NULL
      `, [ids]);
      await client.query('COMMIT');
      console.log(`${TAG} ✓ committed: detached ${res.rowCount} threads.`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`${TAG} apply failed: ${e.message}`);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  } else if (toDetach.length) {
    console.log(`\n${TAG} DRY RUN — no changes applied. Set REEVAL_APPLY=1 to detach.`);
  }
}

// ─── Pass 2: Pure-umbrella Article → Timeline re-evaluation ───────────────
//
// Mirrors the structure of pass 1 but for direct article→timeline
// attachments via story_timeline_articles. We ONLY target "pure umbrella"
// attachments — pairs where the article isn't also justified by a thread
// that's attached to the same timeline (thread propagation auto-inserts
// into this table; we leave those alone because pass 1 already governs
// the thread→timeline decision).
//
// Scoring + gate use the umbrella-specific constants
// (UMBRELLA_ATTACH_THRESHOLD=2.5 + UMBRELLA_PHRASE_BONUS) plus the same
// entity-or-phrase requirement the builder now enforces at the umbrella
// attach point. The leak this pass cleans up: pre-fix, a single nation
// match (2.5 pts) cleared the threshold on its own, and since
// article.iso_code is the publisher country (not the subject), every
// US-wire article attached to every US-tagged Line. The new gate
// requires entity overlap OR a core-phrase title hit.
async function runUmbrellaPass() {
  console.log(`\n${TAG} ═══ PASS 2: Article → Timeline (umbrella only) ═══`);

  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : '';
  // iso_code lives on the countries table (joined via news_articles.country_id),
  // not directly on news_articles — match the umbrella scorer's source of
  // truth in storyTimelineBuilder.js:1875.
  const { rows: pairs } = await pool.query(`
    SELECT sta.timeline_id,
           sta.article_id,
           a.title         AS article_title,
           co.iso_code     AS article_iso,
           tl.title        AS timeline_title,
           tl.keywords     AS timeline_keywords,
           tl.primary_nations AS timeline_nations,
           tl.core_phrases AS timeline_core_phrases,
           tl.status       AS timeline_status
      FROM story_timeline_articles sta
      JOIN news_articles a    ON a.id  = sta.article_id
      LEFT JOIN countries co  ON co.id = a.country_id
      JOIN story_timelines tl ON tl.id = sta.timeline_id
     WHERE NOT EXISTS (
       SELECT 1
         FROM story_thread_articles sta_th
         JOIN story_threads st ON st.id = sta_th.thread_id
        WHERE sta_th.article_id = sta.article_id
          AND st.timeline_id    = sta.timeline_id
     )
     ORDER BY sta.timeline_id, sta.article_id
     ${limitClause}
  `);
  console.log(`${TAG} ${pairs.length} pure-umbrella (article, timeline) pairs to re-evaluate.`);

  if (!pairs.length) return;

  // Build per-timeline feature map (top-10 articles' entities + keywords/
  // nations/core_phrases from the timeline itself). Same shape as pass 1.
  const timelineIds = [...new Set(pairs.map(p => p.timeline_id))];
  const { rows: tlArticleLinks } = await pool.query(`
    SELECT timeline_id, article_id
    FROM (
      SELECT sta.timeline_id, sta.article_id,
             ROW_NUMBER() OVER (
               PARTITION BY sta.timeline_id
               ORDER BY sta.relevance_score DESC NULLS LAST, sta.added_at DESC
             ) AS rn
      FROM story_timeline_articles sta
      WHERE sta.timeline_id = ANY($1::int[])
    ) ranked
    WHERE rn <= 10
  `, [timelineIds]);
  const articlesByTimeline = new Map();
  const allTlArticleIds = new Set();
  for (const r of tlArticleLinks) {
    if (!articlesByTimeline.has(r.timeline_id)) articlesByTimeline.set(r.timeline_id, []);
    articlesByTimeline.get(r.timeline_id).push(Number(r.article_id));
    allTlArticleIds.add(Number(r.article_id));
  }
  const tlCtxMap = await loadContextForArticles([...allTlArticleIds]);
  const timelineFeatures = new Map();
  const tlMetaById = new Map();
  for (const p of pairs) {
    if (timelineFeatures.has(p.timeline_id)) continue;
    const arts = articlesByTimeline.get(p.timeline_id) || [];
    const entitySet = new Set();
    for (const id of arts) {
      const ctx = tlCtxMap.get(id);
      if (!ctx) continue;
      for (const e of (ctx.entities || [])) {
        if (!e?.text) continue;
        entitySet.add(String(e.text).toLowerCase().trim());
      }
    }
    timelineFeatures.set(p.timeline_id, {
      entities:    entitySet,
      nations:     new Set((p.timeline_nations || []).map(n => String(n).toUpperCase())),
      keywords:    new Set((p.timeline_keywords || []).map(normalizeKeyword).filter(Boolean)),
      titleTokens: tokenizeTitle(p.timeline_title),
      corePhrases: Array.isArray(p.timeline_core_phrases) ? p.timeline_core_phrases : [],
    });
    tlMetaById.set(p.timeline_id, {
      title:  p.timeline_title,
      status: p.timeline_status,
    });
  }

  // Score each (article, timeline) pair. Batches keep DB roundtrips low.
  const toDetach = [];
  const kept     = [];
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const articleIds = batch.map(p => p.article_id);

    // Article entities (single source: article_deep_context).
    const artCtxMap = await loadContextForArticles(articleIds);

    // Article keywords from article_keywords table.
    const { rows: akRows } = await pool.query(`
      SELECT article_id, COALESCE(normalized_keyword, LOWER(keyword)) AS kw
      FROM article_keywords
      WHERE article_id = ANY($1::int[])
    `, [articleIds]);
    const kwByArticle = new Map();
    for (const r of akRows) {
      if (!kwByArticle.has(r.article_id)) kwByArticle.set(r.article_id, new Set());
      kwByArticle.get(r.article_id).add(r.kw);
    }

    for (const p of batch) {
      const feat = timelineFeatures.get(p.timeline_id);
      if (!feat) continue;

      // Article-side features.
      const ctx = artCtxMap.get(Number(p.article_id));
      const artEntities = new Set();
      if (ctx) {
        for (const e of (ctx.entities || [])) {
          if (e?.text) artEntities.add(String(e.text).toLowerCase().trim());
        }
      }
      const artNations  = new Set(p.article_iso ? [String(p.article_iso).toUpperCase()] : []);
      const artKeywords = kwByArticle.get(Number(p.article_id)) || new Set();
      const artTitleTok = tokenizeTitle(p.article_title);

      const entShared = Math.min(ENTITY_CAP,  intersectCount(artEntities,  feat.entities));
      const natShared = Math.min(NATION_CAP,  intersectCount(artNations,   feat.nations));
      const kwShared  = Math.min(KEYWORD_CAP, intersectCount(artKeywords,  feat.keywords));
      const ttkShared = intersectCount(artTitleTok, feat.titleTokens);

      const titleLower = String(p.article_title || '').toLowerCase();
      const phraseHit = feat.corePhrases.some(phrase => {
        if (!phrase) return false;
        const rx = new RegExp(
          `(^|\\W)${String(phrase).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(\\W|$)`,
          'i'
        );
        return rx.test(titleLower);
      });
      const phraseBonus = phraseHit ? UMBRELLA_PHRASE_BONUS : 0;

      const score =
        entShared  * W_ENTITY_OVERLAP +
        natShared  * W_NATION_OVERLAP +
        kwShared   * W_KEYWORD_OVERLAP +
        ttkShared  * W_TITLE_TOKEN +
        phraseBonus;

      // Same conservative-cron stance as pass 1: if the timeline's
      // entity feature set is empty (deep-context not loaded for any
      // of its top-10 articles), skip the gate to avoid false-positive
      // detaches on legit attachments to unenriched timelines.
      const timelineHasEntities = feat.entities.size > 0;
      const passesGate = !timelineHasEntities || entShared > 0 || phraseHit;

      const breakdown = { ent: entShared, nat: natShared, kw: kwShared, ttk: ttkShared, ph: phraseBonus };

      let reason = null;
      if (score < UMBRELLA_ATTACH_THRESHOLD) {
        reason = `below_threshold (score=${score.toFixed(1)} < ${UMBRELLA_ATTACH_THRESHOLD})`;
      } else if (!passesGate) {
        reason = `failed_gate (no entity or core_phrase title-hit)`;
      }

      if (reason) {
        toDetach.push({
          article_id:    p.article_id,
          timeline_id:   p.timeline_id,
          score,
          breakdown,
          reason,
          article_title: p.article_title,
          timeline_title: p.timeline_title,
        });
      } else {
        kept.push({ article_id: p.article_id, timeline_id: p.timeline_id, score });
      }
    }

    if ((i / BATCH_SIZE) % 5 === 0) {
      console.log(`${TAG} progress: scored ${Math.min(i + BATCH_SIZE, pairs.length)}/${pairs.length}, queued ${toDetach.length} for detach so far`);
    }
  }

  console.log(`\n${TAG} pass 2 complete: ${kept.length} kept, ${toDetach.length} flagged for detach`);

  // Print proposed detaches grouped by timeline.
  if (toDetach.length) {
    const byTimeline = new Map();
    for (const d of toDetach) {
      if (!byTimeline.has(d.timeline_id)) byTimeline.set(d.timeline_id, []);
      byTimeline.get(d.timeline_id).push(d);
    }
    console.log(`\n${TAG} pass 2 — proposed article detaches by timeline:\n`);
    for (const [tlId, items] of byTimeline) {
      const tlMeta = tlMetaById.get(tlId);
      console.log(`──── Timeline #${tlId} "${tlMeta?.title || '?'}" — ${items.length} article(s) to detach`);
      for (const d of items) {
        const bd = d.breakdown;
        console.log(`     # ${String(d.article_id).padStart(8)}  score=${d.score.toFixed(1)} (e=${bd.ent} n=${bd.nat} k=${bd.kw} t=${bd.ttk} ph=${bd.ph}) ${d.reason}`);
        console.log(`                                       "${(d.article_title || '').slice(0, 100)}"`);
      }
      console.log('');
    }
  }

  // Apply detaches in batches if APPLY mode. Updates the timeline's
  // article_count so the line's UI counter stays consistent.
  if (toDetach.length && APPLY) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pairKeys = toDetach.map(d => `(${d.timeline_id},${d.article_id})`).join(',');
      // unnest two parallel arrays — efficient for ~thousands of pairs.
      const tlIds  = toDetach.map(d => d.timeline_id);
      const artIds = toDetach.map(d => d.article_id);
      const res = await client.query(`
        DELETE FROM story_timeline_articles
         USING (SELECT unnest($1::int[]) AS tl, unnest($2::int[]) AS ar) AS pairs
         WHERE story_timeline_articles.timeline_id = pairs.tl
           AND story_timeline_articles.article_id  = pairs.ar
      `, [tlIds, artIds]);
      // Refresh article_count for affected timelines.
      const uniqueTlIds = [...new Set(tlIds)];
      await client.query(`
        UPDATE story_timelines
           SET article_count = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = story_timelines.id)
         WHERE id = ANY($1::int[])
      `, [uniqueTlIds]);
      await client.query('COMMIT');
      console.log(`${TAG} ✓ pass 2 committed: detached ${res.rowCount} article→timeline rows, refreshed counts on ${uniqueTlIds.length} timelines.`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`${TAG} pass 2 apply failed: ${e.message}`);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  } else if (toDetach.length) {
    console.log(`\n${TAG} DRY RUN — no changes applied. Set REEVAL_APPLY=1 to detach.`);
  }
}

// ─── Driver: run pass(es), then close the pool ────────────────────────────
// REEVAL_PASS=all (default) runs both. =1 runs only thread→line. =2 runs
// only article-umbrella. Useful when you've validated one pass and want
// to apply it independently of the other.
async function run() {
  const t0 = Date.now();
  const passSel = (process.env.REEVAL_PASS || 'all').toLowerCase();
  if (!['all','1','2'].includes(passSel)) {
    console.error(`${TAG} invalid REEVAL_PASS=${passSel} (expected: all | 1 | 2)`);
    process.exit(2);
  }
  console.log(`${TAG} start ${new Date().toISOString()} apply=${APPLY ? 'YES (writes will happen)' : 'NO (dry run)'} batch=${BATCH_SIZE} limit=${LIMIT || 'all'} pass=${passSel}`);
  try {
    if (passSel === 'all' || passSel === '1') await runThreadPass();
    if (passSel === 'all' || passSel === '2') await runUmbrellaPass();
  } finally {
    console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await pool.end();
  }
}

run().catch(err => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
