// server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const pool = require("./db");
const fetchFeeds = require("./fetcher");

const app = express();

// ===============================
// Middleware
// ===============================
app.use(cors());
app.use(express.json());

// ===============================
// Health Check
// ===============================
app.get("/", (req, res) => {
  res.json({ status: "Server running" });
});

// ===============================
// GET ALL CITIES (for globe)
// ===============================
app.get("/api/cities", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, lat, lon, country, story_count
      FROM cities
      ORDER BY name ASC
    `);

    res.json(result.rows);

  } catch (err) {
    console.error("Error fetching cities:", err.message);
    res.status(500).json({ error: "Failed to fetch cities" });
  }
});

// ===============================
// GET LATEST ARTICLES
// ===============================
app.get("/api/news", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM articles
      ORDER BY pub_date DESC
      LIMIT 100
    `);

    res.json(result.rows);

  } catch (err) {
    console.error("Error fetching articles:", err.message);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});

// ===============================
// MANUAL RSS FETCH (optional)
// ===============================
app.post("/api/fetch", async (req, res) => {
  try {
    await fetchFeeds();
    res.json({ message: "RSS fetch completed" });

  } catch (err) {
    console.error("Fetch failed:", err.message);
    res.status(500).json({ error: "Fetch failed" });
  }
});

// ===============================
// DAILY CRON JOB (2AM server time)
// ===============================
cron.schedule("0 2 * * *", async () => {
  console.log("Running scheduled RSS fetch...");
  await fetchFeeds();
});

// ===============================
// Start Server
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
