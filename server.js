const express = require("express");
const cors = require("cors");
const pool = require("./db");

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
    const { cityId } = req.params;
    let limit  = Math.min(parseInt(req.query.limit)  || 10, 50);
    let offset = Math.max(parseInt(req.query.offset) || 0,  0);

    const result = await pool.query(
      `SELECT 
        a.id, a.title, a.url, a.summary, a.image_url, a.published_at,
        s.name AS source_name, s.site_url,
        co.iso_code
      FROM news_articles a
      JOIN news_sources s ON a.source_id = s.id
      LEFT JOIN countries co ON a.country_id = co.id
      WHERE a.city_id = $1
      ORDER BY a.published_at DESC
      LIMIT $2 OFFSET $3`,
      [cityId, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("City news error:", err.message);
    res.status(500).json({ error: "Failed to fetch city news" });
  }
});

app.get("/api/news/country/:countryId", async (req, res) => {
  try {
    const { countryId } = req.params;
    let limit  = Math.min(parseInt(req.query.limit)  || 50, 50);
    let offset = Math.max(parseInt(req.query.offset) || 0,  0);

    const result = await pool.query(
      `SELECT 
        a.id, a.title, a.url, a.summary, a.image_url, a.published_at,
        a.language, s.name AS source_name, s.site_url,
        co.iso_code
      FROM news_articles a
      JOIN news_sources s ON a.source_id = s.id
      LEFT JOIN countries co ON a.country_id = co.id
      WHERE a.country_id = $1
      ORDER BY a.published_at DESC
      LIMIT $2 OFFSET $3`,
      [countryId, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Country news error:", err.message);
    res.status(500).json({ error: "Failed to fetch country news" });
  }
});

app.get("/", (req, res) => res.send("API is running"));

const PORT = process.env.PORT || 3000;
const fetchFeeds = require("./fetcher");

fetchFeeds().catch(console.error);
setInterval(() => fetchFeeds().catch(console.error), 30 * 60 * 1000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));