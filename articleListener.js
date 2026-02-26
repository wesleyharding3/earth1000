// articleListener.js
const pool = require("./db");
const { classifyArticle } = require("./scoringEngine");
const { routeArticle } = require("./locationRouter");

async function startArticleListener() {
  const listener = await pool.connect();

  await listener.query("LISTEN new_article");
  console.log("👂 Listening for new articles...");

  listener.on("notification", async (msg) => {
    const articleId = parseInt(msg.payload);
    console.log(`🔖 New article detected: ${articleId}`);
    try {
      await classifyArticle(articleId);
      await routeArticle(articleId);
    } catch (err) {
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

module.exports = { startArticleListener };