// articleListener.js
const pool = require("./db");
const { classifyArticle } = require("./scoringEngine");
const { routeArticle } = require("./locationRouter");
const { resolveImageForArticle } = require("./imageResolver");
const { deepAnalyzeArticle } = require("./deepAnalyzer");

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

        // Deep NLP analysis — fire-and-forget, only for high-priority articles.
        // Writes sentiment_score + article_entities. Never blocks pipeline.
        deepAnalyzeArticle(articleId)
          .catch(err => console.warn(`⚠️  Deep analysis failed [${articleId}]: ${err.message}`));

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