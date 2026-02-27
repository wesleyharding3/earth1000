require("dotenv").config();

process.on("exit", (code) => {
  console.log(`🚪 Process exiting with code ${code} at`, new Date().toISOString());
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled Rejection:", reason);
  process.exit(1);
});

const fetchFeeds = require("./fetcher");

async function run() {
  try {
    console.log("DATABASE_URL:", process.env.DATABASE_URL);

    await fetchFeeds();

    console.log("Worker finished successfully.");
    process.exit(0);

  } catch (err) {
    console.error("Worker crashed:", err);
    process.exit(1);
  }
}

/**
 * IMPORTANT:
 * Only run automatically if this file is executed directly.
 * Prevents killing the web server when imported.
 */
if (require.main === module) {
  run();
}

module.exports = run;