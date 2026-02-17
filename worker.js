require("dotenv").config();

const fetchFeeds = require("./fetcher");

async function run() {

  console.log("DATABASE_URL:", process.env.DATABASE_URL);

  await fetchFeeds();
  process.exit(0);

}

run();