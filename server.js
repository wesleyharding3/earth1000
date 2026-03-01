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
   Excludes articles that originate from this city's local feed
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
        co.iso_code,
        co.name          AS country_name,
        ci.name          AS city_name
      FROM article_locations al
      JOIN news_articles a   ON a.id  = al.article_id
      JOIN news_sources  ns  ON ns.id = a.source_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN cities    ci ON ci.id = a.city_id
      ${tagJoin}
      WHERE al.city_id        = $1
        AND al.routing_type   IN ('content', 'source')
        AND a.city_id        != $1
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
          AND a.city_id IS NULL   
          AND at.tag_id        = $2
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
   Excludes articles that originate from this country's local feed
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
        co.iso_code,
        co.name          AS country_name,
        ci.name          AS city_name
      FROM article_locations al
      JOIN news_articles a   ON a.id  = al.article_id
      JOIN news_sources  ns  ON ns.id = a.source_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN cities    ci ON ci.id = a.city_id
      ${tagJoin}
      WHERE al.country_id     = $1
        AND al.routing_type   IN ('content', 'source')
        AND a.country_id     != $1
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
   Article Flow Animation
   GET /api/flows?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=300&mode=city|country

   Arc origin  = news_source location (ns.city_id → city coords, else ns.country_id → country coords)
   Arc destination = article_locations routing targets (city or country coords)
   
   Add this route to server.js
========================================= */

app.get("/api/flows", async (req, res) => {
  try {
    const from  = req.query.from  || new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
    const to    = req.query.to    || new Date().toISOString().slice(0,10);
    const limit = Math.min(parseInt(req.query.limit) || 300, 600);
    const mode  = req.query.mode === "city" ? "city" : "country"; // which dest type to emphasise

    const { rows } = await pool.query(`
      SELECT
        a.id                          AS article_id,
        a.published_at,
        a.translated_title            AS title,
        a.sentiment_score,
        al.routing_type,

        /* ── Source: prefer news_source city, fall back to source country ── */
        ns.id                         AS source_id,
        ns.name                       AS source_name,
        COALESCE(src_city.latitude,  src_sco.latitude)  AS src_lat,
        COALESCE(src_city.longitude, src_sco.longitude) AS src_lon,
        COALESCE(src_city.name,      src_sco.name)      AS src_place,
        COALESCE(src_sco.iso_code,   src_sco2.iso_code) AS src_iso,
        CASE WHEN src_city.id IS NOT NULL THEN 'city' ELSE 'country' END AS src_type,

        /* ── Destination: city preferred, fall back to country centroid ── */
        COALESCE(dst_city.latitude,  dst_country.latitude)  AS dst_lat,
        COALESCE(dst_city.longitude, dst_country.longitude) AS dst_lon,
        COALESCE(dst_city.name,      dst_country.name)      AS dst_place,
        COALESCE(dst_country.iso_code) AS dst_iso,
        CASE WHEN dst_city.id IS NOT NULL THEN 'city' ELSE 'country' END AS dst_type

      FROM news_articles a
      JOIN news_sources       ns          ON ns.id          = a.source_id
      JOIN article_locations  al          ON al.article_id  = a.id

      /* source city (local outlet) */
      LEFT JOIN cities        src_city    ON src_city.id    = ns.city_id
      /* source country via ns.country_id */
      LEFT JOIN countries     src_sco     ON src_sco.id     = ns.country_id
      /* fallback iso via article country_id */
      LEFT JOIN countries     src_sco2    ON src_sco2.id    = a.country_id

      /* destination city / country */
      LEFT JOIN cities        dst_city    ON dst_city.id    = al.city_id
      LEFT JOIN countries     dst_country ON dst_country.id = al.country_id

      WHERE a.published_at >= $1::date
        AND a.published_at <  ($2::date + interval '1 day')
        AND al.routing_type IN ('content', 'source')
        /* must have valid source coords */
        AND (
          (src_city.latitude    IS NOT NULL AND src_city.longitude    IS NOT NULL) OR
          (src_sco.latitude     IS NOT NULL AND src_sco.longitude     IS NOT NULL)
        )
        /* must have valid destination coords */
        AND (
          (dst_city.latitude    IS NOT NULL AND dst_city.longitude    IS NOT NULL) OR
          (dst_country.latitude IS NOT NULL AND dst_country.longitude IS NOT NULL)
        )
      ORDER BY a.published_at DESC
      LIMIT $3
    `, [from, to, limit]);

    const flows = rows
      .map(r => {
        const srcLat = parseFloat(r.src_lat);
        const srcLon = parseFloat(r.src_lon);
        const dstLat = parseFloat(r.dst_lat);
        const dstLon = parseFloat(r.dst_lon);
        if (isNaN(srcLat) || isNaN(srcLon) || isNaN(dstLat) || isNaN(dstLon)) return null;
        // drop trivially same-location arcs
        if (Math.abs(srcLat - dstLat) < 0.8 && Math.abs(srcLon - dstLon) < 0.8) return null;
        return {
          articleId:   r.article_id,
          publishedAt: r.published_at,
          title:       r.title,
          sentiment:   r.sentiment_score,
          routingType: r.routing_type,
          sourceName:  r.source_name,
          src: { lat: srcLat, lon: srcLon, place: r.src_place, iso: r.src_iso, type: r.src_type },
          dst: { lat: dstLat, lon: dstLon, place: r.dst_place, iso: r.dst_iso, type: r.dst_type },
        };
      })
      .filter(Boolean);

    res.json(flows);
  } catch (err) {
    console.error("Flows error:", err.message);
    res.status(500).json({ error: "Failed to fetch flows" });
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