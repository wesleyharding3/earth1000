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

app.get("/", (req, res) => res.send("API is running"));

const PORT = process.env.PORT || 3000;

startArticleListener().catch(console.error);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));