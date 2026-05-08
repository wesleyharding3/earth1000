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

// Cap this cron's share of Postgres connections BEFORE db.js loads.
// Without this it defaults to DB_POOL_MAX=60, which when running
// concurrently with the web server + worker + other crons blows past
// Postgres max_connections=103 — the user-facing /api/threads/latest,
// /api/timelines/latest, /api/flows etc. then start failing with
// "remaining connection slots are reserved for SUPERUSER" (53300).
// Per-thread / per-timeline graduation work is mostly Anthropic-bound
// with sequential DB queries between API calls; 4 is plenty.
process.env.DB_POOL_MAX = "4";

require('dotenv').config({ override: true });
const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const { loadContextForArticles } = require('./articleDeepEnrichment');
const { classifyAndTierTimeline, classifyAndTierThread } = require('./entityTierWiring');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CLI flags ────────────────────────────────────────────────────────────────
const LOOKBACK_HOURS = parseInt(
  process.argv.find(a => a.startsWith('--hours='))?.split('=')[1] || '24',
  10
);
const SKIP_EVENTS = process.argv.includes('--skip-events');
const ONLY_EVENTS = process.argv.includes('--only-events');
// --dry-run-gate prints what the Line quality gate WOULD delete without
// mutating anything. Useful before a big one-time sweep.
const DRY_RUN_GATE = process.argv.includes('--dry-run-gate');
// --skip-gate disables the quality gate entirely (useful during backfill
// runs where you want to bootstrap weak Lines before the gate runs).
const SKIP_GATE = process.argv.includes('--skip-gate');
// --skip-umbrella disables the Article Umbrella phase (used during
// backfills where you don't want article-flow to inflate last_updated_at
// before cooldown runs).
const SKIP_UMBRELLA = process.argv.includes('--skip-umbrella');
// --retitle-all runs the Wikipedia-style title rewrite against EVERY
// existing Line (not just newly-created ones). Use once after deploying
// the rewriter, or after tuning the prompt. Costs ~1 Claude Haiku call
// per Line.
const RETITLE_ALL   = process.argv.includes('--retitle-all');
// --reclassify-actors runs the entityTierClassifier across every existing
// thread + line, splitting each primary_nations into a narrowed primary
// tier and a new secondary tier. One-shot sweep; safe to re-run. Costs
// ~1 Haiku call per multi-country thread/line (~$0.03 total).
const RECLASSIFY_ACTORS = process.argv.includes('--reclassify-actors');
// --dry-run-reclassify prints what --reclassify-actors WOULD write without
// committing. Useful as a final gate before the destructive sweep.
const DRY_RUN_RECLASSIFY = process.argv.includes('--dry-run-reclassify');

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
// 7.0 was 9.0 — that bar was essentially "perfect match" and almost no
// dormant Line could clear it, so reactivation was effectively dead. 7.0
// is still meaningfully stricter than ATTACH_THRESHOLD (6.0): a thread
// has to overlap a dormant Line by more than the bar to attach to a
// fresh active Line. Tunable from here if reactivation gets too noisy.
const REAWAKEN_THRESHOLD  = 7.0;   // HIGH overlap → reactivate dormant

// ─── Event extraction ────────────────────────────────────────────────────────
const EVENT_MIN_ARTICLES_PER_DAY = 2;   // skip days with 1 isolated article
const EVENT_LOOKBACK_DAYS        = 21;  // day-clusters older than this are stable
const EVENT_MAX_DAYS_PER_RUN     = 40;  // cap Claude spend per run

// ─── Cooldown ────────────────────────────────────────────────────────────────
// Per-request: active → cooling after 1 week of no updates, cooling →
// dormant after another 2 months (60 days). The dormant threshold is
// measured from last_updated_at (not from the cooling transition), so
// dormant kicks in at 7+60 = 67 days since the last update.
const COOLING_AFTER_DAYS = 7;
const DORMANT_AFTER_DAYS = 67;

// ─── Article Umbrella phase ──────────────────────────────────────────────────
// Beyond thread promotions, recent articles matching a Line's umbrella
// (entities / nations / keywords) keep that Line alive. Articles flow into
// story_timeline_articles so they surface in the Line's Sources list and
// bump last_updated_at, avoiding a premature cooling drift.
const UMBRELLA_LOOKBACK_DAYS          = 7;    // only consider articles from last 7d
const UMBRELLA_CANDIDATES_PER_LINE    = 200;  // SQL pre-filter LIMIT per Line
const UMBRELLA_ATTACH_CAP_PER_LINE    = 50;   // max new articles attached per Line per run
// Article-umbrella uses a LOWER threshold than thread→line attachment
// (6.0). Threads carry multiple articles' worth of context so they need
// a stricter match; single articles are lighter signal and a Line worth
// keeping alive should have wider semantic overlap with its constituents.
// Lower floor = "the article is plausibly a followup coverage piece";
// multi-thread quality gate still protects Line quality long-term.
// 4.0 blocks "1 nation + 1 keyword" minimum matches (which often align on
// the publisher country rather than the subject) while keeping legit
// followup coverage. Hits require either:
//   (a) 1 nation + ≥2 keywords         = 4.5+
//   (b) 2 nations                      = 5.0
//   (c) ≥4 keywords                    = 4.0
//   (d) any combination w/ entity hits  (entity weight is 2.5 each)
const UMBRELLA_ATTACH_THRESHOLD       = 4.0;
// Dormant Lines now ALSO participate. Previously dormant was thread-only
// for reawakening, but the bar (REAWAKEN_THRESHOLD=9.0) was so strict
// almost nothing could come back. Letting umbrella articles also touch
// dormant Lines means a story that picks up coverage again organically
// gets restored to active without waiting for a new thread to graduate
// with near-perfect overlap. Both cooling and dormant flip to active
// when umbrella articles attach (transition handled in runArticleUmbrellaPhase
// below). The article-attach threshold (4.0) plus mandatory entity/nation
// signal keeps low-quality reactivations out.

// ─── Line quality gate (runs every build — first run = one-time sweep) ────────
// A Line is KEPT if it clears either rule:
//   Multi-thread rule:  threads >= 2  AND  span >= 14d  AND  weeks60 >= 3
//   Single-thread carve-out:
//                       threads >= 1  AND  articles >= 50
//                       AND  weeks60 >= 4  AND  span >= 14d
// Anything else (including 0-thread orphans) is DELETED.
// On delete:
//   • story_threads.timeline_id is set to NULL (threads survive, get detached)
//   • story_timeline_articles and story_timeline_events CASCADE away
// The gate protects very fresh Lines from the sweep — a new Line needs at
// least GATE_GRACE_HOURS of wall-clock age before it can be deleted. That
// way a Line that promotes from a thread at t=0 has time to accumulate
// span / weeks / sibling threads before being judged.
const GATE_MIN_THREADS_MULTI   = 2;
const GATE_MIN_SPAN_DAYS       = 14;
const GATE_MIN_WEEKS_MULTI     = 3;
// Single-thread carveout eased so legit big-story single-thread Lines
// can survive without waiting weeks. Was: 50 articles + 4 active weeks.
// New: 25 articles + 2 active weeks. A breaking-story Line with 25+
// articles in 2 active weeks is signal enough to keep alive while it
// grows companion threads. Tighten back if low-quality singles slip in.
const GATE_CARVEOUT_MIN_ART    = 25;
const GATE_CARVEOUT_MIN_WEEKS  = 2;
// Grace 72h → 336h (14d). Reason: a thread that graduates and creates a
// fresh single-thread Line previously had only 3 days to either grow to
// 50 articles or get a sibling thread. Most legit big-story Lines need
// longer than that. 14d also gives the carve-out's 2-active-weeks rule
// time to actually accumulate. After grace, the (now-eased) carveout
// keeps single-thread Lines alive at lower thresholds.
const GATE_GRACE_HOURS         = 336;

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
    candidateThreads:              0,
    attachedThreads:               0,
    newTimelines:                  0,
    reawakened:                    0,
    dormantRescanReactivated:      0,
    dormantRescanRelinked:         0,
    umbrellaRefreshed:             0,
    umbrellaLinesScanned:          0,
    umbrellaCandidatesScored:      0,
    umbrellaArticlesAttached:      0,
    umbrellaLinesRefreshed:        0,
    umbrellaCoolingRestored:       0,
    threadLivenessBumped:          0,
    threadLivenessReactivated:     0,
    eventExtractionRuns:           0,
    eventsEmitted:                 0,
    claudeCallsPromote:            0,
    claudeCallsEvent:              0,
    claudeCallsTitle:              0,
    linesRetitled:                 0,
    claudeCallsTier:               0,
    threadsReclassified:           0,
    linesReclassified:             0,
    inputTokens:                   0,
    outputTokens:                  0,
  };

  if (!ONLY_EVENTS) {
    await runPromotionPhase(metrics, elapsed);
  }

  // Phase B.5: thread-driven dormant reactivation. Runs AFTER promotion
  // (so threads attached this run are visible) and BEFORE the article
  // umbrella (so any reactivations here are picked up by umbrella's
  // active+cooling+dormant scan with their fresh keywords merged in).
  if (!ONLY_EVENTS && !SKIP_UMBRELLA) {
    console.log(`\n   [${elapsed()}] Phase B.5: dormant rescan via active threads...`);
    await runDormantRescanPhase(metrics, elapsed);
  }

  // Article Umbrella phase runs AFTER promotion (so any newly-graduated
  // Lines this run also receive umbrella articles) but BEFORE cooldown
  // (so freshly-attached articles can flip cooling→active before the
  // cooldown pass runs).
  if (!ONLY_EVENTS && !SKIP_UMBRELLA) {
    console.log(`\n   [${elapsed()}] Phase C: Article umbrella (lookback=${UMBRELLA_LOOKBACK_DAYS}d)...`);
    await runArticleUmbrellaPhase(metrics, elapsed);
  }

  if (!SKIP_EVENTS) {
    await runEventExtractionPhase(metrics, elapsed);
  }

  // Thread liveness propagation — runs BEFORE cooldown so timelines
  // inherit any "my child thread is alive" signal that the umbrella
  // phase couldn't capture (timeouts on big lines, connection-exhausted
  // errors, articles below umbrella threshold). Without this step, a
  // timeline whose child threads are getting fresh articles daily but
  // whose umbrella phase happens to time out drifts to cooling after
  // 7 days and dormant after 67 — exactly the user-reported "my Line
  // shows dormant despite the underlying threads being active." Honors
  // the product invariant ("the line records the series of events"):
  // if any event (thread update) is happening, the line is alive.
  console.log(`\n   [${elapsed()}] Thread liveness propagation...`);
  const propagated = await runThreadLivenessPropagation();
  console.log(`   bumped=${propagated.bumped} reactivated=${propagated.reactivated}`);
  metrics.threadLivenessBumped      = propagated.bumped;
  metrics.threadLivenessReactivated = propagated.reactivated;

  console.log(`\n   [${elapsed()}] Cooldown pass...`);
  const cooled = await runCooldownPhase();
  console.log(`   cooled=${cooled.cooled} dormant=${cooled.dormant}`);

  let gateResult = { evaluated: 0, kept: 0, deleted: 0, detachedThreads: 0, dryRun: true };
  if (!SKIP_GATE) {
    console.log(`\n   [${elapsed()}] Line quality gate${DRY_RUN_GATE ? ' (DRY RUN)' : ''}...`);
    gateResult = await runLineQualityGatePhase({ dryRun: DRY_RUN_GATE });
    console.log(
      `   evaluated=${gateResult.evaluated} kept=${gateResult.kept} ` +
      `deleted=${gateResult.deleted} detached_threads=${gateResult.detachedThreads}`
    );
  }

  // One-shot retitle pass. Only runs when explicitly requested via flag so
  // normal scheduled builds don't spend Claude tokens rewriting titles of
  // Lines that were already renamed.
  if (RETITLE_ALL) {
    console.log(`\n   [${elapsed()}] Retitling existing Lines (one-shot pass)...`);
    await runRetitleExistingLinesPhase(metrics);
    console.log(`   ${metrics.linesRetitled} Line(s) retitled`);
  }

  // One-shot actor-tier reclassify pass. Sweeps every existing thread +
  // line, splitting primary_nations into a narrowed primary tier +
  // secondary tier. Safe to re-run. Respects --dry-run-reclassify for a
  // preview-only pass.
  if (RECLASSIFY_ACTORS) {
    console.log(`\n   [${elapsed()}] Actor tier reclassify${DRY_RUN_RECLASSIFY ? ' (DRY RUN)' : ''}...`);
    await runReclassifyActorsPhase(metrics, { dryRun: DRY_RUN_RECLASSIFY });
  }

  // ── End-of-run summary ───────────────────────────────────────────────────
  console.log(`\n═══ TIMELINE RUN SUMMARY (${elapsed()}) ═══`);
  console.log(`  candidate_threads       : ${metrics.candidateThreads}`);
  console.log(`  attached_to_existing    : ${metrics.attachedThreads}`);
  console.log(`  new_timelines_created   : ${metrics.newTimelines}`);
  console.log(`  dormant_reawakened      : ${metrics.reawakened}`);
  console.log(`  dormant_rescan_reactiv. : ${metrics.dormantRescanReactivated}`);
  console.log(`  dormant_rescan_relinked : ${metrics.dormantRescanRelinked}`);
  console.log(`  umbrella_keywords_refrh : ${metrics.umbrellaRefreshed}`);
  console.log(`  umbrella_lines_scanned  : ${metrics.umbrellaLinesScanned}`);
  console.log(`  umbrella_cands_scored   : ${metrics.umbrellaCandidatesScored}`);
  console.log(`  umbrella_articles_added : ${metrics.umbrellaArticlesAttached}`);
  console.log(`  umbrella_lines_refresh  : ${metrics.umbrellaLinesRefreshed}`);
  console.log(`  umbrella_cool_restored  : ${metrics.umbrellaCoolingRestored}`);
  console.log(`  thread_liveness_bumped  : ${metrics.threadLivenessBumped}`);
  console.log(`  thread_liveness_reactiv : ${metrics.threadLivenessReactivated}`);
  console.log(`  timelines_cooled        : ${cooled.cooled}`);
  console.log(`  timelines_dormant       : ${cooled.dormant}`);
  console.log(`  event_extractions_run   : ${metrics.eventExtractionRuns}`);
  console.log(`  events_emitted          : ${metrics.eventsEmitted}`);
  console.log(`  claude_calls (promote)  : ${metrics.claudeCallsPromote}`);
  console.log(`  claude_calls (events)   : ${metrics.claudeCallsEvent}`);
  console.log(`  claude_calls (titles)   : ${metrics.claudeCallsTitle || 0}`);
  console.log(`  lines_retitled          : ${metrics.linesRetitled || 0}`);
  console.log(`  claude_calls (tiers)    : ${metrics.claudeCallsTier || 0}`);
  console.log(`  threads_reclassified    : ${metrics.threadsReclassified || 0}`);
  console.log(`  lines_reclassified      : ${metrics.linesReclassified || 0}`);
  console.log(`  claude_tokens           : in=${metrics.inputTokens}  out=${metrics.outputTokens}`);
  if (!SKIP_GATE) {
    console.log(`  quality_gate_evaluated  : ${gateResult.evaluated}`);
    console.log(`  quality_gate_kept       : ${gateResult.kept}`);
    console.log(`  quality_gate_deleted    : ${gateResult.deleted}${gateResult.dryRun ? ' (dry-run)' : ''}`);
    console.log(`  quality_gate_detached   : ${gateResult.detachedThreads} threads`);
  }
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
        const timelineId = await createTimelineFromThread(cand, metrics);
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

// ─────────────────────────────────────────────────────────────────────────────
//  Wikipedia-style title rewriter
//
//  Threads inherit newsroom-toned titles from headlines, which bleed into
//  Line names when a thread graduates ("Prosecutors Seek 24-Year Sentence
//  for Sánchez's Wife"). Lines are umbrella identifiers for ongoing stories
//  and read best as encyclopedia entries ("Begoña Gómez corruption case"),
//  not breaking-news ledes.
//
//  Returns { title, _usage, _claudeCalls }. On any failure or sanity-check
//  miss, returns the original title so the builder never crashes on a
//  title rewrite.
// ─────────────────────────────────────────────────────────────────────────────
async function generateWikipediaStyleTitle(subject) {
  const originalTitle = String(subject.title || '').trim();
  if (!originalTitle) return { title: originalTitle, _claudeCalls: 0 };

  const keywords = Array.isArray(subject.keywords) ? subject.keywords.slice(0, 8).join(', ') : '';
  const nations  = Array.isArray(subject.primary_nations) ? subject.primary_nations.join(', ') : '';
  const category = subject.primary_category || '';
  const desc     = String(subject.description || '').slice(0, 400);

  const prompt =
`Rewrite this news thread title as a Wikipedia article title for a long-running story/Line entry.

THREAD:
  title: ${originalTitle}
  description: ${desc}
  keywords: ${keywords}
  primary_nations: ${nations}
  category: ${category}

Rules:
- Style: Wikipedia article title — clear, concise, factually neutral, no editorializing.
- Lead with the entity/subject, not the action. Prefer noun phrases over sentences.
- Use full proper names on first mention ("Pedro Sánchez", not "Sánchez"; "Keir Starmer", not "Starmer").
- Strip editorial verbs: "Seek", "Face", "Threaten", "Weigh", "Block", "Slam", "Vow", "Warn".
- Strip hype words: "Crisis" only if the story genuinely is a recognized crisis; otherwise drop it.
- 3–8 words when possible. Never use colons or em-dashes. Never a full sentence.
- No dates unless essential to identity ("2026 Mexican elections" OK; "Iran war 2025" OK; "Starmer Faces Pressure Over Parliamentary Misleading Claims in 2026" NO).
- If the story is about one person's legal trouble, title it "<Full Name> <legal-matter>" ("Begoña Gómez corruption case").
- If it's about a country's ongoing political saga, "<Country> <event>" ("Italy Meloni government crisis").
- Write it in English regardless of source language.

Examples:
- "Prosecutors Seek 24-Year Sentence for Sánchez's Wife" → "Begoña Gómez corruption case"
- "Mexico Farm Crisis Threatens 2026 World Cup" → "2026 Mexican agricultural crisis"
- "Starmer Faces Pressure Over Parliamentary Misleading Claims" → "Keir Starmer parliamentary misleading allegations"
- "Germany Weighs Kerosene Crisis Against Gulf Deployment" → "Germany kerosene shortage 2026"
- "Iran-US-Israel War 2025" → "Iran-US-Israel war" (already fine, drop the year if no ambiguity)

Return ONLY this JSON, no prose, no markdown:
{"title": "..."}`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 120,
      messages:   [{ role: 'user', content: prompt }]
    });
    const raw = response.content?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) return { title: originalTitle, _claudeCalls: 1, _usage: response.usage };
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { return { title: originalTitle, _claudeCalls: 1, _usage: response.usage }; }
    const t = String(parsed.title || '').trim();
    // Sanity checks: non-empty, not absurd length, no trailing punctuation
    // that betrays a sentence, no markdown leftovers.
    if (!t || t.length < 3 || t.length > 120) return { title: originalTitle, _claudeCalls: 1, _usage: response.usage };
    if (/[\.!\?]$/.test(t)) return { title: originalTitle, _claudeCalls: 1, _usage: response.usage };
    if (/^["']|["']$/.test(t)) {
      // Strip surrounding quotes Claude sometimes adds
      const stripped = t.replace(/^["']|["']$/g, '').trim();
      if (stripped.length >= 3) return { title: stripped, _claudeCalls: 1, _usage: response.usage };
    }
    return { title: t, _claudeCalls: 1, _usage: response.usage };
  } catch (err) {
    console.warn(`   ⚠ title rewrite failed for "${originalTitle.slice(0,50)}": ${err.message}`);
    return { title: originalTitle, _claudeCalls: 0 };
  }
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

    // Re-classify the timeline's tiers now that a new thread's nations
    // have been merged into its primary_nations (line 781's UNION adds
    // thread.primary_nations to timeline.primary_nations). Runs outside
    // the transaction so a classification failure can't roll back the
    // attach itself.
    try {
      await classifyAndTierTimeline(pool, timelineId);
    } catch (err) {
      console.warn(`   ⚠ tier reclassify failed after attach to Line ${timelineId}: ${err.message}`);
    }
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

async function createTimelineFromThread(thread, metrics = null) {
  // Rewrite the thread's breaking-news title into a Wikipedia-style Line
  // name before persisting. On any failure the original title is used —
  // we never block promotion on the rewrite.
  const rewrite = await generateWikipediaStyleTitle(thread);
  const lineTitle = rewrite.title || thread.title;
  if (metrics) {
    metrics.claudeCallsTitle = (metrics.claudeCallsTitle || 0) + (rewrite._claudeCalls || 0);
    if (rewrite._usage) {
      metrics.inputTokens  += rewrite._usage.input_tokens        || 0;
      metrics.inputTokens  += rewrite._usage.cache_read_input_tokens || 0;
      metrics.inputTokens  += rewrite._usage.cache_creation_input_tokens || 0;
      metrics.outputTokens += rewrite._usage.output_tokens       || 0;
    }
  }
  if (lineTitle !== thread.title) {
    console.log(`   ✎ retitled for Line: "${thread.title.slice(0,60)}" → "${lineTitle.slice(0,60)}"`);
  }

  // Slug derived from the REWRITTEN title so scope matches the final name.
  const scope = slugifyScope(lineTitle);
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
      lineTitle,
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

    // Tier classification — splits primary_nations into narrowed primary
    // + new secondary tier. Runs AFTER commit (non-transactional) so a
    // failure here never blocks timeline creation. Reads the constituent
    // thread's primary + secondary nations to build candidates.
    try {
      const tiers = await classifyAndTierTimeline(pool, timelineId);
      if (metrics && tiers && !tiers.skipped) {
        metrics.claudeCallsTitle = (metrics.claudeCallsTitle || 0) + (tiers._claudeCalls || 0);
        if (tiers._usage) {
          metrics.inputTokens  += tiers._usage.input_tokens        || 0;
          metrics.inputTokens  += tiers._usage.cache_read_input_tokens || 0;
          metrics.inputTokens  += tiers._usage.cache_creation_input_tokens || 0;
          metrics.outputTokens += tiers._usage.output_tokens       || 0;
        }
      }
    } catch (err) {
      console.warn(`   ⚠ tier classification failed for new Line ${timelineId}: ${err.message}`);
    }

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
  // Wrapped in try/catch because if the umbrella phase exhausted DB
  // connections (53300), this initial query would otherwise FATAL out
  // and exit the whole cron with status 1 — better to log and skip
  // the phase, letting the next run pick it up when the cluster has
  // headroom.
  let dirtyTimelines;
  try {
    const r = await pool.query(`
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
    dirtyTimelines = r.rows;
  } catch (err) {
    if (_isConnectionExhausted(err)) {
      console.warn(`   ⚠ event-extraction phase skipped — DB cluster saturated (${err.code || 'conn'}). Next run will pick up.`);
      return;
    }
    throw err;
  }
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
//  PHASE B.5 : THREAD-DRIVEN DORMANT REACTIVATION
//
//  Catches dormant Lines that have currently-active thread coverage but
//  where individual articles fall below UMBRELLA_ATTACH_THRESHOLD. Threads
//  carry aggregated keywords/nations from many articles, so a thread-level
//  match is a stronger signal than any one article. This is the "if there
//  is an active thread on the same topic, wake the Line up" path.
//
//  Distinct from Phase B (promotion attach):
//    - Phase B fires only on NEWLY graduated threads
//    - Phase B.5 rescans ALL currently-active threads against dormant Lines
//      every run, so a thread that became hot AFTER its parent Line cooled
//      will still reactivate it
//
//  Threads WITHOUT a timeline_id get linked. Threads already linked stay
//  linked (don't break existing relationships) but can still trigger
//  reactivation of OTHER dormant lines they overlap.
// ═════════════════════════════════════════════════════════════════════════════
async function runDormantRescanPhase(metrics, elapsed) {
  const { rows: threads } = await pool.query(`
    SELECT id, title, keywords, primary_nations, importance, timeline_id
    FROM story_threads
    WHERE status = 'active'
      AND last_updated_at > NOW() - INTERVAL '14 days'
    ORDER BY last_updated_at DESC
    LIMIT 500
  `);
  if (!threads.length) {
    console.log(`   [${elapsed()}] no active threads to rescan`);
    return;
  }

  const { rows: dormantLines } = await pool.query(`
    SELECT id, title, status, importance, keywords, primary_nations,
           primary_category, geographic_scope, first_seen_at, last_updated_at
    FROM story_timelines
    WHERE status = 'dormant'
    ORDER BY last_updated_at DESC
    LIMIT 500
  `);
  if (!dormantLines.length) {
    console.log(`   [${elapsed()}] no dormant lines to rescan`);
    return;
  }

  console.log(`   [${elapsed()}] scanning ${threads.length} active thread(s) against ${dormantLines.length} dormant Line(s)...`);

  // Reuse the existing per-line feature builder (entities pulled from the
  // top-N attached articles' deep-context).
  const dormantFeatures = await buildTimelineFeatures(dormantLines);

  // Track which dormant lines we've already reactivated this run so a
  // burst of similar threads doesn't double-update the same line.
  const reactivatedIds = new Set();
  let reactivated = 0;
  let relinked = 0;

  for (const thread of threads) {
    try {
      const candNations  = new Set((thread.primary_nations || []).map(n => String(n).toUpperCase()));
      const candKeywords = new Set((thread.keywords || []).map(normalizeKeyword).filter(Boolean));
      const candTitleTokens = tokenizeTitle(thread.title);
      // Skip the entity-load (loadContextForArticles) for rescan — it's
      // the heavy DB op per thread, and keyword+nation+title overlap is
      // enough signal to clear ATTACH_THRESHOLD on a real match. Phase B
      // pays for entities because it's the FIRST attach decision; rescan
      // is opportunistic catch-up.

      let bestScore = 0;
      let bestLine  = null;
      for (const line of dormantLines) {
        if (reactivatedIds.has(line.id)) continue;
        const feat = dormantFeatures.get(line.id);
        if (!feat) continue;

        const natShared  = intersectCount(candNations,  feat.nations);
        const kwShared   = Math.min(KEYWORD_CAP, intersectCount(candKeywords,  feat.keywords));
        const ttkShared  = intersectCount(candTitleTokens, feat.titleTokens);
        // Entities skipped — see comment above.
        const score = natShared * W_NATION_OVERLAP
                    + kwShared  * W_KEYWORD_OVERLAP
                    + ttkShared * W_TITLE_TOKEN;

        if (score > bestScore) {
          bestScore = score;
          bestLine  = line;
        }
      }

      if (bestLine && bestScore >= ATTACH_THRESHOLD) {
        const shouldRelink = !thread.timeline_id;
        await reactivateDormantFromThread(thread, bestLine.id, shouldRelink);
        reactivatedIds.add(bestLine.id);
        reactivated++;
        if (shouldRelink) relinked++;
        console.log(`   ↳ REACTIVATED dormant Line "${(bestLine.title||'').slice(0,50)}" via thread "${(thread.title||'').slice(0,50)}" (score=${bestScore.toFixed(1)}${shouldRelink ? ', relinked' : ''})`);
      }
    } catch (err) {
      console.warn(`   ⚠ rescan failed for thread ${thread.id}: ${err.message}`);
    }
  }

  metrics.dormantRescanReactivated = reactivated;
  metrics.dormantRescanRelinked    = relinked;
  console.log(`   [${elapsed()}] dormant rescan: ${reactivated} Line(s) reactivated, ${relinked} thread(s) re-linked`);
}

async function reactivateDormantFromThread(thread, lineId, shouldRelink) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');

    if (shouldRelink) {
      await tx.query(`UPDATE story_threads SET timeline_id = $1 WHERE id = $2`, [lineId, thread.id]);
      // Copy thread's articles into the timeline so the Line's article
      // count reflects this fresh evidence.
      await tx.query(`
        INSERT INTO story_timeline_articles (timeline_id, article_id, relevance_score, parabolic_weight, is_anchor, added_at)
        SELECT $1, sta.article_id, sta.relevance_score, 1.0, sta.is_anchor, NOW()
        FROM story_thread_articles sta
        WHERE sta.thread_id = $2
        ON CONFLICT (timeline_id, article_id) DO NOTHING
      `, [lineId, thread.id]);
    }

    // Flip dormant → active, set last_reawakened_at, and merge the
    // thread's keywords + nations into the Line's umbrella so future
    // umbrella scans pick up related articles using the fresh terms.
    await tx.query(`
      UPDATE story_timelines
         SET status             = 'active',
             last_updated_at    = NOW(),
             last_reawakened_at = NOW(),
             importance         = GREATEST(importance, $2),
             keywords           = ARRAY(SELECT DISTINCT unnest(keywords || $3::text[])),
             primary_nations    = ARRAY(SELECT DISTINCT unnest(primary_nations || $4::text[])),
             article_count      = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1)
       WHERE id = $1
    `, [lineId, thread.importance || 5, thread.keywords || [], thread.primary_nations || []]);

    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PHASE C.5 : THREAD LIVENESS PROPAGATION
//
//  Bumps timeline.last_updated_at to MAX(its own, max(linked threads'
//  last_updated_at)) so a timeline reflects its child threads' freshness
//  even when the umbrella phase couldn't reach it (timeouts, connection
//  exhaustion, no articles cleared umbrella threshold). Also pulls
//  cooling/dormant timelines back to active when their threads have
//  been alive within the last COOLING_AFTER_DAYS window — a thread
//  with last_updated within 7 days = the line should be active.
//
//  Idempotent: only writes when the new max thread timestamp is
//  strictly greater than the timeline's current last_updated_at, so
//  steady-state runs do nothing.
// ═════════════════════════════════════════════════════════════════════════════
async function runThreadLivenessPropagation() {
  // Pull the freshest linked-thread last_updated_at per timeline, but
  // ONLY bump rows where it would actually move the needle. The
  // RETURNING clause hands us the affected rows so we can also flip
  // status when the new freshness puts the line back inside the active
  // window. Manual lines are excluded — their freshness is curator-driven.
  const { rows: bumped } = await pool.query(`
    WITH thread_max AS (
      SELECT timeline_id, MAX(last_updated_at) AS max_thread_updated
        FROM story_threads
       WHERE timeline_id IS NOT NULL
       GROUP BY timeline_id
    )
    UPDATE story_timelines tl
       SET last_updated_at = tm.max_thread_updated
      FROM thread_max tm
     WHERE tl.id = tm.timeline_id
       AND COALESCE(tl.is_manual, FALSE) = FALSE
       AND tm.max_thread_updated > tl.last_updated_at
   RETURNING tl.id, tl.status, tl.last_updated_at
  `);

  // Reactivate cooling/dormant lines whose freshly-bumped timestamp
  // puts them back inside the active window. We use the same threshold
  // as the cooldown phase (active means last_updated_at within
  // COOLING_AFTER_DAYS) so the two passes never disagree about what
  // "active" means.
  let reactivated = 0;
  if (bumped.length) {
    const reactivatableIds = bumped
      .filter(r => r.status === 'cooling' || r.status === 'dormant')
      .map(r => r.id);
    if (reactivatableIds.length) {
      const { rowCount } = await pool.query(`
        UPDATE story_timelines
           SET status             = 'active',
               last_reawakened_at = NOW()
         WHERE id = ANY($1::int[])
           AND last_updated_at > NOW() - ($2 * INTERVAL '1 day')
      `, [reactivatableIds, COOLING_AFTER_DAYS]);
      reactivated = rowCount || 0;
    }
  }

  return { bumped: bumped.length, reactivated };
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

// ═════════════════════════════════════════════════════════════════════════════
//  PHASE C : ARTICLE UMBRELLA
//
//  Beyond thread promotions, recent articles that match a Line's umbrella
//  (entities / nations / keywords / title tokens) flow into the Line and
//  keep it alive. The same ATTACH_THRESHOLD we use for thread→timeline is
//  reused — if an article would be considered a chapter of this Line's
//  story, attach it. Cooling Lines that receive fresh articles flip back
//  to 'active'. Dormant Lines are intentionally skipped (per product
//  decision: dormant stays thread-only for reawakening).
// ═════════════════════════════════════════════════════════════════════════════
// Heuristic: is this an error from the DB SERVER hitting max_connections
// (53300) or our pool failing to connect at all? These mean OTHER
// processes have saturated the cluster — there's nothing we can do
// about it from inside this cron, so we bail the current phase
// gracefully instead of hammering 30+ more queries that will all
// fail the same way.
function _isConnectionExhausted(err) {
  if (!err) return false;
  if (err.code === '53300' || err.code === '53400') return true;
  const m = String(err.message || '').toLowerCase();
  return m.includes('remaining connection slots') ||
         m.includes('too many clients') ||
         m.includes('connection terminated') ||
         m.includes('connect econnrefused');
}

// Refresh each Line's umbrella keywords/nations from its most recent
// attached articles. As a story evolves over months, new actors and
// terminology appear in coverage that the Line's STORED keyword set
// (set when the Line was created) doesn't include. Without this refresh,
// dormant or cooling Lines accumulate stale umbrella features and
// stop matching current articles even when coverage is alive.
//
// Strategy: pull the top frequent normalized keywords from the most
// recent N=20 attached articles and UNION them into story_timelines.
// keywords. Keeps the union (doesn't replace) so old terms still work
// for articles re-litigating earlier chapters of the story.
async function refreshLineUmbrellas(lines) {
  if (!lines.length) return 0;
  const lineIds = lines.map(l => l.id);
  const { rows: kwRows } = await pool.query(`
    WITH recent_articles AS (
      SELECT timeline_id, article_id,
             ROW_NUMBER() OVER (PARTITION BY timeline_id ORDER BY added_at DESC) AS rn
      FROM story_timeline_articles
      WHERE timeline_id = ANY($1::int[])
    )
    SELECT ra.timeline_id, ak.normalized_keyword AS kw
    FROM recent_articles ra
    JOIN article_keywords ak ON ak.article_id = ra.article_id
    WHERE ra.rn <= 20
      AND ak.normalized_keyword IS NOT NULL
      AND length(ak.normalized_keyword) >= 3
    GROUP BY ra.timeline_id, ak.normalized_keyword
    HAVING COUNT(*) >= 3
  `, [lineIds]);

  const byTimeline = new Map();
  for (const r of kwRows) {
    if (!byTimeline.has(r.timeline_id)) byTimeline.set(r.timeline_id, []);
    byTimeline.get(r.timeline_id).push(r.kw);
  }

  let refreshed = 0;
  for (const [timelineId, kws] of byTimeline) {
    if (!kws.length) continue;
    try {
      await pool.query(`
        UPDATE story_timelines
           SET keywords = ARRAY(SELECT DISTINCT unnest(keywords || $2::text[]))
         WHERE id = $1
      `, [timelineId, kws]);
      refreshed++;
    } catch (err) {
      console.warn(`   ⚠ umbrella refresh failed for Line ${timelineId}: ${err.message}`);
    }
  }
  return refreshed;
}

async function runArticleUmbrellaPhase(metrics, elapsed) {
  // 1. Load active + cooling + dormant Lines.
  // Dormant added here in tandem with the constants comment above —
  // letting umbrella articles wake dormant Lines is the dominant path
  // for reactivation now that REAWAKEN_THRESHOLD=7 is still rare to clear
  // on a thread-promotion alone. Status order ensures active+cooling are
  // processed first when DB throttling kicks in.
  const { rows: lines } = await pool.query(`
    SELECT id, title, status, importance, keywords, primary_nations,
           primary_category, geographic_scope, first_seen_at, last_updated_at
    FROM story_timelines
    WHERE status IN ('active', 'cooling', 'dormant')
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'cooling' THEN 1 ELSE 2 END,
             last_updated_at DESC
  `);
  metrics.umbrellaLinesScanned = lines.length;
  if (!lines.length) {
    console.log(`   [${elapsed()}] no active/cooling Lines to scan`);
    return;
  }
  console.log(`   [${elapsed()}] ${lines.length} Line(s) to scan for umbrella articles`);

  // Refresh umbrella keywords from each Line's recent articles BEFORE
  // building features, so the per-line feature set used for scoring
  // includes the freshest terminology. Re-fetch lines to pick up the
  // freshly-merged keywords into the in-memory rows.
  const refreshedCount = await refreshLineUmbrellas(lines);
  if (refreshedCount > 0) {
    console.log(`   [${elapsed()}] umbrella refresh: ${refreshedCount} Line(s) merged in fresh keywords`);
    const { rows: refreshed } = await pool.query(`
      SELECT id, keywords, primary_nations
      FROM story_timelines
      WHERE id = ANY($1::int[])
    `, [lines.map(l => l.id)]);
    const byId = new Map(refreshed.map(r => [r.id, r]));
    for (const l of lines) {
      const r = byId.get(l.id);
      if (r) {
        l.keywords = r.keywords;
        l.primary_nations = r.primary_nations;
      }
    }
  }
  metrics.umbrellaRefreshed = refreshedCount;

  // 2. Build umbrella features for every Line (entities from top-N historical
  //    articles + nations + keywords + title tokens)
  const featureMap = await buildTimelineFeatures(lines);

  // Track consecutive connection-exhaustion errors so we can bail the
  // phase early when the DB cluster is saturated by other processes.
  // A single timeout is fine; 3 in a row means the cluster is genuinely
  // out of slots and we should release ours rather than fight for them.
  let _consecutiveConnErrs = 0;
  const _CONN_ERR_BAIL_THRESHOLD = 3;

  // Dedicated client with extended statement_timeout for the candidate
  // scan. The default pool timeout (45s, db.js:40) was killing the
  // UNION pre-filter query for the largest Lines (Ukraine-Russia,
  // Israel-Lebanon, Climate, BRICS, Iran-US-Israel) whose nation +
  // keyword umbrellas span thousands of articles in the 7-day window.
  // Once umbrella fails, last_updated_at never bumps and the cooldown
  // pass falsely flips the Line to cooling. Background cron, no user
  // waiting, so 5 min is fine here. Same pattern as keywordCron.js:101.
  let _umbClient = null;
  try {
    _umbClient = await pool.connect();
    await _umbClient.query('SET statement_timeout = 300000');
  } catch (acqErr) {
    if (_umbClient) { try { _umbClient.release(); } catch (_) {} _umbClient = null; }
    console.warn(`   ⚠ umbrella phase: could not acquire dedicated client (${acqErr.message}) — skipping`);
    return;
  }

  try {
  // 3. For each Line, pre-filter candidate articles via SQL (by nation OR
  //    keyword overlap), then score + attach the ones that clear threshold.
  for (const tl of lines) {
    if (_consecutiveConnErrs >= _CONN_ERR_BAIL_THRESHOLD) {
      console.warn(`   ⚠ umbrella phase bailing early — ${_consecutiveConnErrs} consecutive connection-exhausted errors. ` +
                   `DB cluster is full; remaining ${lines.length - lines.indexOf(tl)} Line(s) skipped this run.`);
      break;
    }
    try {
      const feat = featureMap.get(tl.id);
      if (!feat) continue;

      const nations  = Array.from(feat.nations);                  // ISO uppercase
      const keywords = Array.from(feat.keywords);                 // normalized

      // Skip Lines with no signal at all — nothing to match against.
      if (!nations.length && !keywords.length) continue;

      // Pre-filter as a UNION of two independently-indexed branches so
      // Postgres can use the right index per branch instead of forcing a
      // seq scan on the 700k+ article pool:
      //   Branch A: articles whose country iso ∈ this Line's nations
      //             (uses idx_articles_country_published)
      //   Branch B: articles whose normalized keyword ∈ this Line's keywords
      //             (uses idx_ak_normalized, then joins to news_articles)
      // Both branches already filter to the 7-day window and exclude
      // articles already attached to this Line.
      //
      // iso_code is stored uppercase in the countries table so no cast.
      // nations[] is guaranteed non-empty going into branch A because we
      // skip the whole Line if nations+keywords are both empty above.
      // Always emit both branches — empty arrays short-circuit via the
      // cardinality() guard so Postgres never scans when that branch has
      // no keys, but the $2/$3 type annotations stay valid either way.
      const { rows: candidates } = await _umbClient.query(`
        SELECT DISTINCT ON (id) id, title, published_at, iso_code
        FROM (
          SELECT a.id, a.title, a.published_at, co.iso_code
          FROM news_articles a
          JOIN countries co ON co.id = a.country_id
          WHERE cardinality($2::text[]) > 0
            AND a.published_at >= NOW() - INTERVAL '${UMBRELLA_LOOKBACK_DAYS} days'
            AND co.iso_code = ANY($2::text[])
            AND NOT EXISTS (
              SELECT 1 FROM story_timeline_articles sta
               WHERE sta.timeline_id = $1 AND sta.article_id = a.id
            )
          UNION
          SELECT a.id, a.title, a.published_at, co.iso_code
          FROM article_keywords ak
          JOIN news_articles a ON a.id = ak.article_id
          LEFT JOIN countries co ON co.id = a.country_id
          WHERE cardinality($3::text[]) > 0
            AND ak.normalized_keyword = ANY($3::text[])
            AND a.published_at >= NOW() - INTERVAL '${UMBRELLA_LOOKBACK_DAYS} days'
            AND NOT EXISTS (
              SELECT 1 FROM story_timeline_articles sta
               WHERE sta.timeline_id = $1 AND sta.article_id = a.id
            )
        ) u
        ORDER BY id, published_at DESC
        LIMIT $4
      `, [tl.id, nations, keywords, UMBRELLA_CANDIDATES_PER_LINE]);

      if (!candidates.length) continue;
      metrics.umbrellaCandidatesScored += candidates.length;

      // 4. Batch-load deep-context entities for all candidates in this Line
      //    (single call per Line, shared across all candidates).
      const candIds = candidates.map(c => Number(c.id));
      const ctxMap = await loadContextForArticles(candIds);

      // 5. Batch-load article_keywords for these candidates
      const { rows: akRows } = await _umbClient.query(`
        SELECT article_id, COALESCE(normalized_keyword, LOWER(keyword)) AS kw
        FROM article_keywords
        WHERE article_id = ANY($1::int[])
      `, [candIds]);
      const kwByArticle = new Map();
      for (const r of akRows) {
        if (!kwByArticle.has(r.article_id)) kwByArticle.set(r.article_id, new Set());
        kwByArticle.get(r.article_id).add(r.kw);
      }

      // 6. Score each candidate against this Line's umbrella
      const scored = [];
      for (const c of candidates) {
        const ctx = ctxMap.get(Number(c.id));
        const artEntities = new Set();
        if (ctx) {
          for (const e of (ctx.entities || [])) {
            if (e?.text) artEntities.add(String(e.text).toLowerCase().trim());
          }
        }
        const artNations   = new Set(c.iso_code ? [String(c.iso_code).toUpperCase()] : []);
        const artKeywords  = kwByArticle.get(Number(c.id)) || new Set();
        const artTitleTok  = tokenizeTitle(c.title);

        const entShared = Math.min(ENTITY_CAP,  intersectCount(artEntities,  feat.entities));
        const natShared = intersectCount(artNations,  feat.nations);
        const kwShared  = Math.min(KEYWORD_CAP, intersectCount(artKeywords,  feat.keywords));
        const ttkShared = intersectCount(artTitleTok, feat.titleTokens);

        const score =
          entShared  * W_ENTITY_OVERLAP +
          natShared  * W_NATION_OVERLAP +
          kwShared   * W_KEYWORD_OVERLAP +
          ttkShared  * W_TITLE_TOKEN;

        if (score >= UMBRELLA_ATTACH_THRESHOLD) {
          scored.push({ articleId: Number(c.id), score });
        }
      }

      if (!scored.length) continue;

      // 7. Cap per-Line and attach
      scored.sort((a, b) => b.score - a.score);
      const toAttach = scored.slice(0, UMBRELLA_ATTACH_CAP_PER_LINE);
      const wasCooling = (tl.status === 'cooling');
      const wasDormant = (tl.status === 'dormant');

      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');

        // Bulk insert via unnest(). relevance_score carries the umbrella
        // score; parabolic_weight stays 1.0 (density ruler re-weights at
        // render time). is_anchor=false — these are followup coverage,
        // not the anchor article(s) that seeded the Line.
        const ids   = toAttach.map(a => a.articleId);
        const rels  = toAttach.map(a => a.score);
        await tx.query(`
          INSERT INTO story_timeline_articles (timeline_id, article_id, relevance_score, parabolic_weight, is_anchor, added_at)
          SELECT $1, unnest($2::int[]), unnest($3::float8[]), 1.0, false, NOW()
          ON CONFLICT (timeline_id, article_id) DO NOTHING
        `, [tl.id, ids, rels]);

        // Bump last_updated_at and recount article_count. Both cooling
        // AND dormant flip to active when umbrella articles attach —
        // dormant inclusion is the dominant reactivation path now (see
        // the constants comment above for rationale). last_reawakened_at
        // is set so we can distinguish "stayed active" from
        // "reactivated this run" downstream.
        await tx.query(`
          UPDATE story_timelines
             SET last_updated_at    = NOW(),
                 last_reawakened_at = CASE WHEN status IN ('cooling','dormant') THEN NOW() ELSE last_reawakened_at END,
                 status             = CASE WHEN status IN ('cooling','dormant') THEN 'active' ELSE status END,
                 article_count      = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1)
           WHERE id = $1
        `, [tl.id]);

        await tx.query('COMMIT');
      } catch (err) {
        await tx.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        tx.release();
      }

      metrics.umbrellaArticlesAttached += toAttach.length;
      metrics.umbrellaLinesRefreshed += 1;
      if (wasCooling) metrics.umbrellaCoolingRestored += 1;
      if (wasDormant) metrics.umbrellaDormantRestored = (metrics.umbrellaDormantRestored || 0) + 1;

      // Successful Line iteration — reset the connection-error counter
      // so a single transient blip earlier doesn't trigger an early
      // bail when the cluster actually recovered.
      _consecutiveConnErrs = 0;

      if (toAttach.length >= 5 || wasCooling || wasDormant) {
        console.log(
          `   ↳ umbrella: +${toAttach.length} articles → "${(tl.title||'').slice(0,55)}"` +
          (wasCooling ? ' [cooling→active]' : wasDormant ? ' [dormant→active]' : '')
        );
      }
    } catch (err) {
      console.warn(`   ⚠ umbrella failed for Line ${tl.id} "${(tl.title||'').slice(0,40)}": ${err.message}`);
      if (_isConnectionExhausted(err)) {
        _consecutiveConnErrs += 1;
        // Brief sleep when the cluster is saturated — give other
        // processes a chance to release before we try the next Line.
        await sleep(500);
      } else {
        // Statement timeouts and other per-query failures don't count
        // against the bail threshold (the connection itself is fine).
        _consecutiveConnErrs = 0;
      }
    }
  }
  } finally {
    try { _umbClient.release(); } catch (_) {}
  }

  console.log(
    `   [${elapsed()}] umbrella done: scored=${metrics.umbrellaCandidatesScored} ` +
    `attached=${metrics.umbrellaArticlesAttached} refreshed=${metrics.umbrellaLinesRefreshed} ` +
    `restored=${metrics.umbrellaCoolingRestored}`
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  PHASE E : LINE QUALITY GATE
//  Idempotent destructive enforcement. Runs every build, so the first run on
//  deploy is the one-time sweep and every subsequent run is ongoing
//  enforcement. Fresh Lines younger than GATE_GRACE_HOURS are skipped.
// ═════════════════════════════════════════════════════════════════════════════
async function runLineQualityGatePhase({ dryRun = false } = {}) {
  // Evaluate every timeline with thread / article metrics. Manual
  // (curator-created) Lines are excluded — they're immune to the gate
  // by design (see migration 20260421_manual_timelines.sql).
  const { rows } = await pool.query(`
    WITH tl AS (
      SELECT id, title, status, first_seen_at, last_updated_at
      FROM story_timelines
      WHERE COALESCE(is_manual, FALSE) = FALSE
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
      tl.id,
      tl.title,
      tl.status,
      tl.first_seen_at,
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

    if (passesMulti || passesCarveout) {
      kept++;
      continue;
    }

    // Grace period protects Lines that have just been promoted and haven't
    // had time to accumulate siblings / span yet. Zero-thread orphans are
    // deleted immediately — grace doesn't apply.
    if (tc >= 1 && ageH < GATE_GRACE_HOURS) {
      kept++;
      continue;
    }

    toDelete.push({
      id: r.id,
      title: r.title,
      threads: tc,
      articles: ac,
      weeks60: aw,
      span: Number(sd.toFixed(1)),
    });
  }

  // Verbose logging — cap to keep per-run output reasonable.
  if (toDelete.length) {
    const preview = toDelete.slice(0, 15);
    preview.forEach(d => {
      console.log(
        `     ${dryRun ? '[DRY]' : '[DEL]'} id=${d.id} t=${d.threads} a=${d.articles} ` +
        `wk60=${d.weeks60} span=${d.span}d  ${String(d.title || '').slice(0, 70)}`
      );
    });
    if (toDelete.length > preview.length) {
      console.log(`     ... + ${toDelete.length - preview.length} more`);
    }
  }

  let detachedThreads = 0;
  if (!dryRun && toDelete.length) {
    const ids = toDelete.map(d => d.id);
    // Count threads that will be detached (for reporting) before the delete
    // cascades / sets null.
    const { rows: [{ n }] } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM story_threads WHERE timeline_id = ANY($1::int[])
    `, [ids]);
    detachedThreads = Number(n || 0);

    await pool.query(`
      DELETE FROM story_timelines WHERE id = ANY($1::int[])
    `, [ids]);
    console.log(`     ✔ deleted ${ids.length} Line(s); ${detachedThreads} thread(s) detached`);
  }

  return {
    evaluated: rows.length,
    kept,
    deleted: toDelete.length,
    detachedThreads,
    dryRun,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  RETITLE EXISTING LINES (opt-in via --retitle-all)
//
//  One-shot sweep: iterate every Line (in any status), rewrite the title
//  via Claude, and persist if the new title differs from the old. This
//  cleans up lines that graduated under the old rename-less pipeline.
//  Runs sequentially with a brief throttle to keep the Claude TPS modest.
// ═════════════════════════════════════════════════════════════════════════════
async function runRetitleExistingLinesPhase(metrics) {
  const { rows: lines } = await pool.query(`
    SELECT id, title, description, primary_category, geographic_scope,
           importance, keywords, primary_nations, status
    FROM story_timelines
    ORDER BY importance DESC NULLS LAST, last_updated_at DESC
  `);
  if (!lines.length) return;
  console.log(`   scanning ${lines.length} Line(s)...`);

  for (const line of lines) {
    try {
      const rewrite = await generateWikipediaStyleTitle(line);
      metrics.claudeCallsTitle = (metrics.claudeCallsTitle || 0) + (rewrite._claudeCalls || 0);
      if (rewrite._usage) {
        metrics.inputTokens  += rewrite._usage.input_tokens        || 0;
        metrics.inputTokens  += rewrite._usage.cache_read_input_tokens || 0;
        metrics.inputTokens  += rewrite._usage.cache_creation_input_tokens || 0;
        metrics.outputTokens += rewrite._usage.output_tokens       || 0;
      }
      const newTitle = rewrite.title || line.title;
      if (newTitle && newTitle !== line.title) {
        await pool.query(
          `UPDATE story_timelines SET title = $1 WHERE id = $2`,
          [newTitle, line.id]
        );
        metrics.linesRetitled = (metrics.linesRetitled || 0) + 1;
        console.log(`   ✎ id=${line.id}  "${String(line.title).slice(0,55)}"  →  "${newTitle.slice(0,55)}"`);
      }
    } catch (err) {
      console.warn(`   ⚠ retitle failed for Line ${line.id}: ${err.message}`);
    }
    // Light throttle so sweep of 30-ish Lines stays under ~15s and
    // doesn't burst Claude rate-limits.
    await sleep(250);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  RECLASSIFY ACTOR TIERS (opt-in via --reclassify-actors)
//
//  One-shot sweep: tier-classify every thread + line in the DB. The pure
//  classifier is in entityTierClassifier.js; the DB-aware wrapper lives
//  in entityTierWiring.js. On --dry-run-reclassify, runs the classifier
//  but suppresses writes — prints diffs for audit.
// ═════════════════════════════════════════════════════════════════════════════
async function runReclassifyActorsPhase(metrics, { dryRun = false } = {}) {
  const { classifyActorTiers } = require('./entityTierClassifier');
  const throttle = 100;   // ms between Claude calls — keeps Haiku TPS sane

  // ── Threads ────────────────────────────────────────────────────────────
  const { rows: threads } = await pool.query(`
    SELECT id, title, description, primary_category, keywords,
           primary_nations, secondary_nations, article_count, status
    FROM story_threads
    WHERE COALESCE(array_length(primary_nations, 1), 0) > 0
    ORDER BY article_count DESC, importance DESC NULLS LAST
  `);
  console.log(`   threads to reclassify: ${threads.length}`);

  let tChanged = 0, tSkipped = 0;
  for (const r of threads) {
    const candidates = _mergeCandidates(r.primary_nations, r.secondary_nations);
    if (!candidates.length) { tSkipped++; continue; }

    let tiers;
    if (candidates.length <= 1) {
      tiers = { primary: candidates, secondary: [], _claudeCalls: 0 };
    } else {
      tiers = await classifyActorTiers({
        title: r.title,
        description: r.description,
        keywords: r.keywords,
        primary_category: r.primary_category,
        candidateIsos: candidates,
      });
      metrics.claudeCallsTier = (metrics.claudeCallsTier || 0) + (tiers._claudeCalls || 0);
      if (tiers._usage) {
        metrics.inputTokens  += tiers._usage.input_tokens        || 0;
        metrics.inputTokens  += tiers._usage.cache_read_input_tokens || 0;
        metrics.inputTokens  += tiers._usage.cache_creation_input_tokens || 0;
        metrics.outputTokens += tiers._usage.output_tokens       || 0;
      }
    }

    const beforeP = (r.primary_nations || []).map(s => String(s).toUpperCase());
    const beforeS = (r.secondary_nations || []).map(s => String(s).toUpperCase());
    const changed = !_isoEqual(beforeP, tiers.primary) || !_isoEqual(beforeS, tiers.secondary);

    if (changed) {
      tChanged++;
      if (!dryRun) {
        await pool.query(
          `UPDATE story_threads SET primary_nations = $1, secondary_nations = $2 WHERE id = $3`,
          [tiers.primary, tiers.secondary, r.id]
        );
      }
      if (tChanged <= 20 || (r.status === 'active' && tChanged <= 100)) {
        console.log(
          `   ${dryRun ? '[DRY]' : '[WR]'} thread ${r.id} [${r.status}] ` +
          `p=[${tiers.primary.join(',')}] s=[${tiers.secondary.join(',')}]  "${(r.title||'').slice(0,55)}"`
        );
      }
    }
    if (throttle > 0 && tiers._claudeCalls) await sleep(throttle);
  }
  metrics.threadsReclassified = tChanged;

  // ── Lines ──────────────────────────────────────────────────────────────
  const { rows: lines } = await pool.query(`
    SELECT id, title, description, primary_category, keywords,
           primary_nations, secondary_nations, article_count, status
    FROM story_timelines
    WHERE COALESCE(array_length(primary_nations, 1), 0) > 0
    ORDER BY article_count DESC NULLS LAST, importance DESC NULLS LAST
  `);
  console.log(`   lines to reclassify: ${lines.length}`);

  let lChanged = 0;
  for (const r of lines) {
    const candidates = _mergeCandidates(r.primary_nations, r.secondary_nations);
    if (!candidates.length) continue;

    let tiers;
    if (candidates.length <= 1) {
      tiers = { primary: candidates, secondary: [], _claudeCalls: 0 };
    } else {
      tiers = await classifyActorTiers({
        title: r.title,
        description: r.description,
        keywords: r.keywords,
        primary_category: r.primary_category,
        candidateIsos: candidates,
      });
      metrics.claudeCallsTier = (metrics.claudeCallsTier || 0) + (tiers._claudeCalls || 0);
      if (tiers._usage) {
        metrics.inputTokens  += tiers._usage.input_tokens        || 0;
        metrics.inputTokens  += tiers._usage.cache_read_input_tokens || 0;
        metrics.inputTokens  += tiers._usage.cache_creation_input_tokens || 0;
        metrics.outputTokens += tiers._usage.output_tokens       || 0;
      }
    }

    const beforeP = (r.primary_nations || []).map(s => String(s).toUpperCase());
    const beforeS = (r.secondary_nations || []).map(s => String(s).toUpperCase());
    const changed = !_isoEqual(beforeP, tiers.primary) || !_isoEqual(beforeS, tiers.secondary);

    if (changed) {
      lChanged++;
      if (!dryRun) {
        await pool.query(
          `UPDATE story_timelines SET primary_nations = $1, secondary_nations = $2 WHERE id = $3`,
          [tiers.primary, tiers.secondary, r.id]
        );
      }
      console.log(
        `   ${dryRun ? '[DRY]' : '[WR]'} line ${r.id} [${r.status}] ` +
        `p=[${tiers.primary.join(',')}] s=[${tiers.secondary.join(',')}]  "${(r.title||'').slice(0,55)}"`
      );
    }
    if (throttle > 0 && tiers._claudeCalls) await sleep(throttle);
  }
  metrics.linesReclassified = lChanged;

  console.log(`   done: threads changed=${tChanged}/${threads.length}  lines changed=${lChanged}/${lines.length}` +
              (dryRun ? '  (no writes — dry run)' : ''));
}

function _mergeCandidates(...lists) {
  const s = new Set();
  for (const l of lists) {
    if (!Array.isArray(l)) continue;
    for (const v of l) {
      const k = String(v || '').trim().toUpperCase();
      if (/^[A-Z]{2,3}$/.test(k)) s.add(k);
    }
  }
  return [...s];
}
function _isoEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
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
