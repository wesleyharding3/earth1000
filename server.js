const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const pool = require("./db");
const { startArticleListener } = require("./articleListener");
const { getRankedArticles, getRankedCityArticles } = require("./rankingService");
const { countryVarianceRerank, diversityRerank, calculatePriority, FLOW_CITY_PENALTY } = require("./priorityEngine");
const { translateText } = require("./translator");
const { generateLocationBriefing } = require("./locationBriefingGenerator");
const Anthropic = new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY });
const { resolveImagesForArticles } = require("./imageResolver");
const jwt = require("jsonwebtoken");
const payments = require("./payments");
const sba = require("./supabaseAdmin");
const { checkTranslation, checkExplanation, checkKwExplanation, checkBriefingAccess, checkCustomBriefing } = require("./tierLimits");

const app = express();
console.log("Node version:", process.version);
const corsOptions = {
  origin: [
    "https://wesleyharding3.github.io",
    "https://earth0.onrender.com",
    "http://localhost:3000",
    "http://localhost:5500",
    "capacitor://localhost",
    "ionic://localhost"
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept"],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(express.json());

const DATE_LIKE_KEYWORD_PATTERNS = [
  /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/i,
  /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/i,
  /^(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?$/i,
  /^\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:\s+\d{4})?$/i,
];

function isDateLikeKeyword(keyword) {
  const value = typeof keyword === "string" ? keyword.trim() : "";
  return value ? DATE_LIKE_KEYWORD_PATTERNS.some((pattern) => pattern.test(value)) : false;
}

function parseOptionalPositiveInt(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const tradeTableColumnCache = new Map();
const TRADE_VALUE_COLUMN_CANDIDATES = ["annual_profit", "annual_cost", "value", "total_value", "exports_value", "imports_value", "amount"];
const TRADE_ITEM_COLUMN_CANDIDATES = ["name", "label", "product", "commodity", "item_name", "category"];
const TRADE_YEAR_COLUMN_CANDIDATES = ["year", "data_year", "trade_year"];
const TRADE_RANK_COLUMN_CANDIDATES = ["rank"];

function pickTradeColumn(columns, candidates) {
  for (const candidate of candidates) {
    if (columns.has(candidate)) return candidate;
  }
  return null;
}

async function getTradeTableColumns(tableName) {
  if (tradeTableColumnCache.has(tableName)) return tradeTableColumnCache.get(tableName);

  const { rows } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
  `, [tableName]);

  const columns = new Set(rows.map((row) => row.column_name));
  tradeTableColumnCache.set(tableName, columns);
  return columns;
}

async function getTradeSummary(tableName, query) {
  const countryId = parseOptionalPositiveInt(query.country_id);
  const cityId = parseOptionalPositiveInt(query.city_id);
  const requestedYear = parseOptionalPositiveInt(query.year);
  const topLimit = Math.min(parseOptionalPositiveInt(query.top, 6) || 6, 12);

  if (!countryId && !cityId) {
    const err = new Error("country_id or city_id required");
    err.status = 400;
    throw err;
  }

  const columns = await getTradeTableColumns(tableName);
  if (!columns.size) {
    const err = new Error(`Table "${tableName}" not found`);
    err.status = 404;
    throw err;
  }

  if (!columns.has("country_id") || !columns.has("city_id")) {
    const err = new Error(`Table "${tableName}" is missing country_id/city_id`);
    err.status = 500;
    throw err;
  }

  const valueColumn = pickTradeColumn(columns, TRADE_VALUE_COLUMN_CANDIDATES);
  if (!valueColumn) {
    const err = new Error(`Table "${tableName}" is missing a supported value column`);
    err.status = 500;
    throw err;
  }

  const yearColumn = pickTradeColumn(columns, TRADE_YEAR_COLUMN_CANDIDATES);
  const itemColumn = pickTradeColumn(columns, TRADE_ITEM_COLUMN_CANDIDATES);
  const rankColumn = pickTradeColumn(columns, TRADE_RANK_COLUMN_CANDIDATES);

  const baseConditions = [];
  const baseParams = [];

  if (cityId) {
    if (countryId) {
      baseParams.push(countryId);
      baseConditions.push(`country_id = $${baseParams.length}`);
    }
    baseParams.push(cityId);
    baseConditions.push(`city_id = $${baseParams.length}`);
  } else {
    baseParams.push(countryId);
    baseConditions.push(`country_id = $${baseParams.length}`);
    baseConditions.push(`city_id IS NULL`);
  }

  let effectiveYear = requestedYear;
  if (yearColumn && !effectiveYear) {
    const latestYearSql = `
      SELECT MAX(${yearColumn}) AS year
      FROM ${tableName}
      WHERE ${baseConditions.join(" AND ")}
    `;
    const { rows } = await pool.query(latestYearSql, baseParams);
    effectiveYear = rows[0]?.year != null ? parseInt(rows[0].year, 10) : null;
  }

  const conditions = [...baseConditions];
  const params = [...baseParams];
  if (yearColumn && effectiveYear) {
    params.push(effectiveYear);
    conditions.push(`${yearColumn} = $${params.length}`);
  }

  const whereClause = conditions.join(" AND ");

  const totalSql = `
    SELECT COALESCE(SUM(${valueColumn}), 0)::numeric AS total_value
    FROM ${tableName}
    WHERE ${whereClause}
  `;
  const totalPromise = pool.query(totalSql, params);

  let topItemsPromise = Promise.resolve({ rows: [] });
  if (itemColumn) {
    const topParams = [...params, topLimit];
    const orderBy = rankColumn
      ? `${rankColumn} ASC, name ASC`
      : `value DESC, name ASC`;
    const topItemsSql = `
      SELECT
        ${itemColumn} AS name,
        COALESCE(SUM(${valueColumn}), 0)::numeric AS value
        ${rankColumn ? `, MIN(${rankColumn}) AS rank` : ""}
      FROM ${tableName}
      WHERE ${whereClause}
        AND ${itemColumn} IS NOT NULL
      GROUP BY ${itemColumn}
      ORDER BY ${orderBy}
      LIMIT $${topParams.length}
    `;
    topItemsPromise = pool.query(topItemsSql, topParams);
  }

  const [totalRes, topItemsRes] = await Promise.all([totalPromise, topItemsPromise]);
  return {
    value: totalRes.rows[0]?.total_value != null ? Number(totalRes.rows[0].total_value) : null,
    total_value: totalRes.rows[0]?.total_value != null ? Number(totalRes.rows[0].total_value) : null,
    year: effectiveYear,
    top_items: topItemsRes.rows.map((row) => ({
      name: row.name,
      value: row.value != null ? Number(row.value) : null
    }))
  };
}

/* =========================================
   Auth Middleware
   SUPABASE_JWT_SECRET must be set in .env
   (Supabase dashboard → Project Settings → API → JWT Secret)
========================================= */
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const TIER_ORDER = ["free", "pro", "enterprise"];

function pickBestActiveSubscription(subscriptions = []) {
  const activeSubs = (subscriptions || []).filter((subscription) => subscription?.status === "active");
  if (!activeSubs.length) return null;

  return activeSubs.sort((a, b) => {
    const tierA = TIER_ORDER.indexOf(a?.subscription_tiers?.name || "free");
    const tierB = TIER_ORDER.indexOf(b?.subscription_tiers?.name || "free");
    if (tierA !== tierB) return tierB - tierA;
    const updatedA = new Date(a?.updated_at || 0).getTime();
    const updatedB = new Date(b?.updated_at || 0).getTime();
    return updatedB - updatedA;
  })[0];
}

async function resolveTierRecordById(tierId) {
  if (!tierId) return null;
  const { data, error } = await sba
    .from("subscription_tiers")
    .select("id, name, display_name")
    .eq("id", tierId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// optionalAuth — enriches req.user when a valid Bearer JWT is present.
// Loads is_admin + active tier from Supabase. Falls through silently if no token.
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ") || !SUPABASE_JWT_SECRET) return next();
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };

    // Load admin flag + active subscription tier from Supabase
    const { data: profile } = await sba
      .from("profiles")
      .select("is_admin, subscriptions(status, updated_at, subscription_tiers(name))")
      .eq("id", req.user.id)
      .maybeSingle();

    if (profile) {
      req.user.is_admin = profile.is_admin || false;
      const { data: subs, error: subsError } = await sba
        .from("subscriptions")
        .select("status, updated_at, tier_id")
        .eq("user_id", req.user.id)
        .eq("status", "active");
      if (subsError) throw new Error(subsError.message);
      const activeSub = pickBestActiveSubscription(subs || []);
      const tierRow = await resolveTierRecordById(activeSub?.tier_id);
      req.user.tier = tierRow?.name || "free";
    } else {
      req.user.is_admin = false;
      req.user.tier     = "free";
    }
  } catch (_) {
    // Invalid / expired token — treat request as anonymous
  }
  next();
}

async function resolveSupabaseUserFromRequest(req) {
  if (req.user?.id) return req.user;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const { data, error } = await sba.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    req.user = {
      ...(req.user || {}),
      id: data.user.id,
      email: data.user.email || null,
      is_admin: false,
      tier: "free"
    };
    return req.user;
  } catch (_) {
    return null;
  }
}

// requireAuth — rejects anonymous requests with 401
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  next();
}

// requireTier — factory that enforces a minimum subscription level.
// Admins bypass all tier gates.
function requireTier(minTier) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (req.user.is_admin) return next();
    const userLevel = TIER_ORDER.indexOf(req.user.tier || "free");
    const reqLevel  = TIER_ORDER.indexOf(minTier);
    if (userLevel >= reqLevel) return next();
    return res.status(403).json({
      error: `A ${minTier} subscription is required for this feature`,
      requiredTier: minTier
    });
  };
}

// Apply optionalAuth globally — enriches req.user on every request when a token is present
app.use(optionalAuth);

// Mount payment routes after optionalAuth so subscription activation can require req.user
app.use("/api/payments", payments.router);

/* =========================================
   Auth — Profile (requires valid JWT)
========================================= */
app.get("/api/auth/profile", async (req, res) => {
  try {
    const authUser = await resolveSupabaseUserFromRequest(req);
    if (!authUser?.id) return res.status(401).json({ error: "Authentication required" });

    const { data: profile, error } = await sba
      .from("profiles")
      .select("id, is_admin, created_at")
      .eq("id", authUser.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const { data: subs, error: subsError } = await sba
      .from("subscriptions")
      .select("status, updated_at, tier_id")
      .eq("user_id", authUser.id)
      .eq("status", "active");
    if (subsError) throw new Error(subsError.message);
    const activeSub = pickBestActiveSubscription(subs || []);
    const tierRow = await resolveTierRecordById(activeSub?.tier_id);
    res.json({
      id:                   profile.id,
      is_admin:             profile.is_admin,
      created_at:           profile.created_at,
      tier_name:            tierRow?.name || "free",
      tier_display_name:    tierRow?.display_name || "Free",
      subscription_status:  activeSub?.status || null,
      email:                authUser.email,
    });
  } catch (err) {
    console.error("[auth/profile]", err.message);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

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
   Image Resolution
========================================= */
app.post("/api/images/resolve", async (req, res) => {
  try {
    const articleIds = Array.isArray(req.body?.articleIds) ? req.body.articleIds.slice(0, 100) : [];
    const surface = typeof req.body?.surface === "string" && req.body.surface.trim()
      ? req.body.surface.trim().slice(0, 32)
      : "feed";

    if (!articleIds.length) return res.json({ images: [] });

    const images = await resolveImagesForArticles(articleIds, { surface });
    res.json({ images });
  } catch (err) {
    console.error("Image resolve error:", err.message);
    res.status(500).json({ error: "Failed to resolve images" });
  }
});

/* =========================================
   City Feed — Local (ranked, optional tag)
========================================= */
app.get("/api/news/city/:cityId", async (req, res) => {
  try {
    const limit  = parseOptionalPositiveInt(req.query.limit);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const tagId  = req.query.tag ? parseInt(req.query.tag) : null;

    const ranked = await getRankedCityArticles(parseInt(req.params.cityId), { limit, offset, tagId });
    res.json(ranked);
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
    const limit  = parseOptionalPositiveInt(req.query.limit);
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
        COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
        a.published_at,
        COALESCE(ns.name, ys.name) AS source_name,
        ns.source_summary,
        COALESCE(ns.bias, 'unknown') AS source_bias,
        COALESCE(ns.site_url, ys.site_url) AS site_url,
        COALESCE(ns.popularity_score, 0) AS popularity_score,
          l.iso_code_2 AS language,
        co.iso_code,
        co.name          AS country_name,
        ci.name          AS city_name,
        a.media_type,
        a.video_id,
        a.duration_seconds
      FROM article_locations al
      JOIN news_articles a   ON a.id  = al.article_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN languages  l  ON l.id = ns.language_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN cities    ci ON ci.id = a.city_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      ${tagJoin}
      WHERE al.city_id        = $1
        AND al.routing_type   IN ('content', 'source')
        AND a.city_id        != $1
        ${tagWhere}
      ORDER BY a.id, ${tagOrder}
      ${limit ? "LIMIT $2" : ""}
      OFFSET $${limit ? 3 : 2}
    `, limit ? [req.params.cityId, limit, offset] : [req.params.cityId, offset]);

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
    const limit  = parseOptionalPositiveInt(req.query.limit);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const tagId  = req.query.tag ? parseInt(req.query.tag) : null;

    const ranked = await getRankedArticles(parseInt(req.params.countryId), { limit, offset, tagId });
    res.json(ranked);
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
    const limit  = parseOptionalPositiveInt(req.query.limit);
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
        COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
        a.published_at,
        COALESCE(ns.name, ys.name) AS source_name,
        ns.source_summary,
        COALESCE(ns.bias, 'unknown') AS source_bias,
        COALESCE(ns.site_url, ys.site_url) AS site_url,
        COALESCE(ns.popularity_score, 0) AS popularity_score,
          l.iso_code_2 AS language,
        co.iso_code,
        co.name          AS country_name,
        ci.name          AS city_name,
        a.media_type,
        a.video_id,
        a.duration_seconds
      FROM article_locations al
      JOIN news_articles a   ON a.id  = al.article_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN languages  l  ON l.id = ns.language_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN cities    ci ON ci.id = a.city_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      ${tagJoin}
      WHERE al.country_id     = $1
        AND al.routing_type   IN ('content', 'source')
        AND a.country_id     != $1
        ${tagWhere}
      ORDER BY a.id, ${tagOrder}
      ${limit ? "LIMIT $2" : ""}
      OFFSET $${limit ? 3 : 2}
    `, limit ? [req.params.countryId, limit, offset] : [req.params.countryId, offset]);

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
    const limit  = parseOptionalPositiveInt(req.query.limit);
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

    // Default time gate: no explicit date filter → cap at 72 hours.
    // Prevents week-old articles from outranking today's news via country_boost.
    if (!fromDate && !toDate) {
      conditions.push(`a.published_at > NOW() - INTERVAL '72 hours'`);
    }

    const whereClause = conditions.length
      ? "WHERE " + conditions.join(" AND ")
      : "";

    const needsLocJoin = !!aboutIds?.length;

    let limitClause;
    if (limit) {
      params.push(limit, offset);
      const limitParam  = params.length - 1;
      const offsetParam = params.length;
      limitClause = `LIMIT $${limitParam} OFFSET $${offsetParam}`;
    } else {
      params.push(offset);
      const offsetParam = params.length;
      limitClause = `OFFSET $${offsetParam}`;
    }

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
          COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
          a.published_at,
          a.sentiment_score,
          l.iso_code_2 AS language,
          a.base_priority,
          COALESCE(ns.name, ys.name) AS source_name,
          ns.source_summary,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          COALESCE(ns.site_url, ys.site_url) AS site_url,
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
          ) AS recency_decay,
          a.media_type,
          a.video_id,
          a.duration_seconds
          ${needsLocJoin ? ", about_co.name AS about_country_name" : ""}
        FROM news_articles a
        LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN languages  l  ON l.id = ns.language_id
        JOIN countries src_co    ON src_co.id   = a.country_id
        LEFT JOIN country_feed_boost cfb ON cfb.country_id = a.country_id
        LEFT JOIN cities ci       ON ci.id      = a.city_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        ${needsLocJoin ? `
          JOIN article_locations al  ON al.article_id = a.id
          JOIN countries about_co    ON about_co.id   = al.country_id
        ` : ""}
        ${whereClause}
        ORDER BY a.id
      ) sub
      ORDER BY (
        (COALESCE(sub.base_priority, 0) * 0.15 + sub.recency_decay * 0.85)
        * POWER(sub.country_boost, 2.0)
      ) DESC
      ${limitClause}
    `, params);

    let results = rows.map(r => ({
      ...r,
      // Fix: boost² applied to the whole blended score, not just recency
      final_priority: (
        (r.base_priority || 0) * 0.15 + (r.recency_decay || 0) * 0.85
      ) * Math.pow(r.country_boost || 1, 2.0)
    }));

    // Variation first: source diversity before country variance
    results = diversityRerank(results.map(r => ({
      ...r,
      priority: r.final_priority
    })));

    results = countryVarianceRerank(results);

    // Final pass: only tiebreak by date within a very tight band (3%)
    const PRIORITY_BAND = 0.03;
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
    let viewMode = req.query.view_mode || "country";  // country, city, region/regions
    // Normalize "regions" to "region"
    if (viewMode === "regions") viewMode = "region";
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

    // View-mode specific filtering
    if (viewMode === "city") {
      // City view: both source AND destination must be cities
      conditions.push(`a.city_id IS NOT NULL`);
      conditions.push(`al.city_id IS NOT NULL`);
      // Different cities (can be same or different country)
      conditions.push(`a.city_id != al.city_id`);
    } else if (viewMode === "region") {
      // Region view: both must be cities, different regions
      conditions.push(`a.city_id IS NOT NULL`);
      conditions.push(`al.city_id IS NOT NULL`);
      conditions.push(`a.city_id != al.city_id`);
      // Will add region exclusion after JOINs are defined
    } else {
      // Country view (default): exclude same-country flows
      conditions.push(`a.country_id != al.country_id`);
    }

    const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    if (mode === "aggregate") {
      // ─────────────────────────────────────────
      // AGGREGATE MODE: Group by src/dst, return counts
      // ─────────────────────────────────────────
      params.push(limit);
      const limitParam = params.length;

      // Build region-aware query for aggregate mode
      let aggregateQuery;
      
      if (viewMode === "region") {
        // Region view: group by region, exclude same-region flows
        aggregateQuery = `
          WITH flow_counts AS (
            SELECT
              src_city.region_id                           AS src_region_id,
              dst_city.region_id                           AS dst_region_id,
              COUNT(*)                                     AS flow_count,
              AVG(a.sentiment_score)                       AS avg_sentiment,
              COUNT(*) FILTER (WHERE al.routing_type = 'source')  AS source_routes,
              COUNT(*) FILTER (WHERE al.routing_type = 'content') AS content_routes
            FROM article_locations al
            JOIN news_articles a ON a.id = al.article_id
            JOIN cities src_city ON src_city.id = a.city_id
            JOIN cities dst_city ON dst_city.id = al.city_id
            ${whereClause}
            AND src_city.region_id IS NOT NULL
            AND dst_city.region_id IS NOT NULL
            AND src_city.region_id != dst_city.region_id
            GROUP BY src_city.region_id, dst_city.region_id
          )
          SELECT
            fc.flow_count,
            fc.avg_sentiment,
            fc.source_routes,
            fc.content_routes,
            src_r.centroid_lat AS src_lat,
            src_r.centroid_lng AS src_lon,
            src_r.name AS src_place,
            fc.src_region_id AS src_id,
            'region' AS src_type,
            NULL AS src_iso,
            fc.src_region_id AS src_region_id,
            dst_r.centroid_lat AS dst_lat,
            dst_r.centroid_lng AS dst_lon,
            dst_r.name AS dst_place,
            fc.dst_region_id AS dst_id,
            'region' AS dst_type,
            NULL AS dst_iso,
            fc.dst_region_id AS dst_region_id,
            MAX(fc.flow_count) OVER() AS max_count,
            SUM(fc.flow_count) OVER() AS total_articles
          FROM flow_counts fc
          JOIN regions src_r ON src_r.id = fc.src_region_id
          JOIN regions dst_r ON dst_r.id = fc.dst_region_id
          ORDER BY fc.flow_count DESC
          LIMIT $${limitParam}
        `;
      } else if (viewMode === "city") {
        // City view: city to city only
        aggregateQuery = `
          WITH flow_counts AS (
            SELECT
              a.city_id                                    AS src_city_id,
              al.city_id                                   AS dst_city_id,
              COUNT(*)                                     AS flow_count,
              AVG(a.sentiment_score)                       AS avg_sentiment,
              COUNT(*) FILTER (WHERE al.routing_type = 'source')  AS source_routes,
              COUNT(*) FILTER (WHERE al.routing_type = 'content') AS content_routes
            FROM article_locations al
            JOIN news_articles a ON a.id = al.article_id
            ${whereClause}
            GROUP BY a.city_id, al.city_id
          )
          SELECT
            fc.flow_count,
            fc.avg_sentiment,
            fc.source_routes,
            fc.content_routes,
            src_city.latitude AS src_lat,
            src_city.longitude AS src_lon,
            src_city.name AS src_place,
            fc.src_city_id AS src_id,
            'city' AS src_type,
            src_co.iso_code AS src_iso,
            src_city.region_id AS src_region_id,
            dst_city.latitude AS dst_lat,
            dst_city.longitude AS dst_lon,
            dst_city.name AS dst_place,
            fc.dst_city_id AS dst_id,
            'city' AS dst_type,
            dst_co.iso_code AS dst_iso,
            dst_city.region_id AS dst_region_id,
            MAX(fc.flow_count) OVER() AS max_count,
            SUM(fc.flow_count) OVER() AS total_articles
          FROM flow_counts fc
          JOIN cities src_city ON src_city.id = fc.src_city_id
          JOIN cities dst_city ON dst_city.id = fc.dst_city_id
          JOIN countries src_co ON src_co.id = src_city.country_id
          JOIN countries dst_co ON dst_co.id = dst_city.country_id
          ORDER BY fc.flow_count DESC
          LIMIT $${limitParam}
        `;
      } else {
        // Country view (default): country to country
        aggregateQuery = `
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
            CASE WHEN fc.src_city_id > 0 THEN src_city.region_id ELSE NULL END AS src_region_id,
            CASE WHEN fc.dst_city_id > 0 THEN dst_city.latitude ELSE dst_co.latitude END AS dst_lat,
            CASE WHEN fc.dst_city_id > 0 THEN dst_city.longitude ELSE dst_co.longitude END AS dst_lon,
            CASE WHEN fc.dst_city_id > 0 THEN dst_city.name ELSE dst_co.name END AS dst_place,
            CASE WHEN fc.dst_city_id > 0 THEN fc.dst_city_id ELSE fc.dst_country_id END AS dst_id,
            CASE WHEN fc.dst_city_id > 0 THEN 'city' ELSE 'country' END AS dst_type,
            dst_co.iso_code AS dst_iso,
            CASE WHEN fc.dst_city_id > 0 THEN dst_city.region_id ELSE NULL END AS dst_region_id,
            MAX(fc.flow_count) OVER() AS max_count,
            SUM(fc.flow_count) OVER() AS total_articles
          FROM flow_counts fc
          JOIN countries src_co ON src_co.id = fc.src_country_id
          JOIN countries dst_co ON dst_co.id = fc.dst_country_id
          LEFT JOIN cities src_city ON src_city.id = fc.src_city_id
          LEFT JOIN cities dst_city ON dst_city.id = fc.dst_city_id
          ORDER BY fc.flow_count DESC
          LIMIT $${limitParam}
        `;
      }

      const { rows } = await pool.query(aggregateQuery, params);

      const maxCount = rows.length ? parseInt(rows[0].max_count) : 1;
      const totalArticles = rows.length ? parseInt(rows[0].total_articles) : 0;

      const flows = rows.map(r => ({
        src: {
          lat: parseFloat(r.src_lat),
          lon: parseFloat(r.src_lon),
          place: r.src_place,
          id: r.src_id,
          type: r.src_type,
          iso: r.src_iso,
          regionId: r.src_region_id || null
        },
        dst: {
          lat: parseFloat(r.dst_lat),
          lon: parseFloat(r.dst_lon),
          place: r.dst_place,
          id: r.dst_id,
          type: r.dst_type,
          iso: r.dst_iso,
          regionId: r.dst_region_id || null
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

      // For region view, add region exclusion
      let regionExclusionClause = "";
      if (viewMode === "region") {
        regionExclusionClause = `
          AND src_city.region_id IS NOT NULL
          AND dst_city.region_id IS NOT NULL
          AND src_city.region_id != dst_city.region_id
        `;
      }

      const { rows } = await pool.query(`
        SELECT
          a.id,
          a.title AS "originalTitle",
          a.summary AS "originalSummary",
          a.translated_title AS "translatedTitle",
          a.translated_summary AS "translatedSummary",
          COALESCE(a.translated_title, a.title) AS title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          a.article_url,
          COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
          a.published_at                        AS "publishedAt",
          a.sentiment_score                     AS sentiment,
          COALESCE(ns.name, ys.name)            AS "sourceName",
          ns.source_summary                     AS "sourceSummary",
          COALESCE(ns.bias, 'unknown')          AS "sourceBias",
          COALESCE(ns.popularity_score, 1.0)    AS "popularityScore",
          COALESCE(ns.popularity_tier, 1)       AS "popularityTier",
          al.routing_type                       AS "routingType",
          COALESCE(a.base_priority, 0)          AS intensity,
          COALESCE(src_city.latitude, src_co.latitude)   AS src_lat,
          COALESCE(src_city.longitude, src_co.longitude) AS src_lon,
          COALESCE(src_city.name, src_co.name)           AS src_place,
          CASE WHEN a.city_id IS NOT NULL THEN a.city_id ELSE a.country_id END AS src_id,
          CASE WHEN a.city_id IS NOT NULL THEN 'city' ELSE 'country' END AS src_type,
          src_co.iso_code AS src_iso,
          src_city.region_id AS src_region_id,
          src_r.centroid_lat AS src_region_lat,
          src_r.centroid_lng AS src_region_lon,
          COALESCE(dst_city.latitude, dst_co.latitude)   AS dst_lat,
          COALESCE(dst_city.longitude, dst_co.longitude) AS dst_lon,
          COALESCE(dst_city.name, dst_co.name)           AS dst_place,
          CASE WHEN al.city_id IS NOT NULL THEN al.city_id ELSE al.country_id END AS dst_id,
          CASE WHEN al.city_id IS NOT NULL THEN 'city' ELSE 'country' END AS dst_type,
          dst_co.iso_code AS dst_iso,
          dst_city.region_id AS dst_region_id,
          dst_r.centroid_lat AS dst_region_lat,
          dst_r.centroid_lng AS dst_region_lon
        FROM article_locations al
        JOIN news_articles a   ON a.id = al.article_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        JOIN countries src_co  ON src_co.id = a.country_id
        JOIN countries dst_co  ON dst_co.id = al.country_id
        LEFT JOIN cities src_city ON src_city.id = a.city_id
        LEFT JOIN cities dst_city ON dst_city.id = al.city_id
        LEFT JOIN regions src_r ON src_r.id = src_city.region_id
        LEFT JOIN regions dst_r ON dst_r.id = dst_city.region_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        ${whereClause}
        ${regionExclusionClause}
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
        originalTitle: r.originalTitle,
        originalSummary: r.originalSummary,
        translatedTitle: r.translatedTitle,
        translatedSummary: r.translatedSummary,
        articleUrl: r.article_url,
        imageUrl: r.image_url,
        publishedAt: r.publishedAt,
        sentiment: r.sentiment,
        sourceName: r.sourceName,
        sourceBias: r.sourceBias,
        routingType: r.routingType,
        priority: r.priority,
        src: {
          lat: parseFloat(r.src_lat),
          lon: parseFloat(r.src_lon),
          place: r.src_place,
          id: r.src_id,
          type: r.src_type,
          iso: r.src_iso,
          regionId: r.src_region_id || null,
          regionLat: r.src_region_lat ? parseFloat(r.src_region_lat) : null,
          regionLon: r.src_region_lon ? parseFloat(r.src_region_lon) : null
        },
        dst: {
          lat: parseFloat(r.dst_lat),
          lon: parseFloat(r.dst_lon),
          place: r.dst_place,
          id: r.dst_id,
          type: r.dst_type,
          iso: r.dst_iso,
          regionId: r.dst_region_id || null,
          regionLat: r.dst_region_lat ? parseFloat(r.dst_region_lat) : null,
          regionLon: r.dst_region_lon ? parseFloat(r.dst_region_lon) : null
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
   Trade Stats
========================================= */
app.get("/api/exports", async (req, res) => {
  try {
    const data = await getTradeSummary("exports", req.query);
    res.json(data);
  } catch (err) {
    const status = err.status || 500;
    console.error("[exports]", err.message);
    res.status(status).json({ error: err.message || "Failed to fetch exports" });
  }
});

app.get("/api/imports", async (req, res) => {
  try {
    const data = await getTradeSummary("imports", req.query);
    res.json(data);
  } catch (err) {
    const status = err.status || 500;
    console.error("[imports]", err.message);
    res.status(status).json({ error: err.message || "Failed to fetch imports" });
  }
});

/* =========================================
   Daily Briefing Endpoints
========================================= */

// GET /api/articles/by-ids?ids=1,2,3 — fetch specific articles by ID (used by briefing player)
app.get("/api/articles/by-ids", async (req, res) => {
  try {
    const ids = (req.query.ids || "").split(",").map(Number).filter(Boolean).slice(0, 20);
    if (!ids.length) return res.json([]);
    const { rows } = await pool.query(`
      SELECT
        a.id, a.title, a.translated_title, a.summary, a.translated_summary,
        a.published_at, a.url, a.video_id, a.media_type,
        COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
        COALESCE(ns.name, ys.name) AS source_name,
        ns.source_summary,
        COALESCE(ns.bias, 'unknown') AS source_bias,
        co.name AS country_name, co.iso_code,
        ci.name AS city_name
      FROM news_articles a
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN cities ci ON ci.id = a.city_id
      WHERE a.id = ANY($1::int[])
      ORDER BY array_position($1::int[], a.id)
    `, [ids]);
    res.json(rows);
  } catch (err) {
    console.error("[articles/by-ids]", err.message);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});

// GET /api/articles/by-thread?thread_id=X&limit=20 — articles for a cluster node thread
app.get("/api/articles/by-thread", async (req, res) => {
  try {
    const threadId = parseInt(req.query.thread_id, 10);
    if (!threadId) return res.status(400).json({ error: "thread_id required" });
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 40);
    const { rows } = await pool.query(`
      SELECT
        a.id, a.title, a.translated_title, a.summary, a.translated_summary,
        a.published_at, a.url, a.video_id, a.media_type,
        COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
        COALESCE(ns.name, ys.name) AS source_name,
        ns.source_summary,
        COALESCE(ns.bias, 'unknown') AS source_bias,
        co.name AS country_name, co.iso_code,
        ci.name AS city_name,
        sta.relevance_score, sta.is_anchor
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN cities ci ON ci.id = a.city_id
      WHERE sta.thread_id = $1
      ORDER BY sta.is_anchor DESC, sta.relevance_score DESC, a.published_at DESC
      LIMIT $2
    `, [threadId, limit]);
    res.json(rows);
  } catch (err) {
    console.error("[articles/by-thread]", err.message);
    res.status(500).json({ error: "Failed to fetch thread articles" });
  }
});

// GET /api/threads/latest — top story threads with hero image from highest-scored article
app.get("/api/threads/latest", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    // Step 1: get threads
    const { rows: threads } = await pool.query(`
      SELECT
        id AS thread_id, title, description, primary_category,
        geographic_scope, importance, keywords, article_count,
        last_updated_at
      FROM story_threads
      WHERE article_count >= 2
      ORDER BY importance DESC, article_count DESC, last_updated_at DESC NULLS LAST
      LIMIT $1
    `, [limit]);

    if (!threads.length) return res.json([]);

    // Step 2: batch-fetch hero images for all threads
    const threadIds = threads.map(t => t.thread_id);
    const { rows: heroes } = await pool.query(`
      SELECT DISTINCT ON (sta.thread_id)
        sta.thread_id,
        COALESCE(a.image_url, img_a.public_url) AS hero_image_url,
        img_a.public_url AS hero_catalog_image_url,
        COALESCE(ns.name, ys.name) AS hero_source_name,
        co.iso_code AS hero_iso_code
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE sta.thread_id = ANY($1)
        AND (a.image_url IS NOT NULL OR img_a.public_url IS NOT NULL)
      ORDER BY sta.thread_id, sta.relevance_score DESC, a.published_at DESC
    `, [threadIds]);

    const heroMap = new Map(heroes.map(h => [h.thread_id, h]));

    const result = threads.map(t => {
      const h = heroMap.get(t.thread_id);
      return {
        ...t,
        hero_image_url: h?.hero_image_url || null,
        hero_catalog_image_url: h?.hero_catalog_image_url || null,
        hero_source_name: h?.hero_source_name || null,
        hero_iso_code: h?.hero_iso_code || null
      };
    });

    res.json(result);
  } catch (err) {
    console.error("[threads/latest]", err.message, err.stack);
    res.status(500).json({ error: "Failed to fetch threads", detail: err.message });
  }
});

// POST /api/cluster-node/summary — 200-word unbiased Claude-generated description using deep article search
app.post("/api/cluster-node/summary", async (req, res) => {
  const { thread_id } = req.body || {};
  const threadId = parseInt(thread_id, 10);
  if (!threadId) return res.status(400).json({ error: "thread_id required" });

  try {
    // Deep article search: fetch all articles for this thread with full context
    const { rows: articles } = await pool.query(`
      SELECT
        a.title, a.translated_title, a.summary, a.translated_summary,
        a.published_at, a.media_type,
        COALESCE(ns.name, ys.name) AS source_name,
        co.name AS country_name
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE sta.thread_id = $1
      ORDER BY sta.is_anchor DESC, a.published_at ASC
      LIMIT 30
    `, [threadId]);

    // Also fetch the thread metadata
    const { rows: threadRows } = await pool.query(`
      SELECT title, description, primary_category, keywords
      FROM story_threads WHERE id = $1
    `, [threadId]);
    const thread = threadRows[0];

    if (!articles.length && !thread) {
      return res.status(404).json({ error: "No data found for this thread" });
    }

    // Build deep context from actual article content
    const articleContext = articles.map((a, i) => {
      const title = a.translated_title || a.title || "Untitled";
      const summary = a.translated_summary || a.summary || "";
      const source = a.source_name || "Unknown source";
      const country = a.country_name || "";
      const date = a.published_at ? new Date(a.published_at).toISOString().slice(0, 10) : "";
      const type = a.media_type === "video" ? " [Video]" : "";
      return `${i + 1}. "${title}"${type} — ${source}${country ? `, ${country}` : ""}${date ? ` (${date})` : ""}\n   ${summary.slice(0, 300)}`;
    }).join("\n");

    const threadContext = thread
      ? `Thread: "${thread.title}"\nCategory: ${thread.primary_category || "General"}\nDescription: ${thread.description || ""}\nKeywords: ${(thread.keywords || []).slice(0, 15).join(", ")}`
      : "";

    const response = await Anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `You are an impartial global news analyst. Using ONLY the article data below, write exactly 200 words (no more, no less). Structure: first paragraph provides the broader geopolitical or societal context; second paragraph summarizes the specific events and developments. Be factual, neutral, and unbiased — no opinions, no speculation, no markdown formatting, no introductory phrases.\n\n${threadContext}\n\nArticles:\n${articleContext}`,
      }],
    });

    const summary = (response.content[0]?.text || "").trim();
    res.json({ summary });
  } catch (err) {
    console.error("[cluster-node/summary]", err.message);
    res.status(500).json({ error: "Summary generation failed" });
  }
});

// GET /api/clusters/related?thread_id=X&run_id=Y — related clusters for a given thread's cluster
app.get("/api/clusters/related", async (req, res) => {
  const threadId = parseInt(req.query.thread_id, 10);
  const runId = parseInt(req.query.run_id, 10);
  if (!threadId) return res.status(400).json({ error: "thread_id required" });

  try {
    // Resolve the run_id if not provided — use latest completed run
    let effectiveRunId = runId;
    if (!effectiveRunId) {
      const { rows: runRows } = await pool.query(`
        SELECT id FROM cluster_runs WHERE status = 'completed'
        ORDER BY completed_at DESC NULLS LAST LIMIT 1
      `);
      if (!runRows.length) return res.json([]);
      effectiveRunId = runRows[0].id;
    }

    // Find this thread's cluster_id
    const { rows: nodeRows } = await pool.query(`
      SELECT cluster_id FROM cluster_nodes WHERE run_id = $1 AND thread_id = $2 LIMIT 1
    `, [effectiveRunId, threadId]);
    if (!nodeRows.length) return res.json([]);
    const myClusterId = nodeRows[0].cluster_id;

    // Find related clusters via edges that bridge between this cluster and others
    const { rows: edgeRows } = await pool.query(`
      SELECT DISTINCT
        CASE
          WHEN src.cluster_id = $2 THEN tgt.cluster_id
          ELSE src.cluster_id
        END AS related_cluster_id,
        MAX(ce.weight) AS max_weight
      FROM cluster_edges ce
      JOIN cluster_nodes src ON src.run_id = $1 AND src.thread_id = ce.source_thread_id
      JOIN cluster_nodes tgt ON tgt.run_id = $1 AND tgt.thread_id = ce.target_thread_id
      WHERE ce.run_id = $1
        AND (src.cluster_id = $2 OR tgt.cluster_id = $2)
        AND src.cluster_id != tgt.cluster_id
      GROUP BY related_cluster_id
      ORDER BY max_weight DESC
      LIMIT 8
    `, [effectiveRunId, myClusterId]);

    const relatedIds = edgeRows.map(r => r.related_cluster_id);

    // Also find clusters with shared keywords/category (backup if few edge-based results)
    if (relatedIds.length < 5) {
      const { rows: myGroup } = await pool.query(`
        SELECT primary_category, shared_properties FROM cluster_groups
        WHERE run_id = $1 AND cluster_id = $2 LIMIT 1
      `, [effectiveRunId, myClusterId]);

      if (myGroup.length) {
        const myProps = Array.isArray(myGroup[0].shared_properties) ? myGroup[0].shared_properties : [];
        const myCat = myGroup[0].primary_category;

        const { rows: candidateGroups } = await pool.query(`
          SELECT cluster_id, primary_category, shared_properties
          FROM cluster_groups
          WHERE run_id = $1 AND cluster_id != $2
        `, [effectiveRunId, myClusterId]);

        candidateGroups.forEach(cg => {
          if (relatedIds.includes(cg.cluster_id)) return;
          const props = Array.isArray(cg.shared_properties) ? cg.shared_properties : [];
          const overlap = myProps.filter(p => props.includes(p)).length;
          const catMatch = cg.primary_category === myCat ? 1 : 0;
          if (overlap > 0 || catMatch) {
            relatedIds.push(cg.cluster_id);
          }
        });
      }
    }

    if (!relatedIds.length) return res.json([]);

    // Fetch full group info for related clusters
    const { rows: groups } = await pool.query(`
      SELECT
        cg.cluster_id, cg.label, cg.summary, cg.primary_category,
        cg.node_count, cg.article_count, cg.shared_properties
      FROM cluster_groups cg
      WHERE cg.run_id = $1 AND cg.cluster_id = ANY($2::text[])
      ORDER BY cg.article_count DESC
    `, [effectiveRunId, relatedIds.slice(0, 10)]);

    res.json(groups.map(g => ({
      cluster_id: g.cluster_id,
      label: g.label,
      summary: g.summary,
      primary_category: g.primary_category,
      node_count: parseInt(g.node_count, 10) || 0,
      article_count: parseInt(g.article_count, 10) || 0,
      shared_properties: Array.isArray(g.shared_properties) ? g.shared_properties : []
    })));
  } catch (err) {
    console.error("[clusters/related]", err.message);
    res.status(500).json({ error: "Failed to fetch related clusters" });
  }
});

// GET /api/articles/recent?limit=60&hours=48 — random recent articles for global ticker
app.get("/api/articles/recent", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 60, 100);
  const hours = Math.min(parseInt(req.query.hours) || 48, 168);
  try {
    const { rows } = await pool.query(`
      SELECT
        a.id, a.title, a.translated_title, a.summary,
        a.published_at, a.url,
        COALESCE(a.image_url, img_a.public_url) AS image_url,
        COALESCE(ns.name, ys.name) AS source_name,
        ns.source_summary,
        COALESCE(ns.bias, 'unknown') AS source_bias,
        co.name AS country_name, co.iso_code
      FROM news_articles a
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE a.published_at >= NOW() - ($2 || ' hours')::interval
        AND a.title IS NOT NULL
      ORDER BY RANDOM()
      LIMIT $1
    `, [limit, hours]);
    res.json(rows);
  } catch (err) {
    console.error("[articles/recent]", err.message);
    res.status(500).json({ error: "Failed" });
  }
});

// GET /api/briefing/today — returns today's ready episode (no audio binary)
app.get("/api/briefing/today", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(`
      SELECT id, target_date, headline, voiceover_script, segments, status, generated_at,
             (audio_data IS NOT NULL) AS has_audio
      FROM briefing_episodes
      WHERE user_id IS NULL AND target_date = $1 AND status = 'ready'
      ORDER BY id DESC
      LIMIT 1
    `, [today]);
    if (!rows.length) return res.status(404).json({ error: "No briefing for today yet" });

    const episode = rows[0];

    // Free-tier weekly access gate (2 briefings per rolling 7 days)
    if (req.user?.id) {
      const tier = req.user.tier || "free";
      const access = await checkBriefingAccess(req.user.id, episode.id, tier).catch(() => ({ allowed: true }));
      if (!access.allowed) {
        return res.status(403).json({
          error:       access.resetNote || "Weekly briefing limit reached",
          limitReached: true,
          used:        access.used,
          limit:       access.limit,
          requiredTier: "pro",
        });
      }
    }

    res.json(episode);
  } catch (err) {
    console.error("[briefing/today]", err.message);
    res.status(500).json({ error: "Failed to fetch briefing" });
  }
});

// GET /api/briefing/audio/:id/:segIdx — serves one segment's MP3 slice (CBR 128kbps, 16 bytes/ms)
app.get("/api/briefing/audio/:id/:segIdx", async (req, res) => {
  try {
    const episodeId = parseInt(req.params.id);
    const segIdx    = parseInt(req.params.segIdx);
    const { rows } = await pool.query(
      `SELECT audio_data, segments FROM briefing_episodes WHERE id = $1 AND audio_data IS NOT NULL`,
      [episodeId]
    );
    if (!rows.length) return res.status(404).json({ error: "Audio not found" });
    const buf  = rows[0].audio_data;
    const segs = rows[0].segments;
    if (!segs || segIdx < 0 || segIdx >= segs.length) return res.status(404).json({ error: "Segment not found" });
    const seg  = segs[segIdx];
    const next = segs[segIdx + 1];
    if (seg.start_ms == null) return res.status(404).json({ error: "No segment timing" });
    const BYTES_PER_MS = 128 / 8;   // 128 kbps = 16 bytes/ms
    const byteStart = Math.round(seg.start_ms  * BYTES_PER_MS);
    const byteEnd   = next?.start_ms != null
      ? Math.round(next.start_ms * BYTES_PER_MS)
      : buf.length;
    const slice = buf.slice(byteStart, Math.min(byteEnd, buf.length));
    if (!slice.length) return res.status(404).json({ error: "Empty slice" });
    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Length", slice.length);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(slice);
  } catch (err) {
    console.error("[briefing/audio/seg]", err.message);
    res.status(500).json({ error: "Failed to serve segment audio" });
  }
});

// GET /api/briefing/audio/:id — streams the MP3 audio for an episode
app.get("/api/briefing/audio/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT audio_data FROM briefing_episodes WHERE id = $1 AND audio_data IS NOT NULL`,
      [parseInt(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: "Audio not found" });
    const buf = rows[0].audio_data;
    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Length", buf.length);
    res.set("Accept-Ranges", "bytes");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    console.error("[briefing/audio]", err.message);
    res.status(500).json({ error: "Failed to stream audio" });
  }
});

// GET /api/briefing/recent — last 7 days of briefings (for a history panel)
app.get("/api/briefing/recent", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, target_date, headline, status, generated_at,
             (audio_data IS NOT NULL) AS has_audio
      FROM briefing_episodes
      WHERE user_id IS NULL AND status = 'ready'
      ORDER BY target_date DESC
      LIMIT 7
    `);
    res.json(rows);
  } catch (err) {
    console.error("[briefing/recent]", err.message);
    res.status(500).json({ error: "Failed to fetch recent briefings" });
  }
});

// GET /api/briefing/voices — returns all configured ElevenLabs voices
// Reads every env var matching ELEVENLABS_VOICE_ID_<LANGUAGE>
app.get("/api/briefing/voices", (req, res) => {
  const voices = [];
  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue;
    const match = key.match(/^ELEVENLABS_VOICE_ID_(.+)$/);
    if (match) {
      const raw  = match[1];                                         // e.g. "ENGLISH", "PORTUGUESE_BR"
      const label = raw.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
      voices.push({ language: label, voiceId: val });
    }
  }
  // Sort alphabetically so the dropdown is consistent
  voices.sort((a, b) => a.language.localeCompare(b.language));
  res.json(voices);
});

// POST /api/briefing/location — on-demand briefing for a city or country node
app.post("/api/briefing/location", async (req, res) => {
  const { type, id, name, voiceover = false, sourceFilter = 'mix', voiceId } = req.body || {};
  if (!type || !id || !name) return res.status(400).json({ error: "type, id, and name are required" });
  if (!["city", "country"].includes(type)) return res.status(400).json({ error: "type must be 'city' or 'country'" });
  const validFilters = ['local', 'mix', 'global'];
  const filter = validFilters.includes(sourceFilter) ? sourceFilter : 'mix';
  try {
    const ep = await generateLocationBriefing({ type, id: parseInt(id), name, voiceover: !!voiceover, sourceFilter: filter, voiceId: voiceId || null });
    res.json(ep);
  } catch (err) {
    console.error("[briefing/location]", err.message);
    res.status(500).json({ error: err.message || "Failed to generate location briefing" });
  }
});

// POST /api/briefing/custom — custom briefing with from/about/keyword filters.
// Returns 422 { insufficient, count, message, suggestions } if < 8 articles found
// and skipCheck is not true. Otherwise generates and returns an episode.
app.post("/api/briefing/custom", async (req, res) => {
  // Tier gate: free/pro pay per use ($2.50); enterprise has monthly cap
  if (req.user?.id) {
    const tier = req.user.tier || "free";
    const cbAccess = await checkCustomBriefing(req.user.id, tier).catch(() => ({ allowed: true }));
    if (!cbAccess.allowed && !cbAccess.payPerUse) {
      return res.status(403).json({
        error:       cbAccess.resetNote || "Monthly custom briefing limit reached",
        limitReached: true,
        used:        cbAccess.used,
        limit:       cbAccess.limit,
      });
    }
    if (cbAccess.payPerUse) {
      // Allow if they've confirmed payment intent, otherwise surface the price
      if (!req.body?.confirmedPayPerUse) {
        return res.status(402).json({
          error:      "Custom briefings cost $2.50",
          payPerUse:  true,
          priceUsd:   2.50,
          message:    "Add confirmedPayPerUse: true to proceed (billing handled separately)",
        });
      }
    }
  }

  const { from, about, keywords = [], skipCheck = false, voiceover = false, voiceId } = req.body || {};
  if (!from && !about && !keywords.length) {
    return res.status(400).json({ error: "Provide at least one of: from, about, or keywords" });
  }

  try {
    // ── Build article filter query ───────────────────────────────────────────
    const conditions = [
      "a.published_at > NOW() - INTERVAL '72 hours'",
      "a.status = 'ready'",
    ];
    const params = [];

    if (from) {
      params.push(`%${from}%`);
      conditions.push(`(a.source_country_name ILIKE $${params.length} OR a.source_name ILIKE $${params.length})`);
    }
    if (about) {
      params.push(`%${about}%`);
      conditions.push(`(
        a.city_name ILIKE $${params.length}
        OR a.country_name ILIKE $${params.length}
        OR COALESCE(a.translated_title, a.title) ILIKE $${params.length}
        OR COALESCE(a.translated_summary, a.summary) ILIKE $${params.length}
      )`);
    }
    if (keywords.length) {
      params.push(keywords);
      conditions.push(`EXISTS (
        SELECT 1 FROM article_keywords ak
        WHERE ak.article_id = a.id
          AND COALESCE(ak.normalized_keyword, ak.keyword) = ANY($${params.length}::text[])
      )`);
    }

    const where = conditions.join(' AND ');

    // ── Content availability check ───────────────────────────────────────────
    if (!skipCheck) {
      const { rows: cnt } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM news_articles a WHERE ${where}`, params
      );
      const count = cnt[0].count;
      const THRESHOLD = 8;

      if (count < THRESHOLD) {
        // Ask Claude for intelligent alternatives
        const Anthropic = require('@anthropic-ai/sdk');
        const haiku = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const ctx = [
          from    ? `from: "${from}"`          : '',
          about   ? `about: "${about}"`         : '',
          keywords.length ? `keywords: "${keywords.join(', ')}"` : '',
        ].filter(Boolean).join(', ');

        const sugRes = await haiku.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `A user searched for news briefing content with parameters: ${ctx}. Only ${count} articles were found in the last 72 hours — below the minimum of ${THRESHOLD} needed for a meaningful briefing.

Generate 3–4 intelligent alternative search directions related to the user's interests that would yield richer news coverage. Think geographically adjacent places, thematically related topics, or broader regional/political contexts.

Return ONLY valid JSON: { "message": "one sentence explaining why coverage is limited", "suggestions": ["Direction 1", "Direction 2", "Direction 3"] }`,
          }],
        });
        const match = sugRes.content[0].text.match(/\{[\s\S]*\}/);
        const sugg  = match ? JSON.parse(match[0]) : { message: `Only ${count} matching articles found.`, suggestions: [] };
        return res.status(422).json({ insufficient: true, count, ...sugg });
      }
    }

    // ── Sufficient content — generate briefing via location generator ─────────
    // Use `about` or keywords as the location "name"; type=country is fine for prompting
    const locName = about || keywords.join(', ') || from || 'Custom';
    const ep = await generateLocationBriefing({
      type: 'country',
      id: null,
      name: locName,
      voiceover: !!voiceover,
      sourceFilter: 'mix',
      voiceId: voiceId || null,
      customFilter: { from, about, keywords, sqlWhere: where, sqlParams: params },
    });
    res.json(ep);
  } catch (err) {
    console.error("[briefing/custom]", err.message);
    res.status(500).json({ error: err.message || "Failed to generate custom briefing" });
  }
});

/* =========================================
   On-demand Translation
========================================= */
app.post("/api/translate", async (req, res) => {
  const { title, summary, id, targetLang } = req.body || {};
  if (!title && !summary) return res.status(400).json({ error: "No text provided" });

  // Tier-based translation limits
  if (req.user?.id) {
    const tlAccess = await checkTranslation(req.user.id, req.user.tier || "free").catch(() => ({ allowed: true }));
    if (!tlAccess.allowed) {
      return res.status(429).json({
        error:       tlAccess.resetNote || "Translation limit reached",
        limitReached: true,
        used:        tlAccess.used,
        limit:       tlAccess.limit,
        requiredTier: (req.user.tier || "free") === "free" ? "pro" : null,
      });
    }
  }

  try {
    // DeepL supports all but: Filipino (TL), Hindi (HI), Malay (MS), Vietnamese (VI)
    const DEEPL_UNSUPPORTED = new Set(['TL', 'HI', 'MS', 'VI']);
    const target = targetLang || 'EN-US';
    const baseTarget = target.split('-')[0].toUpperCase();
    const needsClaudeFallback = DEEPL_UNSUPPORTED.has(baseTarget);

    let translatedTitle = null, translatedSummary = null;
    if (needsClaudeFallback) {
      // Claude Haiku fallback for unsupported DeepL languages
      const langNames = { TL: 'Filipino (Tagalog)', HI: 'Hindi', MS: 'Malay', VI: 'Vietnamese' };
      const langName = langNames[baseTarget] || target;
      const pieces = [title, summary].filter(Boolean);
      const prompt = `Translate each of the following items into ${langName}. Return a JSON array with the same number of elements in the same order. Only return the JSON array, nothing else.\n${JSON.stringify(pieces)}`;
      const resp = await Anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      try {
        const arr = JSON.parse(resp.content[0].text.trim());
        let i = 0;
        if (title)   translatedTitle   = arr[i++] || null;
        if (summary) translatedSummary = arr[i++] || null;
      } catch (_) {}
    } else {
      [translatedTitle, translatedSummary] = await Promise.all([
        title   ? translateText(title,   target) : Promise.resolve(null),
        summary ? translateText(summary, target) : Promise.resolve(null),
      ]);
    }

    // Only persist to DB for English translations (to avoid mixing languages across users)
    const isEnglishTarget = target.startsWith('EN');
    if (isEnglishTarget && id && (translatedTitle || translatedSummary)) {
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
   AI Context Explanation
   Generates a ≤250-char contextual writeup for an article or story thread.
   Tier limits: Pro = 5/day, Enterprise = 20/day, Free = restricted.
========================================= */
app.post("/api/explain", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });

  const tier = user.tier || "free";
  const access = await checkExplanation(user.id, tier).catch(() => ({ allowed: false }));
  if (!access.allowed) {
    return res.status(429).json({
      error:     access.resetNote || "Daily explanation limit reached",
      limitReached: true,
      used:      access.used,
      limit:     access.limit,
      requiredTier: tier === "free" ? "pro" : null,
    });
  }

  const { type, title, summary, keywords = [], description } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    const context = type === "thread"
      ? `Story thread: "${title}"\nDescription: ${description || summary || ""}\nKeywords: ${(keywords || []).slice(0, 10).join(", ")}`
      : `Article: "${title}"\nSummary: ${(summary || "").slice(0, 400)}`;

    const response = await Anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 120,
      messages:   [{
        role:    "user",
        content: `You are a concise global news analyst. Write a single plain-English sentence (max 250 characters) explaining the broader significance and context of this news item. No quotes, no markdown, no introductory phrases like "This article" — just the insight.\n\n${context}`,
      }],
    });

    const explanation = (response.content[0]?.text || "").trim().slice(0, 250);
    res.json({ explanation, used: access.used, limit: access.limit });
  } catch (err) {
    console.error("[api/explain]", err.message);
    res.status(500).json({ error: "Explanation generation failed" });
  }
});

/* =========================================
   Keyword AI Context  —  POST /api/keywords/explain
   Enterprise-only. 25 calls/user/day.
   Fetches recent articles for the keyword, then asks
   Claude Haiku to explain significance and context.
========================================= */
app.post("/api/keywords/explain", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });

  const tier = user.tier || "free";
  const access = await checkKwExplanation(user.id, tier).catch(() => ({ allowed: false }));
  if (!access.allowed) {
    return res.status(429).json({
      error:        access.resetNote || "Daily keyword explanation limit reached",
      limitReached: true,
      used:         access.used,
      limit:        access.limit,
      requiredTier: tier !== "enterprise" ? "enterprise" : null,
    });
  }

  const { keyword, topKeywords = [], locationCountry } = req.body || {};
  if (!keyword && !topKeywords.length) {
    return res.status(400).json({ error: "keyword or topKeywords is required" });
  }

  try {
    let context = "";

    if (keyword) {
      // Fetch recent articles mentioning this keyword (last 7 days)
      const { rows: articles } = await pool.query(`
        SELECT DISTINCT ON (a.id)
               COALESCE(a.translated_title, a.title)        AS title,
               COALESCE(a.translated_summary, a.summary)    AS summary,
               a.published_at,
               ns.name AS source
        FROM news_articles a
        JOIN article_keywords ak ON ak.article_id = a.id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        WHERE ak.keyword = $1
          AND a.published_at > NOW() - INTERVAL '7 days'
          ${locationCountry ? "AND a.about_country_id = (SELECT id FROM countries WHERE iso_code_2 = $2 LIMIT 1)" : ""}
        ORDER BY a.id, a.base_priority DESC
        LIMIT 10
      `, locationCountry ? [keyword, locationCountry] : [keyword]);

      const articleLines = articles.map(a =>
        `- "${(a.title || '').slice(0, 100)}" (${a.source || 'Unknown'}, ${new Date(a.published_at).toLocaleDateString()})`
      ).join('\n');

      context = `Keyword: "${keyword}"
${locationCountry ? `Geographic focus: ${locationCountry}` : ""}
Recent articles (${articles.length} found, last 7 days):
${articleLines || "No recent articles found — keyword may be older trending data."}`;
    } else {
      // Trending context — explain the overall keyword landscape
      context = `Top trending keywords right now: ${topKeywords.slice(0, 8).join(', ')}
${locationCountry ? `Geographic focus: ${locationCountry}` : "Global view"}`;
    }

    const response = await Anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 200,
      messages:   [{
        role:    "user",
        content: `You are a senior geopolitical analyst providing keyword intelligence context.
Write 2-3 plain sentences explaining: what broader story or trend this keyword represents, why it is significant right now, and what underlying forces are driving it. Be specific and analytical. No markdown, no bullet points, no introductory phrases.

${context}`,
      }],
    });

    const explanation = (response.content[0]?.text || "").trim().slice(0, 450);
    res.json({ explanation, used: access.used, limit: access.limit });
  } catch (err) {
    console.error("[api/keywords/explain]", err.message);
    res.status(500).json({ error: "Keyword explanation generation failed" });
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

const KEYWORD_ROUTE_TTLS = Object.freeze({
  trending: 90 * 1000,
  rising: 90 * 1000,
  autocomplete: 30 * 1000,
  top: 60 * 1000,
  trend: 60 * 1000,
  articles: 45 * 1000,
});

const keywordResponseCache = new Map();
const keywordInFlight = new Map();
const keywordCountryIdCache = new Map();

function clampQueryInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeLowerString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function appendKeywordCountryClauses(clauses, params, {
  sourceCountryId = null,
  aboutCountryId = null,
  defaultGlobal = false,
  alias = "",
} = {}) {
  const prefix = alias ? `${alias}.` : "";
  if (sourceCountryId != null || aboutCountryId != null) {
    if (sourceCountryId != null) {
      params.push(sourceCountryId);
      clauses.push(`${prefix}source_country_id = $${params.length}`);
    }
    if (aboutCountryId != null) {
      params.push(aboutCountryId);
      clauses.push(`${prefix}about_country_id = $${params.length}`);
    }
    return;
  }

  if (defaultGlobal) {
    clauses.push(`${prefix}source_country_id IS NULL`);
    clauses.push(`${prefix}about_country_id IS NULL`);
  }
}

function makeKeywordCacheKey(route, parts) {
  return `${route}:${parts.join(":")}`;
}

// DB-level cache check — written by keywordCron.js on a scheduled basis.
// Returns pre-computed results if fresh enough, null otherwise.
// maxAgeMinutes: trending = 1440 (24h), rising = 240 (4h)
async function getDbKeywordCache(mode, filterKey, maxAgeMinutes) {
  try {
    const { rows } = await pool.query(`
      SELECT results, computed_at
      FROM   keyword_intelligence_cache
      WHERE  mode       = $1
        AND  filter_key = $2
        AND  computed_at > NOW() - ($3 * INTERVAL '1 minute')
      ORDER BY computed_at DESC
      LIMIT 1
    `, [mode, filterKey, maxAgeMinutes]);
    if (rows.length) return rows[0].results; // already parsed JSONB
  } catch {
    // Table may not exist yet if migration hasn't run — fall through silently
  }
  return null;
}

async function getCachedKeywordPayload(cacheKey, ttlMs, loader) {
  const now = Date.now();
  const cached = keywordResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  if (keywordInFlight.has(cacheKey)) return keywordInFlight.get(cacheKey);

  const pending = (async () => {
    try {
      const value = await loader();
      keywordResponseCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
      return value;
    } finally {
      keywordInFlight.delete(cacheKey);
    }
  })();

  keywordInFlight.set(cacheKey, pending);
  return pending;
}

function setKeywordCacheHeaders(res, ttlMs) {
  res.set("Cache-Control", `public, max-age=${Math.max(0, Math.floor(ttlMs / 1000))}`);
}

function pruneKeywordRouteCache() {
  const now = Date.now();
  for (const [key, entry] of keywordResponseCache.entries()) {
    if (entry.expiresAt <= now) keywordResponseCache.delete(key);
  }
}

setInterval(pruneKeywordRouteCache, 10 * 60 * 1000).unref?.();

async function resolveCountryIdByIso(rawIso) {
  const iso = normalizeLowerString(rawIso);
  if (!iso) return null;
  if (keywordCountryIdCache.has(iso)) return keywordCountryIdCache.get(iso);

  const { rows } = await pool.query(
    `SELECT id
     FROM countries
     WHERE LOWER(COALESCE(iso_code, '')) = $1
        OR LOWER(COALESCE(iso_code_2, '')) = $1
     LIMIT 1`,
    [iso]
  );

  const id = rows[0]?.id ?? null;
  keywordCountryIdCache.set(iso, id);
  return id;
}

async function resolveKeywordCountryFilters(sourceCountry, aboutCountry) {
  const requestedSource = normalizeLowerString(sourceCountry);
  const requestedAbout = normalizeLowerString(aboutCountry);
  const [sourceCountryId, aboutCountryId] = await Promise.all([
    resolveCountryIdByIso(requestedSource),
    resolveCountryIdByIso(requestedAbout),
  ]);

  return {
    sourceCountryId,
    aboutCountryId,
    invalid:
      (requestedSource && sourceCountryId == null) ||
      (requestedAbout && aboutCountryId == null),
  };
}

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
    const daysInt = clampQueryInt(days, 7, 1, 365);
    const limitInt = clampQueryInt(limit, 20, 1, 100);
    const { sourceCountryId, aboutCountryId, invalid } =
      await resolveKeywordCountryFilters(source_country, about_country);

    if (invalid) return res.json([]);

    const cacheKey = makeKeywordCacheKey("trending", [
      daysInt,
      limitInt,
      sourceCountryId ?? "global",
      aboutCountryId ?? "global",
    ]);

    // Check DB pre-computed cache for global requests (populated by keywordCron.js)
    if (!sourceCountryId && !aboutCountryId) {
      const dbCached = await getDbKeywordCache("trending", "global", 1440); // 24h
      if (dbCached) {
        setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.trending);
        return res.json(dbCached.slice(0, limitInt));
      }
    }

    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.trending);
    const rows = await getCachedKeywordPayload(cacheKey, KEYWORD_ROUTE_TTLS.trending, async () => {
      const params = [daysInt];
      const clauses = ["k.date >= CURRENT_DATE - $1::int"];
      appendKeywordCountryClauses(clauses, params, {
        sourceCountryId,
        aboutCountryId,
        defaultGlobal: true,
        alias: "k",
      });
      params.push(limitInt);
      const limitIdx = params.length;

      const result = await pool.query(
        `SELECT
           k.keyword,
           SUM(k.total_count)::bigint AS mentions,
           COUNT(DISTINCT k.date)::int AS days_active
         FROM keyword_daily_stats k
         WHERE ${clauses.join("\n           AND ")}
           AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)
         GROUP BY k.keyword
         HAVING SUM(k.total_count) >= 3
         ORDER BY mentions DESC, k.keyword ASC
         LIMIT $${limitIdx}`,
        params
      );

      return result.rows;
    });

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
    source_country = null,
    about_country  = null,
  } = req.query;

  try {
    const daysInt = clampQueryInt(days, 3, 1, 90);
    const baselineDaysInt = clampQueryInt(baseline_days, 14, daysInt + 1, 365);
    const limitInt = clampQueryInt(limit, 15, 1, 100);
    const { sourceCountryId, aboutCountryId, invalid } =
      await resolveKeywordCountryFilters(source_country, about_country);

    if (invalid) return res.json([]);

    const cacheKey = makeKeywordCacheKey("rising", [
      daysInt,
      baselineDaysInt,
      limitInt,
      sourceCountryId ?? "global",
      aboutCountryId ?? "global",
    ]);

    // Check DB pre-computed cache for global requests (populated by keywordCron.js)
    if (!sourceCountryId && !aboutCountryId) {
      const dbCached = await getDbKeywordCache("rising", "global", 240); // 4h
      if (dbCached) {
        setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.rising);
        return res.json(dbCached.filter((row) => !isDateLikeKeyword(row && row.keyword)).slice(0, limitInt));
      }
    }

    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.rising);
    const rows = await getCachedKeywordPayload(cacheKey, KEYWORD_ROUTE_TTLS.rising, async () => {
      const params = [daysInt, baselineDaysInt];
      const recentClauses = ["k.date >= CURRENT_DATE - $1::int"];
      const baselineClauses = [
        "k.date >= CURRENT_DATE - ($1::int + $2::int)",
        "k.date < CURRENT_DATE - $1::int",
      ];

      appendKeywordCountryClauses(recentClauses, params, {
        sourceCountryId,
        aboutCountryId,
        defaultGlobal: true,
        alias: "k",
      });
      appendKeywordCountryClauses(baselineClauses, params, {
        sourceCountryId,
        aboutCountryId,
        defaultGlobal: true,
        alias: "k",
      });

      params.push(limitInt);
      const limitIdx = params.length;

      const result = await pool.query(
        `WITH recent AS (
           SELECT k.keyword, SUM(k.total_count)::bigint AS recent_count
           FROM keyword_daily_stats k
           WHERE ${recentClauses.join("\n             AND ")}
             AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)
           GROUP BY k.keyword
           HAVING SUM(k.total_count) >= 2
         ),
         baseline AS (
           SELECT k.keyword, SUM(k.total_count)::bigint AS baseline_count
           FROM keyword_daily_stats k
           WHERE ${baselineClauses.join("\n             AND ")}
             AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)
           GROUP BY k.keyword
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
         ORDER BY momentum DESC, r.recent_count DESC, r.keyword ASC
         LIMIT $${limitIdx}`,
        params
      );

      return result.rows;
    });

    res.json(rows.filter((row) => !isDateLikeKeyword(row && row.keyword)).slice(0, limitInt));
  } catch (err) {
    console.error("[keywords/rising]", err.message);
    res.status(500).json({ error: "rising failed" });
  }
});

// GET /api/keywords/autocomplete?q=clim
// Returns up to 10 distinct keywords matching the prefix
app.get("/api/keywords/autocomplete", async (req, res) => {
  const q = normalizeLowerString(req.query.q) || "";
  if (q.length < 2) return res.json([]);
  try {
    const cacheKey = makeKeywordCacheKey("autocomplete", [q]);

    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.autocomplete);
    const rows = await getCachedKeywordPayload(cacheKey, KEYWORD_ROUTE_TTLS.autocomplete, async () => {
      const result = await pool.query(
        `SELECT DISTINCT LOWER(keyword) AS keyword
         FROM article_keywords
         WHERE LOWER(keyword) LIKE $1
           AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = LOWER(article_keywords.keyword))
         ORDER BY keyword ASC
         LIMIT 10`,
        [`${q}%`]
      );
      return result.rows.map(r => r.keyword);
    });

    res.json(rows);
  } catch (err) {
    console.error("[keywords/autocomplete]", err.message);
    res.status(500).json({ error: "autocomplete failed" });
  }
});

// GET /api/keywords/cooccurrence?keyword=climate&days=7&limit=12
// Co-occurrence storage was intentionally removed, so keep this endpoint as a
// fast empty response instead of letting the widget fail on a 404/500.
app.get("/api/keywords/cooccurrence", async (req, res) => {
  const keyword = normalizeLowerString(req.query.keyword);
  const daysInt = clampQueryInt(req.query.days, 7, 1, 365);
  const limitInt = clampQueryInt(req.query.limit, 12, 1, 50);
  const cacheKey = makeKeywordCacheKey("cooccurrence-disabled", [
    keyword || "none",
    daysInt,
    limitInt,
  ]);

  try {
    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.autocomplete);
    const rows = await getCachedKeywordPayload(
      cacheKey,
      KEYWORD_ROUTE_TTLS.autocomplete,
      async () => []
    );
    res.json(rows);
  } catch (err) {
    console.error("[keywords/cooccurrence]", err.message);
    res.status(500).json({ error: "cooccurrence failed" });
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
    const normalizedKeyword = normalizeLowerString(keyword);
    const daysInt = clampQueryInt(days, 7, 1, 365);
    const limitInt = clampQueryInt(limit, 20, 1, 100);
    const { sourceCountryId, aboutCountryId, invalid } =
      await resolveKeywordCountryFilters(source_country, about_country);

    if (!normalizedKeyword || invalid) return res.json([]);

    const cacheKey = makeKeywordCacheKey("top", [
      normalizedKeyword,
      daysInt,
      limitInt,
      sourceCountryId ?? "any",
      aboutCountryId ?? "any",
    ]);

    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.top);
    const rows = await getCachedKeywordPayload(cacheKey, KEYWORD_ROUTE_TTLS.top, async () => {
      const params = [normalizedKeyword, daysInt];
      const clauses = [
        "k.keyword = $1",
        "k.date >= CURRENT_DATE - $2::int",
      ];
      appendKeywordCountryClauses(clauses, params, {
        sourceCountryId,
        aboutCountryId,
        alias: "k",
      });

      params.push(limitInt);
      const limitIdx = params.length;

      const result = await pool.query(
        `SELECT
           k.keyword,
           SUM(k.total_count)::bigint AS total_mentions,
           SUM(k.language_group_count)::bigint AS language_groups,
           MIN(k.date) AS first_seen,
           MAX(k.date) AS last_seen
         FROM keyword_daily_stats k
         WHERE ${clauses.join("\n           AND ")}
         GROUP BY k.keyword
         ORDER BY total_mentions DESC
         LIMIT $${limitIdx}`,
        params
      );

      return result.rows;
    });

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
    const normalizedKeyword = normalizeLowerString(keyword);
    const daysInt = clampQueryInt(days, 30, 1, 365);
    const { sourceCountryId, aboutCountryId, invalid } =
      await resolveKeywordCountryFilters(source_country, about_country);

    if (!normalizedKeyword || invalid) return res.json([]);

    const cacheKey = makeKeywordCacheKey("trend", [
      normalizedKeyword,
      daysInt,
      sourceCountryId ?? "any",
      aboutCountryId ?? "any",
    ]);

    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.trend);
    const rows = await getCachedKeywordPayload(cacheKey, KEYWORD_ROUTE_TTLS.trend, async () => {
      const params = [normalizedKeyword, daysInt];
      const clauses = [
        "k.keyword = $1",
        "k.date >= CURRENT_DATE - $2::int",
      ];
      appendKeywordCountryClauses(clauses, params, {
        sourceCountryId,
        aboutCountryId,
        alias: "k",
      });

      const result = await pool.query(
        `WITH date_series AS (
           SELECT generate_series(
             CURRENT_DATE - $2::int,
             CURRENT_DATE,
             '1 day'::interval
           )::date AS date
         ),
         counts AS (
           SELECT k.date, SUM(k.total_count)::bigint AS mentions
           FROM keyword_daily_stats k
           WHERE ${clauses.join("\n             AND ")}
           GROUP BY k.date
         )
         SELECT
           ds.date,
           COALESCE(c.mentions, 0) AS mentions
         FROM date_series ds
         LEFT JOIN counts c ON c.date = ds.date
         ORDER BY ds.date ASC`,
        params
      );

      return result.rows;
    });

    res.json(rows);
  } catch (err) {
    console.error("[keywords/trend]", err.message);
    res.status(500).json({ error: "trend failed" });
  }
});


// GET /api/keywords/articles?keyword=ukraine&days=7&limit=20
// Returns recent articles containing the keyword
app.get("/api/keywords/articles", async (req, res) => {
  const { keyword, days = 7, limit = 20 } = req.query;
  if (!keyword) return res.status(400).json({ error: "keyword required" });

  try {
    const kw = normalizeLowerString(keyword);
    const daysInt = clampQueryInt(days, 7, 1, 365);
    const limitInt = clampQueryInt(limit, 20, 1, 100);

    if (!kw) return res.json([]);

    const cacheKey = makeKeywordCacheKey("articles", [kw, daysInt, limitInt]);
    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.articles);
    const rows = await getCachedKeywordPayload(cacheKey, KEYWORD_ROUTE_TTLS.articles, async () => {
      const result = await pool.query(
        `SELECT
           a.id,
           COALESCE(a.translated_title, a.title) AS title,
           COALESCE(a.translated_summary, a.summary) AS summary,
           COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
           a.article_url,
           a.published_at,
           a.sentiment_score,
           COALESCE(ns.name, ys.name) AS source_name,
           ns.source_summary,
           COALESCE(ns.bias, 'unknown') AS source_bias,
           ns.site_url AS source_url,
           co.name AS country_name,
           co.iso_code,
           ak.frequency
         FROM article_keywords ak
         JOIN news_articles a ON a.id = ak.article_id
         LEFT JOIN news_sources ns ON ns.id = a.source_id
         LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
         LEFT JOIN countries co ON co.id = a.country_id
         LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
         LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
         WHERE ak.keyword = $1
           AND a.published_at >= NOW() - ($2 || ' days')::INTERVAL
         ORDER BY ak.frequency DESC, a.published_at DESC
         LIMIT $3`,
        [kw, daysInt, limitInt]
      );

      return result.rows;
    });

    res.json(rows);
  } catch (err) {
    console.error("[keywords/articles]", err.message);
    res.status(500).json({ error: "articles lookup failed" });
  }
});

/* =========================================
   Cluster Snapshot API
========================================= */
app.get("/api/clusters/weekly", async (req, res) => {
  const preset = typeof req.query.preset === "string" && req.query.preset.trim()
    ? req.query.preset.trim().slice(0, 16)
    : "7d";
  const runId = req.query.runId ? parseInt(req.query.runId, 10) : null;
  const minImportance = clampQueryInt(req.query.minImportance, 0, 0, 10);
  const category = typeof req.query.category === "string" && req.query.category.trim()
    ? req.query.category.trim().toLowerCase().slice(0, 32)
    : null;

  try {
    const runParams = [];
    let runSql = `
      SELECT
        id,
        preset,
        window_start,
        window_end,
        algorithm_version,
        thread_count,
        group_count,
        completed_at
      FROM cluster_runs
      WHERE status = 'completed'
    `;

    if (Number.isInteger(runId) && runId > 0) {
      runParams.push(runId);
      runSql += ` AND id = $1`;
    } else {
      runParams.push(preset);
      runSql += ` AND preset = $1`;
    }

    runSql += ` ORDER BY completed_at DESC NULLS LAST, started_at DESC LIMIT 1`;

    const { rows: runRows } = await pool.query(runSql, runParams);
    const run = runRows[0];
    if (!run) return res.status(404).json({ error: "No completed cluster snapshot found" });

    const nodeParams = [run.id, minImportance];
    const nodeClauses = [
      `cn.run_id = $1`,
      `COALESCE(cn.importance, 0) >= $2`
    ];

    if (category) {
      nodeParams.push(category);
      nodeClauses.push(`LOWER(COALESCE(cn.primary_category, '')) = $${nodeParams.length}`);
    }

    const { rows: nodeRows } = await pool.query(`
      SELECT
        cn.thread_id,
        cn.story_identity_id,
        cn.cluster_id,
        cn.title,
        cn.description,
        cn.primary_category,
        cn.importance,
        cn.article_count,
        cn.language_count,
        cn.source_country_count,
        cn.feature_keywords,
        cn.top_countries,
        cn.top_languages,
        cn.x,
        cn.y,
        cn.z,
        cn.radius,
        cn.density_score,
        cn.novelty_score
      FROM cluster_nodes cn
      WHERE ${nodeClauses.join("\n        AND ")}
      ORDER BY COALESCE(cn.importance, 0) DESC, cn.article_count DESC, cn.thread_id ASC
    `, nodeParams);

    const nodeIds = nodeRows.map(r => parseInt(r.thread_id, 10)).filter(Boolean);
    const clusterIds = [...new Set(nodeRows.map(r => r.cluster_id).filter(Boolean))];

    const [groupResult, edgeResult] = await Promise.all([
      clusterIds.length
        ? pool.query(`
            SELECT
              cg.cluster_id,
              cg.label,
              cg.summary,
              cg.primary_category,
              cg.node_count,
              cg.article_count,
              cg.language_count,
              cg.source_country_count,
              cg.centroid_x,
              cg.centroid_y,
              cg.centroid_z,
              cg.spread,
              cg.shared_properties
            FROM cluster_groups cg
            WHERE cg.run_id = $1
              AND cg.cluster_id = ANY($2::text[])
            ORDER BY cg.node_count DESC, cg.article_count DESC, cg.cluster_id ASC
          `, [run.id, clusterIds])
        : Promise.resolve({ rows: [] }),
      nodeIds.length
        ? pool.query(`
            SELECT
              ce.source_thread_id,
              ce.target_thread_id,
              ce.weight,
              ce.reasons
            FROM cluster_edges ce
            WHERE ce.run_id = $1
              AND ce.source_thread_id = ANY($2::int[])
              AND ce.target_thread_id = ANY($2::int[])
            ORDER BY ce.weight DESC, ce.source_thread_id ASC, ce.target_thread_id ASC
          `, [run.id, nodeIds])
        : Promise.resolve({ rows: [] })
    ]);

    const groups = groupResult.rows.map((row) => ({
      cluster_id: row.cluster_id,
      label: row.label,
      summary: row.summary,
      primary_category: row.primary_category,
      node_count: parseInt(row.node_count, 10) || 0,
      article_count: parseInt(row.article_count, 10) || 0,
      language_count: parseInt(row.language_count, 10) || 0,
      source_country_count: parseInt(row.source_country_count, 10) || 0,
      centroid: {
        x: Number(row.centroid_x) || 0,
        y: Number(row.centroid_y) || 0,
        z: Number(row.centroid_z) || 0
      },
      spread: Number(row.spread) || 0,
      shared_properties: Array.isArray(row.shared_properties) ? row.shared_properties : []
    }));

    const nodes = nodeRows.map((row) => ({
      thread_id: parseInt(row.thread_id, 10),
      story_identity_id: row.story_identity_id ? parseInt(row.story_identity_id, 10) : null,
      cluster_id: row.cluster_id,
      title: row.title,
      description: row.description,
      primary_category: row.primary_category,
      importance: row.importance != null ? parseInt(row.importance, 10) : null,
      article_count: parseInt(row.article_count, 10) || 0,
      language_count: parseInt(row.language_count, 10) || 0,
      source_country_count: parseInt(row.source_country_count, 10) || 0,
      feature_keywords: Array.isArray(row.feature_keywords) ? row.feature_keywords : [],
      top_countries: Array.isArray(row.top_countries) ? row.top_countries : [],
      top_languages: Array.isArray(row.top_languages) ? row.top_languages : [],
      position: {
        x: Number(row.x) || 0,
        y: Number(row.y) || 0,
        z: Number(row.z) || 0
      },
      radius: Number(row.radius) || 1,
      density_score: Number(row.density_score) || 0,
      novelty_score: Number(row.novelty_score) || 0
    }));

    const edges = edgeResult.rows.map((row) => ({
      source_thread_id: parseInt(row.source_thread_id, 10),
      target_thread_id: parseInt(row.target_thread_id, 10),
      weight: Number(row.weight) || 0,
      reasons: Array.isArray(row.reasons) ? row.reasons : []
    }));

    res.json({
      run: {
        id: parseInt(run.id, 10),
        preset: run.preset,
        window_start: run.window_start,
        window_end: run.window_end,
        algorithm_version: run.algorithm_version,
        thread_count: parseInt(run.thread_count, 10) || 0,
        group_count: parseInt(run.group_count, 10) || 0,
        completed_at: run.completed_at
      },
      groups,
      nodes,
      edges
    });
  } catch (err) {
    console.error("[clusters/weekly]", err.message);
    res.status(500).json({ error: "Failed to fetch cluster snapshot" });
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
    const limit  = parseOptionalPositiveInt(req.query.limit);
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
          COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
          a.published_at,
          COALESCE(ns.name, ys.name) AS source_name,
          ns.source_summary,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          COALESCE(ns.site_url, ys.site_url) AS site_url,
          COALESCE(ns.popularity_score, 0) AS popularity_score,
          l.iso_code_2    AS language,
          co.iso_code,
          co.name         AS country_name,
          ci_mention.name AS city_name,
          a.media_type,
          a.video_id,
          a.duration_seconds
        FROM article_locations al
        JOIN news_articles  a   ON a.id  = al.article_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        JOIN cities ci_mention  ON ci_mention.id = al.city_id
        LEFT JOIN languages l   ON l.id  = ns.language_id
        LEFT JOIN countries co  ON co.id = a.country_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE ci_mention.region_id = $1
          AND a.published_at > NOW() - INTERVAL '7 days'
        ORDER BY a.id, a.published_at DESC
        ${limit ? "LIMIT $2" : ""}
        OFFSET $${limit ? 3 : 2}
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
          COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
          a.published_at,
          COALESCE(ns.name, ys.name) AS source_name,
          ns.source_summary,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          COALESCE(ns.site_url, ys.site_url) AS site_url,
          COALESCE(ns.popularity_score, 0) AS popularity_score,
          l.iso_code_2    AS language,
          co.iso_code,
          co.name         AS country_name,
          ci.name         AS city_name,
        a.media_type,
        a.video_id,
        a.duration_seconds
        FROM news_articles a
        LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        JOIN cities         ci  ON ci.id = a.city_id
        LEFT JOIN languages l   ON l.id  = ns.language_id
        LEFT JOIN countries co  ON co.id = a.country_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE ci.region_id = $1
          AND a.published_at > NOW() - INTERVAL '7 days'
        ORDER BY a.published_at DESC
        ${limit ? "LIMIT $2" : ""}
        OFFSET $${limit ? 3 : 2}
      `;
    }

    const { rows } = await pool.query(query, limit ? [regionId, limit, offset] : [regionId, offset]);
    
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

app.get("/api/environment", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, slug, entity_type,
             latitude, longitude, area_km2, biome, priority_score
      FROM environmental_entity
      WHERE is_active = true
      ORDER BY entity_type, name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("[environment]", err.message);
    res.status(500).json({ error: "Failed to fetch environment" });
  }
});

/* =========================================
   Location Stats  —  /api/stats/location
   Returns panel-header metrics for a city,
   country, or region node.
========================================= */
app.get("/api/stats/location", async (req, res) => {
  const { type, id } = req.query;
  const nodeId = parseInt(id);
  if (!type || !nodeId) return res.status(400).json({ error: "type and id required" });

  // Build the WHERE clause for articles belonging to this location
  let articleWhere;
  let sourceWhere;
  if (type === "city") {
    articleWhere = `a.city_id = ${nodeId}`;
    sourceWhere  = `s.city_id = ${nodeId}`;
  } else if (type === "country") {
    articleWhere = `a.country_id = ${nodeId}`;
    sourceWhere  = `s.country_id = ${nodeId}`;
  } else if (type === "region") {
    // Articles whose source country is in this region
    articleWhere = `a.country_id IN (SELECT id FROM countries WHERE region_id = ${nodeId})`;
    sourceWhere  = `s.country_id IN (SELECT id FROM countries WHERE region_id = ${nodeId})`;
  } else {
    return res.status(400).json({ error: "type must be city, country, or region" });
  }

  try {
    const [todayRes, yesterdayRes, sourceRes, globalRes, nationsRes] = await Promise.all([

      // Articles published today (UTC midnight → now)
      pool.query(`
        SELECT COUNT(*)::int AS n
        FROM news_articles a
        WHERE ${articleWhere}
          AND a.published_at >= CURRENT_DATE
          AND a.published_at <  NOW()
      `),

      // Articles published yesterday (for delta)
      pool.query(`
        SELECT COUNT(*)::int AS n
        FROM news_articles a
        WHERE ${articleWhere}
          AND a.published_at >= CURRENT_DATE - INTERVAL '1 day'
          AND a.published_at <  CURRENT_DATE
      `),

      // Active sources assigned to this location
      pool.query(`
        SELECT COUNT(*)::int AS n
        FROM news_sources s
        WHERE ${sourceWhere}
          AND s.is_active = true
      `),

      // Global attention: location's 7-day articles as % of all 7-day articles
      pool.query(`
        SELECT
          ROUND(
            100.0 * loc.n / NULLIF(total.n, 0),
            2
          ) AS pct
        FROM (
          SELECT COUNT(*)::numeric AS n
          FROM news_articles a
          WHERE ${articleWhere}
            AND a.published_at >= NOW() - INTERVAL '7 days'
        ) loc,
        (
          SELECT COUNT(*)::numeric AS n
          FROM news_articles
          WHERE published_at >= NOW() - INTERVAL '7 days'
        ) total
      `),

      // Source nations: distinct countries of sources covering this location
      pool.query(`
        SELECT COUNT(DISTINCT s.country_id)::int AS n
        FROM news_articles a
        JOIN news_sources s ON s.id = a.source_id
        WHERE ${articleWhere}
          AND a.published_at >= NOW() - INTERVAL '7 days'
          AND s.country_id IS NOT NULL
      `)
    ]);

    const today     = todayRes.rows[0].n;
    const yesterday = yesterdayRes.rows[0].n;

    res.json({
      stories_today:        today,
      stories_delta:        today - yesterday,
      source_count:         sourceRes.rows[0].n,
      attention_pct:        parseFloat(globalRes.rows[0].pct) || 0,
      source_country_count: nationsRes.rows[0].n
    });

  } catch (err) {
    console.error("[stats/location]", err.message);
    res.status(500).json({ error: "Failed to fetch location stats" });
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

// ── Keyword cache refresh ─────────────────────────────────────────────────
// keywordCron.js calls pool.end() so it must run as a child process.
// Run once at startup (60s delay so DB pool settles) then every 4 hours.
function runKeywordCron(label = "") {
  const tag = label ? `[keywordCron${label}]` : "[keywordCron]";
  console.log(`${tag} starting...`);
  const proc = spawn(process.execPath, [path.join(__dirname, "keywordCron.js")], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", d => process.stdout.write(d));
  proc.stderr.on("data", d => process.stderr.write(d));
  proc.on("exit", code => console.log(`${tag} exited (code ${code})`));
  proc.on("error", err => console.error(`${tag} spawn error: ${err.message}`));
}

setTimeout(() => runKeywordCron(" startup"), 60_000);           // ~1 min after boot
setInterval(() => runKeywordCron(), 4 * 60 * 60 * 1000).unref?.(); // every 4h

startArticleListener().catch(console.error);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
