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
const { processArticleById: extractEntitiesForArticle } = require("./entityResolver");
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
const CONCURRENCY = 5;
let _active = 0;
const _queue = [];

function enqueue(fn) {
  _queue.push(fn);
  _drain();
}

function _drain() {
  while (_active < CONCURRENCY && _queue.length > 0) {
    const fn = _queue.shift();
    _active++;
    fn().finally(() => {
      _active--;
      _drain();
    });
  }
}

// Dedup guard — the fetcher fires an explicit pg_notify AND the DB trigger
// fires one too, so each insert produces two notifications. Track recently-seen
// IDs for 10 seconds to silently skip the duplicate.
const recentlySeen = new Map(); // articleId → timestamp
const DEDUP_TTL_MS = 10_000;

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

        // ─── Timelines knowledge-graph extraction (PAUSED) ──────────────────
        // Fire-and-forget call to entityResolver.processArticleById, which:
        //   • runs Claude entity extraction (entityExtractor.js)
        //   • resolves Wikidata QIDs via wbsearchentities (entityResolver.js)
        //   • persists to entities / article_entity_mentions / article_referenced_dates
        //   • is idempotent (skips already-processed articles)
        //
        // CURRENTLY DISABLED to avoid Claude costs until we have paying users
        // to justify the spend. The full pipeline is wired and tested — flip
        // the env var TIMELINES_EXTRACTION_ENABLED=true to turn it on. No code
        // changes required. The backfill script (backfillEntities.js) is also
        // ready and gated behind --go / --limit flags.
        if (process.env.TIMELINES_EXTRACTION_ENABLED === 'true') {
          extractEntitiesForArticle(articleId)
            .then(r => {
              if (r?.skipped) return;
              const ents = r?.summary?.entities?.length ?? 0;
              const dates = r?.summary?.dates_inserted ?? 0;
              if (ents || dates) console.log(`🧬 Entities extracted [${articleId}]: ${ents} entity mention(s), ${dates} historical date(s)`);
            })
            .catch(err => console.warn(`⚠️  Entity extraction failed [${articleId}]: ${err.message}`));
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
  logScoringVerification,
  resetStats
};