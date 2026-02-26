// articleListener.js
const { Pool } = require("pg");
const { classifyArticle } = require("./scoringEngine");

async function startArticleListener() {
  // Dedicated connection — LISTEN cannot share a pooled client
  const client = new Pool(/* your db config */).connect();
  const listener = await client;

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
    console.error("Listener error:", err);
  });
}

module.exports = { startArticleListener };