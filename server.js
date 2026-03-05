const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { startArticleListener } = require("./articleListener");
const { getRankedArticles, getRankedCityArticles } = require("./rankingService");
const { countryVarianceRerank } = require("./priorityEngine");

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
        c.id, 
        c.name, 
        c.timezone, 
        c.country_id,
        c.latitude AS lat, 
        c.longitude AS lon,
        c.fame_index,
        c.population,
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
   City Feed — Global
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
   Country Feed — Local
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
   Country Feed — Global
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
   Search — relational (from → keyword → about)
========================================= */
app.get("/api/news/search", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 24, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);

    const fromIds = req.query.from
      ? req.query.from.split(",").map(Number).filter(Boolean)
      : null;

    const aboutIds = req.query.about
      ? req.query.about.split(",").map(Number).filter(Boolean)
      : null;

    const keyword  = req.query.keyword?.trim() || null;
    const fromDate = req.query.from_date?.trim() || null;
    const toDate   = req.query.to_date?.trim()   || null;

    const conditions = [];
    const params     = [];

    if (fromIds?.length) {
      params.push(fromIds);
      conditions.push(`a.country_id = ANY($${params.length})`);
    }

    if (aboutIds?.length) {
      params.push(aboutIds);
      conditions.push(`al.country_id = ANY($${params.length})`);
    }

    if (keyword) {
      params.push(`%${keyword}%`);
      conditions.push(`(
        COALESCE(a.translated_title, a.title) ILIKE $${params.length}
        OR
        COALESCE(a.translated_summary, a.summary) ILIKE $${params.length}
      )`);
    }

    if (fromDate) {
      params.push(fromDate);
      conditions.push(`a.published_at >= $${params.length}::date`);
    }

    if (toDate) {
      params.push(toDate);
      conditions.push(`a.published_at < $${params.length}::date + interval '1 day'`);
    }

    const whereClause = conditions.length
      ? "WHERE " + conditions.join(" AND ")
      : "";

    const needsLocJoin = !!aboutIds?.length;

    params.push(limit, offset);
    const limitParam  = params.length - 1;
    const offsetParam = params.length;

    const { rows } = await pool.query(`
      SELECT * FROM (
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
          a.sentiment_score,
          a.base_priority,
          ns.name            AS source_name,
          ns.site_url,
          src_co.iso_code,
          src_co.name        AS country_name,
          src_co.flag        AS country_flag,
          ci.name            AS city_name,
          COALESCE(cfb.boost_score, 1.0) AS country_boost,
          COUNT(*) OVER()    AS total_count
          ${needsLocJoin ? ", about_co.name AS about_country_name" : ""}
        FROM news_articles a
        JOIN news_sources ns      ON ns.id      = a.source_id
        JOIN countries src_co    ON src_co.id   = a.country_id
        LEFT JOIN country_feed_boost cfb ON cfb.country_id = a.country_id
        LEFT JOIN cities ci       ON ci.id      = a.city_id
        ${needsLocJoin ? `
          JOIN article_locations al  ON al.article_id = a.id
          JOIN countries about_co    ON about_co.id   = al.country_id
        ` : ""}
        ${whereClause}
        ORDER BY a.id
      ) sub
      ORDER BY (sub.base_priority * sub.country_boost) DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `, params);

    let results = rows.map(r => ({
      ...r,
      final_priority: (r.base_priority || 0) * (r.country_boost || 1)
    }));

    results = countryVarianceRerank(results);

    const total = rows.length ? rows[0].total_count : 0;

    res.json({ total, articles: results });

  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

/* =========================================
   Flows — aggregated by country
========================================= */
app.get("/api/flows", async (req, res) => {
  try {
    const from  = req.query.from  || null;
    const to    = req.query.to    || null;
    const limit = Math.min(parseInt(req.query.limit) || 300, 500);

    const { rows } = await pool.query(`
      SELECT
        a.id,
        a.translated_title                    AS title,
        a.published_at                        AS "publishedAt",
        a.sentiment_score                     AS sentiment,
        ns.name                               AS "sourceName",
        al.routing_type                       AS "routingType",
        src_co.latitude                       AS src_lat,
        src_co.longitude                      AS src_lon,
        src_co.name                           AS src_place,
        dst_co.latitude                       AS dst_lat,
        dst_co.longitude                      AS dst_lon,
        dst_co.name                           AS dst_place
      FROM article_locations al
      JOIN news_articles  a      ON a.id      = al.article_id
      JOIN news_sources   ns     ON ns.id     = a.source_id
      JOIN countries      src_co ON src_co.id = a.country_id
      JOIN countries      dst_co ON dst_co.id = al.country_id
      WHERE al.routing_type IN ('content', 'source')
        AND src_co.id != dst_co.id
        AND ($1::date IS NULL OR a.published_at >= $1::date)
        AND ($2::date IS NULL OR a.published_at <  $2::date + interval '1 day')
      ORDER BY a.published_at DESC
      LIMIT $3
    `, [from, to, limit]);

    const flows = rows.map(r => ({
      title:       r.title,
      publishedAt: r.publishedAt,
      sentiment:   r.sentiment,
      sourceName:  r.sourceName,
      routingType: r.routingType,
      src: { lat: parseFloat(r.src_lat), lon: parseFloat(r.src_lon), place: r.src_place },
      dst: { lat: parseFloat(r.dst_lat), lon: parseFloat(r.dst_lon), place: r.dst_place },
    }));

    res.json(flows);
  } catch (err) {
    console.error("Flows error:", err.message);
    res.status(500).json({ error: "Failed to fetch flows" });
  }
});

/* =========================================
   Ocean Temperature
========================================= */
app.get("/api/ocean/temperature", async (req, res) => {
  try {
    const year  = req.query.year  ? parseInt(req.query.year)  : null;
    const month = req.query.month ? parseInt(req.query.month) : null;
    const limit = Math.min(parseInt(req.query.limit) || 10000, 50000);

    const conditions = [];
    const params     = [];

    if (year) {
      params.push(year);
      conditions.push(`EXTRACT(YEAR  FROM time::date) = $${params.length}`);
    }
    if (month) {
      params.push(month);
      conditions.push(`EXTRACT(MONTH FROM time::date) = $${params.length}`);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    params.push(limit);

    const { rows } = await pool.query(`
      SELECT
        latitude  AS lat,
        longitude AS lon,
        temperature,
        time
      FROM ocean.ocean_temperature
      ${where}
      ORDER BY time DESC
      LIMIT $${params.length}
    `, params);

    res.json(rows);
  } catch (err) {
    console.error("Ocean temperature error:", err.message);
    res.status(500).json({ error: "Failed to fetch ocean temperature data" });
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