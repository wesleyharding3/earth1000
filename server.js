const express = require("express");
const cors = require("cors");
const pool = require("./db");

const app = express();

// ===============================
// Middleware
// ===============================

app.use(cors());
app.use(express.json());


// ===============================
// GET ALL CITIES
// ===============================

app.get("/api/cities", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id,
        c.name,
        c.country_id,
        c.latitude AS lat,
        c.longitude AS lon,
        co.name AS country
      FROM cities c
      LEFT JOIN countries co
        ON c.country_id = co.id
      WHERE c.is_active = true
      ORDER BY c.name ASC
    `);

    res.json(result.rows);

  } catch (err) {
    console.error("Cities FULL error:", err);
    res.status(500).json({ error: "Failed to fetch cities" });
  }
});


// ===============================
// GET ALL COUNTRIES
// ===============================

app.get("/api/countries", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        slug,
        iso_code,
        latitude AS lat,
        longitude AS lon,
        population
      FROM countries
      ORDER BY name ASC
    `);

    res.json(result.rows);

  } catch (err) {
    console.error("Countries error:", err);
    res.status(500).json({ error: "Failed to fetch countries" });
  }
});


// ===============================
// GET NEWS BY CITY
// ===============================

app.get("/api/news/city/:cityId", async (req, res) => {
  try {
    const { cityId } = req.params;

    let limit = parseInt(req.query.limit) || 10;
    let offset = parseInt(req.query.offset) || 0;

    if (limit > 50) limit = 50;
    if (offset < 0) offset = 0;

    const result = await pool.query(
      `
      SELECT 
        a.id,
        COALESCE(a.translated_title, a.title) AS title,
        a.url,
        COALESCE(a.translated_summary, a.summary) AS summary,
        a.published_at,
        s.name AS source_name,
        s.site_url
      FROM news_articles a
      JOIN news_sources s ON a.source_id = s.id
      WHERE a.city_id = $1
      ORDER BY a.published_at DESC
      LIMIT $2
      OFFSET $3
      `,
      [cityId, limit, offset]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("City news error:", err.message);
    res.status(500).json({ error: "Failed to fetch city news" });
  }
});


// ===============================
// GET NEWS BY COUNTRY
// ===============================

app.get("/api/news/country/:countryId", async (req, res) => {
  try {
    const { countryId } = req.params;

    let limit = parseInt(req.query.limit) || 15;
    let offset = parseInt(req.query.offset) || 0;

    if (limit > 50) limit = 50;
    if (offset < 0) offset = 0;

    const result = await pool.query(
      `
      SELECT 
        a.id,
        COALESCE(a.translated_title, a.title) AS title,
        a.url,
        COALESCE(a.translated_summary, a.summary) AS summary,
        a.published_at,
        a.sentiment_score,
        a.language,
        s.name AS source_name,
        s.site_url
      FROM news_articles a
      JOIN news_sources s ON a.source_id = s.id
      WHERE a.country_id = $1
      ORDER BY a.published_at DESC
      LIMIT $2
      OFFSET $3
      `,
      [countryId, limit, offset]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("Country news error:", err.message);
    res.status(500).json({ error: "Failed to fetch country news" });
  }
});


// ===============================
// Health Check
// ===============================

app.get("/", (req, res) => {
  res.send("API is running");
});


// ===============================
// Start Server
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
