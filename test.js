// test.js
require("dotenv").config();
const pool = require("./db");
const { routeArticle } = require("./locationRouter");

const ID = 1198498;

async function main() {
  const { rows } = await pool.query(
    `SELECT title, translated_title, summary, translated_summary FROM news_articles WHERE id = $1`, [ID]
  );
  console.log("Article:", JSON.stringify(rows[0]));

  await routeArticle(ID);

  const { rows: locs } = await pool.query(
    `SELECT * FROM article_locations WHERE article_id = $1`, [ID]
  );
  console.log("Locations inserted:", locs.length, JSON.stringify(locs));

  await pool.end();
  process.exit(0);
}

main();