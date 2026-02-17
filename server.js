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
      SELECT id, name, lat, lon, country
      FROM cities
      ORDER BY name ASC
    `);

    res.json(result.rows);

  } catch (err) {
    console.error("Cities error:", err.message);
    res.status(500).json({ error: "Failed to fetch cities" });
  }
});



// ===============================
// GET NEWS BY CITY (with Pagination)
// ===============================

app.get("/api/news/city/:cityId", async (req, res) => {
  try {
    const { cityId } = req.params;

    // Read pagination query params
    let limit = parseInt(req.query.limit) || 10;
    let offset = parseInt(req.query.offset) || 0;

    // Safety limits (prevents abuse)
    if (limit > 50) limit = 50;
    if (offset < 0) offset = 0;

    const result = await pool.query(
      `
      SELECT 
        a.id,
        a.title,
        a.url,
        a.summary,
        a.published_at,
        s.name AS source_name,
        s.site_url
      FROM news_articles a
      JOIN news_sources s ON a.source_id = s.id
      WHERE a.primary_city_id = $1
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
