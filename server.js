const express = require("express");
const cors = require("cors");
const pool = require("./db");   // your db.js

const app = express();

// ===============================
// Middleware
// ===============================

app.use(cors());
app.use(express.json());


// ===============================
// GET NEWS BY CITY
// ===============================

app.get("/api/news/city/:cityId", async (req, res) => {
  try {
    const { cityId } = req.params;

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
      LIMIT 20
      `,
      [cityId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("City news error:", err.message);
    res.status(500).json({ error: "Failed to fetch city news" });
  }
});


// ===============================
// Health Check (VERY useful on Render)
// ===============================

app.get("/", (req, res) => {
  res.send("API is running");
});


// ===============================
// Start Server (IMPORTANT)
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});