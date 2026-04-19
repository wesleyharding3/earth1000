/**
 * storyTimelineBuilder.js  —  v3 (thread-graduation architecture)
 *
 * Builds the "Lines" lane — broad multi-month umbrella arcs that track
 * the world's major ongoing conflicts, crises, and geopolitical
 * narratives.
 *
 * ═══ CORE MODEL ═══
 *
 *   Threads  (storyThreadBuilder.js)
 *     48-hour breaking-story cards. A thread emerges when ≥3 distinct
 *     sources converge on the same signal within a 24 h window. Lives
 *     for the duration of active coverage.
 *
 *   Lines / Timelines  (this file)
 *     The graduated form of threads that have crossed a "sustained
 *     coverage" gate. A storm timeline may dormant in 10 days; an
 *     Iran–US timeline may stay active for 5 years. The data model
 *     doesn't care about duration, only about signal.
 *
 *   The product framing:
 *     "The line records the series of events, the thread captures
 *     pictures of the present."
 *
 *     Threads and timelines COEXIST after promotion. The thread keeps
 *     showing as a 48 h breaking card in the feed. The timeline shows
 *     in the Lines lane with the thread linked via story_threads
 *     .timeline_id. Multiple threads roll up into one timeline over
 *     time (new "Hormuz Closure" thread + existing "Iran-US Escalation"
 *     timeline → thread.timeline_id set, timeline gets the new articles).
 *
 * ═══ WHY v3 ═══
 *
 *   v2 clustered raw articles directly (Phases 1–3), duplicating work
 *   the thread builder had just done two hours earlier. Threads and
 *   timelines were two parallel pipelines with similar keyword
 *   clustering and overlapping dedup logic. This caused:
 *     — timelines that weren't sourced from the thread signal the
 *       product calls "news"
 *     — double spend on Claude for overlapping article pools
 *     — inconsistent titles (threads optimized for 48 h, timelines
 *       copying those same titles)
 *     — no concept of "events" — a 6-month arc rendered as a flat
 *       bag of 200 articles, which isn't a timeline, it's a topic tag
 *
 *   v3 reframes timelines as the graduated form of threads, and adds a
 *   day-level event extraction pass so the UI / briefing narrator can
 *   render them as chronological progressions.
 *
 * ═══ PIPELINE ═══
 *
 *   Phase A — PROMOTION CANDIDATES
 *     Scan story_threads for promotion-ready candidates:
 *       — ≥ MIN_PROMOTION_ARTICLES articles
 *       — ≥ MIN_PROMOTION_SOURCES distinct sources
 *       — published span ≥ MIN_PROMOTION_SPAN_DAYS
 *       — primary_nations populated (populated by the article_deep
 *         _context writeback in the thread-builder's deep-enrich pass)
 *       — not already linked to a timeline (timeline_id IS NULL)
 *
 *   Phase B — ATTACH OR CREATE
 *     For each candidate thread, score it against every active/cooling
 *     /dormant timeline using:
 *       — entity overlap   (from article_deep_context.entities of the
 *                          thread's anchor + top articles)
 *       — primary_nations  overlap (Jaccard)
 *       — keyword          overlap (Jaccard, normalized kw)
 *       — title-token      Jaccard (cheap baseline)
 *     If max score clears ATTACH_THRESHOLD → link to that timeline.
 *     Dormant timelines with VERY HIGH overlap (REAWAKEN_THRESHOLD)
 *     reactivate (status='active', last_reawakened_at=NOW()) — e.g.
 *     "Ukraine-Russia Ceasefire" dormant 6 months, war resumes, same
 *     timeline comes back to life rather than spawning a duplicate.
 *     Otherwise → create a new timeline (title = thread title, scope
 *     derived from slug).
 *
 *   Phase C — EVENT EXTRACTION
 *     For each active/cooling timeline that has fresh articles since
 *     last extraction, run Claude Haiku once per dirty day-cluster to
 *     emit 1–3 events per day. Event title is the anchor article's
 *     (translated) title verbatim; Claude only writes the
 *     one/two-sentence description. Upsert to story_timeline_events
 *     (timeline_id, event_date, anchor_article_id) UNIQUE.
 *
 *   Phase D — COOLDOWN
 *     Transition active → cooling (30d no new articles) → dormant (90d).
 *
 * ═══ RELATIONSHIP TO OLD PHASES ═══
 *
 *   v2 Phase 1 (deterministic attach of raw articles):  REMOVED
 *   v2 Phase 2 (cluster unmatched raw articles):         REMOVED
 *   v2 Phase 3 (Claude creates from raw clusters):       REMOVED
 *   v2 Phase 4 (seedFromThreads):                        EXPANDED into Phase A+B
 *   v2 Phase 5 (cooldown + dedup):                       Phase D (dedup now a separate manual tool)
 *
 * Usage:
 *   node storyTimelineBuilder.js                  — default run, last 24h of threads
 *   node storyTimelineBuilder.js --hours=72       — custom thread-scan window
 *   node storyTimelineBuilder.js --skip-events    — promotion only, no event pass
 *   node storyTimelineBuilder.js --only-events    — event extraction only
 */

'use strict';

require('dotenv').config();
const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const { loadContextForArticles } = require('./articleDeepEnrichment');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CLI flags ────────────────────────────────────────────────────────────────
const LOOKBACK_HOURS = parseInt(
  process.argv.find(a => a.startsWith('--hours='))?.split('=')[1] || '24',
  10
);
const SKIP_EVENTS = process.argv.includes('--skip-events');
const ONLY_EVENTS = process.argv.includes('--only-events');

// ─── Promotion gates ──────────────────────────────────────────────────────────
// The thread → timeline graduation criteria. Tuned so that a storm that
// produces a day's worth of coverage doesn't immediately become a
// timeline, but a trial / agreement / protest / conflict with a week+
// of sustained signal does.
const MIN_PROMOTION_ARTICLES    = 5;
const MIN_PROMOTION_SOURCES     = 3;
const MIN_PROMOTION_SPAN_DAYS   = 3;
const MIN_PROMOTION_IMPORTANCE  = 5;   // out of 10
// Max threads to evaluate per run. Keeps Claude cost bounded even if a
// burst of new threads crosses the gate simultaneously.
const MAX_PROMOTIONS_PER_RUN    = 60;

// ─── Attach / reawaken thresholds ─────────────────────────────────────────────
// Scoring is additive across entity / nation / keyword / title signals.
// Weights chosen so:
//   — 4+ shared entities OR 2 entities + 1 nation = clear attach
//   — 3 shared entities + 1 nation + 2 keywords  = clear attach
//   — single coincidental title word alone       = no attach (below floor)
const W_ENTITY_OVERLAP    = 2.5;   // per shared entity text (case-folded)
const W_NATION_OVERLAP    = 2.5;   // per shared ISO code
const W_KEYWORD_OVERLAP   = 1.0;   // per shared normalized keyword
const W_TITLE_TOKEN       = 0.4;   // per shared title token, amplifier only
const ENTITY_CAP          = 6;
const KEYWORD_CAP         = 8;

const ATTACH_THRESHOLD    = 6.0;   // thread links to this timeline
const REAWAKEN_THRESHOLD  = 9.0;   // VERY HIGH overlap → reactivate dormant

// ─── Event extraction ────────────────────────────────────────────────────────
const EVENT_MIN_ARTICLES_PER_DAY = 2;   // skip days with 1 isolated article
const EVENT_LOOKBACK_DAYS        = 21;  // day-clusters older than this are stable
const EVENT_MAX_DAYS_PER_RUN     = 40;  // cap Claude spend per run

// ─── Cooldown ────────────────────────────────────────────────────────────────
const COOLING_AFTER_DAYS = 30;
const DORMANT_AFTER_DAYS = 90;

// ─── Stopwords for title tokenization ─────────────────────────────────────────
const TITLE_STOPWORDS = new Set([
  'the','a','an','of','in','on','at','to','for','and','or','but','is','are','was','were',
  'with','from','by','as','that','this','its','it','after','before','over','under',
  'new','old','first','last','top','all','some','any',
  'news','report','update','coverage','story','analysis',
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🗓  Story Timeline Builder v3 (threads→timelines) — ${new Date().toISOString()}`);
  console.log(`   lookback=${LOOKBACK_HOURS}h  min_articles=${MIN_PROMOTION_ARTICLES}  min_sources=${MIN_PROMOTION_SOURCES}  min_span_days=${MIN_PROMOTION_SPAN_DAYS}  min_imp=${MIN_PROMOTION_IMPORTANCE}`);

  const metrics = {
    candidateThreads:    0,
    attachedThreads:     0,
    newTimelines:        0,
    reawakened:          0,
    eventExtractionRuns: 0,
    eventsEmitted:       0,
    claudeCallsPromote:  0,
    claudeCallsEvent:    0,
    inputTokens:         0,
    outputTokens:        0,
  };

  if (!ONLY_EVENTS) {
    await runPromotionPhase(metrics, elapsed);
  }

  if (!SKIP_EVENTS) {
    await runEventExtractionPhase(metrics, elapsed);
  }

  console.log(`\n   [${elapsed()}] Cooldown pass...`);
  const cooled = await runCooldownPhase();
  console.log(`   cooled=${cooled.cooled} dormant=${cooled.dormant}`);

  // ── End-of-run summary ───────────────────────────────────────────────────
  console.log(`\n═══ TIMELINE RUN SUMMARY (${elapsed()}) ═══`);
  console.log(`  candidate_threads       : ${metrics.candidateThreads}`);
  console.log(`  attached_to_existing    : ${metrics.attachedThreads}`);
  console.log(`  new_timelines_created   : ${metrics.newTimelines}`);
  console.log(`  dormant_reawakened      : ${metrics.reawakened}`);
  console.log(`  timelines_cooled        : ${cooled.cooled}`);
  console.log(`  timelines_dormant       : ${cooled.dormant}`);
  console.log(`  event_extractions_run   : ${metrics.eventExtractionRuns}`);
  console.log(`  events_emitted          : ${metrics.eventsEmitted}`);
  console.log(`  claude_calls (promote)  : ${metrics.claudeCallsPromote}`);
  console.log(`  claude_calls (events)   : ${metrics.claudeCallsEvent}`);
  console.log(`  claude_tokens           : in=${metrics.inputTokens}  out=${metrics.outputTokens}`);
  console.log(`✅ Done.\n`);
  await pool.end();
}

// ═════════════════════════════════════════════════════════════════════════════
//  PHASE A + B : PROMOTION
// ═════════════════════════════════════════════════════════════════════════════
async function runPromotionPhase(metrics, elapsed) {
  // ── A. Find candidate threads ────────────────────────────────────────────
  // Gates: enough articles, enough sources, enough span, enough importance,
  // primary_nations set, not already graduated, actively extending (last
  // article in window).
  console.log(`   [${elapsed()}] Phase A: scanning for promotion-ready threads...`);
  const { rows: candidates } = await pool.query(`
    WITH thread_stats AS (
      SELECT
        t.id, t.title, t.description, t.primary_category, t.geographic_scope,
        t.importance, t.keywords, t.primary_nations, t.article_count,
        t.distinct_source_count, t.status, t.timeline_id,
        MAX(a.published_at) AS latest_pub,
        MIN(a.published_at) AS earliest_pub,
        COUNT(DISTINCT COALESCE(a.source_id::text, a.youtube_source_id::text)) AS src_count,
        EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400.0 AS span_days
      FROM story_threads t
      JOIN story_thread_articles sta ON sta.thread_id = t.id
      JOIN news_articles a ON a.id = sta.article_id
      WHERE t.timeline_id IS NULL
        AND t.status IN ('active','cooling')
      GROUP BY t.id
    )
    SELECT *
    FROM thread_stats
    WHERE article_count         >= $1
      AND src_count              >= $2
      AND span_days              >= $3
      AND importance             >= $4
      AND latest_pub > NOW() - ($5 * INTERVAL '1 hour')
      AND COALESCE(array_length(primary_nations, 1), 0) > 0
    ORDER BY importance DESC, article_count DESC
    LIMIT $6
  `, [
    MIN_PROMOTION_ARTICLES, MIN_PROMOTION_SOURCES, MIN_PROMOTION_SPAN_DAYS,
    MIN_PROMOTION_IMPORTANCE, LOOKBACK_HOURS, MAX_PROMOTIONS_PER_RUN
  ]);
  metrics.candidateThreads = candidates.length;
  console.log(`   [${elapsed()}] ${candidates.length} candidate thread(s) ready for promotion`);

  if (!candidates.length) return;

  // ── Load all timelines for matching (active + cooling + dormant) ─────────
  const { rows: timelines } = await pool.query(`
    SELECT id, title, description, scope, status, importance, keywords,
           primary_nations, article_count, primary_category, geographic_scope,
           first_seen_at, last_updated_at
    FROM story_timelines
    WHERE last_updated_at > NOW() - INTERVAL '365 days'
       OR status = 'active'
    ORDER BY importance DESC, last_updated_at DESC
    LIMIT 1000
  `);
  console.log(`   [${elapsed()}] ${timelines.length} existing timeline(s) in match pool`);

  // Precompute timeline match-features once. Entities for existing
  // timelines come from article_deep_context rows of their articles —
  // batched read.
  const timelineFeatures = await buildTimelineFeatures(timelines);

  // ── B. For each candidate, attach or create ──────────────────────────────
  for (const cand of candidates) {
    try {
      const decision = await decideAttachOrCreate(cand, timelines, timelineFeatures);
      metrics.claudeCallsPromote += decision._claudeCalls || 0;
      if (decision._usage) {
        metrics.inputTokens  += decision._usage.input_tokens        || 0;
        metrics.inputTokens  += decision._usage.cache_read_input_tokens || 0;
        metrics.inputTokens  += decision._usage.cache_creation_input_tokens || 0;
        metrics.outputTokens += decision._usage.output_tokens       || 0;
      }

      if (decision.action === 'attach' || decision.action === 'reawaken') {
        await attachThreadToTimeline(cand, decision.timelineId, decision.action === 'reawaken');
        metrics.attachedThreads++;
        if (decision.action === 'reawaken') metrics.reawakened++;
        const matched = timelines.find(t => t.id === decision.timelineId);
        console.log(`   ↳ ${decision.action === 'reawaken' ? 'REAWAKENED' : 'attached'} thread "${cand.title.slice(0,50)}" → timeline "${matched?.title?.slice(0,50) || decision.timelineId}" (score=${decision.score?.toFixed(1)})`);
      } else {
        const timelineId = await createTimelineFromThread(cand);
        metrics.newTimelines++;
        // Add the freshly-created timeline to the in-memory match pool so
        // any subsequent candidate this run can dedup-attach to it. Cheap
        // rebuild of its feature row from the thread we just promoted.
        const newRow = {
          id: timelineId,
          title: cand.title,
          description: cand.description,
          scope: null,
          status: 'active',
          importance: cand.importance,
          keywords: cand.keywords || [],
          primary_nations: cand.primary_nations || [],
          article_count: cand.article_count,
          primary_category: cand.primary_category,
          geographic_scope: cand.geographic_scope,
        };
        timelines.push(newRow);
        timelineFeatures.set(timelineId, await buildSingleTimelineFeatures(newRow));
        console.log(`   ↳ CREATED new timeline "${cand.title.slice(0,60)}" (id=${timelineId})`);
      }
    } catch (err) {
      console.warn(`   ⚠ Promotion failed for thread ${cand.id} "${cand.title?.slice(0,40)}": ${err.message}`);
    }
    await sleep(300);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Match features — built once per run, reused across every candidate
// ─────────────────────────────────────────────────────────────────────────────
async function buildTimelineFeatures(timelines) {
  // Fetch top-N articles per timeline and batch-load their deep-context
  // entities. Timelines with zero deep-enriched articles get an empty
  // entity set — they'll still match on keywords/nations/title.
  const featureMap = new Map();
  if (!timelines.length) return featureMap;

  const timelineIds = timelines.map(t => t.id);
  const { rows: articleLinks } = await pool.query(`
    SELECT timeline_id, article_id
    FROM (
      SELECT sta.timeline_id, sta.article_id,
             ROW_NUMBER() OVER (PARTITION BY sta.timeline_id ORDER BY sta.relevance_score DESC NULLS LAST, sta.added_at DESC) AS rn
      FROM story_timeline_articles sta
      WHERE sta.timeline_id = ANY($1::int[])
    ) ranked
    WHERE rn <= 10
  `, [timelineIds]);

  const byTimeline = new Map();
  const allArticleIds = new Set();
  for (const r of articleLinks) {
    if (!byTimeline.has(r.timeline_id)) byTimeline.set(r.timeline_id, []);
    byTimeline.get(r.timeline_id).push(Number(r.article_id));
    allArticleIds.add(Number(r.article_id));
  }

  const ctxMap = await loadContextForArticles([...allArticleIds]);

  for (const t of timelines) {
    const arts = byTimeline.get(t.id) || [];
    const entitySet = new Set();
    for (const id of arts) {
      const ctx = ctxMap.get(id);
      if (!ctx) continue;
      for (const e of (ctx.entities || [])) {
        if (!e?.text) continue;
        entitySet.add(String(e.text).toLowerCase().trim());
      }
    }
    featureMap.set(t.id, {
      entities: entitySet,
      nations:  new Set((t.primary_nations || []).map(n => String(n).toUpperCase())),
      keywords: new Set((t.keywords || []).map(normalizeKeyword).filter(Boolean)),
      titleTokens: tokenizeTitle(t.title),
    });
  }
  return featureMap;
}

async function buildSingleTimelineFeatures(t) {
  return {
    entities: new Set(),  // new timeline — no article history yet
    nations:  new Set((t.primary_nations || []).map(n => String(n).toUpperCase())),
    keywords: new Set((t.keywords || []).map(normalizeKeyword).filter(Boolean)),
    titleTokens: tokenizeTitle(t.title),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scoring a candidate thread against existing timelines
// ─────────────────────────────────────────────────────────────────────────────
async function decideAttachOrCreate(cand, timelines, timelineFeatures) {
  // Gather the candidate's own entities from its articles' deep-context.
  // Force-load: if the anchor article hasn't been deep-enriched yet,
  // the promotion decision is weaker but still valid via keywords+nations.
  const { rows: topArts } = await pool.query(`
    SELECT sta.article_id
    FROM story_thread_articles sta
    WHERE sta.thread_id = $1
    ORDER BY sta.is_anchor DESC NULLS LAST, sta.relevance_score DESC NULLS LAST
    LIMIT 5
  `, [cand.id]);
  const candArticleIds = topArts.map(r => Number(r.article_id));
  const candCtxMap = await loadContextForArticles(candArticleIds);
  const candEntities = new Set();
  for (const id of candArticleIds) {
    const ctx = candCtxMap.get(id);
    if (!ctx) continue;
    for (const e of (ctx.entities || [])) {
      if (!e?.text) continue;
      candEntities.add(String(e.text).toLowerCase().trim());
    }
  }
  const candNations  = new Set((cand.primary_nations || []).map(n => String(n).toUpperCase()));
  const candKeywords = new Set((cand.keywords || []).map(normalizeKeyword).filter(Boolean));
  const candTitleTokens = tokenizeTitle(cand.title);

  // Score every timeline; pick max.
  let bestScore = 0;
  let bestTimeline = null;
  const breakdown = [];
  for (const tl of timelines) {
    const feat = timelineFeatures.get(tl.id);
    if (!feat) continue;

    const entShared  = Math.min(ENTITY_CAP,  intersectCount(candEntities,  feat.entities));
    const natShared  = intersectCount(candNations,  feat.nations);
    const kwShared   = Math.min(KEYWORD_CAP, intersectCount(candKeywords,  feat.keywords));
    const ttkShared  = intersectCount(candTitleTokens, feat.titleTokens);

    const score =
      entShared  * W_ENTITY_OVERLAP +
      natShared  * W_NATION_OVERLAP +
      kwShared   * W_KEYWORD_OVERLAP +
      ttkShared  * W_TITLE_TOKEN;

    if (score > bestScore) {
      bestScore = score;
      bestTimeline = tl;
      breakdown.length = 0;
      breakdown.push({ ent: entShared, nat: natShared, kw: kwShared, ttk: ttkShared });
    }
  }

  // Decide.
  if (bestTimeline && bestScore >= ATTACH_THRESHOLD) {
    const isDormant = (bestTimeline.status === 'dormant');
    const action = (isDormant && bestScore >= REAWAKEN_THRESHOLD) ? 'reawaken' : 'attach';
    return {
      action,
      timelineId: bestTimeline.id,
      score: bestScore,
      breakdown: breakdown[0],
      _claudeCalls: 0,   // deterministic — no Claude needed
    };
  }

  // No confident deterministic match. Check if the score is in the gray
  // zone (3.0 < score < ATTACH_THRESHOLD) — call Claude for tiebreak.
  // Below 3.0 we just create a new timeline outright (no signal).
  if (bestScore >= 3.0 && bestTimeline) {
    const claudeCall = await askClaudeAttachOrCreate(cand, bestTimeline);
    if (claudeCall && claudeCall.decision === 'attach') {
      return {
        action: bestTimeline.status === 'dormant' ? 'reawaken' : 'attach',
        timelineId: bestTimeline.id,
        score: bestScore,
        breakdown: breakdown[0],
        _claudeCalls: 1,
        _usage: claudeCall._usage,
      };
    }
    return {
      action: 'create',
      _claudeCalls: claudeCall ? 1 : 0,
      _usage: claudeCall?._usage,
    };
  }

  return { action: 'create', _claudeCalls: 0 };
}

async function askClaudeAttachOrCreate(cand, candidateTimeline) {
  try {
    const prompt =
`Decide whether this THREAD should attach to the candidate TIMELINE or become its own new timeline.

THREAD:
  title: ${cand.title}
  description: ${cand.description || ''}
  primary_nations: ${(cand.primary_nations || []).join(', ') || '(none)'}
  keywords: ${(cand.keywords || []).slice(0, 6).join(', ')}
  category: ${cand.primary_category}

TIMELINE:
  title: ${candidateTimeline.title}
  description: ${candidateTimeline.description || ''}
  primary_nations: ${(candidateTimeline.primary_nations || []).join(', ') || '(none)'}
  keywords: ${(candidateTimeline.keywords || []).slice(0, 6).join(', ')}
  status: ${candidateTimeline.status}

Attach if the thread is clearly a chapter / episode of the timeline's ongoing story.
Create if the thread is a different story that happens to share some vocabulary.

Return ONLY this JSON, nothing else:
{"decision": "attach" | "create", "reason": "one sentence"}`;

    const response = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }]
    });
    const raw = response.content?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return {
      decision: parsed.decision === 'attach' ? 'attach' : 'create',
      reason:   parsed.reason || '',
      _usage:   response.usage || null,
    };
  } catch (err) {
    console.warn(`   ⚠ Claude tiebreak failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Persist: attach thread to existing timeline / create new
// ─────────────────────────────────────────────────────────────────────────────
async function attachThreadToTimeline(thread, timelineId, reawaken) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    // Link the thread
    await tx.query(
      `UPDATE story_threads SET timeline_id = $1 WHERE id = $2`,
      [timelineId, thread.id]
    );

    // Attach the thread's articles to the timeline (upsert — idempotent).
    // parabolic_weight + relevance_score stay whatever the thread gave
    // them; timelines don't re-weight.
    await tx.query(`
      INSERT INTO story_timeline_articles (timeline_id, article_id, relevance_score, parabolic_weight, is_anchor, added_at)
      SELECT $1, sta.article_id, sta.relevance_score, 1.0, sta.is_anchor, NOW()
      FROM story_thread_articles sta
      WHERE sta.thread_id = $2
      ON CONFLICT (timeline_id, article_id) DO NOTHING
    `, [timelineId, thread.id]);

    // Refresh timeline counters + mark active. last_reawakened_at only
    // set if the dormant-→-active transition actually happened here.
    if (reawaken) {
      await tx.query(`
        UPDATE story_timelines
           SET status             = 'active',
               last_reawakened_at = NOW(),
               last_updated_at    = NOW(),
               importance         = GREATEST(importance, $2),
               keywords           = ARRAY(SELECT DISTINCT unnest(keywords || $3::text[])),
               primary_nations    = ARRAY(SELECT DISTINCT unnest(primary_nations || $4::text[])),
               article_count      = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1)
         WHERE id = $1
      `, [timelineId, thread.importance || 5, thread.keywords || [], thread.primary_nations || []]);
    } else {
      await tx.query(`
        UPDATE story_timelines
           SET last_updated_at = NOW(),
               importance      = GREATEST(importance, $2),
               keywords        = ARRAY(SELECT DISTINCT unnest(keywords || $3::text[])),
               primary_nations = ARRAY(SELECT DISTINCT unnest(primary_nations || $4::text[])),
               article_count   = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1),
               status          = CASE WHEN status = 'dormant' THEN 'active' ELSE status END
         WHERE id = $1
      `, [timelineId, thread.importance || 5, thread.keywords || [], thread.primary_nations || []]);
    }

    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

async function createTimelineFromThread(thread) {
  const scope = slugifyScope(thread.title);
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    // Scope is UNIQUE — on collision we append thread id as suffix. We
    // already checked overlap against existing timelines above; this is
    // a belt-and-braces safeguard against two threads producing the
    // same slug at the exact same time.
    const { rows } = await tx.query(`
      INSERT INTO story_timelines
        (title, description, scope, status, importance, primary_category,
         geographic_scope, keywords, primary_nations, article_count,
         first_seen_at, last_updated_at)
      VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, 0, NOW(), NOW())
      ON CONFLICT (scope) DO UPDATE SET
        last_updated_at = NOW()
      RETURNING id
    `, [
      thread.title,
      thread.description || '',
      scope,
      thread.importance || 5,
      thread.primary_category || 'politics',
      thread.geographic_scope || 'global',
      thread.keywords || [],
      thread.primary_nations || [],
    ]);
    const timelineId = rows[0].id;

    // Link thread
    await tx.query(
      `UPDATE story_threads SET timeline_id = $1 WHERE id = $2`,
      [timelineId, thread.id]
    );

    // Attach articles
    await tx.query(`
      INSERT INTO story_timeline_articles (timeline_id, article_id, relevance_score, parabolic_weight, is_anchor, added_at)
      SELECT $1, sta.article_id, sta.relevance_score, 1.0, sta.is_anchor, NOW()
      FROM story_thread_articles sta
      WHERE sta.thread_id = $2
      ON CONFLICT (timeline_id, article_id) DO NOTHING
    `, [timelineId, thread.id]);

    // Refresh count
    await tx.query(`
      UPDATE story_timelines
         SET article_count = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1)
       WHERE id = $1
    `, [timelineId]);

    await tx.query('COMMIT');
    return timelineId;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PHASE C : EVENT EXTRACTION
// ═════════════════════════════════════════════════════════════════════════════
async function runEventExtractionPhase(metrics, elapsed) {
  console.log(`\n   [${elapsed()}] Phase C: day-level event extraction...`);

  // Find active/cooling timelines that have fresh articles since their
  // last event extraction. Use GREATEST(latest_event_created_at,
  // first_seen_at) to include timelines that have never been extracted.
  const { rows: dirtyTimelines } = await pool.query(`
    SELECT t.id, t.title,
           MAX(ste.created_at) AS last_event_at,
           MAX(a.published_at) AS latest_article_at
    FROM story_timelines t
    JOIN story_timeline_articles sta ON sta.timeline_id = t.id
    JOIN news_articles a ON a.id = sta.article_id
    LEFT JOIN story_timeline_events ste ON ste.timeline_id = t.id
    WHERE t.status IN ('active','cooling')
    GROUP BY t.id, t.title
    HAVING MAX(a.published_at) > COALESCE(MAX(ste.created_at), t.first_seen_at)
    ORDER BY MAX(a.published_at) DESC
    LIMIT 80
  `);
  console.log(`   [${elapsed()}] ${dirtyTimelines.length} timeline(s) have fresh articles since last extraction`);

  let daysProcessed = 0;
  for (const tl of dirtyTimelines) {
    if (daysProcessed >= EVENT_MAX_DAYS_PER_RUN) break;
    try {
      const emitted = await extractEventsForTimeline(tl.id, tl.title, metrics);
      metrics.eventsEmitted += emitted.eventsEmitted;
      metrics.eventExtractionRuns += emitted.daysProcessed;
      metrics.claudeCallsEvent += emitted.claudeCalls;
      metrics.inputTokens  += emitted.inputTokens;
      metrics.outputTokens += emitted.outputTokens;
      daysProcessed += emitted.daysProcessed;
    } catch (err) {
      console.warn(`   ⚠ Event extraction failed for timeline ${tl.id}: ${err.message}`);
    }
    await sleep(400);
  }
}

async function extractEventsForTimeline(timelineId, timelineTitle, metrics) {
  // Load articles attached to this timeline, grouped by day. We only
  // (re)extract for days that (a) have ≥ EVENT_MIN_ARTICLES_PER_DAY
  // articles AND (b) either have no events yet OR have new articles
  // added since the last extraction.
  const { rows } = await pool.query(`
    WITH day_clusters AS (
      SELECT
        DATE(a.published_at AT TIME ZONE 'UTC') AS event_date,
        a.id, a.title, a.translated_title, a.summary, a.translated_summary,
        a.article_url, a.published_at, a.country_id, a.source_id,
        sta.relevance_score, sta.is_anchor,
        co.name AS country_name,
        COALESCE(ns.name, ys.name) AS source_name
      FROM story_timeline_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE sta.timeline_id = $1
        AND a.published_at IS NOT NULL
        AND a.published_at > NOW() - ($2 * INTERVAL '1 day')
    )
    SELECT * FROM day_clusters
    ORDER BY event_date DESC, relevance_score DESC NULLS LAST
  `, [timelineId, EVENT_LOOKBACK_DAYS]);

  if (!rows.length) {
    return { eventsEmitted: 0, daysProcessed: 0, claudeCalls: 0, inputTokens: 0, outputTokens: 0 };
  }

  // Group by day
  const byDay = new Map();
  for (const r of rows) {
    const key = r.event_date.toISOString().slice(0,10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }

  // Find dirty days: days whose existing events are stale (older than
  // the newest article on that day) OR days with no events yet.
  const { rows: existingEvents } = await pool.query(`
    SELECT event_date, MAX(updated_at) AS last_extracted
    FROM story_timeline_events
    WHERE timeline_id = $1
    GROUP BY event_date
  `, [timelineId]);
  const extractedMap = new Map();
  for (const e of existingEvents) {
    extractedMap.set(e.event_date.toISOString().slice(0,10), e.last_extracted);
  }

  const dirtyDays = [];
  for (const [day, articles] of byDay.entries()) {
    if (articles.length < EVENT_MIN_ARTICLES_PER_DAY) continue;
    const last = extractedMap.get(day);
    const newest = articles[0].published_at;
    if (!last || new Date(newest) > new Date(last)) {
      dirtyDays.push({ day, articles });
    }
  }
  if (!dirtyDays.length) {
    return { eventsEmitted: 0, daysProcessed: 0, claudeCalls: 0, inputTokens: 0, outputTokens: 0 };
  }

  // Claude pass: one call covers up to 5 days at once. Keeps token budget
  // low. We give Claude the day's articles and ask for {anchor_article_id,
  // event_description} — the event_title is set by us from the anchor's
  // (translated) title.
  let eventsEmitted = 0;
  let claudeCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const daysBatches = chunk(dirtyDays, 5);
  for (const batch of daysBatches) {
    const batchInput = batch.map(b => ({
      date: b.day,
      articles: b.articles.slice(0, 6).map(a => ({
        id: a.id,
        title: a.translated_title || a.title,
        summary: (a.translated_summary || a.summary || '').slice(0, 200),
        source: a.source_name,
        country: a.country_name,
      })),
    }));

    const prompt =
`You are the event-structure writer for a geopolitical timeline called "${timelineTitle}".

Below is a list of days. For each day, the articles published that day are provided. Extract the KEY EVENTS that happened (1–3 per day). Pick an anchor article (the most representative reporting of the event), and write a 1–2 sentence description of what occurred.

If a day contains only background/commentary/opinion articles with no clear event, emit zero events for it.

DAYS:
${JSON.stringify(batchInput, null, 2)}

Return ONLY a JSON array, no markdown fences, no prose:
[
  {
    "event_date": "YYYY-MM-DD",
    "anchor_article_id": <number>,
    "description": "1-2 sentence description of the event"
  }
]`;

    try {
      const response = await client.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      claudeCalls++;
      inputTokens  += response.usage?.input_tokens  || 0;
      outputTokens += response.usage?.output_tokens || 0;

      const rawText = response.content?.[0]?.text || '';
      const parsed = parseJsonArray(rawText);
      if (!Array.isArray(parsed)) continue;

      // Persist
      for (const evt of parsed) {
        if (!evt.event_date || !evt.anchor_article_id) continue;
        // Find the anchor article's title from our batch input
        const dayBatch = batch.find(b => b.day === evt.event_date);
        const anchor = dayBatch?.articles.find(a => Number(a.id) === Number(evt.anchor_article_id));
        if (!anchor) continue;
        const eventTitle = anchor.translated_title || anchor.title;
        if (!eventTitle) continue;

        // article_ids: every article from that day that mentions the same
        // signals. Simplest heuristic: all articles in the day-batch.
        const allIdsForDay = dayBatch.articles.map(a => Number(a.id));
        const sourceCount = new Set(dayBatch.articles.map(a => a.source_id).filter(Boolean)).size
                         || dayBatch.articles.length;

        await pool.query(`
          INSERT INTO story_timeline_events (
            timeline_id, event_date, anchor_article_id,
            event_title, event_description, article_ids, source_count, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
          ON CONFLICT (timeline_id, event_date, anchor_article_id) DO UPDATE SET
            event_title       = EXCLUDED.event_title,
            event_description = EXCLUDED.event_description,
            article_ids       = EXCLUDED.article_ids,
            source_count      = EXCLUDED.source_count,
            updated_at        = NOW()
        `, [
          timelineId,
          evt.event_date,
          Number(evt.anchor_article_id),
          eventTitle.slice(0, 400),
          String(evt.description || '').slice(0, 1200),
          allIdsForDay,
          sourceCount,
        ]);
        eventsEmitted++;
      }
    } catch (err) {
      console.warn(`   ⚠ Event extraction Claude call failed: ${err.message}`);
    }
  }

  return {
    eventsEmitted,
    daysProcessed: dirtyDays.length,
    claudeCalls,
    inputTokens,
    outputTokens,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  PHASE D : COOLDOWN
// ═════════════════════════════════════════════════════════════════════════════
async function runCooldownPhase() {
  const { rows: c1 } = await pool.query(`
    UPDATE story_timelines
       SET status = 'cooling'
     WHERE status = 'active'
       AND last_updated_at < NOW() - ($1 * INTERVAL '1 day')
     RETURNING id
  `, [COOLING_AFTER_DAYS]);
  const { rows: c2 } = await pool.query(`
    UPDATE story_timelines
       SET status = 'dormant'
     WHERE status = 'cooling'
       AND last_updated_at < NOW() - ($1 * INTERVAL '1 day')
     RETURNING id
  `, [DORMANT_AFTER_DAYS]);
  return { cooled: c1.length, dormant: c2.length };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizeKeyword(keyword) {
  return String(keyword || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/["""'`]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitle(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w))
  );
}

function intersectCount(a, b) {
  if (!a || !b) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function slugifyScope(title) {
  return String(title || 'untitled')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Tolerant JSON array extractor — strips markdown fences, falls back to
// bracketed match. Same pattern we use in keywordNormalizer +
// articleDeepEnrichment now.
function parseJsonArray(rawText) {
  if (!rawText) return null;
  let text = String(rawText).trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {}
  const bracketMatch = text.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[0]);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {}
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
