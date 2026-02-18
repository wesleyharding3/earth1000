require("dotenv").config();

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

run();
