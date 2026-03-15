const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const pool = require("./db");
const { startArticleListener } = require("./articleListener");
const { getRankedArticles, getRankedCityArticles } = require("./rankingService");
const { countryVarianceRerank, calculatePriority, FLOW_CITY_PENALTY } = require("./priorityEngine");
const { translateText } = require("./translator");

const app = express();
console.log("Node version:", process.version);
app.use(cors({
  origin: [
    "https://wesleyharding3.github.io",
    "http://localhost:3000",
    "http://localhost:5500"
  ]
}));
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
        c.region_id,
        c.latitude AS lat, 
        c.longitude AS lon,
        c.fame_index,
        c.population,
        c.gdp,
        co.name AS country,
        r.name AS region
      FROM cities c
      LEFT JOIN countries co ON c.country_id = co.id
      LEFT JOIN regions r ON c.region_id = r.id
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
      SELECT id, name, flag, slug, iso_code, latitude AS lat, longitude AS lon, population, gdp
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
          l.iso_code_2 AS language,
          co.iso_code
        FROM news_articles a
        JOIN news_sources  ns  ON ns.id = a.source_id
        JOIN article_tags  at  ON at.article_id = a.id
        LEFT JOIN languages  l  ON l.id = ns.language_id
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
          l.iso_code_2 AS language,
        co.iso_code,
        co.name          AS country_name,
        ci.name          AS city_name
      FROM article_locations al
      JOIN news_articles a   ON a.id  = al.article_id
      JOIN news_sources  ns  ON ns.id = a.source_id
      LEFT JOIN languages  l  ON l.id = ns.language_id
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
          l.iso_code_2 AS language,
          co.iso_code
        FROM news_articles a
        JOIN news_sources  ns  ON ns.id = a.source_id
        JOIN article_tags  at  ON at.article_id = a.id
        LEFT JOIN languages  l  ON l.id = ns.language_id
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
          l.iso_code_2 AS language,
        co.iso_code,
        co.name          AS country_name,
        ci.name          AS city_name
      FROM article_locations al
      JOIN news_articles a   ON a.id  = al.article_id
      JOIN news_sources  ns  ON ns.id = a.source_id
      LEFT JOIN languages  l  ON l.id = ns.language_id
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

    // Always exclude city-level articles from the general search feed
    conditions.push(`a.city_id IS NULL`);

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
      const kwParam = params.length;
      params.push(keyword.toLowerCase().trim());
      const exactKwParam = params.length;
      conditions.push(`(
        COALESCE(a.translated_title, a.title) ILIKE $${kwParam}
        OR COALESCE(a.translated_summary, a.summary) ILIKE $${kwParam}
        OR EXISTS (
          SELECT 1 FROM article_keywords ak
          WHERE ak.article_id = a.id
          AND (ak.keyword ILIKE $${kwParam} OR ak.normalized_keyword = $${exactKwParam})
        )
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
          l.iso_code_2 AS language,
          a.base_priority,
          ns.name            AS source_name,
          ns.site_url,
          src_co.iso_code,
          src_co.name        AS country_name,
          src_co.flag        AS country_flag,
          ci.name            AS city_name,
          COALESCE(cfb.boost_score, 1.0) AS country_boost,
          COUNT(*) OVER()    AS total_count,
          -- Recency decay: half-life 6h, floor 0.02
          GREATEST(
            POWER(0.5, EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 21600.0),
            0.02
          ) AS recency_decay
          ${needsLocJoin ? ", about_co.name AS about_country_name" : ""}
        FROM news_articles a
        JOIN news_sources ns      ON ns.id      = a.source_id
        LEFT JOIN languages  l  ON l.id = ns.language_id
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
      ORDER BY (
        (sub.base_priority * 0.10 + sub.recency_decay * 0.90)
        * POWER(sub.country_boost, 2.0)
      ) DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `, params);

    let results = rows.map(r => ({
      ...r,
      final_priority: (r.base_priority || 0) * 0.10
                    + (r.recency_decay  || 1) * 0.90
                    * Math.pow(r.country_boost || 1, 2.0)
    }));

    results = countryVarianceRerank(results);

    // Final pass: re-sort ensuring recency is respected within close priority bands
    const PRIORITY_BAND = 0.15; // articles within 15% of each other sort by date
    results.sort((a, b) => {
      const pa = a.final_priority || 0;
      const pb = b.final_priority || 0;
      const maxP = Math.max(pa, pb) || 1;
      if (Math.abs(pa - pb) / maxP < PRIORITY_BAND) {
        return new Date(b.published_at) - new Date(a.published_at);
      }
      return pb - pa;
    });

    const total = rows.length ? rows[0].total_count : 0;

    res.json({ total, articles: results });

  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

/* =========================================
   Flows — Priority-scored with sqrt-normalized distribution
   
   Query params:
     mode         = 'individual' (default) | 'aggregate'
     from_date    = YYYY-MM-DD
     to_date      = YYYY-MM-DD
     from_country = country ID (source)
     from_city    = city ID (source)
     about_country= country ID (destination)
     about_city   = city ID (destination)
     keyword      = text search in title/summary
     limit        = max results (default 800, max 2500)
     normalize    = 'true' (default) | 'false' — sqrt-dampened distribution across destinations
     
   Normalization ensures every destination with routed articles is represented,
   while high-volume destinations still get more flows (but dampened via sqrt).
   Example: USA with 100 articles → ~10 flows, Luxembourg with 4 → ~2 flows
========================================= */
app.get("/api/flows", async (req, res) => {
  try {
    const mode = req.query.mode || "individual";
    const maxLimit = mode === "aggregate" ? 2500 : 2500;
    const limit = Math.min(parseInt(req.query.limit) || 800, maxLimit);
    const normalize = req.query.normalize !== "false"; // default true

    // Parse filters (support legacy param names too)
    const fromDate     = req.query.from_date?.trim()    || req.query.from?.trim() || null;
    const toDate       = req.query.to_date?.trim()      || req.query.to?.trim()   || null;
    const fromCountry  = req.query.from_country         ? parseInt(req.query.from_country) : null;
    const fromCity     = req.query.from_city            ? parseInt(req.query.from_city)    : null;
    const aboutCountry = req.query.about_country        ? parseInt(req.query.about_country): null;
    const aboutCity    = req.query.about_city           ? parseInt(req.query.about_city)   : null;
    const keyword      = req.query.keyword?.trim()      || null;

    // Build dynamic WHERE conditions
    const conditions = [];
    const params = [];

    // Always: must have routing
    conditions.push(`al.routing_type IN ('content', 'source')`);

    // Date filters
    if (fromDate) {
      params.push(fromDate);
      conditions.push(`a.published_at >= $${params.length}::date`);
    }
    if (toDate) {
      params.push(toDate);
      conditions.push(`a.published_at < $${params.length}::date + interval '1 day'`);
    }

    // Source location filters (from news_articles.country_id / city_id)
    if (fromCountry) {
      params.push(fromCountry);
      conditions.push(`a.country_id = $${params.length}`);
    }
    if (fromCity) {
      params.push(fromCity);
      conditions.push(`a.city_id = $${params.length}`);
    }

    // Destination location filters (from article_locations)
    if (aboutCountry) {
      params.push(aboutCountry);
      conditions.push(`al.country_id = $${params.length}`);
    }
    if (aboutCity) {
      params.push(aboutCity);
      conditions.push(`al.city_id = $${params.length}`);
    }

    // Keyword filter
    if (keyword) {
      params.push(`%${keyword}%`);
      const kwParam = params.length;
      params.push(keyword.toLowerCase().trim());
      const exactKwParam = params.length;
      conditions.push(`(
        COALESCE(a.translated_title, a.title) ILIKE $${kwParam}
        OR COALESCE(a.translated_summary, a.summary) ILIKE $${kwParam}
        OR EXISTS (
          SELECT 1 FROM article_keywords ak
          WHERE ak.article_id = a.id
          AND (ak.keyword ILIKE $${kwParam} OR ak.normalized_keyword = $${exactKwParam})
        )
      )`);
    }

    // Exclude all same-country flows (stubby lines)
    // Only allow: different countries
    conditions.push(`a.country_id != al.country_id`);

    const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    if (mode === "aggregate") {
      // ─────────────────────────────────────────
      // AGGREGATE MODE: Group by src/dst, return counts
      // ─────────────────────────────────────────
      params.push(limit);
      const limitParam = params.length;

      const { rows } = await pool.query(`
        WITH flow_counts AS (
          SELECT
            COALESCE(a.city_id, 0)                     AS src_city_id,
            a.country_id                               AS src_country_id,
            COALESCE(al.city_id, 0)                    AS dst_city_id,
            al.country_id                              AS dst_country_id,
            COUNT(*)                                   AS flow_count,
            AVG(a.sentiment_score)                     AS avg_sentiment,
            COUNT(*) FILTER (WHERE al.routing_type = 'source')  AS source_routes,
            COUNT(*) FILTER (WHERE al.routing_type = 'content') AS content_routes
          FROM article_locations al
          JOIN news_articles a ON a.id = al.article_id
          ${whereClause}
          GROUP BY 
            COALESCE(a.city_id, 0),
            a.country_id,
            COALESCE(al.city_id, 0),
            al.country_id
        )
        SELECT
          fc.flow_count,
          fc.avg_sentiment,
          fc.source_routes,
          fc.content_routes,
          CASE WHEN fc.src_city_id > 0 THEN src_city.latitude ELSE src_co.latitude END AS src_lat,
          CASE WHEN fc.src_city_id > 0 THEN src_city.longitude ELSE src_co.longitude END AS src_lon,
          CASE WHEN fc.src_city_id > 0 THEN src_city.name ELSE src_co.name END AS src_place,
          CASE WHEN fc.src_city_id > 0 THEN fc.src_city_id ELSE fc.src_country_id END AS src_id,
          CASE WHEN fc.src_city_id > 0 THEN 'city' ELSE 'country' END AS src_type,
          src_co.iso_code AS src_iso,
          CASE WHEN fc.dst_city_id > 0 THEN dst_city.latitude ELSE dst_co.latitude END AS dst_lat,
          CASE WHEN fc.dst_city_id > 0 THEN dst_city.longitude ELSE dst_co.longitude END AS dst_lon,
          CASE WHEN fc.dst_city_id > 0 THEN dst_city.name ELSE dst_co.name END AS dst_place,
          CASE WHEN fc.dst_city_id > 0 THEN fc.dst_city_id ELSE fc.dst_country_id END AS dst_id,
          CASE WHEN fc.dst_city_id > 0 THEN 'city' ELSE 'country' END AS dst_type,
          dst_co.iso_code AS dst_iso,
          MAX(fc.flow_count) OVER() AS max_count,
          SUM(fc.flow_count) OVER() AS total_articles
        FROM flow_counts fc
        JOIN countries src_co ON src_co.id = fc.src_country_id
        JOIN countries dst_co ON dst_co.id = fc.dst_country_id
        LEFT JOIN cities src_city ON src_city.id = fc.src_city_id
        LEFT JOIN cities dst_city ON dst_city.id = fc.dst_city_id
        ORDER BY fc.flow_count DESC
        LIMIT $${limitParam}
      `, params);

      const maxCount = rows.length ? parseInt(rows[0].max_count) : 1;
      const totalArticles = rows.length ? parseInt(rows[0].total_articles) : 0;

      const flows = rows.map(r => ({
        src: {
          lat: parseFloat(r.src_lat),
          lon: parseFloat(r.src_lon),
          place: r.src_place,
          id: r.src_id,
          type: r.src_type,
          iso: r.src_iso
        },
        dst: {
          lat: parseFloat(r.dst_lat),
          lon: parseFloat(r.dst_lon),
          place: r.dst_place,
          id: r.dst_id,
          type: r.dst_type,
          iso: r.dst_iso
        },
        count: parseInt(r.flow_count),
        avgSentiment: r.avg_sentiment ? parseFloat(r.avg_sentiment) : null,
        routingBreakdown: {
          source: parseInt(r.source_routes),
          content: parseInt(r.content_routes)
        }
      }));

      res.json({
        mode: "aggregate",
        totalRoutes: flows.length,
        totalArticles,
        maxCount,
        flows
      });

    } else {
      // ─────────────────────────────────────────
      // INDIVIDUAL MODE: Priority-scored, sqrt-normalized
      // ─────────────────────────────────────────
      
      // Fetch extra articles for normalization (3x limit, capped at 5000)
      const fetchLimit = normalize ? Math.min(limit * 3, 5000) : limit;
      params.push(fetchLimit);
      const limitParam = params.length;

      const { rows } = await pool.query(`
        SELECT
          a.id,
          COALESCE(a.translated_title, a.title) AS title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          a.article_url,
          a.image_url,
          a.published_at                        AS "publishedAt",
          a.sentiment_score                     AS sentiment,
          ns.name                               AS "sourceName",
          ns.popularity_score                   AS "popularityScore",
          ns.popularity_tier                    AS "popularityTier",
          al.routing_type                       AS "routingType",
          COALESCE(a.base_priority, 0)          AS intensity,
          COALESCE(src_city.latitude, src_co.latitude)   AS src_lat,
          COALESCE(src_city.longitude, src_co.longitude) AS src_lon,
          COALESCE(src_city.name, src_co.name)           AS src_place,
          CASE WHEN a.city_id IS NOT NULL THEN a.city_id ELSE a.country_id END AS src_id,
          CASE WHEN a.city_id IS NOT NULL THEN 'city' ELSE 'country' END AS src_type,
          src_co.iso_code AS src_iso,
          COALESCE(dst_city.latitude, dst_co.latitude)   AS dst_lat,
          COALESCE(dst_city.longitude, dst_co.longitude) AS dst_lon,
          COALESCE(dst_city.name, dst_co.name)           AS dst_place,
          CASE WHEN al.city_id IS NOT NULL THEN al.city_id ELSE al.country_id END AS dst_id,
          CASE WHEN al.city_id IS NOT NULL THEN 'city' ELSE 'country' END AS dst_type,
          dst_co.iso_code AS dst_iso
        FROM article_locations al
        JOIN news_articles a   ON a.id = al.article_id
        JOIN news_sources ns   ON ns.id = a.source_id
        JOIN countries src_co  ON src_co.id = a.country_id
        JOIN countries dst_co  ON dst_co.id = al.country_id
        LEFT JOIN cities src_city ON src_city.id = a.city_id
        LEFT JOIN cities dst_city ON dst_city.id = al.city_id
        ${whereClause}
        ORDER BY a.published_at DESC
        LIMIT $${limitParam}
      `, params);

      // Calculate priority scores using simplified scoring
      const maxIntensity = Math.max(...rows.map(r => parseFloat(r.intensity) || 0), 1);
      
      const scored = rows.map(r => ({
        ...r,
        priority: calculatePriority({
          rawIntensity:    parseFloat(r.intensity) || 0,
          maxIntensity,
          tagWeightSum:    0,  // Skip tag weight for performance
          popularityScore: parseFloat(r.popularityScore) || 1,
          popularityTier:  parseInt(r.popularityTier) || 1,
          publishedAt:     r.publishedAt,
          isCitySource:    r.src_type === 'city',  // National sources get priority
          cityPenaltyOverride: FLOW_CITY_PENALTY   // Gentler penalty - city articles can still compete
        })
      }));

      // Sort by priority
      scored.sort((a, b) => b.priority - a.priority);

      let selected;
      
      if (normalize && scored.length > 0) {
        // ─────────────────────────────────────────
        // SQRT-NORMALIZED DISTRIBUTION
        // Group by destination, allocate slots proportional to sqrt(count)
        // ─────────────────────────────────────────
        
        // Group articles by destination (city if present, else country)
        const byDestination = new Map();
        for (const article of scored) {
          const dstKey = article.dst_type === 'city' 
            ? `city:${article.dst_id}` 
            : `country:${article.dst_id}`;
          if (!byDestination.has(dstKey)) {
            byDestination.set(dstKey, []);
          }
          byDestination.get(dstKey).push(article);
        }

        // Calculate raw sqrt weights for each destination
        const destinations = [];
        for (const [key, articles] of byDestination) {
          destinations.push({
            key,
            articles,
            rawCount: articles.length,
            sqrtWeight: Math.sqrt(articles.length)
          });
        }

        // Sum of all sqrt weights
        const totalSqrtWeight = destinations.reduce((sum, d) => sum + d.sqrtWeight, 0);

        // Allocate slots: each destination gets at least 1, rest proportional to sqrt
        // Reserve 1 slot per destination, distribute remaining by sqrt proportion
        const guaranteedSlots = destinations.length;
        const remainingSlots = Math.max(0, limit - guaranteedSlots);

        for (const dest of destinations) {
          const proportionalSlots = totalSqrtWeight > 0 
            ? Math.floor((dest.sqrtWeight / totalSqrtWeight) * remainingSlots)
            : 0;
          dest.allocatedSlots = 1 + proportionalSlots;
        }

        // If we have leftover slots due to rounding, give them to highest-weight destinations
        let totalAllocated = destinations.reduce((sum, d) => sum + d.allocatedSlots, 0);
        destinations.sort((a, b) => b.sqrtWeight - a.sqrtWeight);
        
        let i = 0;
        while (totalAllocated < limit && i < destinations.length) {
          // Only add if destination has more articles available
          if (destinations[i].articles.length > destinations[i].allocatedSlots) {
            destinations[i].allocatedSlots++;
            totalAllocated++;
          }
          i++;
          if (i >= destinations.length) i = 0; // wrap around
          // Safety: break if we've cycled through all and none can accept more
          if (destinations.every(d => d.articles.length <= d.allocatedSlots)) break;
        }

        // Select top articles from each destination (already sorted by priority)
        selected = [];
        for (const dest of destinations) {
          const toTake = Math.min(dest.allocatedSlots, dest.articles.length);
          selected.push(...dest.articles.slice(0, toTake));
        }

        // Final sort by priority so animation order makes sense
        selected.sort((a, b) => b.priority - a.priority);
        
      } else {
        // No normalization: just take top N by priority
        selected = scored.slice(0, limit);
      }

      const flows = selected.map(r => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        articleUrl: r.article_url,
        imageUrl: r.image_url,
        publishedAt: r.publishedAt,
        sentiment: r.sentiment,
        sourceName: r.sourceName,
        routingType: r.routingType,
        priority: r.priority,
        src: {
          lat: parseFloat(r.src_lat),
          lon: parseFloat(r.src_lon),
          place: r.src_place,
          id: r.src_id,
          type: r.src_type,
          iso: r.src_iso
        },
        dst: {
          lat: parseFloat(r.dst_lat),
          lon: parseFloat(r.dst_lon),
          place: r.dst_place,
          id: r.dst_id,
          type: r.dst_type,
          iso: r.dst_iso
        }
      }));

      res.json({
        mode: "individual",
        normalized: normalize,
        total: flows.length,
        flows
      });
    }

  } catch (err) {
    console.error("Flows error:", err.message);
    res.status(500).json({ error: "Failed to fetch flows", detail: err.message });
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
   On-demand Translation
========================================= */
app.post("/api/translate", async (req, res) => {
  const { title, summary, id } = req.body || {};
  if (!title && !summary) return res.status(400).json({ error: "No text provided" });
  try {
    const [translatedTitle, translatedSummary] = await Promise.all([
      title   ? translateText(title,   "EN-US") : Promise.resolve(null),
      summary ? translateText(summary, "EN-US") : Promise.resolve(null),
    ]);
    if (id && (translatedTitle || translatedSummary)) {
      await pool.query(
        `UPDATE news_articles SET translated_title = COALESCE($1, translated_title), translated_summary = COALESCE($2, translated_summary) WHERE id = $3`,
        [translatedTitle, translatedSummary, id]
      );
    }
    res.json({ translatedTitle, translatedSummary });
  } catch (err) {
    console.error("On-demand translate error:", err.message);
    res.status(500).json({ error: "Translation failed" });
  }
});

/* =========================================
   Commodities — server-side cache
   Fetches gold/silver from gold-api.com (no key)
   Fetches oil, gas, lumber, steel from FRED (free key)
   Refreshes every 12 hours. Clients poll /api/commodities.
========================================= */

const FRED_API_KEY = process.env.FRED_API_KEY || "";

// In-memory cache — persists between client requests
const commodityCache = {
  gold:   { price: null, change: null, pct: null, updatedAt: null },
  silver: { price: null, change: null, pct: null, updatedAt: null },
  oil:    { price: null, change: null, pct: null, updatedAt: null },
  gas:    { price: null, change: null, pct: null, updatedAt: null },
  lumber: { price: null, change: null, pct: null, updatedAt: null },
  steel:  { price: null, change: null, pct: null, updatedAt: null },
};

// FRED series IDs
const FRED_SERIES = {
  oil:    "DCOILWTICO",  // WTI crude, daily, USD/barrel
  gas:    "DHHNGSP",     // Henry Hub natural gas, daily, USD/MMBtu
  lumber: "WPU081",      // PPI lumber, monthly, index
  steel:  "WPU101",      // PPI steel mill products, monthly, index
};

async function fetchGoldApiPrice(symbol, id) {
  try {
    const res  = await fetch(`https://api.gold-api.com/price/${symbol}`);
    if (!res.ok) throw new Error(`gold-api ${res.status}`);
    const data = await res.json();
    if (!data.price) throw new Error("no price field");
    const prev = commodityCache[id].price;
    commodityCache[id] = {
      price:     data.price,
      change:    prev != null ? data.price - prev : 0,
      pct:       prev != null && prev > 0 ? ((data.price - prev) / prev) * 100 : 0,
      updatedAt: data.updatedAt || new Date().toISOString(),
    };
    console.log(`[commodities] ${id} = $${data.price}`);
  } catch (e) {
    console.warn(`[commodities] ${id} fetch failed:`, e.message);
  }
}

async function fetchFredPrice(seriesId, id) {
  if (!FRED_API_KEY) {
    console.warn(`[commodities] FRED_API_KEY not set — skipping ${id}`);
    return;
  }
  try {
    // Pull last 2 observations so we can compute change
    const url = `https://api.stlouisfed.org/fred/series/observations`
      + `?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json`
      + `&sort_order=desc&limit=2`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`FRED ${res.status}`);
    const data = await res.json();
    const obs  = (data.observations || []).filter(o => o.value !== ".");
    if (!obs.length) throw new Error("no valid observations");
    const latest = parseFloat(obs[0].value);
    const prev   = obs[1] ? parseFloat(obs[1].value) : latest;
    commodityCache[id] = {
      price:     latest,
      change:    latest - prev,
      pct:       prev > 0 ? ((latest - prev) / prev) * 100 : 0,
      updatedAt: obs[0].date,
    };
    console.log(`[commodities] ${id} (FRED ${seriesId}) = ${latest}`);
  } catch (e) {
    console.warn(`[commodities] ${id} FRED fetch failed:`, e.message);
  }
}

async function refreshAllCommodities() {
  console.log("[commodities] refreshing...");
  await Promise.allSettled([
    fetchGoldApiPrice("XAU", "gold"),
    fetchGoldApiPrice("XAG", "silver"),
    fetchFredPrice(FRED_SERIES.oil,    "oil"),
    fetchFredPrice(FRED_SERIES.gas,    "gas"),
    fetchFredPrice(FRED_SERIES.lumber, "lumber"),
    fetchFredPrice(FRED_SERIES.steel,  "steel"),
  ]);
  console.log("[commodities] refresh complete");
}

// Fetch on startup, then every 12 hours
refreshAllCommodities();
setInterval(refreshAllCommodities, 12 * 60 * 60 * 1000);

app.get("/api/commodities", (req, res) => {
  res.json(commodityCache);
});

/* =========================================
   Keyword Routes
========================================= */

/* =========================================
   Keyword Intelligence API
========================================= */

// GET /api/keywords/trending?days=7&limit=20&source_country=us&about_country=cn
// Returns globally trending keywords (top by total mentions in date range)
app.get("/api/keywords/trending", async (req, res) => {
  const {
    days           = 7,
    limit          = 20,
    source_country = null,
    about_country  = null,
  } = req.query;

  try {
    const params = [parseInt(days)];
    let where = `WHERE date >= NOW() - ($1 || ' days')::INTERVAL
                 AND source_country_id IS NULL AND about_country_id IS NULL`;

    // If filtering by country, query those specific rows instead
    if (source_country || about_country) {
      where = `WHERE date >= NOW() - ($1 || ' days')::INTERVAL`;
      if (source_country) {
        params.push(source_country.toLowerCase());
        where += ` AND source_country_id = (SELECT id FROM countries WHERE LOWER(iso_code) = $${params.length} LIMIT 1)`;
      }
      if (about_country) {
        params.push(about_country.toLowerCase());
        where += ` AND about_country_id = (SELECT id FROM countries WHERE LOWER(iso_code) = $${params.length} LIMIT 1)`;
      }
    }

    params.push(parseInt(limit));
    const limitIdx = params.length;

    const { rows } = await pool.query(
      `SELECT
         keyword,
         SUM(total_count) AS mentions,
         COUNT(DISTINCT date) AS days_active
       FROM keyword_daily_stats
       ${where}
       GROUP BY keyword
       HAVING SUM(total_count) >= 3
       ORDER BY mentions DESC
       LIMIT $${limitIdx}`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("[keywords/trending]", err.message);
    res.status(500).json({ error: "trending failed" });
  }
});

// GET /api/keywords/rising?days=3&baseline_days=14&limit=15
// Returns keywords with recent spike vs baseline (momentum detection)
app.get("/api/keywords/rising", async (req, res) => {
  const {
    days          = 3,    // Recent window
    baseline_days = 14,   // Baseline comparison window
    limit         = 15,
  } = req.query;

  try {
    const { rows } = await pool.query(
      `WITH recent AS (
         SELECT keyword, SUM(total_count) AS recent_count
         FROM keyword_daily_stats
         WHERE date >= NOW() - ($1 || ' days')::INTERVAL
           AND source_country_id IS NULL AND about_country_id IS NULL
         GROUP BY keyword
         HAVING SUM(total_count) >= 2
       ),
       baseline AS (
         SELECT keyword, SUM(total_count) AS baseline_count
         FROM keyword_daily_stats
         WHERE date >= NOW() - ($2 || ' days')::INTERVAL
           AND date < NOW() - ($1 || ' days')::INTERVAL
           AND source_country_id IS NULL AND about_country_id IS NULL
         GROUP BY keyword
       )
       SELECT
         r.keyword,
         r.recent_count,
         COALESCE(b.baseline_count, 0) AS baseline_count,
         CASE
           WHEN COALESCE(b.baseline_count, 0) = 0 THEN r.recent_count * 10
           ELSE ROUND((r.recent_count::numeric / NULLIF(b.baseline_count, 0)::numeric * ($2::numeric / $1::numeric)) * 100) / 100
         END AS momentum
       FROM recent r
       LEFT JOIN baseline b ON b.keyword = r.keyword
       WHERE r.recent_count >= 2
       ORDER BY momentum DESC, r.recent_count DESC
       LIMIT $3`,
      [parseInt(days), parseInt(baseline_days), parseInt(limit)]
    );

    res.json(rows);
  } catch (err) {
    console.error("[keywords/rising]", err.message);
    res.status(500).json({ error: "rising failed" });
  }
});

// GET /api/keywords/autocomplete?q=clim
// Returns up to 10 distinct keywords matching the prefix
app.get("/api/keywords/autocomplete", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT keyword
       FROM article_keywords
       WHERE keyword ILIKE $1
       ORDER BY keyword ASC
       LIMIT 10`,
      [q + "%"]
    );
    res.json(rows.map(r => r.keyword));
  } catch (err) {
    console.error("[keywords/autocomplete]", err.message);
    res.status(500).json({ error: "autocomplete failed" });
  }
});

// GET /api/keywords/top?keyword=climate&days=7&source_country=us&about_country=cn&limit=20
// Returns total mention count for a keyword over a date range
app.get("/api/keywords/top", async (req, res) => {
  const {
    keyword,
    days           = 7,
    source_country = null,
    about_country  = null,
    limit          = 20,
  } = req.query;

  if (!keyword) return res.status(400).json({ error: "keyword required" });

  try {
    const params = [keyword.toLowerCase().trim(), parseInt(days)];
    let   where  = `WHERE keyword = $1 AND date >= NOW() - ($2 || ' days')::INTERVAL`;

    if (source_country) {
      params.push(source_country.toLowerCase());
      where += ` AND source_country_id = (SELECT id FROM countries WHERE LOWER(iso_code_2) = $${params.length})`;
    }
    if (about_country) {
      params.push(about_country.toLowerCase());
      where += ` AND about_country_id = (SELECT id FROM countries WHERE LOWER(iso_code_2) = $${params.length})`;
    }

    const limitIdx = params.push(parseInt(limit));
    const { rows } = await pool.query(
      `SELECT
         keyword,
         SUM(total_count)          AS total_mentions,
         SUM(language_group_count) AS language_groups,
         MIN(date)                 AS first_seen,
         MAX(date)                 AS last_seen
       FROM keyword_daily_stats
       ${where}
       GROUP BY keyword
       ORDER BY total_mentions DESC
       LIMIT $${limitIdx}`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("[keywords/top]", err.message);
    res.status(500).json({ error: "top keywords failed" });
  }
});

// GET /api/keywords/trend?keyword=ukraine&days=30&source_country=us&about_country=ua
// Returns day-by-day mention counts for a keyword (for line/bar charts)
app.get("/api/keywords/trend", async (req, res) => {
  const {
    keyword,
    days           = 30,
    source_country = null,
    about_country  = null,
  } = req.query;

  if (!keyword) return res.status(400).json({ error: "keyword required" });

  try {
    const params = [keyword.toLowerCase().trim(), parseInt(days)];
    let   where  = `WHERE keyword = $1 AND date >= NOW() - ($2 || ' days')::INTERVAL`;

    if (source_country) {
      params.push(source_country.toLowerCase());
      where += ` AND source_country_id = (SELECT id FROM countries WHERE LOWER(iso_code_2) = $${params.length})`;
    }
    if (about_country) {
      params.push(about_country.toLowerCase());
      where += ` AND about_country_id = (SELECT id FROM countries WHERE LOWER(iso_code_2) = $${params.length})`;
    }

    const { rows } = await pool.query(
      `WITH date_series AS (
         SELECT generate_series(
           (NOW() - ($2 || ' days')::INTERVAL)::date,
           NOW()::date,
           '1 day'::interval
         )::date AS date
       ),
       counts AS (
         SELECT date, SUM(total_count) AS mentions
         FROM keyword_daily_stats
         ${where}
         GROUP BY date
       )
       SELECT
         ds.date,
         COALESCE(c.mentions, 0) AS mentions
       FROM date_series ds
       LEFT JOIN counts c ON c.date = ds.date
       ORDER BY ds.date ASC`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("[keywords/trend]", err.message);
    res.status(500).json({ error: "trend failed" });
  }
});

// GET /api/keywords/cooccurrence?keyword=ukraine&days=30&limit=15
// Returns keywords most frequently mentioned alongside the given keyword
app.get("/api/keywords/cooccurrence", async (req, res) => {
  const { keyword, days = 30, limit = 15 } = req.query;
  if (!keyword) return res.status(400).json({ error: "keyword required" });

  try {
    const kw = keyword.toLowerCase().trim();
    const { rows } = await pool.query(
      `SELECT
         CASE WHEN keyword_a = $1 THEN keyword_b ELSE keyword_a END AS related_keyword,
         COUNT(*) AS co_mentions
       FROM keyword_cooccurrence
       WHERE (keyword_a = $1 OR keyword_b = $1)
         AND date >= NOW() - ($2 || ' days')::INTERVAL
       GROUP BY related_keyword
       ORDER BY co_mentions DESC
       LIMIT $3`,
      [kw, parseInt(days), parseInt(limit)]
    );
    res.json(rows);
  } catch (err) {
    console.error("[keywords/cooccurrence]", err.message);
    res.status(500).json({ error: "cooccurrence failed" });
  }
});

// GET /api/keywords/articles?keyword=ukraine&days=7&limit=20
// Returns recent articles containing the keyword
app.get("/api/keywords/articles", async (req, res) => {
  const { keyword, days = 7, limit = 20 } = req.query;
  if (!keyword) return res.status(400).json({ error: "keyword required" });

  try {
    const kw = keyword.toLowerCase().trim();
    const { rows } = await pool.query(
      `SELECT
         a.id,
         COALESCE(a.translated_title, a.title) AS title,
         COALESCE(a.translated_summary, a.summary) AS summary,
         a.image_url,
         a.article_url,
         a.published_at,
         a.sentiment_score,
         ns.name AS source_name,
         ns.site_url AS source_url,
         co.name AS country_name,
         co.iso_code,
         ak.frequency
       FROM article_keywords ak
       JOIN news_articles a ON a.id = ak.article_id
       JOIN news_sources ns ON ns.id = a.source_id
       LEFT JOIN countries co ON co.id = a.country_id
       WHERE ak.keyword = $1
         AND a.published_at >= NOW() - ($2 || ' days')::INTERVAL
       ORDER BY ak.frequency DESC, a.published_at DESC
       LIMIT $3`,
      [kw, parseInt(days), parseInt(limit)]
    );

    res.json(rows);
  } catch (err) {
    console.error("[keywords/articles]", err.message);
    res.status(500).json({ error: "articles lookup failed" });
  }
});

/* =========================================
   Region News Feed
   City-level articles only - aggregated via cities.region_id
   Local: articles FROM cities in this region (source-based)
   Global: articles that MENTION cities in this region (via article_locations)
========================================= */
app.get("/api/news/region/:regionId", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 12, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const regionId = parseInt(req.params.regionId);
    const feed = req.query.feed || "local"; // "local" or "global"

    let query;
    if (feed === "global") {
      // Global: articles that MENTION cities in this region (via article_locations)
      query = `
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
          ns.name         AS source_name,
          ns.site_url,
          ns.popularity_score,
          l.iso_code_2    AS language,
          co.iso_code,
          co.name         AS country_name,
          ci_mention.name AS city_name
        FROM article_locations al
        JOIN news_articles  a   ON a.id  = al.article_id
        JOIN news_sources   ns  ON ns.id = a.source_id
        JOIN cities ci_mention  ON ci_mention.id = al.city_id
        LEFT JOIN languages l   ON l.id  = ns.language_id
        LEFT JOIN countries co  ON co.id = a.country_id
        WHERE ci_mention.region_id = $1
          AND a.published_at > NOW() - INTERVAL '7 days'
        ORDER BY a.id, a.published_at DESC
        LIMIT $2 OFFSET $3
      `;
    } else {
      // Local: articles FROM cities in this region (source-based, city_id not null)
      query = `
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
          l.iso_code_2    AS language,
          co.iso_code,
          co.name         AS country_name,
          ci.name         AS city_name
        FROM news_articles a
        JOIN news_sources   ns  ON ns.id = a.source_id
        JOIN cities         ci  ON ci.id = a.city_id
        LEFT JOIN languages l   ON l.id  = ns.language_id
        LEFT JOIN countries co  ON co.id = a.country_id
        WHERE ci.region_id = $1
          AND a.published_at > NOW() - INTERVAL '7 days'
        ORDER BY a.published_at DESC
        LIMIT $2 OFFSET $3
      `;
    }

    const { rows } = await pool.query(query, [regionId, limit, offset]);
    
    // Get total count for pagination
    let countQuery;
    if (feed === "global") {
      countQuery = `
        SELECT COUNT(DISTINCT a.id) AS total
        FROM article_locations al
        JOIN news_articles a ON a.id = al.article_id
        JOIN cities ci_mention ON ci_mention.id = al.city_id
        WHERE ci_mention.region_id = $1
          AND a.published_at > NOW() - INTERVAL '7 days'
      `;
    } else {
      countQuery = `
        SELECT COUNT(*) AS total
        FROM news_articles a
        JOIN cities ci ON ci.id = a.city_id
        WHERE ci.region_id = $1
          AND a.published_at > NOW() - INTERVAL '7 days'
      `;
    }
    const countResult = await pool.query(countQuery, [regionId]);
    const total = parseInt(countResult.rows[0]?.total || 0);
    
    res.json({ articles: rows, total });
  } catch (err) {
    console.warn("[region news]", err.message);
    res.json({ articles: [], total: 0 });
  }
});


app.get("/api/land/geojson", (req, res) => {
  const file = path.join(__dirname, "ne_50m_land.geojson");
  res.setHeader("Content-Type", "application/json");
  res.sendFile(file, err => {
    if (err) {
      console.error("ne_50m_land.geojson sendFile error:", err.message, "| path:", file);
      if (!res.headersSent) res.status(404).json({ error: "ne_50m_land.geojson not found" });
    }
  });
});

// Get cities in a region
app.get("/api/regions/:regionId/cities", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.lat, c.lon, c.population, co.name AS country_name, co.iso_code
      FROM cities c
      LEFT JOIN countries co ON co.id = c.country_id
      WHERE c.region_id = $1
      ORDER BY c.population DESC NULLS LAST
    `, [req.params.regionId]);
    res.json(rows);
  } catch (err) {
    console.error("[region cities]", err.message);
    res.status(500).json({ error: "Failed to fetch region cities" });
  }
});

app.get("/api/regions", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, slug, continent_id, color,
             centroid_lng, centroid_lat, population
      FROM regions
      ORDER BY name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("[regions]", err.message);
    res.status(500).json({ error: "Failed to fetch regions" });
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

["ne_50m_land.geojson"].forEach(f => {
  const p = path.join(__dirname, f);
  fs.access(p, fs.constants.R_OK, err =>
    err
      ? console.error(`[startup] MISSING: ${p}`)
      : console.log(`[startup] OK: ${p}`)
  );
});

startArticleListener().catch(console.error);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));