const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { startArticleListener } = require("./articleListener");
const { getRankedArticles, getRankedCityArticles } = require("./rankingService");

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
   City Feed — Local (ranked, optional tag)
========================================= */
app.get("/api/news/city/:cityId", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 10, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const tagId  = req.query.tag ? parseInt(req.query.tag) : null;

    if (tagId) {
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
          ns.name         AS source_name,
          ns.site_url,
          ns.popularity_score,
          co.iso_code
        FROM news_articles a
        JOIN news_sources  ns  ON ns.id = a.source_id
        JOIN article_tags  at  ON at.article_id = a.id
        LEFT JOIN countries co ON co.id = a.country_id
        WHERE a.city_id      = $1
          AND at.tag_id      = $2
        ORDER BY at.score DESC
        LIMIT $3 OFFSET $4
      `, [req.params.cityId, tagId, limit, offset]);
      return res.json(rows);
    }

    const ranked = await getRankedCityArticles(parseInt(req.params.cityId));
    res.json(ranked.slice(offset, offset + limit));
  } catch (err) {
    console.error("City news error:", err.message);
    res.status(500).json({ error: "Failed to fetch city news" });
  }
});

/* =========================================
   City Feed — Global (content + source routed, optional tag)
========================================= */
app.get("/api/news/city/:cityId/global", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const tagId  = req.query.tag ? parseInt(req.query.tag) : null;

    const tagJoin  = tagId ? `JOIN article_tags at ON at.article_id = a.id` : "";
    const tagWhere = tagId ? `AND at.tag_id = ${tagId}` : "";
    const tagOrder = tagId ? `at.score DESC` : `a.published_at DESC`;

    const { rows } = await pool.query(`
      SELECT DISTINCT ON (a.id)
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
      ${tagJoin}
      WHERE al.city_id        = $1
        AND al.routing_type   IN ('content', 'source')
        AND a.published_at    > NOW() - INTERVAL '7 days'
        ${tagWhere}
      ORDER BY a.id, ${tagOrder}
      LIMIT $2 OFFSET $3
    `, [req.params.cityId, limit, offset]);

    res.json(rows);
  } catch (err) {
    console.error("City global feed error:", err.message);
    res.status(500).json({ error: "Failed to fetch global city feed" });
  }
});

/* =========================================
   Country Feed — Local (ranked, optional tag)
   NOTE: includes articles from city sources within this country
========================================= */
app.get("/api/news/country/:countryId", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const tagId  = req.query.tag ? parseInt(req.query.tag) : null;

    if (tagId) {
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
          ns.name         AS source_name,
          ns.site_url,
          ns.popularity_score,
          co.iso_code
        FROM news_articles a
        JOIN news_sources  ns  ON ns.id = a.source_id
        JOIN article_tags  at  ON at.article_id = a.id
        LEFT JOIN countries co ON co.id = a.country_id
        WHERE a.country_id     = $1
          AND at.tag_id        = $2
          AND a.published_at   > NOW() - INTERVAL '7 days'
        ORDER BY at.score DESC
        LIMIT $3 OFFSET $4
      `, [req.params.countryId, tagId, limit, offset]);
      return res.json(rows);
    }

    const ranked = await getRankedArticles(parseInt(req.params.countryId));
    res.json(ranked.slice(offset, offset + limit));
  } catch (err) {
    console.error("Country news error:", err.message);
    res.status(500).json({ error: "Failed to fetch country news" });
  }
});

/* =========================================
   Country Feed — Global (content + source routed, optional tag)
========================================= */
app.get("/api/news/country/:countryId/global", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const tagId  = req.query.tag ? parseInt(req.query.tag) : null;

    const tagJoin  = tagId ? `JOIN article_tags at ON at.article_id = a.id` : "";
    const tagWhere = tagId ? `AND at.tag_id = ${tagId}` : "";
    const tagOrder = tagId ? `at.score DESC` : `a.published_at DESC`;

    const { rows } = await pool.query(`
      SELECT DISTINCT ON (a.id)
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
      ${tagJoin}
      WHERE al.country_id     = $1
        AND al.routing_type   IN ('content', 'source')
        AND a.published_at    > NOW() - INTERVAL '7 days'
        ${tagWhere}
      ORDER BY a.id, ${tagOrder}
      LIMIT $2 OFFSET $3
    `, [req.params.countryId, limit, offset]);

    res.json(rows);
  } catch (err) {
    console.error("Country global feed error:", err.message);
    res.status(500).json({ error: "Failed to fetch global country feed" });
  }
});

/* =========================================
   Tags
========================================= */
app.get("/api/tags", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name FROM tags ORDER BY id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Tags error:", err);
    res.status(500).json({ error: "Failed to fetch tags" });
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