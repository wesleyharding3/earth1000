const fetchFeeds = require("./fetcher");

async function run() {
  await fetchFeeds();
  process.exit(0);
}

run();
