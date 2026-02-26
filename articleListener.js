// articleListener.js
const pool = require("./db");
const { classifyArticle } = require("./scoringEngine");

async function startArticleListener() {
  const listener = await pool.connect();

  await listener.query("LISTEN new_article");
  console.log("👂 Listening for new articles...");

  listener.on("notification", async (msg) => {
    const articleId = parseInt(msg.payload);
    console.log(`🔖 New article detected: ${articleId}`);
    try {
      await classifyArticle(articleId);
    } catch (err) {
      console.error(`Classification failed for ${articleId}:`, err);
    }
  });

  listener.on("error", (err) => {
    console.error("❌ Listener error:", err);
    listener.release();
    // Reconnect after 5 seconds
    setTimeout(() => startArticleListener().catch(console.error), 5000);
  });

  listener.on("end", () => {
    console.warn("⚠️ Listener connection ended — reconnecting...");
    setTimeout(() => startArticleListener().catch(console.error), 5000);
  });
}

module.exports = { startArticleListener };