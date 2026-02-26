const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { startArticleListener } = require("./articleListener");
const { getRankedArticles, getRankedCityArticles } = require("./rankingService");
// const fetchFeeds = require("./fetcher"); // handled by cron worker, not server

const app = express();
console.log("Node version:", process.version);
app.use(cors());
app.use(express.json());

/* =========================================
   Cities
========================================= */
app.get("/api/cities", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id, c.name, c.timezone, c.country_id,
        c.latitude AS lat, c.longitude AS lon,
        co.name AS country
      FROM cities c
      LEFT JOIN countries co ON c.country_id = co.id
      WHERE c.is_active = true
      ORDER BY c.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Cities error:", err);
    res.status(500).json({ error: "Failed to fetch cities" });
  }
});

/* =========================================
   Countries
========================================= */
app.get("/api/countries", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, flag, slug, iso_code, latitude AS lat, longitude AS lon, population
      FROM countries
      ORDER BY name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Countries error:", err);
    res.status(500).json({ error: "Failed to fetch countries" });
  }
});

/* =========================================
   City Feed — Local (ranked)
========================================= */
app.get("/api/news/city/:cityId", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 10, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const ranked = await getRankedCityArticles(parseInt(req.params.cityId));
    res.json(ranked.slice(offset, offset + limit));
  } catch (err) {
    console.error("City news error:", err.message);
    res.status(500).json({ error: "Failed to fetch city news" });
  }
});

/* =========================================
   City Feed — Global (content routed)
========================================= */
app.get("/api/news/city/:cityId/global", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);

    const { rows } = await pool.query(`
      SELECT
        a.id,
        a.title,
        a.translated_title,
        a.url,
        a.article_url,
        a.summary,
        a.translated_summary,
        a.image_url,
        a.published_at,
        ns.name          AS source_name,
        ns.site_url,
        ns.popularity_score,
        co.iso_code
      FROM article_locations al
      JOIN news_articles a   ON a.id  = al.article_id
      JOIN news_sources  ns  ON ns.id = a.source_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE al.city_id      = $1
        AND al.routing_type = 'content'
        AND a.published_at  > NOW() - INTERVAL '24 hours'
      ORDER BY a.published_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.cityId, limit, offset]);

    res.json(rows);
  } catch (err) {
    console.error("City global feed error:", err.message);
    res.status(500).json({ error: "Failed to fetch global city feed" });
  }
});

/* =========================================
   Country Feed — Local (ranked)
========================================= */
app.get("/api/news/country/:countryId", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const ranked = await getRankedArticles(parseInt(req.params.countryId));
    res.json(ranked.slice(offset, offset + limit));
  } catch (err) {
    console.error("Country news error:", err.message);
    res.status(500).json({ error: "Failed to fetch country news" });
  }
});

/* =========================================
   Country Feed — Global (content routed)
========================================= */
app.get("/api/news/country/:countryId/global", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);

    const { rows } = await pool.query(`
      SELECT
        a.id,
        a.title,
        a.translated_title,
        a.url,
        a.article_url,
        a.summary,
        a.translated_summary,
        a.image_url,
        a.published_at,
        ns.name          AS source_name,
        ns.site_url,
        ns.popularity_score,
        co.iso_code
      FROM article_locations al
      JOIN news_articles a   ON a.id  = al.article_id
      JOIN news_sources  ns  ON ns.id = a.source_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE al.country_id   = $1
        AND al.city_id      IS NULL
        AND al.routing_type = 'content'
        AND a.published_at  > NOW() - INTERVAL '24 hours'
      ORDER BY a.published_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.countryId, limit, offset]);

    res.json(rows);
  } catch (err) {
    console.error("Country global feed error:", err.message);
    res.status(500).json({ error: "Failed to fetch global country feed" });
  }
});

/* =========================================
   Health Check
========================================= */
app.get("/", (req, res) => res.send("API is running"));

/* =========================================
   Start
========================================= */
const PORT = process.env.PORT || 3000;
startArticleListener().catch(console.error);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));