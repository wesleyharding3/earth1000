// articleListener.js
const pool = require("./db");
const { classifyArticle } = require("./scoringEngine");
const { routeArticle } = require("./locationRouter");
const { resolveImageForArticle } = require("./imageResolver");
// deepAnalyzer.js is deprecated — the per-article fire-and-forget call
// below was disabled months ago in favor of post-threading enrichment
// via storyThreadBuilder. Deep enrichment now lives in
// articleDeepEnrichment.js. Import left out entirely so we don't pull
// the Anthropic client init for nothing.
const { persistPreExtracted } = require("./entityResolver");
const { extractEntitiesBatch } = require("./entityExtractor");
const { scoreArticle: lexiconScoreArticle } = require("./sentimentLexicon");

// ── Lexicon-based sentiment (zero-cost, 100% coverage) ─────────────────────
// Runs on every new article to guarantee sentiment_score is never NULL.
// deepAnalyzer.js (Claude Haiku) still runs in parallel for high-priority
// articles and will overwrite this score with a higher-quality reading.
async function applyLexiconSentiment(articleId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, summary, translated_title, translated_summary, language, sentiment_score
         FROM news_articles WHERE id = $1`,
      [articleId]
    );
    const row = rows[0];
    if (!row) return;
    // Never overwrite an existing (likely Haiku) score.
    if (row.sentiment_score != null) return;
    const { score, matched } = lexiconScoreArticle(row);
    if (!matched) return;
    await pool.query(
      `UPDATE news_articles
          SET sentiment_score = $1
        WHERE id = $2
          AND sentiment_score IS NULL`,
      [score, articleId]
    );
  } catch (err) {
    console.warn(`⚠️  Lexicon sentiment failed [${articleId}]: ${err.message}`);
  }
}

// Track scoring results across the current fetch run
const scoringStats = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  failedIds: [],
};

function resetStats() {
  scoringStats.attempted = 0;
  scoringStats.succeeded = 0;
  scoringStats.failed    = 0;
  scoringStats.failedIds = [];
}

async function logScoringVerification() {
  const { attempted, succeeded, failed, failedIds } = scoringStats;
  if (attempted === 0) {
    console.log("📊 Scoring Verification: No articles were processed.");
    return;
  }

  const pct = ((succeeded / attempted) * 100).toFixed(1);

  // Pull a DB-side sanity check for the articles we touched
  let avgPriority = "N/A";
  let articlesWithTags = 0;
  if (succeeded > 0) {
    const { rows } = await pool.query(`
      SELECT
        ROUND(AVG(a.base_priority)::numeric, 4) AS avg_priority,
        COUNT(DISTINCT at.article_id)            AS articles_with_tags
      FROM news_articles a
      LEFT JOIN article_tags at ON at.article_id = a.id
      WHERE a.published_at > NOW() - INTERVAL '10 minutes'
        AND a.base_priority > 0
    `);
    avgPriority      = rows[0].avg_priority ?? "N/A";
    articlesWithTags = rows[0].articles_with_tags ?? 0;
  }

  console.log(`\n📊 Scoring Verification — Fetch Run Complete`);
  console.log(`   ✅ Scored successfully: ${succeeded} / ${attempted} (${pct}%)`);
  console.log(`   🏷️  Articles with tags:  ${articlesWithTags}`);
  console.log(`   📈 Avg base_priority:   ${avgPriority}`);
  if (failed > 0) {
    console.warn(`   ❌ Failed to score:     ${failed}`);
    failedIds.forEach(id => console.warn(`      → Article ID: ${id}`));
  } else {
    console.log(`   🎉 All articles scored without errors`);
  }
  console.log();
}

// Concurrency limiter — process at most this many articles simultaneously.
// Without this, a burst of 200 notifications would open 200 concurrent DB
// pipelines and exhaust the connection pool, starving the API server.
//
// Each in-flight article holds 3-5 pool connections (classify + route +
// lexicon-sentiment + image-resolver, some sequential, some parallel).
// At CONCURRENCY=5 a 60-article burst from the fetcher consumed enough
// pool to time out user requests. Lowered to 3 — peak listener load
// is now ~12 connections instead of ~20, leaving headroom for API
// traffic. Combined with the adaptive pause below (skip a tick when
// the pool is hot), bursts no longer starve the server.
//
// Throughput note: classifyArticle averages ~5s. CONCURRENCY=3 drains
// a 60-article burst in ~100s vs ~60s at 5. Threads form on a 30-min
// cron so this delay is invisible to thread cadence.
const CONCURRENCY = 3;
// Adaptive pause threshold. When the shared pool is heavily contended
// (most connections busy) we hold new articles in the queue and let
// API requests drain through. Articles already in flight finish; the
// queue is preserved (no skipping) so routing/keywords/sentiment/image
// still happen — just a few seconds later.
const POOL_HOT_PAUSE_MS = 250;
let _active = 0;
const _queue = [];

function _poolIsHot() {
  // pg-pool exposes totalCount, idleCount, waitingCount. "Hot" =
  // someone is waiting OR we're at >85% of max with no idle conns.
  const max = pool.options?.max ?? 60;
  if ((pool.waitingCount ?? 0) > 0) return true;
  if ((pool.idleCount ?? 0) === 0 && (pool.totalCount ?? 0) >= 0.85 * max) return true;
  return false;
}

// Shutdown coordination. When the server process gets SIGTERM (Render
// restart, deploy, OOM), we need to drain the in-flight articles before
// pool.end() runs — otherwise classifyArticle hits a closed pool and
// spams "Cannot use a pool after calling end on the pool" once per
// queued/active article.
let _shutdownRequested = false;
let _idleResolvers = [];
function _signalIdleIfDone() {
  if (_active === 0 && _queue.length === 0) {
    const r = _idleResolvers; _idleResolvers = [];
    for (const resolve of r) resolve();
  }
}

function enqueue(fn) {
  // Refuse new work after shutdown has begun. The article will be
  // re-NOTIFIED by Postgres on the next listener startup if needed
  // (LISTEN/NOTIFY isn't durable, but the fetcher writes the row before
  // notifying — a follow-up backfill scan picks up anything missed).
  if (_shutdownRequested) return;
  _queue.push(fn);
  _drain();
}

function _drain() {
  while (_active < CONCURRENCY && _queue.length > 0) {
    // Adaptive pause: if Postgres is hot, hold the queue and retry
    // shortly. The article stays queued — no skipping. In-flight work
    // finishes, pool relieves, drain resumes. During shutdown we let
    // the queue empty without pausing so we don't deadlock against
    // _awaitIdle.
    if (!_shutdownRequested && _poolIsHot()) {
      setTimeout(_drain, POOL_HOT_PAUSE_MS).unref?.();
      return;
    }
    const fn = _queue.shift();
    _active++;
    fn().finally(() => {
      _active--;
      _drain();
      _signalIdleIfDone();
    });
  }
}

// Wait for the queue to fully drain. Returns immediately if already
// idle. Caller is responsible for setting _shutdownRequested first if
// they want to prevent new work from arriving during the wait.
function _awaitIdle(timeoutMs = 25_000) {
  if (_active === 0 && _queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const onIdle = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    _idleResolvers.push(onIdle);
    timer = setTimeout(() => {
      _idleResolvers = _idleResolvers.filter(r => r !== onIdle);
      console.warn(`[articleListener] drain timed out — ${_active} active, ${_queue.length} queued`);
      resolve();
    }, timeoutMs);
  });
}

async function stopArticleListener({ timeoutMs = 25_000 } = {}) {
  _shutdownRequested = true;
  console.log(`[articleListener] shutdown requested — draining ${_active} active + ${_queue.length} queued`);
  await _awaitIdle(timeoutMs);
  console.log('[articleListener] drained');
}

// Dedup guard — the fetcher fires an explicit pg_notify AND the DB trigger
// fires one too, so each insert produces two notifications. Track recently-seen
// IDs for 10 seconds to silently skip the duplicate.
const recentlySeen = new Map(); // articleId → timestamp
const DEDUP_TTL_MS = 10_000;

// ── Batched entity extraction ──────────────────────────────────────────────
// Articles come in one-at-a-time via pg_notify, but each entity-extraction
// Claude call re-sends the ~4K-token rules/examples preamble. Batching 15
// articles per call + using prompt caching on the preamble reduces
// per-article Claude cost by ~60-70%. See entityExtractor.extractEntitiesBatch.
//
// Flush triggers (whichever hits first):
//   - BATCH_SIZE articles buffered
//   - BATCH_IDLE_MS since the last article was added (end-of-fetch-run flush)
//
// Articles stay in memory until flush — if the process dies mid-batch, they
// get picked up on the next fetch cycle because the listener is re-fed and
// extraction_state stays 'pending' (never marked 'processing' pre-flush).
const BATCH_SIZE    = parseInt(process.env.ENTITY_BATCH_SIZE || '15', 10);
const BATCH_IDLE_MS = parseInt(process.env.ENTITY_BATCH_IDLE_MS || '45000', 10);
const _entityQueue = [];
let _entityFlushTimer = null;
let _entityFlushing = false;

function _scheduleEntityFlush() {
  if (_entityFlushTimer) return;
  _entityFlushTimer = setTimeout(() => { _entityFlushTimer = null; _flushEntityQueue(); }, BATCH_IDLE_MS);
  _entityFlushTimer.unref?.();
}

function _enqueueForEntityExtraction(articleId) {
  _entityQueue.push(articleId);
  if (_entityQueue.length >= BATCH_SIZE) {
    if (_entityFlushTimer) { clearTimeout(_entityFlushTimer); _entityFlushTimer = null; }
    _flushEntityQueue();
  } else {
    _scheduleEntityFlush();
  }
}

async function _flushEntityQueue() {
  if (_entityFlushing) { _scheduleEntityFlush(); return; } // overlap — retry next idle
  if (!_entityQueue.length) return;
  _entityFlushing = true;
  const ids = _entityQueue.splice(0, BATCH_SIZE);
  try {
    // Fetch all in one query. Also filter out anything already processed
    // so we don't waste Claude tokens on articles another worker already
    // handled between enqueue + flush.
    const { rows: articles } = await pool.query(`
      SELECT a.id, a.title, a.summary, a.translated_summary, a.published_at
        FROM news_articles a
        LEFT JOIN article_entity_extraction_state s ON s.article_id = a.id
       WHERE a.id = ANY($1::int[])
         AND (s.status IS NULL OR s.status NOT IN ('done','processing'))
         AND (a.title IS NOT NULL OR a.summary IS NOT NULL OR a.translated_summary IS NOT NULL)
    `, [ids]);
    if (!articles.length) { _entityFlushing = false; return; }

    const batchResult = await extractEntitiesBatch(articles);

    // Persist each article's results sequentially. saveArticleExtraction
    // takes its own tx per article; keeping it serial avoids flooding the
    // entities table with concurrent upserts of the same canonical name.
    for (const a of articles) {
      try {
        const r = batchResult[a.id];
        if (!r) continue;
        await persistPreExtracted(a.id, r);
      } catch (err) {
        console.warn(`⚠️  Entity persist failed [${a.id}]: ${err.message}`);
      }
    }
    const entCount = Object.values(batchResult).reduce((s, r) => s + (r?.entities?.length || 0), 0);
    console.log(`🧬 Entity batch [${articles.length} articles → ${entCount} entities]`);
  } catch (err) {
    console.warn(`⚠️  Entity batch failed (${ids.length} articles): ${err.message}`);
    // Leave articles unmarked — they'll be retried next NOTIFY burst if
    // the fetcher re-touches them, otherwise the backfill script picks
    // them up later. Don't individually fall back here; that would erase
    // the batching savings on every transient Claude hiccup.
  } finally {
    _entityFlushing = false;
    if (_entityQueue.length) _scheduleEntityFlush();
  }
}

function isDuplicate(articleId) {
  const now = Date.now();
  // Prune stale entries to prevent unbounded growth
  for (const [id, ts] of recentlySeen) {
    if (now - ts > DEDUP_TTL_MS) recentlySeen.delete(id);
  }
  if (recentlySeen.has(articleId)) return true;
  recentlySeen.set(articleId, now);
  return false;
}

async function startArticleListener() {
  const listener = await pool.connect();
  await listener.query("LISTEN new_article");
  console.log("👂 Listening for new articles...");

  listener.on("notification", (msg) => {
    const articleId = parseInt(msg.payload);
    if (isDuplicate(articleId)) {
      console.log(`🔖 Skipping duplicate notify for article ${articleId}`);
      return;
    }
    console.log(`🔖 New article detected: ${articleId}`);
    scoringStats.attempted++;

    enqueue(async () => {
      try {
        const result = await classifyArticle(articleId);
        await routeArticle(articleId);

        // Lexicon sentiment — zero-cost baseline on every article so the
        // sentiment heatmap has 100% coverage. deepAnalyzer (below) will
        // overwrite this with a Haiku-quality score for priority articles.
        applyLexiconSentiment(articleId)
          .catch(err => console.warn(`⚠️  Lexicon sentiment failed [${articleId}]: ${err.message}`));

        // Deep NLP enrichment runs post-threading from storyThreadBuilder,
        // via articleDeepEnrichment.enrichArticle on the top-N articles
        // per active thread (see deepAnalyzeTopPerThread). Per-article
        // fire-and-forget at ingest time was disabled months ago — Haiku
        // cost was dominated by 80% of articles that never ended up
        // surfaced. The consolidated pipeline feeds both the thread
        // builder (primary_nations backfill) and briefingGenerator
        // (cached thread.deepContext via DB read, no re-scrape).

        // ─── Timelines knowledge-graph extraction (BATCHED) ─────────────────
        // Buffers this article id for the next entity-extraction flush.
        // Flush fires on BATCH_SIZE (default 15) or BATCH_IDLE_MS (default
        // 45s) — whichever comes first. Inside the flush, a single Claude
        // call extracts entities + referenced_dates for the whole batch
        // with prompt caching on the rules preamble, then persists each
        // article's results via entityResolver.persistPreExtracted.
        //
        // Gated on TIMELINES_EXTRACTION_ENABLED=true. When off, entities
        // stay unextracted — no Claude cost. Flip env var to enable.
        if (process.env.TIMELINES_EXTRACTION_ENABLED === 'true') {
          _enqueueForEntityExtraction(articleId);
        }

        // Resolve image after classify+route so article_tags and article_locations
        // are already written — the resolver depends on both.
        // Fire-and-forget so image failures never block scoring stats.
        resolveImageForArticle(articleId, { surface: "feed" })
          .then(r => {
            if (r?.source === "fallback" || r?.source === "assignment") {
              console.log(`🖼️  Image resolved [${articleId}]: ${r.source} (score: ${r.score ?? "—"})`);
            }
          })
          .catch(err => console.warn(`⚠️  Image resolution failed [${articleId}]: ${err.message}`));

        if (result.success) {
          scoringStats.succeeded++;
        } else {
          scoringStats.failed++;
          scoringStats.failedIds.push(articleId);
          console.warn(`⚠️  Scoring returned no signal for article ${articleId}: ${result.reason}`);
        }
      } catch (err) {
        scoringStats.failed++;
        scoringStats.failedIds.push(articleId);
        console.error(`Processing failed for ${articleId}:`, err);
      }
    });
  });

  listener.on("error", (err) => {
    console.error("❌ Listener error:", err);
    listener.release();
    setTimeout(() => startArticleListener().catch(console.error), 5000);
  });

  listener.on("end", () => {
    console.warn("⚠️ Listener connection ended — reconnecting...");
    setTimeout(() => startArticleListener().catch(console.error), 5000);
  });
}

module.exports = {
  startArticleListener,
  stopArticleListener,
  logScoringVerification,
  resetStats
};