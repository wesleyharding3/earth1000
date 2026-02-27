// articleListener.js
const pool = require("./db");
const { classifyArticle } = require("./scoringEngine");
const { routeArticle } = require("./locationRouter");

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

async function startArticleListener() {
  const listener = await pool.connect();
  await listener.query("LISTEN new_article");
  console.log("👂 Listening for new articles...");

  listener.on("notification", async (msg) => {
    const articleId = parseInt(msg.payload);
    console.log(`🔖 New article detected: ${articleId}`);
    scoringStats.attempted++;

    try {
      const result = await classifyArticle(articleId);
      await routeArticle(articleId);

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

