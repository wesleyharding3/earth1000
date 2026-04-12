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
const dataPanels = require("./dataPanelGenerator");
const Anthropic = new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY });
const { resolveImagesForArticles } = require("./imageResolver");
const jwt = require("jsonwebtoken");
const payments = require("./payments");
const sba = require("./supabaseAdmin");
const { checkTranslation, checkExplanation, checkKwExplanation, checkBriefingAccess, checkCustomBriefing } = require("./tierLimits");
const { extractArticleSignals } = require("./sentimentLexicon");
const { findFallbackImage } = require("./imageFallback");

const app = express();
console.log("Node version:", process.version);

// ── Title-based country boost for threads/timelines ──────────────────────
// Threads/timelines whose title or geographic_scope mention these countries
// get a ranking boost so they surface higher in the feed.
const TITLE_COUNTRY_BOOST = {
  // Extra boost (!)
  'russia': 1.8, 'israel': 1.8, 'iran': 1.8, 'united states': 1.8, 'lebanon': 1.8,
  'russian': 1.8, 'israeli': 1.8, 'iranian': 1.8, 'american': 1.8, 'lebanese': 1.8,
  'u.s.': 1.8, 'usa': 1.8,
  // Standard boost
  'turkey': 1.4, 'turkish': 1.4, 'japan': 1.4, 'japanese': 1.4,
  'egypt': 1.4, 'egyptian': 1.4, 'south africa': 1.4, 'south african': 1.4,
  'mexico': 1.4, 'mexican': 1.4, 'argentina': 1.4, 'argentine': 1.4,
  'brazil': 1.4, 'brazilian': 1.4, 'venezuela': 1.4, 'venezuelan': 1.4,
  'colombia': 1.4, 'colombian': 1.4, 'canada': 1.4, 'canadian': 1.4,
  'australia': 1.4, 'australian': 1.4, 'thailand': 1.4, 'thai': 1.4,
  'indonesia': 1.4, 'indonesian': 1.4, 'india': 1.4, 'indian': 1.4,
  'pakistan': 1.4, 'pakistani': 1.4, 'china': 1.4, 'chinese': 1.4,
  'germany': 1.4, 'german': 1.4, 'france': 1.4, 'french': 1.4,
  'united kingdom': 1.4, 'british': 1.4, 'uk': 1.4,
  'spain': 1.4, 'spanish': 1.4, 'hungary': 1.4, 'hungarian': 1.4,
  'italy': 1.4, 'italian': 1.4, 'poland': 1.4, 'polish': 1.4,
  'greece': 1.4, 'greek': 1.4, 'saudi arabia': 1.4, 'saudi': 1.4,
};
const _titleBoostPatterns = Object.keys(TITLE_COUNTRY_BOOST)
  .sort((a, b) => b.length - a.length)
  .map(k => ({ re: new RegExp(`\\b${k.replace(/\./g, '\\.')}\\b`, 'i'), boost: TITLE_COUNTRY_BOOST[k] }));

function getTitleCountryBoost(item) {
  const text = [item.title || '', ...(Array.isArray(item.geographic_scope) ? item.geographic_scope : [])].join(' ');
  let max = 1.0;
  for (const { re, boost } of _titleBoostPatterns) {
    if (re.test(text) && boost > max) max = boost;
  }
  return max;
}

// ── Simple in-memory rate limiter ─────────────────────────────────────────
function rateLimit({ windowMs = 60_000, max = 100 } = {}) {
  const hits = new Map();
  // Prune expired entries every minute
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs) hits.delete(key);
    }
  }, 60_000).unref();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests, slow down' });
    }
    next();
  };
}

// General API: 200 req/min per IP — generous for normal use
const apiLimiter = rateLimit({ windowMs: 60_000, max: 200 });
// Expensive endpoints: 30 req/min per IP
const heavyLimiter = rateLimit({ windowMs: 60_000, max: 30 });
// Search: 60 req/min per IP
const searchLimiter = rateLimit({ windowMs: 60_000, max: 60 });
const _prodOrigins = [
  "https://earth00.com",
  "https://www.earth00.com",
  "https://wesleyharding3.github.io",
  "https://earth0.onrender.com",
  "https://earth-wjr6.onrender.com",
  "capacitor://localhost",
  "ionic://localhost"
];
const _devOrigins = [
  "http://localhost:3000",
  "http://localhost:5500",
];
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? _prodOrigins
    : [..._prodOrigins, ..._devOrigins],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept"],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(express.json());

// Apply general rate limit to all API routes
app.use('/api', apiLimiter);

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

// ── Resolve hero ISO code from title/description text ───────────────────────
// Scans thread/timeline title + description for country name mentions and
// returns the first matched country's ISO code. Uses a JS regex built once
// from the countries table (sorted longest-first to prefer "South Korea"
// over "Korea", etc.).
let _jsCountryLookup = null;
async function getCountryLookup() {
  if (_jsCountryLookup) return _jsCountryLookup;
  const { rows } = await pool.query(
    `SELECT name, iso_code FROM countries WHERE name IS NOT NULL AND length(name) >= 4 ORDER BY length(name) DESC`
  );
  const entries = rows
    .filter(r => r.iso_code)  // skip countries with no ISO code
    .map(r => ({
      name: r.name,
      iso: r.iso_code.toLowerCase(),
      re: new RegExp(`\\b${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    }));
  _jsCountryLookup = entries;
  return entries;
}

// Given a text string (title + description), return the first country ISO match
async function pickCountryIsoFromText(text) {
  if (!text) return null;
  const lookup = await getCountryLookup();
  for (const entry of lookup) {
    if (entry.re.test(text)) return entry.iso;
  }
  return null;
}

// Batch version: for an array of items with title+description,
// returns a Map<itemId, isoCode> where itemId is thread_id or timeline_id.
async function resolveHeroIsoFromText(items, idKey) {
  const lookup = await getCountryLookup();
  const result = new Map();
  for (const item of items) {
    const text = `${item.title || ''} ${item.description || ''}`;
    for (const entry of lookup) {
      if (entry.re.test(text)) {
        result.set(item[idKey], entry.iso);
        break;
      }
    }
  }
  return result;
}

// ── Tiny TTL cache + single-flight for hot read endpoints ────────────────────
//
// Coalesces concurrent requests for the same key into one DB query, then
// serves the result from memory until the TTL expires. Cuts feed/threads
// load to a single query per key per window even under fan-out from many
// clients hitting the page at once. New articles still appear within `ttlMs`
// of being inserted, so the live feel is preserved.
const _ttlCache = new Map();        // key → { expires, value }
const _ttlInflight = new Map();     // key → Promise
async function ttlCached(key, ttlMs, producer) {
  const now = Date.now();
  const hit = _ttlCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const inflight = _ttlInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const value = await producer();
      _ttlCache.set(key, { expires: Date.now() + ttlMs, value });
      return value;
    } finally {
      _ttlInflight.delete(key);
    }
  })();
  _ttlInflight.set(key, p);
  return p;
}

// ── Country-name regex, built once at boot ─────────────────────────────────
//
// `/api/threads/latest` previously did a JOIN against the full countries
// table with a per-row `~*` regex, which is N×M and crushes the query plan.
// We now precompute a single `\m(name1|name2|...)\M` alternation and reuse it
// for one regex eval per thread row instead of hundreds.
let _countryRegexPromise = null;
function getCountryRegex() {
  if (_countryRegexPromise) return _countryRegexPromise;
  _countryRegexPromise = (async () => {
    const { rows } = await pool.query(
      `SELECT name FROM countries WHERE name IS NOT NULL AND length(name) >= 4 ORDER BY length(name) DESC`
    );
    const escaped = rows
      .map(r => r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    return `\\m(${escaped})\\M`;
  })().catch(err => {
    _countryRegexPromise = null;            // allow retry next call
    console.error('[country-regex] build failed:', err.message);
    return '\\m$^\\M';                      // never matches → safe fallback
  });
  return _countryRegexPromise;
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
    // Look up actual admin flag + subscription tier
    try {
      const { data: profile } = await sba
        .from("profiles")
        .select("is_admin")
        .eq("id", req.user.id)
        .maybeSingle();
      if (profile) req.user.is_admin = profile.is_admin || false;
      const { data: subs } = await sba
        .from("subscriptions")
        .select("status, updated_at, tier_id")
        .eq("user_id", req.user.id)
        .eq("status", "active");
      const activeSub = pickBestActiveSubscription(subs || []);
      const tierRow = await resolveTierRecordById(activeSub?.tier_id);
      req.user.tier = tierRow?.name || "free";
    } catch (_) {}
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
   Video embed proxy — serves YouTube embed in
   an HTTPS HTML page so Capacitor/WKWebView
   gets a valid origin (fixes error 153 on mobile)
========================================= */
app.get("/api/video-embed", (req, res) => {
  const videoId = (req.query.v || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!videoId) return res.status(400).send('Missing video ID');
  const autoplay = req.query.autoplay !== '0' ? '1' : '0';
  const mute = req.query.mute !== '0' ? '1' : '0';
  const enablejsapi = req.query.jsapi === '1' ? '1' : '0';
  const cc = req.query.cc === '1' ? '1' : '0';

  // Derive origin from the request itself so the proxy page IS the origin
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'earth-wjr6.onrender.com';
  const selfOrigin = `${proto}://${host}`;

  const params = new URLSearchParams({
    autoplay, mute, playsinline: '1', rel: '0',
    modestbranding: '1', controls: '1',
    origin: selfOrigin,
    enablejsapi: '1'          // always enable so we can relay errors back
  });
  if (cc === '1') params.set('cc_load_policy', '1');

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:#000}
iframe{width:100%;height:100%;border:none}</style></head>
<body><iframe id="ytplayer" src="https://www.youtube.com/embed/${videoId}?${params}"
allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;web-share"
allowfullscreen></iframe>
<script>
// Relay YT IFrame API messages (including errors) to parent so Capacitor can catch them
window.addEventListener('message',function(e){
  try{window.parent.postMessage(e.data,'*')}catch(_){}
});
// Also relay via onError callback
function onYouTubeIframeAPIReady(){}
</script></body></html>`);
});

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
    const rows = await ttlCached('cities:all', 300_000, async () => {
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
      return result.rows;
    });
    res.json(rows);
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
    const rows = await ttlCached('countries:all', 300_000, async () => {
      const result = await pool.query(`
        SELECT id, name, flag, slug, iso_code, latitude AS lat, longitude AS lon, population, gdp
        FROM countries
        ORDER BY name ASC
      `);
      return result.rows;
    });
    res.json(rows);
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
    const ambient = req.query.ambient === "1" || req.query.ambient === "true";

    const ranked = await getRankedCityArticles(parseInt(req.params.cityId), { limit, offset, tagId, ambient });
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
    const ambient = req.query.ambient === "1" || req.query.ambient === "true";

    const ranked = await getRankedArticles(parseInt(req.params.countryId), { limit, offset, tagId, ambient });
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
    const rows = await ttlCached('tags:all', 300_000, async () => {
      const result = await pool.query(`
        SELECT id, name FROM tags ORDER BY id ASC
      `);
      return result.rows;
    });
    res.json(rows);
  } catch (err) {
    console.error("Tags error:", err);
    res.status(500).json({ error: "Failed to fetch tags" });
  }
});

/* =========================================
   Search — relational (from → keyword → about)
========================================= */

// Shared helper: executes the default (no-filter) news search query.
// Used by the endpoint fast-path and by _warmFeedCaches.
async function _executeNewsSearch({ effectiveLimit, offset }) {
  const conditions = [`a.city_id IS NULL`, `a.published_at > NOW() - INTERVAL '72 hours'`];
  const params = [effectiveLimit + 1, offset];
  try {
    const { rows } = await pool.query(`
      SELECT * FROM (
        SELECT
          a.id, a.title, a.translated_title, a.url, a.article_url,
          a.summary, a.translated_summary,
          COALESCE(a.image_url, img_a.public_url) AS image_url,
          img_a.public_url AS catalog_image_url,
          a.published_at, a.sentiment_score,
          l.iso_code_2 AS language, a.base_priority,
          COALESCE(ns.name, ys.name) AS source_name,
          ns.source_summary,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          COALESCE(ns.site_url, ys.site_url) AS site_url,
          src_co.iso_code, src_co.name AS country_name, src_co.flag AS country_flag,
          COALESCE(cfb.boost_score, 1.0) AS country_boost,
          GREATEST(
            POWER(0.5, EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 21600.0),
            0.02
          ) AS recency_decay,
          a.media_type, a.video_id, a.duration_seconds
        FROM news_articles a
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN languages l ON l.id = ns.language_id
        JOIN countries src_co ON src_co.id = a.country_id
        LEFT JOIN country_feed_boost cfb ON cfb.country_id = a.country_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE ${conditions.join(' AND ')}
      ) sub
      ORDER BY (
        (COALESCE(sub.base_priority, 0) * 0.15 + sub.recency_decay * 0.85)
        * POWER(sub.country_boost, 2.0)
      ) DESC
      LIMIT $1 OFFSET $2
    `, params);

    return _finalizeSearchResults(rows, effectiveLimit, offset);
  } catch (err) {
    // Fallback: lightweight query when the full query times out under DB pressure
    console.warn('[news/search] Full query failed, trying lightweight fallback:', err.message);
    const { rows } = await pool.query(`
      SELECT
        a.id, a.title, a.translated_title, a.url, a.article_url,
        a.summary, a.translated_summary,
        COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
        a.published_at, a.sentiment_score,
        NULL AS language, a.base_priority,
        NULL AS source_name, NULL AS source_summary,
        'unknown' AS source_bias, NULL AS site_url,
        src_co.iso_code, src_co.name AS country_name, src_co.flag AS country_flag,
        1.0 AS country_boost,
        GREATEST(
          POWER(0.5, EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 21600.0),
          0.02
        ) AS recency_decay,
        a.media_type, a.video_id, a.duration_seconds
      FROM news_articles a
      JOIN countries src_co ON src_co.id = a.country_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      WHERE a.city_id IS NULL
        AND a.published_at > NOW() - INTERVAL '72 hours'
      ORDER BY a.base_priority DESC NULLS LAST, a.published_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    return _finalizeSearchResults(rows, effectiveLimit, offset);
  }
}

function _finalizeSearchResults(rows, effectiveLimit, offset) {
  const hasMore = rows.length > effectiveLimit;
  if (hasMore) rows.pop();

  let results = rows.map(r => ({
    ...r,
    final_priority: (
      (r.base_priority || 0) * 0.15 + (r.recency_decay || 0) * 0.85
    ) * Math.pow(r.country_boost || 1, 2.0)
  }));

  if (results.length >= 8) {
    results = diversityRerank(results.map(r => ({ ...r, priority: r.final_priority })));
    results = countryVarianceRerank(results);
  }

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

  return { total: offset + results.length + (hasMore ? 1 : 0), articles: results };
}

app.get("/api/news/search", searchLimiter, async (req, res) => {
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

    // ── Fast path: default query (no filters, page 0) → serve from TTL cache ──
    const isDefaultQuery = !fromIds && !aboutIds && !keyword && !fromDate && !toDate && !req.query.tag && offset === 0;
    const effectiveLimit = limit || 24;
    if (isDefaultQuery) {
      const cacheKey = `news/search:default:${effectiveLimit}`;
      const cached = await ttlCached(cacheKey, 60_000, async () => {
        return await _executeNewsSearch({ effectiveLimit, offset: 0 });
      });
      return res.json(cached);
    }

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

    // Fetch 1 extra row to know if there are more pages (avoids expensive COUNT)
    params.push(effectiveLimit + 1, offset);
    const limitParam  = params.length - 1;
    const offsetParam = params.length;
    const limitClause = `LIMIT $${limitParam} OFFSET $${offsetParam}`;

    const { rows } = await pool.query(`
      SELECT * FROM (
        SELECT ${needsLocJoin ? "DISTINCT ON (a.id)" : ""}
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
          COALESCE(cfb.boost_score, 1.0) AS country_boost,
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
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        ${needsLocJoin ? `
          JOIN article_locations al  ON al.article_id = a.id
          JOIN countries about_co    ON about_co.id   = al.country_id
        ` : ""}
        ${whereClause}
        ${needsLocJoin ? "ORDER BY a.id" : ""}
      ) sub
      ORDER BY (
        (COALESCE(sub.base_priority, 0) * 0.15 + sub.recency_decay * 0.85)
        * POWER(sub.country_boost, 2.0)
      ) DESC
      ${limitClause}
    `, params);

    // Check if there's a next page, then trim the extra row
    const hasMore = rows.length > effectiveLimit;
    if (hasMore) rows.pop();

    let results = rows.map(r => ({
      ...r,
      final_priority: (
        (r.base_priority || 0) * 0.15 + (r.recency_decay || 0) * 0.85
      ) * Math.pow(r.country_boost || 1, 2.0)
    }));

    // Light reranking only when we have enough rows to benefit
    if (results.length >= 8) {
      results = diversityRerank(results.map(r => ({ ...r, priority: r.final_priority })));
      results = countryVarianceRerank(results);
    }

    // Tiebreak by date within a tight priority band (3%)
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

    res.json({ total: offset + results.length + (hasMore ? 1 : 0), articles: results });

  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed", detail: req.user?.is_admin ? err.message : undefined });
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
app.get("/api/flows", heavyLimiter, async (req, res) => {
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

    // ── TTL cache for flows — keyed by all filter params ──────────────
    const _flowCacheKey = `flows:${mode}:${viewMode}:${limit}:${fromDate||''}:${toDate||''}:${fromCountry||''}:${fromCity||''}:${aboutCountry||''}:${aboutCity||''}:${keyword||''}:${normalize}`;
    const _flowResult = await ttlCached(_flowCacheKey, 45_000, async () => {

    // Build dynamic WHERE conditions
    const conditions = [];
    const params = [];

    // Always: must have routing
    conditions.push(`al.routing_type IN ('content', 'source')`);

    // Date filters — default to 7 days if no date range specified
    if (fromDate) {
      params.push(fromDate);
      conditions.push(`a.published_at >= $${params.length}::date`);
    }
    if (toDate) {
      params.push(toDate);
      conditions.push(`a.published_at < $${params.length}::date + interval '1 day'`);
    }
    if (!fromDate && !toDate) {
      conditions.push(`a.published_at > NOW() - INTERVAL '7 days'`);
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

      return {
        mode: "aggregate",
        totalRoutes: flows.length,
        totalArticles,
        maxCount,
        flows
      };

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

      return {
        mode: "individual",
        normalized: normalize,
        total: flows.length,
        flows
      };
    }

    }); // end ttlCached

    res.json(_flowResult);

  } catch (err) {
    console.error("Flows error:", err.message);
    res.status(500).json({ error: "Failed to fetch flows", detail: req.user?.is_admin ? err.message : undefined });
  }
});

/* =========================================
   Flows for a single article
   Returns aggregate flows for all locations mentioned in the article
========================================= */
app.get("/api/flows/article/:id", async (req, res) => {
  try {
    const articleId = parseInt(req.params.id, 10);
    if (!articleId) return res.status(400).json({ error: "Invalid article ID" });

    const _cached = await ttlCached(`flows/article:${articleId}`, 60_000, async () => {
    const { rows } = await pool.query(`
      SELECT
        a.id AS article_id,
        COALESCE(a.translated_title, a.title) AS title,
        a.title AS original_title,
        COALESCE(a.translated_summary, a.summary) AS summary,
        a.published_at,
        a.article_url,
        COALESCE(a.image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
        COALESCE(ns.name, ys.name) AS source_name,
        COALESCE(ns.bias, 'unknown') AS source_bias,
        a.sentiment_score,
        a.media_type,
        a.video_id,
        src_co.iso_code AS article_iso,
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
        dst_co.iso_code AS dst_iso,
        al.routing_type AS routing_type
      FROM article_locations al
      JOIN news_articles a   ON a.id = al.article_id
      JOIN countries src_co  ON src_co.id = a.country_id
      JOIN countries dst_co  ON dst_co.id = al.country_id
      LEFT JOIN cities src_city ON src_city.id = a.city_id
      LEFT JOIN cities dst_city ON dst_city.id = al.city_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      WHERE al.article_id = $1
        AND al.routing_type IN ('content', 'source')
    `, [articleId]);

    if (!rows.length) return res.json({ flows: [] });

    // Build article object from first row (same article for all flows)
    const r0 = rows[0];
    const article = {
      id: r0.article_id,
      title: r0.title,
      translated_title: r0.title,
      summary: r0.summary,
      translated_summary: r0.summary,
      published_at: r0.published_at,
      article_url: r0.article_url,
      image_url: r0.image_url,
      catalog_image_url: r0.catalog_image_url,
      source_name: r0.source_name,
      source_bias: r0.source_bias,
      sentiment_score: r0.sentiment_score,
      media_type: r0.media_type,
      video_id: r0.video_id,
      iso_code: r0.article_iso
    };

    const flows = rows.map(r => ({
      title: r.title,
      publishedAt: r.published_at,
      src: {
        lat: parseFloat(r.src_lat), lon: parseFloat(r.src_lon),
        place: r.src_place, id: r.src_id, type: r.src_type, iso: r.src_iso
      },
      dst: {
        lat: parseFloat(r.dst_lat), lon: parseFloat(r.dst_lon),
        place: r.dst_place, id: r.dst_id, type: r.dst_type, iso: r.dst_iso
      },
      count: 1,
      routingType: r.routing_type
    }));

    return { flows, article };
    });
    res.json(_cached);
  } catch (err) {
    console.error("[flows/article]", err.message);
    res.status(500).json({ error: "Failed to fetch article flows", detail: req.user?.is_admin ? err.message : undefined });
  }
});

/* =========================================
   Flows for a thread (all articles in the thread)
   Returns arcs between countries directly involved in the story
   (subject/actor/location roles from entity extraction, not
   every country that merely has an article mentioning the topic)
========================================= */
app.get("/api/flows/thread/:id", async (req, res) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ error: "Invalid thread ID" });

    const _cached = await ttlCached(`flows/thread:${threadId}`, 60_000, async () => {
    // Find distinct countries directly involved in this thread's story
    // by looking at entity mentions with active roles (subject/actor/location)
    const { rows: involvedCountries } = await pool.query(`
      SELECT DISTINCT
        co.id, co.name AS place, co.latitude AS lat, co.longitude AS lon,
        co.iso_code AS iso,
        'country' AS type,
        -- Weight: subject > actor > location for ordering
        MIN(CASE aem.role
          WHEN 'subject'  THEN 1
          WHEN 'actor'    THEN 2
          WHEN 'location' THEN 3
          ELSE 4
        END) AS role_rank,
        COUNT(DISTINCT sta.article_id) AS mention_count
      FROM story_thread_articles sta
      JOIN article_entity_mentions aem ON aem.article_id = sta.article_id
      JOIN entities e ON e.id = aem.entity_id
      JOIN countries co ON LOWER(co.iso_code) = LOWER(e.country_code)
      WHERE sta.thread_id = $1
        AND e.entity_type = 'location'
        AND aem.role IN ('subject', 'actor', 'location')
        AND aem.confidence >= 0.6
      GROUP BY co.id, co.name, co.latitude, co.longitude, co.iso_code
      ORDER BY role_rank, mention_count DESC
      LIMIT 10
    `, [threadId]);

    if (involvedCountries.length < 2) {
      // Fallback: find distinct content-routed countries across all articles
      // in this thread, then draw arcs between them (country↔country, not
      // source→country which shows where reporters are, not the story).
      const { rows: contentCountries } = await pool.query(`
        SELECT
          co.id, co.name AS place, co.latitude AS lat, co.longitude AS lon,
          co.iso_code AS iso,
          COUNT(DISTINCT al.article_id) AS mention_count
        FROM story_thread_articles sta
        JOIN article_locations al ON al.article_id = sta.article_id
        JOIN countries co ON co.id = al.country_id
        WHERE sta.thread_id = $1
          AND al.routing_type = 'content'
        GROUP BY co.id, co.name, co.latitude, co.longitude, co.iso_code
        ORDER BY mention_count DESC
        LIMIT 10
      `, [threadId]);

      if (contentCountries.length < 2) return { flows: [], maxCount: 0 };

      // Connect consecutive content-country pairs (most-mentioned first)
      const flows = [];
      for (let i = 0; i < contentCountries.length - 1; i++) {
        const src = contentCountries[i];
        const dst = contentCountries[i + 1];
        flows.push({
          src: { lat: parseFloat(src.lat), lon: parseFloat(src.lon),
                 place: src.place, id: src.id, type: 'country', iso: src.iso },
          dst: { lat: parseFloat(dst.lat), lon: parseFloat(dst.lon),
                 place: dst.place, id: dst.id, type: 'country', iso: dst.iso },
          count: parseInt(src.mention_count) + parseInt(dst.mention_count)
        });
      }
      const maxCount = Math.max(...flows.map(f => f.count));
      return { flows, maxCount };
    }

    // Build arcs between involved countries (consecutive pairs by role importance)
    const flows = [];
    for (let i = 0; i < involvedCountries.length - 1; i++) {
      const src = involvedCountries[i];
      const dst = involvedCountries[i + 1];
      flows.push({
        src: { lat: parseFloat(src.lat), lon: parseFloat(src.lon),
               place: src.place, id: src.id, type: 'country', iso: src.iso },
        dst: { lat: parseFloat(dst.lat), lon: parseFloat(dst.lon),
               place: dst.place, id: dst.id, type: 'country', iso: dst.iso },
        count: parseInt(src.mention_count) + parseInt(dst.mention_count)
      });
    }

    const maxCount = flows.length ? Math.max(...flows.map(f => f.count)) : 1;
    return { flows, maxCount };
    });
    res.json(_cached);
  } catch (err) {
    console.error("[flows/thread]", err.message);
    res.status(500).json({ error: "Failed to fetch thread flows", detail: req.user?.is_admin ? err.message : undefined });
  }
});

/* =========================================
   Articles for a specific route within a thread
   Used when clicking a flow arc in thread flow view
========================================= */
app.get("/api/flows/thread/:id/route", async (req, res) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    const srcId = parseInt(req.query.src_id, 10);
    const dstId = parseInt(req.query.dst_id, 10);
    const srcType = req.query.src_type || "country";
    const dstType = req.query.dst_type || "country";

    if (!threadId || !srcId || !dstId) {
      return res.status(400).json({ error: "thread_id, src_id, dst_id required" });
    }

    // Try entity-based lookup first: find articles that mention BOTH countries
    // as subject/actor/location entities
    const { rows: srcCountry } = await pool.query(
      `SELECT iso_code FROM countries WHERE id = $1`, [srcId]
    );
    const { rows: dstCountry } = await pool.query(
      `SELECT iso_code FROM countries WHERE id = $1`, [dstId]
    );

    let rows;
    if (srcCountry.length && dstCountry.length) {
      const result = await pool.query(`
        SELECT DISTINCT ON (a.id)
          a.id,
          COALESCE(a.translated_title, a.title) AS title,
          a.title AS original_title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          a.published_at,
          a.article_url,
          COALESCE(a.image_url, img_a.public_url) AS image_url,
          img_a.public_url AS catalog_image_url,
          COALESCE(ns.name, ys.name) AS source_name,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          a.media_type,
          a.video_id,
          src_co.iso_code AS iso_code,
          src_co.name AS country_name,
          src_city.name AS city_name
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        JOIN countries src_co ON src_co.id = a.country_id
        LEFT JOIN cities src_city ON src_city.id = a.city_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE sta.thread_id = $1
          AND EXISTS (
            SELECT 1 FROM article_entity_mentions aem
            JOIN entities e ON e.id = aem.entity_id
            WHERE aem.article_id = a.id
              AND e.entity_type = 'location'
              AND LOWER(e.country_code) = LOWER($2)
              AND aem.role IN ('subject', 'actor', 'location')
          )
          AND EXISTS (
            SELECT 1 FROM article_entity_mentions aem
            JOIN entities e ON e.id = aem.entity_id
            WHERE aem.article_id = a.id
              AND e.entity_type = 'location'
              AND LOWER(e.country_code) = LOWER($3)
              AND aem.role IN ('subject', 'actor', 'location')
          )
        ORDER BY a.id, a.published_at DESC
        LIMIT 50
      `, [threadId, srcCountry[0].iso_code, dstCountry[0].iso_code]);
      rows = result.rows;
    }

    // Fallback to legacy article_locations if entity lookup returned nothing
    if (!rows || !rows.length) {
      const srcJoin = srcType === "city" ? "a.city_id" : "a.country_id";
      const dstJoin = dstType === "city" ? "al.city_id" : "al.country_id";
      const result = await pool.query(`
        SELECT DISTINCT ON (a.id)
          a.id,
          COALESCE(a.translated_title, a.title) AS title,
          a.title AS original_title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          a.published_at,
          a.article_url,
          COALESCE(a.image_url, img_a.public_url) AS image_url,
          img_a.public_url AS catalog_image_url,
          COALESCE(ns.name, ys.name) AS source_name,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          a.media_type,
          a.video_id,
          src_co.iso_code AS iso_code,
          src_co.name AS country_name,
          src_city.name AS city_name
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        JOIN article_locations al ON al.article_id = a.id
        JOIN countries src_co ON src_co.id = a.country_id
        LEFT JOIN cities src_city ON src_city.id = a.city_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE sta.thread_id = $1
          AND ${srcJoin} = $2
          AND ${dstJoin} = $3
          AND al.routing_type = 'content'
        ORDER BY a.id, a.published_at DESC
        LIMIT 50
      `, [threadId, srcId, dstId]);
      rows = result.rows;
    }

    res.json({ articles: rows });
  } catch (err) {
    console.error("[flows/thread/route]", err.message);
    res.status(500).json({ error: "Failed to fetch route articles", detail: req.user?.is_admin ? err.message : undefined });
  }
});

/* =========================================
   Thread Timeline — articles with timestamps and involved nations
   Returns articles in chronological order with their mentioned countries
========================================= */
app.get("/api/threads/:id/timeline", async (req, res) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ error: "Invalid thread ID" });

    const { rows } = await pool.query(`
      SELECT
        a.id,
        COALESCE(a.translated_title, a.title) AS title,
        a.published_at,
        a.sentiment_score,
        COALESCE(ns.name, ys.name) AS source_name,
        src_co.name AS source_country,
        src_co.iso_code AS source_iso,
        ARRAY_AGG(DISTINCT dst_co.name) FILTER (WHERE dst_co.name IS NOT NULL) AS mentioned_countries,
        ARRAY_AGG(DISTINCT dst_co.iso_code) FILTER (WHERE dst_co.iso_code IS NOT NULL) AS mentioned_isos
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries src_co ON src_co.id = a.country_id
      LEFT JOIN article_locations al ON al.article_id = a.id AND al.routing_type IN ('content', 'source')
      LEFT JOIN countries dst_co ON dst_co.id = al.country_id
      WHERE sta.thread_id = $1
      GROUP BY a.id, a.translated_title, a.title, a.published_at, a.sentiment_score,
               ns.name, ys.name, src_co.name, src_co.iso_code
      ORDER BY a.published_at ASC
      LIMIT 200
    `, [threadId]);

    // Collect all unique countries involved
    const allCountries = new Set();
    rows.forEach(r => {
      if (r.source_country) allCountries.add(r.source_country);
      if (r.mentioned_countries) r.mentioned_countries.forEach(c => allCountries.add(c));
    });

    const timeline = rows.map(r => ({
      id: r.id,
      title: r.title,
      publishedAt: r.published_at,
      sentiment: r.sentiment_score ? parseFloat(r.sentiment_score) : null,
      sourceName: r.source_name,
      sourceCountry: r.source_country,
      sourceIso: r.source_iso,
      mentionedCountries: r.mentioned_countries || [],
      mentionedIsos: r.mentioned_isos || []
    }));

    res.json({
      threadId,
      totalArticles: timeline.length,
      countries: [...allCountries],
      timeline
    });
  } catch (err) {
    console.error("[threads/timeline]", err.message);
    res.status(500).json({ error: "Failed to fetch thread timeline", detail: req.user?.is_admin ? err.message : undefined });
  }
});


/* =========================================
   Semantic Heatmap
   Aggregates articles by country for the globe heatmap view.
   Supports coverage (article counts), sentiment (avg score), and
   optional time-bucketed series for playback.
   Params:
     mode        coverage|sentiment|volume  (affects server-side sort only)
     days        int (default 7, max 90)
     from,to     ISO dates (override days if provided)
     keyword     ILIKE filter on title/summary/translated_title
     thread_id   scope to a single story thread
     bucket      none|day|hour (default none)
     level       country (city reserved for future)
========================================= */

// ── Heatmap snapshot refresh ──────────────────────────────────────────────
// Pre-computes country/city aggregations for standard time windows so the
// /api/heatmap endpoint can read from a tiny snapshot table (~2k rows per
// preset) instead of scanning 300k+ news_articles rows.
async function refreshHeatmapSnapshots() {
  // Process each preset independently — own connection, own timeout.
  // If one preset fails (e.g. 90d is too large), the others still succeed.
  const presets = [
    { key: '7d',  days: 7   },   // default — most important, run first
    { key: '1d',  days: 1   },
    { key: '30d', days: 30  },
    { key: '90d', days: 90  },
  ];

  const results = [];
  for (const { key, days } of presets) {
    const client = await pool.connect();
    try {
      // 5 min timeout per preset — must be session-level SET (not LOCAL)
      // because the heavy aggregation queries run outside the transaction.
      await client.query('SET statement_timeout = 300000');

      const { rows: countryRows } = await client.query(`
        SELECT
          c.id AS ref_id, c.id AS country_id,
          c.iso_code AS iso, NULL::text AS country_name,
          c.name, c.latitude AS lat, c.longitude AS lon,
          COUNT(*)::int AS n,
          COUNT(a.sentiment_score)::int AS sent_n,
          AVG(a.sentiment_score)::float AS avg_sent
        FROM news_articles a
        JOIN countries c ON c.id = a.country_id
        WHERE a.published_at > NOW() - make_interval(days => $1)
          AND a.country_id IS NOT NULL
          AND a.city_id IS NULL
          AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
        GROUP BY c.id, c.name, c.iso_code, c.latitude, c.longitude
        ORDER BY n DESC
        LIMIT 500
      `, [days]);

      const { rows: cityRows } = await client.query(`
        SELECT
          ci.id AS ref_id, ci.country_id,
          co.iso_code AS iso, co.name AS country_name,
          ci.name, ci.latitude AS lat, ci.longitude AS lon,
          COUNT(*)::int AS n,
          COUNT(a.sentiment_score)::int AS sent_n,
          AVG(a.sentiment_score)::float AS avg_sent
        FROM news_articles a
        JOIN cities ci ON ci.id = a.city_id
        LEFT JOIN countries co ON co.id = ci.country_id
        WHERE a.published_at > NOW() - make_interval(days => $1)
          AND a.city_id IS NOT NULL
          AND ci.latitude IS NOT NULL AND ci.longitude IS NOT NULL
        GROUP BY ci.id, ci.country_id, co.iso_code, co.name, ci.name, ci.latitude, ci.longitude
        ORDER BY n DESC
        LIMIT 1500
      `, [days]);

      await client.query('BEGIN');
      await client.query('DELETE FROM heatmap_snapshots WHERE preset = $1', [key]);

      if (countryRows.length) {
        const vals = countryRows.map((r, i) => {
          const off = i * 11;
          return `($${off+1},'country',$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10},$${off+11},NOW())`;
        }).join(',');
        const params = countryRows.flatMap(r => [key, r.ref_id, r.country_id, r.iso, r.country_name, r.name, r.lat, r.lon, r.n, r.sent_n, r.avg_sent]);
        await client.query(`INSERT INTO heatmap_snapshots (preset,level,ref_id,country_id,iso,country_name,name,lat,lon,n,sent_n,avg_sent,refreshed_at) VALUES ${vals}`, params);
      }

      if (cityRows.length) {
        const CHUNK = 200;
        for (let c = 0; c < cityRows.length; c += CHUNK) {
          const chunk = cityRows.slice(c, c + CHUNK);
          const vals = chunk.map((r, i) => {
            const off = i * 11;
            return `($${off+1},'city',$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10},$${off+11},NOW())`;
          }).join(',');
          const params = chunk.flatMap(r => [key, r.ref_id, r.country_id, r.iso, r.country_name, r.name, r.lat, r.lon, r.n, r.sent_n, r.avg_sent]);
          await client.query(`INSERT INTO heatmap_snapshots (preset,level,ref_id,country_id,iso,country_name,name,lat,lon,n,sent_n,avg_sent,refreshed_at) VALUES ${vals}`, params);
        }
      }

      await client.query('COMMIT');
      console.log(`[heatmap-refresh] preset=${key} countries=${countryRows.length} cities=${cityRows.length}`);
      results.push({ preset: key, ok: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error(`[heatmap-refresh] preset=${key} failed:`, e.message);
      results.push({ preset: key, ok: false, error: e.message });
    } finally {
      client.release();
    }
  }
  // If ALL presets failed, throw so the endpoint returns 500
  if (results.every(r => !r.ok)) {
    throw new Error(`All presets failed: ${results.map(r => r.error).join('; ')}`);
  }
  return results;
}

// ── Time-series (bucketed) snapshot refresh ─────────────────────────────────
// Pre-computes bucketed aggregates for the most common time-series combos.
// 7d_hour / 14d_hour are too large to pre-compute; they remain live-query.
async function refreshHeatmapTsSnapshots() {
  const tsPresets = [
    { key: '7d_day',   days: 7,  trunc: 'day'  },   // most requested
    { key: '1d_hour',  days: 1,  trunc: 'hour' },
    { key: '14d_day',  days: 14, trunc: 'day'  },
    { key: '3d_hour',  days: 3,  trunc: 'hour' },
    { key: '3d_day',   days: 3,  trunc: 'day'  },
    { key: '1d_day',   days: 1,  trunc: 'day'  },
  ];

  const results = [];
  for (const { key, days, trunc } of tsPresets) {
    const client = await pool.connect();
    try {
      // 2 min per TS preset — shorter than flat presets to stay within cron budget
      await client.query('SET statement_timeout = 120000');

      const { rows: countryRows } = await client.query(`
        SELECT
          date_trunc('${trunc}', a.published_at) AS bucket_time,
          c.id AS ref_id, c.id AS country_id,
          c.iso_code AS iso, NULL::text AS country_name,
          c.name, c.latitude AS lat, c.longitude AS lon,
          COUNT(*)::int AS n,
          COUNT(a.sentiment_score)::int AS sent_n,
          AVG(a.sentiment_score)::float AS avg_sent
        FROM news_articles a
        JOIN countries c ON c.id = a.country_id
        WHERE a.published_at > NOW() - make_interval(days => $1)
          AND a.country_id IS NOT NULL
          AND a.city_id IS NULL
          AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
        GROUP BY date_trunc('${trunc}', a.published_at), c.id, c.name, c.iso_code, c.latitude, c.longitude
        ORDER BY bucket_time, n DESC
        LIMIT 20000
      `, [days]);

      const { rows: cityRows } = await client.query(`
        SELECT
          date_trunc('${trunc}', a.published_at) AS bucket_time,
          ci.id AS ref_id, ci.country_id,
          co.iso_code AS iso, co.name AS country_name,
          ci.name, ci.latitude AS lat, ci.longitude AS lon,
          COUNT(*)::int AS n,
          COUNT(a.sentiment_score)::int AS sent_n,
          AVG(a.sentiment_score)::float AS avg_sent
        FROM news_articles a
        JOIN cities ci ON ci.id = a.city_id
        LEFT JOIN countries co ON co.id = ci.country_id
        WHERE a.published_at > NOW() - make_interval(days => $1)
          AND a.city_id IS NOT NULL
          AND ci.latitude IS NOT NULL AND ci.longitude IS NOT NULL
        GROUP BY date_trunc('${trunc}', a.published_at), ci.id, ci.country_id, co.iso_code, co.name, ci.name, ci.latitude, ci.longitude
        ORDER BY bucket_time, n DESC
        LIMIT 40000
      `, [days]);

      await client.query('BEGIN');
      await client.query('DELETE FROM heatmap_ts_snapshots WHERE preset = $1', [key]);

      const insertChunk = async (rows, level) => {
        const CHUNK = 200;
        for (let c = 0; c < rows.length; c += CHUNK) {
          const chunk = rows.slice(c, c + CHUNK);
          const vals = chunk.map((r, i) => {
            const off = i * 12;
            return `($${off+1},'${level}',$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10},$${off+11},$${off+12},NOW())`;
          }).join(',');
          const params = chunk.flatMap(r => [key, r.bucket_time, r.ref_id, r.country_id, r.iso, r.country_name, r.name, r.lat, r.lon, r.n, r.sent_n, r.avg_sent]);
          await client.query(`INSERT INTO heatmap_ts_snapshots (preset,level,bucket_time,ref_id,country_id,iso,country_name,name,lat,lon,n,sent_n,avg_sent,refreshed_at) VALUES ${vals}`, params);
        }
      };

      if (countryRows.length) await insertChunk(countryRows, 'country');
      if (cityRows.length)    await insertChunk(cityRows, 'city');

      await client.query('COMMIT');
      console.log(`[heatmap-ts-refresh] preset=${key} countries=${countryRows.length} cities=${cityRows.length}`);
      results.push({ preset: key, ok: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error(`[heatmap-ts-refresh] preset=${key} failed:`, e.message);
      results.push({ preset: key, ok: false, error: e.message });
    } finally {
      client.release();
    }
  }
  return results;
}

// GET|POST /api/admin/refresh-heatmap — triggered by Render cron every 10-15 min
// Accepts both GET (Render cron jobs hit URLs via GET) and POST.
// Auth: pass secret as query param ?key= or Authorization header.
app.all("/api/admin/refresh-heatmap", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  const queryKey = req.query.key;
  if (!secret || (auth !== `Bearer ${secret}` && queryKey !== secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const t0 = Date.now();
    const flatResults = await refreshHeatmapSnapshots();
    // Time-series snapshots run after flat — if they fail, flat results are still saved
    let tsResults = [];
    try {
      tsResults = await refreshHeatmapTsSnapshots();
    } catch (e) {
      console.error('[heatmap-ts-refresh] failed:', e.message);
      tsResults = [{ ok: false, error: e.message }];
    }
    const elapsed = Date.now() - t0;
    console.log(`[heatmap-refresh] completed in ${elapsed}ms (flat + ts)`);
    // Bust in-memory TTL cache so next request picks up fresh snapshot
    for (const k of _ttlCache.keys()) {
      if (k.startsWith('heatmap:')) _ttlCache.delete(k);
    }
    res.json({ ok: true, elapsed_ms: elapsed, presets: flatResults, ts_presets: tsResults });
  } catch (err) {
    console.error("[heatmap-refresh] failed:", err.message, err.stack);
    res.status(500).json({ error: "Refresh failed", detail: req.user?.is_admin ? err.message : undefined });
  }
});

// ── Briefing Editor Admin Routes ──────────────────────────────────────────
async function requireAdmin(req, res, next) {
  // optionalAuth may fail for ES256 tokens — fall back to Supabase API
  if (!req.user?.id) {
    const authUser = await resolveSupabaseUserFromRequest(req);
    if (!authUser?.id) return res.status(401).json({ error: 'Authentication required' });
    // Load admin flag
    const { data: profile } = await sba
      .from('profiles')
      .select('is_admin')
      .eq('id', authUser.id)
      .maybeSingle();
    req.user.is_admin = profile?.is_admin || false;
  }
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// List candidate threads for briefing editor (mirrors listCandidateThreads from briefingGenerator)
app.get('/api/admin/briefing-editor/threads', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        st.id, st.title, st.primary_category, st.importance, st.keywords,
        st.geographic_scope,
        COUNT(sta.article_id)::int AS recent_articles,
        COUNT(CASE WHEN a.video_id IS NOT NULL THEN 1 END)::int AS video_count
      FROM story_threads st
      JOIN story_thread_articles sta ON sta.thread_id = st.id
      JOIN news_articles a ON a.id = sta.article_id
      WHERE st.status = 'active'
        AND st.last_updated_at > NOW() - INTERVAL '3 days'
        AND a.published_at > NOW() - INTERVAL '3 days'
      GROUP BY st.id
      HAVING COUNT(sta.article_id) >= 1
      ORDER BY st.importance DESC, COUNT(sta.article_id) DESC
      LIMIT 100
    `);
    res.json({ threads: rows.map(r => ({
      ...r,
      hasVideo: r.video_count > 0,
      keywords: Array.isArray(r.keywords) ? r.keywords : (r.keywords ? [r.keywords] : []),
      geographic_scope: Array.isArray(r.geographic_scope) ? r.geographic_scope : (r.geographic_scope ? [r.geographic_scope] : [])
    })) });
  } catch (err) {
    console.error('[briefing-editor] threads error:', err.message);
    res.status(500).json({ error: 'Failed to load threads' });
  }
});

// Resolve a YouTube URL to get video metadata
app.post('/api/admin/briefing-editor/resolve-video', requireAdmin, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Extract video ID from various YouTube URL formats
    let videoId = null;
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) { videoId = m[1]; break; }
    }
    if (!videoId) return res.status(400).json({ error: 'Could not extract YouTube video ID from URL' });

    // Try to get video info via oEmbed (no API key needed)
    let title = 'YouTube Video', author = '';
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const resp = await fetch(oembedUrl);
      if (resp.ok) {
        const data = await resp.json();
        title = data.title || 'Unknown';
        author = data.author_name || '';
      } else if (resp.status === 401 || resp.status === 403) {
        return res.status(400).json({ error: 'Video is not embeddable (embedding disabled by owner)' });
      } else if (resp.status === 404) {
        return res.status(400).json({ error: 'Video not found or unavailable' });
      }
    } catch (_) {}

    // Check embed endpoint (catches error 150/153 — owner disabled embedding)
    try {
      const embedResp = await fetch(`https://www.youtube-nocookie.com/embed/${videoId}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000)
      });
      const xfo = embedResp.headers.get('x-frame-options');
      if (xfo && xfo.toLowerCase() === 'sameorigin') {
        return res.status(400).json({ error: 'Video cannot be embedded (X-Frame-Options restriction)' });
      }
    } catch (_) {}

    // Check if captions/subtitles are available via timedtext API
    let hasCaptions = false;
    try {
      const ccResp = await fetch(`https://video.google.com/timedtext?type=list&v=${videoId}`, {
        signal: AbortSignal.timeout(3000)
      });
      if (ccResp.ok) {
        const ccText = await ccResp.text();
        hasCaptions = ccText.includes('<track');
      }
    } catch (_) {}

    res.json({
      video_id: videoId,
      title,
      author,
      embeddable: true,
      has_captions: hasCaptions,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    });
  } catch (err) {
    console.error('[briefing-editor] resolve-video error:', err.message);
    res.status(500).json({ error: 'Failed to resolve video' });
  }
});

// Save manifest and trigger briefing generation — streams logs via SSE
app.post('/api/admin/briefing-editor/generate', requireAdmin, async (req, res) => {
  try {
    const manifest = req.body;
    if (!manifest?.selected_threads?.length) {
      return res.status(400).json({ error: 'Manifest must include selected_threads' });
    }

    // Save manifest to temp file
    const tmpDir = require('os').tmpdir();
    const manifestPath = path.join(tmpDir, `briefing-manifest-${Date.now()}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // SSE headers — stream logs to the editor in real-time
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = (type, data, extra) => {
      const evt = { type, data };
      if (extra) Object.assign(evt, extra);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    send('log', `Manifest saved: ${manifestPath}`);

    // Spawn briefingGenerator
    const args = ['briefingGenerator.js', '--force', '--manifest', manifestPath];
    if (manifest.options?.no_audio) args.push('--no-audio');
    if (manifest.options?.force_audio) args.push('--force-audio');
    if (manifest.options?.no_panels) args.push('--no-panels');

    send('log', `Spawning: node ${args.join(' ')}`);

    const child = spawn('node', args, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env }
    });

    let _detectedEpisodeId = null;
    child.stdout.on('data', d => {
      const text = d.toString();
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) send('log', line);
      // Extract episode ID from generator output so we can pass it to the client
      const epMatch = text.match(/Episode id[=:]\s*(\d+)/i);
      if (epMatch) _detectedEpisodeId = parseInt(epMatch[1]);
    });
    child.stderr.on('data', d => {
      const lines = d.toString().split('\n').filter(Boolean);
      for (const line of lines) send('error', line);
    });

    child.on('close', (code) => {
      if (code === 0) {
        send('done', 'Briefing generated successfully', { episode_id: _detectedEpisodeId });
      } else {
        send('fail', `Generator exited with code ${code}`);
      }
      try { fs.unlinkSync(manifestPath); } catch (_) {}
      res.end();
    });

    // If client disconnects, kill the generator
    req.on('close', () => {
      if (!child.killed) child.kill();
    });
  } catch (err) {
    console.error('[briefing-editor] generate error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start generation', detail: req.user?.is_admin ? err.message : undefined });
    }
  }
});

// Check generation status for today
app.get('/api/admin/briefing-editor/status', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, status, headline, generated_at,
             CASE WHEN segments IS NOT NULL THEN jsonb_array_length(segments::jsonb) ELSE 0 END AS segment_count
      FROM briefing_episodes
      WHERE user_id IS NULL AND target_date = CURRENT_DATE
      ORDER BY id DESC LIMIT 1
    `);
    if (!rows.length) return res.json({ status: 'none' });
    const ep = rows[0];
    res.json({
      episode_id: ep.id,
      status: ep.status,
      headline: ep.headline,
      generated_at: ep.generated_at,
      segment_count: ep.segment_count
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// Fetch segments for editing
app.get('/api/admin/briefing-editor/segments/:episodeId', requireAdmin, async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { rows } = await pool.query(`
      SELECT id, headline, segments, status,
             (audio_data IS NOT NULL) AS has_audio
      FROM briefing_episodes WHERE id = $1
    `, [episodeId]);
    if (!rows.length) return res.status(404).json({ error: 'Episode not found' });
    const ep = rows[0];
    const segments = typeof ep.segments === 'string' ? JSON.parse(ep.segments) : ep.segments;
    res.json({
      episode_id: ep.id,
      headline: ep.headline,
      status: ep.status,
      has_audio: ep.has_audio,
      segments
    });
  } catch (err) {
    console.error('[briefing-editor] segments fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch segments' });
  }
});

// Resolve location name(s) to coordinates — tries countries first, then cities
app.post('/api/admin/briefing-editor/resolve-coords', requireAdmin, async (req, res) => {
  try {
    const names = req.body?.names;
    if (!Array.isArray(names) || !names.length) return res.json({});
    const lower = names.map(n => (n || '').toLowerCase().trim());
    const coords = {};

    // Countries
    const { rows: cRows } = await pool.query(
      `SELECT name, latitude AS lat, longitude AS lon FROM countries WHERE LOWER(name) = ANY($1::text[])`,
      [lower]
    );
    for (const r of cRows) {
      const orig = names.find(n => n.toLowerCase().trim() === r.name.toLowerCase());
      if (orig) coords[orig] = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), type: 'country' };
    }

    // Cities — only names not matched as countries
    const remaining = names.filter(n => !coords[n]);
    if (remaining.length) {
      const { rows: ciRows } = await pool.query(
        `SELECT name, latitude AS lat, longitude AS lon FROM cities WHERE LOWER(name) = ANY($1::text[])`,
        [remaining.map(n => n.toLowerCase().trim())]
      );
      for (const r of ciRows) {
        const orig = remaining.find(n => n.toLowerCase().trim() === r.name.toLowerCase());
        if (orig) coords[orig] = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), type: 'city' };
      }
    }

    res.json(coords);
  } catch (err) {
    console.error('[briefing-editor] resolve-coords error:', err.message);
    res.status(500).json({ error: 'Failed to resolve coordinates' });
  }
});

// Save edited segments
app.put('/api/admin/briefing-editor/segments/:episodeId', requireAdmin, async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { segments, headline } = req.body;
    if (!segments || !Array.isArray(segments)) {
      return res.status(400).json({ error: 'segments array required' });
    }

    const updates = ['segments = $1'];
    const params = [JSON.stringify(segments)];
    let paramIdx = 2;

    if (headline) {
      updates.push(`headline = $${paramIdx}`);
      params.push(headline);
      paramIdx++;
    }

    params.push(episodeId);
    await pool.query(
      `UPDATE briefing_episodes SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      params
    );

    res.json({ ok: true, message: 'Segments saved' });
  } catch (err) {
    console.error('[briefing-editor] segments save error:', err.message);
    res.status(500).json({ error: 'Failed to save segments' });
  }
});

// Generate audio for edited segments — streams logs via SSE
app.post('/api/admin/briefing-editor/generate-audio/:episodeId', requireAdmin, async (req, res) => {
  try {
    const { episodeId } = req.params;

    // Verify episode exists
    const { rows } = await pool.query(
      'SELECT id, segments FROM briefing_episodes WHERE id = $1',
      [episodeId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Episode not found' });
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = (type, data) => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    send('log', `Starting audio generation for episode ${episodeId}`);

    const child = spawn('node', [
      'briefingGenerator.js', '--force', '--audio-only'
    ], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env }
    });

    child.stdout.on('data', d => {
      const lines = d.toString().split('\n').filter(Boolean);
      for (const line of lines) send('log', line);
    });
    child.stderr.on('data', d => {
      const lines = d.toString().split('\n').filter(Boolean);
      for (const line of lines) send('error', line);
    });

    child.on('close', (code) => {
      if (code === 0) {
        send('done', 'Audio generated successfully');
      } else {
        send('fail', `Audio generation exited with code ${code}`);
      }
      res.end();
    });

    req.on('close', () => {
      if (!child.killed) child.kill();
    });
  } catch (err) {
    console.error('[briefing-editor] audio gen error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start audio generation' });
    }
  }
});

// Serve briefing editor page
app.get('/briefing-editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'briefing-editor.html'));
});

// Serve tweet curator page
app.get('/tweet-curator', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'tweet-curator.html'));
});

// Serve unified editor platform
app.get('/editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'earth-editor.html'));
});

/* =========================================
   Timeline Editor — Data Panel Workflow
   ========================================= */

// Search data sources by keyword — returns matching adapter+indicator catalog entries
app.post('/api/admin/timeline-editor/search-data', requireAdmin, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query required' });
    const q = query.toLowerCase().trim();
    // Split query into words so "oil price" or "military spending" match
    // indicators containing all the individual terms, not just the exact phrase.
    // Expand common synonyms so natural queries hit the right indicators.
    const SYNONYMS = {
      spending: ['expenditure','spend','cost','budget'],
      expenditure: ['spending','spend','cost','budget'],
      price: ['cost','value','rate','prices'],
      cost: ['price','expenditure','spending'],
      army: ['military','defense','defence','armed'],
      defense: ['military','defence','armed'],
      weapon: ['arms','ammunition','military'],
      arms: ['weapon','ammunition','military'],
      emissions: ['emission','co2','carbon','pollution'],
      oil: ['petroleum','fuel','crude'],
      petroleum: ['oil','fuel','crude'],
      war: ['conflict','military','armed'],
      conflict: ['war','armed','violence'],
      import: ['imports','trade'],
      export: ['exports','trade'],
      energy: ['electricity','power','fuel','oil'],
    };
    const rawWords = q.split(/\s+/).filter(w => w.length >= 2);
    if (!rawWords.length) return res.json({ results: [] });
    // For each query word, build a set of acceptable matches
    const wordSets = rawWords.map(w => {
      const syns = SYNONYMS[w] || [];
      return [w, ...syns];
    });
    const available = dataPanels ? require('./dataSources').listAvailable() : [];
    const results = [];
    for (const adapter of available) {
      for (const indicator of (adapter.catalog || [])) {
        // Match against indicator-specific fields (NOT adapter.description,
        // which is too broad and would match every indicator in the adapter).
        const indicatorText = [indicator.label, indicator.id, indicator.unit]
          .filter(Boolean).join(' ').toLowerCase();
        // Adapter name/label is useful but not the long description
        const adapterText = [adapter.name, adapter.label].filter(Boolean).join(' ').toLowerCase();
        const text = indicatorText + ' ' + adapterText;
        // Every query word (or one of its synonyms) must appear in the text
        const allMatch = wordSets.every(wSet => wSet.some(w => text.includes(w)));
        if (allMatch) {
          // Score: how many query words match in the indicator label specifically
          const labelLower = indicator.label.toLowerCase();
          const labelHits = wordSets.filter(wSet => wSet.some(w => labelLower.includes(w))).length;
          results.push({
            adapter: adapter.name,
            adapter_label: adapter.label,
            id: indicator.id,
            label: indicator.label,
            unit: indicator.unit || null,
            description: adapter.description || '',
            _score: labelHits
          });
        }
      }
    }
    // Sort: most label hits first, then by adapter name
    results.sort((a, b) => b._score - a._score || a.adapter.localeCompare(b.adapter));
    results.forEach(r => delete r._score);
    res.json({ results: results.slice(0, 30) });
  } catch (err) {
    console.error('[timeline-editor] search-data error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Generate a data panel for a timeline using Haiku (cheap)
app.post('/api/admin/timeline-editor/generate-panel', requireAdmin, async (req, res) => {
  try {
    const { timeline_id, timeline_title, timeline_description, adapter, indicator, indicator_label } = req.body;
    if (!timeline_id || !adapter || !indicator) return res.status(400).json({ error: 'Missing fields' });

    const adapterMod = require('./dataSources').getAdapter(adapter);
    if (!adapterMod) return res.status(400).json({ error: `Adapter "${adapter}" not available` });

    // Use Haiku to create a smart query + chart metadata
    const Anthropic = require('@anthropic-ai/sdk');
    const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are a data journalist creating a data panel for a news timeline story.

TIMELINE: "${timeline_title}"
DESCRIPTION: ${timeline_description || 'N/A'}
DATA SOURCE: ${adapter} — indicator: ${indicator} (${indicator_label})

Create a query and chart metadata for this data panel. The query must match the adapter's expected format:
- worldbank: { indicator: '<id>', countries: ['Country1',...], years: [2015..2024] }
- owid: { indicator: '<slug>', countries: ['Country'], year_min: 2010 }
- eia: { indicator: '<series>', limit: 24 }
- fred: { indicator: '<series>', limit: 60 }
- comtrade: { indicator: '<hsCode>', reporter: 'Country', partner: 'all', flow: 'X', years: [2019..2024] }
- acled: { indicator: 'all', country: 'Country', months: 18 }
- gdelt: { indicator: 'volume', query: 'topic', span: '6months' }
- usgs: { indicator: 'sig-30d' }
- noaa: { indicator: 'temp-anomaly-land-ocean', year_min: 1980 }

Return ONLY valid JSON:
{
  "title": "Short chart title (max 60 chars)",
  "subtitle": "Optional 1-line context",
  "caption": "1-2 sentence explanation tying chart to story",
  "chart_type": "line|bar|stacked_bar|area|pie|scatter",
  "query": { /* adapter-specific parameters */ }
}`;

    const resp = await aiClient.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = resp.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'AI returned no JSON' });

    const meta = JSON.parse(match[0]);
    const validTypes = ['line','bar','stacked_bar','area','pie','scatter'];
    if (!validTypes.includes(meta.chart_type)) meta.chart_type = 'line';

    // Fetch real data from the adapter
    let data = null;
    let generated_by = 'ai_real';
    try {
      data = await adapterMod.fetch(meta.query || {});
    } catch (fetchErr) {
      console.warn('[timeline-editor] adapter fetch failed:', fetchErr.message);
      generated_by = 'ai_composed';
    }

    const panel = {
      title: String(meta.title || indicator_label).slice(0, 120),
      subtitle: meta.subtitle || null,
      caption: meta.caption || null,
      chart_type: meta.chart_type,
      data: data || {},
      source_name: adapterMod.label,
      source_url: data?.source_url || null,
      generated_by,
      adapter,
      query: meta.query || {}
    };

    res.json(panel);
  } catch (err) {
    console.error('[timeline-editor] generate-panel error:', err.message);
    res.status(500).json({ error: 'Panel generation failed' });
  }
});

// Save a data panel for a timeline
app.post('/api/admin/timeline-editor/save-panel', requireAdmin, async (req, res) => {
  try {
    const { timeline_id, panel } = req.body;
    if (!timeline_id || !panel) return res.status(400).json({ error: 'Missing fields' });

    // Get current max ord for this timeline
    const { rows: ordRows } = await pool.query(
      `SELECT COALESCE(MAX(ord), -1) AS max_ord FROM data_panels WHERE scope_type = 'timeline' AND scope_id = $1`,
      [timeline_id]
    );
    const nextOrd = (ordRows[0]?.max_ord ?? -1) + 1;

    const { rows } = await pool.query(`
      INSERT INTO data_panels (scope_type, scope_id, ord, title, subtitle, caption, chart_type, data, source_name, source_url, generated_by, adapter, query)
      VALUES ('timeline', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `, [timeline_id, nextOrd, panel.title, panel.subtitle, panel.caption, panel.chart_type,
        JSON.stringify(panel.data || {}), panel.source_name, panel.source_url, panel.generated_by, panel.adapter,
        JSON.stringify(panel.query || {})]);

    res.json({ id: rows[0].id, success: true });
  } catch (err) {
    console.error('[timeline-editor] save-panel error:', err.message);
    res.status(500).json({ error: 'Save failed' });
  }
});

// Get saved panels for a timeline
app.get('/api/admin/timeline-editor/panels/:timelineId', requireAdmin, async (req, res) => {
  try {
    const tlId = parseInt(req.params.timelineId, 10);
    if (!Number.isFinite(tlId)) return res.status(400).json({ error: 'bad id' });
    const { rows } = await pool.query(
      `SELECT id, title, subtitle, caption, chart_type, data, source_name, source_url, generated_by, adapter, query, created_at
       FROM data_panels WHERE scope_type = 'timeline' AND scope_id = $1 ORDER BY ord`,
      [tlId]
    );
    res.json({ panels: rows });
  } catch (err) {
    console.error('[timeline-editor] load panels error:', err.message);
    res.status(500).json({ error: 'Load failed' });
  }
});

// Delete a timeline data panel
app.delete('/api/admin/timeline-editor/panels/:panelId', requireAdmin, async (req, res) => {
  try {
    const panelId = parseInt(req.params.panelId, 10);
    if (!Number.isFinite(panelId)) return res.status(400).json({ error: 'bad id' });
    await pool.query(`DELETE FROM data_panels WHERE id = $1`, [panelId]);
    res.json({ success: true });
  } catch (err) {
    console.error('[timeline-editor] delete panel error:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.get("/api/heatmap", heavyLimiter, async (req, res) => {
  try {
    const mode     = (req.query.mode || "coverage").toLowerCase();
    const bucket   = (req.query.bucket || "none").toLowerCase();
    const keyword  = (req.query.keyword || "").trim();
    const threadId = parseInt(req.query.thread_id, 10) || null;
    const daysRaw  = parseInt(req.query.days, 10);
    const days     = Math.min(Math.max(isNaN(daysRaw) ? 7 : daysRaw, 1), 90);
    const fromIso  = req.query.from || null;
    const toIso    = req.query.to   || null;

    const bucketExpr =
      bucket === "hour" ? `date_trunc('hour', a.published_at)` :
      bucket === "day"  ? `date_trunc('day',  a.published_at)` :
      null;

    // ── Snapshot fast-path ──────────────────────────────────────────────
    // Standard requests (no keyword, no thread_id, no custom dates, no
    // time buckets) read from the pre-aggregated heatmap_snapshots table
    // instead of scanning 300k+ rows in news_articles.
    const SNAPSHOT_PRESETS = { 1: '1d', 7: '7d', 30: '30d', 90: '90d' };
    const presetKey = SNAPSHOT_PRESETS[days];
    const useSnapshot = presetKey && !keyword && !threadId && bucket === 'none' && !fromIso && !toIso;

    // ── Time-series snapshot fast-path ─────────────────────────────────
    // Pre-computed bucketed snapshots for standard combos.
    const TS_SNAPSHOT_PRESETS = {
      '1_hour': '1d_hour', '1_day': '1d_day',
      '3_hour': '3d_hour', '3_day': '3d_day',
      '7_day':  '7d_day',  '14_day': '14d_day',
    };
    const tsPresetKey = TS_SNAPSHOT_PRESETS[`${days}_${bucket}`];
    const useTsSnapshot = tsPresetKey && !keyword && !threadId && !fromIso && !toIso;

    // cache key — v2 adds the country-wash + city-cluster split
    const _cacheKey = `heatmap:v2:${mode}:${bucket}:${keyword}:${threadId||''}:${days}:${fromIso||''}:${toIso||''}`;
    // Bucketed queries from snapshots are cheap; live-query fallback is expensive.
    // TS snapshot hit: 60s. TS live fallback (7d_hour, 14d_hour): 3 min. Standard: 1 min.
    const _cacheTtl = bucket !== 'none' ? (useTsSnapshot ? 60_000 : 180_000) : 60_000;
    const _cached = await ttlCached(_cacheKey, _cacheTtl, async () => {

      if (useSnapshot) {
        try {
          const [countryRes, cityRes] = await Promise.all([
            pool.query(
              `SELECT ref_id AS country_id, iso, country_name, name, lat, lon, n, sent_n, avg_sent
               FROM heatmap_snapshots WHERE preset = $1 AND level = 'country'
               ORDER BY n DESC`, [presetKey]),
            pool.query(
              `SELECT ref_id AS city_id, country_id, iso, country_name, name, lat, lon, n, sent_n, avg_sent
               FROM heatmap_snapshots WHERE preset = $1 AND level = 'city'
               ORDER BY n DESC`, [presetKey]),
          ]);
          // Only use snapshot if it's been populated (guard against empty table)
          if (countryRes.rows.length > 0) {
            return { countryRows: countryRes.rows, cityRows: cityRes.rows };
          }
        } catch (e) {
          console.error('[heatmap] snapshot read failed, falling back to live query:', e.message);
        }
      }

      // ── Time-series snapshot fast-path ─────────────────────────────────
      if (useTsSnapshot) {
        try {
          const [countryRes, cityRes] = await Promise.all([
            pool.query(
              `SELECT bucket_time AS t, ref_id AS country_id, iso, country_name, name, lat, lon, n, sent_n, avg_sent
               FROM heatmap_ts_snapshots WHERE preset = $1 AND level = 'country'
               ORDER BY bucket_time, n DESC`, [tsPresetKey]),
            pool.query(
              `SELECT bucket_time AS t, ref_id AS city_id, country_id, iso, country_name, name, lat, lon, n, sent_n, avg_sent
               FROM heatmap_ts_snapshots WHERE preset = $1 AND level = 'city'
               ORDER BY bucket_time, n DESC`, [tsPresetKey]),
          ]);
          if (countryRes.rows.length > 0) {
            return { countryRows: countryRes.rows, cityRows: cityRes.rows };
          }
        } catch (e) {
          console.error('[heatmap] ts-snapshot read failed, falling back to live query:', e.message);
        }
      }

      // ── Live query fallback (filtered requests or empty snapshot) ────
      const params = [];
      const where  = [];

      if (fromIso && toIso) {
        params.push(fromIso); where.push(`a.published_at >= $${params.length}::timestamptz`);
        params.push(toIso);   where.push(`a.published_at <  $${params.length}::timestamptz`);
      } else {
        // Use make_interval — unambiguous across Postgres versions and avoids
        // the `int || text` coercion path that has tripped 500s on some hosts.
        params.push(days);
        where.push(`a.published_at > NOW() - make_interval(days => $${params.length}::int)`);
      }

      if (threadId) {
        params.push(threadId);
        where.push(`EXISTS (SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id AND sta.thread_id = $${params.length})`);
      }

      if (keyword) {
        params.push(`%${keyword}%`);
        const p = `$${params.length}`;
        where.push(`(a.title ILIKE ${p} OR a.translated_title ILIKE ${p} OR a.summary ILIKE ${p})`);
      }

      const whereSql = `WHERE ${where.join(' AND ')}`;

      const selectBucket = bucketExpr ? `${bucketExpr} AS t,` : ``;
      const groupBucket  = bucketExpr ? `${bucketExpr},` : ``;

      // Country-level rows = articles with NO city (country_id set, city_id null).
      // These feed the soft per-country "wash" layer on the client.
      const sqlCountry = `
        SELECT
          ${selectBucket}
          c.id   AS country_id,
          c.name AS name,
          c.iso_code AS iso,
          c.latitude  AS lat,
          c.longitude AS lon,
          COUNT(*)::int AS n,
          COUNT(a.sentiment_score)::int AS sent_n,
          AVG(a.sentiment_score)::float AS avg_sent
        FROM news_articles a
        JOIN countries c ON c.id = a.country_id
        ${whereSql}
          AND a.country_id IS NOT NULL
          AND a.city_id    IS NULL
          AND c.latitude   IS NOT NULL
          AND c.longitude  IS NOT NULL
        GROUP BY ${groupBucket} c.id, c.name, c.iso_code, c.latitude, c.longitude
        ORDER BY ${bucketExpr ? 't,' : ''} n DESC
        LIMIT ${bucketExpr ? 20000 : 500}
      `;

      // City-level rows = articles with a city_id. These form their own
      // centers of gravity on the client.
      const sqlCity = `
        SELECT
          ${selectBucket}
          ci.id AS city_id,
          ci.country_id AS country_id,
          co.iso_code AS iso,
          co.name AS country_name,
          ci.name AS name,
          ci.latitude  AS lat,
          ci.longitude AS lon,
          COUNT(*)::int AS n,
          COUNT(a.sentiment_score)::int AS sent_n,
          AVG(a.sentiment_score)::float AS avg_sent
        FROM news_articles a
        JOIN cities ci    ON ci.id = a.city_id
        LEFT JOIN countries co ON co.id = ci.country_id
        ${whereSql}
          AND a.city_id   IS NOT NULL
          AND ci.latitude  IS NOT NULL
          AND ci.longitude IS NOT NULL
        GROUP BY ${groupBucket} ci.id, ci.country_id, co.iso_code, co.name, ci.name, ci.latitude, ci.longitude
        ORDER BY ${bucketExpr ? 't,' : ''} n DESC
        LIMIT ${bucketExpr ? 40000 : 1500}
      `;

      // Run country + city in parallel for ~2× speed-up on bucketed queries.
      // Each gets its own connection so one slow half can't block the other.
      async function _heatmapQuery(sql) {
        const c = await pool.connect();
        try {
          await c.query(`SET statement_timeout = 90000`);
          const r = await c.query(sql, params);
          return r.rows;
        } catch (e) {
          console.error("[heatmap] query failed:", e.message);
          return [];
        } finally {
          c.release();
        }
      }
      const [countryRows, cityRows] = await Promise.all([
        _heatmapQuery(sqlCountry),
        _heatmapQuery(sqlCity),
      ]);
      return { countryRows, cityRows };
    });

    const { countryRows, cityRows } = _cached;

    const mapCountry = (r) => ({
      country_id: r.country_id,
      name: r.name,
      iso: r.iso ? String(r.iso).trim() : null,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      n: r.n,
      sent_n: r.sent_n,
      avg_sent: r.avg_sent == null ? null : parseFloat(r.avg_sent)
    });
    const mapCity = (r) => ({
      city_id: r.city_id,
      country_id: r.country_id,
      iso: r.iso ? String(r.iso).trim() : null,
      country_name: r.country_name || null,
      name: r.name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      n: r.n,
      sent_n: r.sent_n,
      avg_sent: r.avg_sent == null ? null : parseFloat(r.avg_sent)
    });

    if (!bucketExpr) {
      const country_points = countryRows.map(mapCountry);
      const city_points    = cityRows.map(mapCity);

      // Legacy `points` = merged view kept for any caller still on v1 schema.
      // Country-level rows positioned at country centroid; city-level rows at
      // city centroid. Rolled up into a single flat list.
      const legacyPoints = [
        ...country_points,
        ...city_points.map(p => ({
          country_id: p.country_id,
          name: p.country_name || p.name,
          iso: p.iso,
          lat: p.lat, lon: p.lon,
          n: p.n, sent_n: p.sent_n, avg_sent: p.avg_sent
        }))
      ];

      const totalArticles =
        country_points.reduce((s, p) => s + p.n, 0) +
        city_points.reduce((s, p) => s + p.n, 0);
      const totalScored =
        country_points.reduce((s, p) => s + p.sent_n, 0) +
        city_points.reduce((s, p) => s + p.sent_n, 0);
      const uniqueCountries = new Set([
        ...country_points.map(p => p.country_id),
        ...city_points.map(p => p.country_id)
      ]).size;

      return res.json({
        mode, bucket: 'none',
        country_points,
        city_points,
        points: legacyPoints,
        stats: {
          countries: uniqueCountries,
          cities: city_points.length,
          articles: totalArticles,
          scored: totalScored,
          sentiment_coverage: totalArticles ? (totalScored / totalArticles) : 0
        }
      });
    }

    // Bucketed response: group rows by timestamp, split country vs city.
    const byT = new Map();
    const ensure = (key) => {
      if (!byT.has(key)) byT.set(key, { country_points: [], city_points: [] });
      return byT.get(key);
    };
    for (const r of countryRows) {
      const key = r.t instanceof Date ? r.t.toISOString() : r.t;
      ensure(key).country_points.push(mapCountry(r));
    }
    for (const r of cityRows) {
      const key = r.t instanceof Date ? r.t.toISOString() : r.t;
      ensure(key).city_points.push(mapCity(r));
    }
    const buckets = [...byT.entries()]
      .sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([t, o]) => ({
        t,
        country_points: o.country_points,
        city_points:    o.city_points,
        // legacy merged list for older clients
        points: [
          ...o.country_points,
          ...o.city_points.map(p => ({
            country_id: p.country_id,
            name: p.country_name || p.name,
            iso: p.iso,
            lat: p.lat, lon: p.lon,
            n: p.n, sent_n: p.sent_n, avg_sent: p.avg_sent
          }))
        ]
      }));
    res.json({ mode, bucket, buckets });
  } catch (err) {
    console.error("[heatmap]", err.message);
    res.status(500).json({ error: "Failed to fetch heatmap", detail: req.user?.is_admin ? err.message : undefined });
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
//
// ═══════════════════════════════════════════════════════════════════════════
// TIMELINES — umbrella arcs (broad, 7-day, parabolic-weighted)
// Mirrors /api/threads/latest in shape so the frontend can render timeline
// cards with the same card component. See storyTimelineBuilder.js.
// ═══════════════════════════════════════════════════════════════════════════
app.get("/api/timelines/latest", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const _cacheKey = `timelines/latest:${limit}`;
    const _cached = await ttlCached(_cacheKey, 60_000, async () => {
      const { rows: timelines } = await pool.query(`
        SELECT
          t.id AS timeline_id, t.title, t.description, t.scope,
          t.primary_category, t.geographic_scope, t.importance, t.keywords,
          t.article_count, t.distinct_source_count, t.parabolic_weight_sum,
          t.historical_anchors, t.status, t.last_updated_at
        FROM story_timelines t
        WHERE t.status IN ('active','cooling','dormant')
          AND t.article_count >= 2
        ORDER BY
          CASE t.status WHEN 'active' THEN 0 WHEN 'cooling' THEN 1 ELSE 2 END,
          CASE WHEN t.primary_category IN ('politics','military','diplomacy','economy','conflict') THEN 0
               WHEN t.primary_category IN ('environment','climate') THEN 2
               ELSE 1 END,
          t.importance DESC,
          t.parabolic_weight_sum DESC,
          t.last_updated_at DESC NULLS LAST
        LIMIT $1
      `, [limit]);

      if (!timelines.length) return [];

      // Hero images: prefer scraped publisher image on the highest-weighted article
      const timelineIds = timelines.map(t => t.timeline_id);
      const { rows: heroes } = await pool.query(`
        SELECT DISTINCT ON (sta.timeline_id)
          sta.timeline_id,
          COALESCE(a.image_url, img_a.public_url) AS hero_image_url,
          img_a.public_url AS hero_catalog_image_url,
          COALESCE(ns.name, ys.name) AS hero_source_name,
          co.iso_code AS hero_iso_code
        FROM story_timeline_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN countries co ON co.id = a.country_id
        WHERE sta.timeline_id = ANY($1)
        ORDER BY
          sta.timeline_id,
          (a.image_url IS NOT NULL AND a.image_url <> '') DESC,
          (img_a.public_url IS NOT NULL) DESC,
          sta.parabolic_weight DESC,
          a.published_at DESC
      `, [timelineIds]);

      const heroMap = new Map(heroes.map(h => [h.timeline_id, h]));
      const textIsoMap = await resolveHeroIsoFromText(timelines, 'timeline_id');
      const mapped = timelines.map(t => {
        const h = heroMap.get(t.timeline_id);
        const subjectIso = textIsoMap.get(t.timeline_id);
        return {
          ...t,
          thread_id: t.timeline_id,
          latest_published_at: t.last_updated_at,
          hero_image_url: h?.hero_image_url || null,
          hero_catalog_image_url: h?.hero_catalog_image_url || null,
          hero_source_name: h?.hero_source_name || null,
          hero_iso_code: subjectIso || h?.hero_iso_code || null
        };
      });
      // Fallback image search for items missing hero images (capped + timeout)
      const _noImgTl = mapped.filter(t => !t.hero_image_url && !t.hero_catalog_image_url).slice(0, 10);
      if (_noImgTl.length) {
        await Promise.race([
          Promise.all(_noImgTl.map(async (t) => {
            try {
              const url = await findFallbackImage(t);
              if (url) t.hero_image_url = url;
            } catch (e) { /* silent */ }
          })),
          new Promise(r => setTimeout(r, 6000))
        ]);
      }
      // Apply title-based country boost reranking
      mapped.forEach(t => { t._titleBoost = getTitleCountryBoost(t); });
      mapped.sort((a, b) => {
        // Preserve status grouping, then apply boost within groups
        const sa = a.status === 'active' ? 0 : a.status === 'cooling' ? 1 : 2;
        const sb = b.status === 'active' ? 0 : b.status === 'cooling' ? 1 : 2;
        if (sa !== sb) return sa - sb;
        return ((b.importance || 0) * b._titleBoost) - ((a.importance || 0) * a._titleBoost);
      });
      mapped.forEach(t => { delete t._titleBoost; });
      return mapped;
    });
    res.json(_cached);
  } catch (err) {
    console.error("[timelines/latest]", err.message);
    res.status(500).json({ error: "Failed to fetch timelines", detail: req.user?.is_admin ? err.message : undefined });
  }
});

// GET /api/timelines/:id/articles — articles in a timeline, ordered by weight
app.get("/api/timelines/:id/articles", async (req, res) => {
  try {
    const timelineId = parseInt(req.params.id, 10);
    if (!timelineId) return res.status(400).json({ error: "Invalid timeline ID" });
    const { rows } = await pool.query(`
      SELECT
        a.id,
        COALESCE(a.translated_title, a.title) AS title,
        a.title AS original_title,
        COALESCE(a.translated_summary, a.summary) AS summary,
        a.published_at,
        a.url, a.article_url,
        COALESCE(a.image_url, img_a.public_url) AS image_url,
        COALESCE(ns.name, ys.name) AS source_name,
        COALESCE(ns.bias, 'unknown') AS source_bias,
        co.iso_code, co.name AS country_name, ci.name AS city_name,
        a.media_type, a.video_id,
        sta.parabolic_weight, sta.is_anchor
      FROM story_timeline_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN cities    ci ON ci.id = a.city_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      WHERE sta.timeline_id = $1
      ORDER BY sta.parabolic_weight DESC, a.published_at DESC
      LIMIT 200
    `, [timelineId]);
    res.json({ articles: rows });
  } catch (err) {
    console.error("[timelines/articles]", err.message);
    res.status(500).json({ error: "Failed to fetch timeline articles" });
  }
});

// GET /api/flows/timeline/:id — flow arcs for a timeline
// Uses entity extraction (subject/actor/location roles) to show only
// countries directly involved in the story, not every reporting country.
app.get("/api/flows/timeline/:id", async (req, res) => {
  try {
    const timelineId = parseInt(req.params.id, 10);
    if (!timelineId) return res.status(400).json({ error: "Invalid timeline ID" });

    const _cached = await ttlCached(`flows/timeline:${timelineId}`, 60_000, async () => {
    // Find distinct countries directly involved in this timeline's story
    const { rows: involvedCountries } = await pool.query(`
      SELECT DISTINCT
        co.id, co.name AS place, co.latitude AS lat, co.longitude AS lon,
        co.iso_code AS iso,
        'country' AS type,
        MIN(CASE aem.role
          WHEN 'subject'  THEN 1
          WHEN 'actor'    THEN 2
          WHEN 'location' THEN 3
          ELSE 4
        END) AS role_rank,
        COUNT(DISTINCT sta.article_id) AS mention_count
      FROM story_timeline_articles sta
      JOIN article_entity_mentions aem ON aem.article_id = sta.article_id
      JOIN entities e ON e.id = aem.entity_id
      JOIN countries co ON LOWER(co.iso_code) = LOWER(e.country_code)
      WHERE sta.timeline_id = $1
        AND e.entity_type = 'location'
        AND aem.role IN ('subject', 'actor', 'location')
        AND aem.confidence >= 0.6
      GROUP BY co.id, co.name, co.latitude, co.longitude, co.iso_code
      ORDER BY role_rank, mention_count DESC
      LIMIT 10
    `, [timelineId]);

    if (involvedCountries.length < 2) {
      // Fallback: find distinct content-routed countries across all articles
      // in this timeline, then draw arcs between them (country↔country).
      const { rows: contentCountries } = await pool.query(`
        SELECT
          co.id, co.name AS place, co.latitude AS lat, co.longitude AS lon,
          co.iso_code AS iso,
          COUNT(DISTINCT al.article_id) AS mention_count
        FROM story_timeline_articles sta
        JOIN article_locations al ON al.article_id = sta.article_id
        JOIN countries co ON co.id = al.country_id
        WHERE sta.timeline_id = $1
          AND al.routing_type = 'content'
        GROUP BY co.id, co.name, co.latitude, co.longitude, co.iso_code
        ORDER BY mention_count DESC
        LIMIT 10
      `, [timelineId]);

      if (contentCountries.length < 2) return { flows: [], maxCount: 0 };

      const flows = [];
      for (let i = 0; i < contentCountries.length - 1; i++) {
        const src = contentCountries[i];
        const dst = contentCountries[i + 1];
        flows.push({
          src: { lat: parseFloat(src.lat), lon: parseFloat(src.lon),
                 place: src.place, id: src.id, type: 'country', iso: src.iso },
          dst: { lat: parseFloat(dst.lat), lon: parseFloat(dst.lon),
                 place: dst.place, id: dst.id, type: 'country', iso: dst.iso },
          count: parseInt(src.mention_count) + parseInt(dst.mention_count)
        });
      }
      const maxCount = Math.max(...flows.map(f => f.count));
      return { flows, maxCount };
    }

    // Build arcs between involved countries (consecutive pairs by role importance)
    const flows = [];
    for (let i = 0; i < involvedCountries.length - 1; i++) {
      const src = involvedCountries[i];
      const dst = involvedCountries[i + 1];
      flows.push({
        src: { lat: parseFloat(src.lat), lon: parseFloat(src.lon),
               place: src.place, id: src.id, type: 'country', iso: src.iso },
        dst: { lat: parseFloat(dst.lat), lon: parseFloat(dst.lon),
               place: dst.place, id: dst.id, type: 'country', iso: dst.iso },
        count: parseInt(src.mention_count) + parseInt(dst.mention_count)
      });
    }

    const maxCount = flows.length ? Math.max(...flows.map(f => f.count)) : 1;
    return { flows, maxCount };
    });
    res.json(_cached);
  } catch (err) {
    console.error("[flows/timeline]", err.message);
    res.status(500).json({ error: "Failed to fetch timeline flows", detail: req.user?.is_admin ? err.message : undefined });
  }
});

// GET /api/flows/timeline/:id/route — articles for one src→dst on a timeline
app.get("/api/flows/timeline/:id/route", async (req, res) => {
  try {
    const timelineId = parseInt(req.params.id, 10);
    const srcId = parseInt(req.query.src_id, 10);
    const dstId = parseInt(req.query.dst_id, 10);
    const srcType = req.query.src_type || "country";
    const dstType = req.query.dst_type || "country";
    if (!timelineId || !srcId || !dstId) {
      return res.status(400).json({ error: "timeline_id, src_id, dst_id required" });
    }

    // Try entity-based lookup first
    const { rows: srcCountry } = await pool.query(
      `SELECT iso_code FROM countries WHERE id = $1`, [srcId]
    );
    const { rows: dstCountry } = await pool.query(
      `SELECT iso_code FROM countries WHERE id = $1`, [dstId]
    );

    let rows;
    if (srcCountry.length && dstCountry.length) {
      const result = await pool.query(`
        SELECT DISTINCT ON (a.id)
          a.id,
          COALESCE(a.translated_title, a.title) AS title,
          a.title AS original_title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          a.published_at, a.article_url,
          COALESCE(a.image_url, img_a.public_url) AS image_url,
          COALESCE(ns.name, ys.name) AS source_name,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          a.media_type, a.video_id,
          src_co.iso_code AS iso_code,
          src_co.name AS country_name, src_city.name AS city_name
        FROM story_timeline_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        JOIN countries src_co ON src_co.id = a.country_id
        LEFT JOIN cities src_city ON src_city.id = a.city_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE sta.timeline_id = $1
          AND EXISTS (
            SELECT 1 FROM article_entity_mentions aem
            JOIN entities e ON e.id = aem.entity_id
            WHERE aem.article_id = a.id
              AND e.entity_type = 'location'
              AND LOWER(e.country_code) = LOWER($2)
              AND aem.role IN ('subject', 'actor', 'location')
          )
          AND EXISTS (
            SELECT 1 FROM article_entity_mentions aem
            JOIN entities e ON e.id = aem.entity_id
            WHERE aem.article_id = a.id
              AND e.entity_type = 'location'
              AND LOWER(e.country_code) = LOWER($3)
              AND aem.role IN ('subject', 'actor', 'location')
          )
        ORDER BY a.id, a.published_at DESC
        LIMIT 50
      `, [timelineId, srcCountry[0].iso_code, dstCountry[0].iso_code]);
      rows = result.rows;
    }

    // Fallback to legacy article_locations
    if (!rows || !rows.length) {
      const srcJoin = srcType === "city" ? "a.city_id" : "a.country_id";
      const dstJoin = dstType === "city" ? "al.city_id" : "al.country_id";
      const result = await pool.query(`
        SELECT DISTINCT ON (a.id)
          a.id,
          COALESCE(a.translated_title, a.title) AS title,
          a.title AS original_title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          a.published_at, a.article_url,
          COALESCE(a.image_url, img_a.public_url) AS image_url,
          COALESCE(ns.name, ys.name) AS source_name,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          a.media_type, a.video_id,
          src_co.iso_code AS iso_code,
          src_co.name AS country_name, src_city.name AS city_name
        FROM story_timeline_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        JOIN article_locations al ON al.article_id = a.id
        JOIN countries src_co ON src_co.id = a.country_id
        LEFT JOIN cities src_city ON src_city.id = a.city_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE sta.timeline_id = $1
          AND ${srcJoin} = $2
          AND ${dstJoin} = $3
          AND al.routing_type = 'content'
        ORDER BY a.id, a.published_at DESC
        LIMIT 50
      `, [timelineId, srcId, dstId]);
      rows = result.rows;
    }

    res.json({ articles: rows });
  } catch (err) {
    console.error("[flows/timeline/route]", err.message);
    res.status(500).json({ error: "Failed to fetch timeline route articles" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sentiment/country/:iso
//
// Feeds the Regional Sentiment interpanel. Returns the last-7-day corpus of
// articles for the given country with their sentiment score AND the signal
// words that produced the score (computed live from sentimentLexicon). Each
// article is ranked positive → negative so the UI can render a gradient of
// mood from tone at the top to doom at the bottom.
app.get("/api/sentiment/country/:iso", async (req, res) => {
  try {
    const iso = (req.params.iso || "").trim().toUpperCase();
    if (!iso) return res.status(400).json({ error: "iso required" });
    const limit = Math.min(parseInt(req.query.limit, 10) || 150, 300);
    const days  = Math.min(parseInt(req.query.days, 10)  || 7,   30);

    const cached = await ttlCached(`sentiment/country:${iso}:${days}:${limit}`, 45_000, async () => {
      const { rows } = await pool.query(`
        SELECT
          a.id,
          COALESCE(a.translated_title, a.title)     AS title,
          a.title                                    AS original_title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          a.translated_title, a.translated_summary,
          a.language,
          a.published_at, a.article_url, a.url,
          COALESCE(a.image_url, img_a.public_url)   AS image_url,
          COALESCE(ns.name, ys.name)                AS source_name,
          COALESCE(ns.bias, 'unknown')              AS source_bias,
          a.media_type, a.video_id,
          co.iso_code, co.name AS country_name,
          ci.name AS city_name,
          a.sentiment_score
        FROM news_articles a
        JOIN countries co ON co.id = a.country_id
        LEFT JOIN cities ci ON ci.id = a.city_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE co.iso_code = $1
          AND a.published_at > NOW() - ($2 || ' days')::interval
          AND a.sentiment_score IS NOT NULL
        ORDER BY a.sentiment_score DESC NULLS LAST, a.published_at DESC
        LIMIT $3
      `, [iso, String(days), limit]);

      return rows.map(r => {
        const { matched_words } = extractArticleSignals(r);
        const { translated_title, translated_summary, language, ...rest } = r;
        return { ...rest, matched_words };
      });
    });

    res.json({ iso_code: iso, count: cached.length, articles: cached });
  } catch (err) {
    console.error("[sentiment/country]", err.message);
    res.status(500).json({ error: "Failed to fetch country sentiment", detail: req.user?.is_admin ? err.message : undefined });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/keywords/:keyword/references
//
// Feeds the Keyword → References interpanel. Returns every article that
// mentions the given keyword (case-insensitive match against title +
// summary + translated variants + article_keywords join), ranked by
// base_priority DESC then published_at DESC. This mirrors the sentiment
// interpanel's list shape so the same front-end renderer can handle both.
app.get("/api/keywords/:keyword/references", async (req, res) => {
  try {
    const keyword = (req.params.keyword || "").trim();
    if (!keyword) return res.status(400).json({ error: "keyword required" });
    const limit = Math.min(parseInt(req.query.limit, 10) || 150, 300);
    const days  = Math.min(parseInt(req.query.days, 10)  || 14,  60);
    const pat   = `%${keyword.toLowerCase()}%`;

    // Fast path: match via article_keywords table (indexed), then fallback to title LIKE
    const { rows } = await pool.query(`
      WITH matched_ids AS (
        SELECT DISTINCT a.id
        FROM news_articles a
        JOIN article_keywords ak ON ak.article_id = a.id
        WHERE a.published_at > NOW() - ($2 || ' days')::interval
          AND LOWER(ak.keyword) = LOWER($4)
        UNION
        SELECT DISTINCT a.id
        FROM news_articles a
        WHERE a.published_at > NOW() - ($2 || ' days')::interval
          AND (LOWER(a.title) LIKE $1 OR LOWER(COALESCE(a.translated_title, '')) LIKE $1)
        LIMIT $3
      )
      SELECT DISTINCT ON (a.id)
        a.id,
        COALESCE(a.translated_title, a.title)     AS title,
        a.title                                    AS original_title,
        COALESCE(a.translated_summary, a.summary) AS summary,
        a.published_at, a.article_url, a.url,
        COALESCE(a.image_url, img_a.public_url)   AS image_url,
        COALESCE(ns.name, ys.name)                AS source_name,
        COALESCE(ns.bias, 'unknown')              AS source_bias,
        a.media_type, a.video_id,
        co.iso_code, co.name AS country_name,
        ci.name AS city_name,
        a.base_priority,
        a.sentiment_score
      FROM news_articles a
      JOIN matched_ids m ON m.id = a.id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN cities ci ON ci.id = a.city_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
      ORDER BY a.id, a.base_priority DESC NULLS LAST, a.published_at DESC
      LIMIT $3
    `, [pat, String(days), limit, keyword]);

    // Second-pass sort: by score, since DISTINCT ON forced id ordering.
    rows.sort((a, b) => {
      const ap = a.base_priority || 0;
      const bp = b.base_priority || 0;
      if (bp !== ap) return bp - ap;
      return new Date(b.published_at) - new Date(a.published_at);
    });

    res.json({ keyword, count: rows.length, articles: rows });
  } catch (err) {
    console.error("[keywords/references]", err.message);
    res.status(500).json({ error: "Failed to fetch keyword references", detail: req.user?.is_admin ? err.message : undefined });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/threads/by-country/:iso
//
// Feeds the sentiment/coverage interpanel. Returns every active or cooling
// thread that has at least one article in the given country within the
// lookback window, ranked by importance (or article count). Shaped to match
// the bar-list contract so it can be merged with articles/videos in the
// front-end interpanel renderer.
app.get("/api/threads/by-country/:iso", async (req, res) => {
  try {
    const iso = (req.params.iso || "").trim().toUpperCase();
    if (!iso) return res.status(400).json({ error: "iso required" });
    const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
    const days  = Math.min(parseInt(req.query.days,  10) || 7,  30);

    const rows = await ttlCached(`threads/by-country:${iso}:${days}:${limit}`, 45_000, async () => {
    const { rows } = await pool.query(`
      WITH candidate_articles AS (
        SELECT
          sta.thread_id,
          a.id,
          a.published_at,
          a.sentiment_score
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        WHERE a.published_at > NOW() - ($2 || ' days')::interval
      ),
      thread_country_matches AS (
        -- Entity-based country involvement: mirrors /api/flows/thread/:id
        SELECT DISTINCT
          ca.thread_id,
          ca.id AS article_id,
          ca.published_at,
          ca.sentiment_score
        FROM candidate_articles ca
        JOIN article_entity_mentions aem ON aem.article_id = ca.id
        JOIN entities e ON e.id = aem.entity_id
        WHERE e.entity_type = 'location'
          AND LOWER(e.country_code) = LOWER($1)
          AND aem.role IN ('subject', 'actor', 'location')
          AND aem.confidence >= 0.6

        UNION

        -- Content/source routing fallback: mirrors the flow fallback path
        SELECT DISTINCT
          ca.thread_id,
          ca.id AS article_id,
          ca.published_at,
          ca.sentiment_score
        FROM candidate_articles ca
        JOIN article_locations al ON al.article_id = ca.id
        JOIN countries co ON co.id = al.country_id
        WHERE co.iso_code = $1
          AND al.routing_type IN ('content', 'source')
      ),
      ranked_threads AS (
        SELECT
          t.id                    AS thread_id,
          t.title,
          t.description,
          t.importance,
          t.article_count,
          t.status,
          t.primary_category,
          t.keywords,
          t.geographic_scope,
          t.first_seen_at,
          t.last_updated_at,
          t.breaking_signal_score,
          t.distinct_source_count,
          COUNT(DISTINCT m.article_id) AS in_country_articles,
          AVG(m.sentiment_score) FILTER (WHERE m.sentiment_score IS NOT NULL)
                               AS avg_sentiment,
          MAX(m.published_at)   AS last_in_country_at,
          (
            COALESCE(t.importance, 0) * 1000
            + COUNT(DISTINCT m.article_id) * 25
            + COALESCE(t.breaking_signal_score, 0) * 100
            + GREATEST(
                0,
                240 - EXTRACT(EPOCH FROM (NOW() - MAX(m.published_at))) / 3600.0
              )
          ) AS feed_score
        FROM story_threads t
        JOIN thread_country_matches m ON m.thread_id = t.id
        WHERE t.status IN ('active', 'cooling')
          AND COALESCE(t.article_count, 0) > 0
        GROUP BY t.id
        ORDER BY t.importance DESC NULLS LAST,
                 COUNT(DISTINCT m.article_id) DESC,
                 MAX(m.published_at) DESC,
                 t.last_updated_at DESC
        LIMIT $3
      )
      SELECT
        rt.*,
        h.hero_image_url,
        h.hero_iso_code
      FROM ranked_threads rt
      LEFT JOIN LATERAL (
        SELECT
          a.image_url AS hero_image_url,
          co.iso_code AS hero_iso_code
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        LEFT JOIN countries co ON co.id = a.country_id
        WHERE sta.thread_id = rt.thread_id
        ORDER BY
          (a.image_url IS NOT NULL AND a.image_url <> '') DESC,
          sta.relevance_score DESC,
          a.published_at DESC
        LIMIT 1
      ) h ON TRUE
      ORDER BY rt.importance DESC NULLS LAST,
               rt.feed_score DESC,
               rt.in_country_articles DESC,
               rt.last_in_country_at DESC,
               rt.last_updated_at DESC
    `, [iso, String(days), limit]);
      // Override hero_iso_code with subject country from geographic_scope
      const geoIsoMap = await resolveGeoScopeIsoMap(rows);
      for (const row of rows) {
        const subjectIso = pickGeoScopeIso(row.geographic_scope, geoIsoMap);
        if (subjectIso) row.hero_iso_code = subjectIso;
      }
      return rows;
    });

    res.json({ iso_code: iso, count: rows.length, threads: rows });
  } catch (err) {
    console.error("[threads/by-country]", err.message);
    res.status(500).json({ error: "Failed to fetch country threads", detail: req.user?.is_admin ? err.message : undefined });
  }
});

app.get("/api/threads/id/:id", async (req, res) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ error: "Invalid thread ID" });

    const { rows } = await pool.query(`
      SELECT
        st.id AS thread_id,
        st.title,
        st.description,
        st.primary_category,
        st.geographic_scope,
        st.importance,
        st.keywords,
        st.article_count,
        st.status,
        st.last_updated_at,
        st.distinct_source_count,
        st.breaking_signal_score
      FROM story_threads st
      WHERE st.id = $1
        AND st.article_count >= 1
      LIMIT 1
    `, [threadId]);

    if (!rows.length) return res.status(404).json({ error: "Thread not found" });

    const thread = rows[0];
    const { rows: heroRows } = await pool.query(`
      SELECT
        a.image_url AS hero_image_url,
        co.iso_code AS hero_iso_code
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE sta.thread_id = $1
      ORDER BY
        (a.image_url IS NOT NULL AND a.image_url <> '') DESC,
        sta.relevance_score DESC,
        a.published_at DESC
      LIMIT 1
    `, [threadId]);

    const hero = heroRows[0] || {};
    const geoIsoMap = await resolveGeoScopeIsoMap([thread]);
    const subjectIso = pickGeoScopeIso(thread.geographic_scope, geoIsoMap);
    res.json({
      ...thread,
      latest_published_at: thread.last_updated_at,
      hero_image_url: hero.hero_image_url || null,
      hero_catalog_image_url: null,
      hero_source_name: null,
      hero_iso_code: subjectIso || hero.hero_iso_code || null
    });
  } catch (err) {
    console.error("[threads/id/:id]", err.message);
    res.status(500).json({ error: "Failed to fetch thread", detail: req.user?.is_admin ? err.message : undefined });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Returns threads in ALL three live lifecycle states:
//   active   — currently receiving new articles
//   cooling  — no new articles in 14d, but still browsable
//   dormant  — no new articles in 28d+; kept forever as historical arcs
//
// Merge-loser shells (article_count = 0) are excluded so the dedup pass
// doesn't leave empty cards in the UI. Status is included in the response
// so the front-end can badge / sort threads if it wants to.
app.get("/api/threads/latest", async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit, 10) || 1000, 1000);
    const fromDate = req.query.from_date || null;  // ISO date string e.g. "2026-03-01"
    const toDate   = req.query.to_date   || null;

    // 30s in-memory TTL — coalesces concurrent requests for the same
    // (limit, from, to) tuple into one query. New threads still surface
    // within the next refresh window.
    // 2-minute TTL — thread data doesn't change fast enough to justify
    // hammering the DB every 30s. The builder runs once/day and articles
    // trickle in; 2 min is plenty fresh for a feed.
    const _cacheKey = `threads/latest:${limit}:${fromDate || ''}:${toDate || ''}`;
    const _cached = await ttlCached(_cacheKey, 120_000, async () => {

    // Step 1: get threads — single fast query on story_threads only,
    // no JOINs, no regex, no correlated subqueries.
    const params = [limit];
    const dateClauses = [];
    if (fromDate) { params.push(fromDate); dateClauses.push(`st.last_updated_at >= $${params.length}::date`); }
    if (toDate)   { params.push(toDate);   dateClauses.push(`st.last_updated_at <  ($${params.length}::date + INTERVAL '1 day')`); }
    const dateWhere = dateClauses.length ? `AND ${dateClauses.join(' AND ')}` : '';

    const { rows: threads } = await pool.query(`
      SELECT
        st.id AS thread_id, st.title, st.description, st.primary_category,
        st.geographic_scope, st.importance, st.keywords, st.article_count,
        st.status, st.last_updated_at
      FROM story_threads st
      WHERE st.article_count >= 2
        AND st.status IN ('active', 'cooling', 'dormant')
        ${dateWhere}
      ORDER BY
        CASE st.status
          WHEN 'active'  THEN 0
          WHEN 'cooling' THEN 1
          WHEN 'dormant' THEN 2
          ELSE 3
        END,
        CASE WHEN st.primary_category IN ('politics','military','diplomacy','economy','conflict') THEN 0
             WHEN st.primary_category IN ('environment','climate') THEN 2
             ELSE 1 END,
        st.importance DESC,
        st.article_count DESC,
        st.last_updated_at DESC NULLS LAST
      LIMIT ($1 * 3)
    `, params);

    // ── Diversity rerank (greedy MMR) ───────────────────────────────────────
    // The SQL above gives us a fundamentally-correct ranking but tends to
    // bunch near-duplicate subjects (e.g. three "Easter Sunday Mass" threads,
    // five Trump threads in a row, etc.). We rerank in JS so the top of the
    // feed surfaces a wider variety of stories. We over-fetch by 3x and slice
    // back to `limit` after diversification.
    //
    // Three signals stack:
    //   1. Significant TITLE tokens shared with any prior pick — biggest hammer.
    //      Catches the "three Easter threads" case where keyword arrays may
    //      diverge but the user-visible headlines obviously repeat.
    //   2. Keyword-array overlap with prior picks — softer, broader signal.
    //   3. Same primary_category as any pick in a small recent window.
    const TITLE_TOKEN_PENALTY = 8.0;  // per shared significant title token
    const KW_PENALTY          = 2.0;  // per overlapping keyword w/ a prior pick
    const CAT_PENALTY         = 0.7;  // per same primary_category in recent window
    const RECENCY_WINDOW      = 8;    // category penalty only for last N picks

    const TITLE_STOPWORDS = new Set([
      'the','a','an','and','or','but','of','in','on','at','to','for','from','by',
      'with','as','is','are','was','were','be','been','being','it','its','this',
      'that','these','those','his','her','their','our','your','my','i','we','they',
      'he','she','him','them','us','you','me','about','after','before','over','out',
      'up','down','off','into','through','during','until','while','than','then',
      'so','if','not','no','yes','too','very','more','most','some','any','all',
      'new','says','said','will','would','could','should','may','might','can',
      'has','have','had','do','does','did','amid','amidst','vs','versus','plus',
      'also','again','still','just','like','what','who','when','where','why','how',
      'live','update','updates','breaking','exclusive','today','tomorrow','yesterday',
      'thread','story','stories','news','report','reports','reporting'
    ]);
    function titleTokens(title) {
      if (!title) return [];
      return String(title)
        .toLowerCase()
        .replace(/[^a-z0-9\s'-]+/g, ' ')
        .split(/\s+/)
        .map(t => t.replace(/^['-]+|['-]+$/g, ''))
        .filter(t => t.length >= 4 && !TITLE_STOPWORDS.has(t));
    }

    function diversifyRerank(rows, want) {
      if (rows.length <= 1) return rows;
      const remaining = rows.map((r, i) => ({
        row: r,
        baseRank: i,
        titleTokens: titleTokens(r.title)
      }));
      const picked      = [];
      const seenKw      = new Map();   // keyword → times seen
      const seenTitleTk = new Map();   // significant title token → times seen
      while (picked.length < want && remaining.length) {
        let bestIdx = 0, bestScore = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const cand = remaining[i];
          let penalty = 0;
          // Title-token overlap — the dominant penalty.
          for (const t of cand.titleTokens) {
            penalty += (seenTitleTk.get(t) || 0) * TITLE_TOKEN_PENALTY;
          }
          // Keyword overlap — softer.
          const kws = Array.isArray(cand.row.keywords) ? cand.row.keywords : [];
          for (const kw of kws) {
            const k = String(kw || '').toLowerCase().trim();
            if (!k) continue;
            penalty += (seenKw.get(k) || 0) * KW_PENALTY;
          }
          // Category bunching in the most recent window.
          const cat = cand.row.primary_category || '';
          if (cat) {
            const recent = picked.slice(-RECENCY_WINDOW);
            const sameCatRecent = recent.filter(p => (p.primary_category || '') === cat).length;
            penalty += sameCatRecent * CAT_PENALTY;
          }
          const score = cand.baseRank + penalty;
          if (score < bestScore) { bestScore = score; bestIdx = i; }
        }
        const chosenWrap = remaining.splice(bestIdx, 1)[0];
        const chosen = chosenWrap.row;
        picked.push(chosen);
        for (const t of chosenWrap.titleTokens) {
          seenTitleTk.set(t, (seenTitleTk.get(t) || 0) + 1);
        }
        const ckws = Array.isArray(chosen.keywords) ? chosen.keywords : [];
        for (const kw of ckws) {
          const k = String(kw || '').toLowerCase().trim();
          if (!k) continue;
          seenKw.set(k, (seenKw.get(k) || 0) + 1);
        }
      }
      return picked;
    }
    const diversified = diversifyRerank(threads, limit);
    threads.length = 0;
    threads.push(...diversified);

    if (!threads.length) return [];

    // Step 2: batch-fetch hero images — lightweight: just grab the best
    // image_url per thread from the article with the highest relevance.
    // Stripped source name / iso / catalog lookups to eliminate 4 LEFT JOINs.
    const threadIds = threads.map(t => t.thread_id);
    const { rows: heroes } = await pool.query(`
      SELECT DISTINCT ON (sta.thread_id)
        sta.thread_id,
        a.image_url AS hero_image_url,
        co.iso_code AS hero_iso_code
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE sta.thread_id = ANY($1)
      ORDER BY sta.thread_id,
        (a.image_url IS NOT NULL AND a.image_url <> '') DESC,
        sta.relevance_score DESC,
        a.published_at DESC
    `, [threadIds]);

    const heroMap = new Map(heroes.map(h => [h.thread_id, h]));

    // Resolve hero ISO from country names mentioned in title/description
    // so hero flags reflect thread subject countries, not article origin.
    const textIsoMap = await resolveHeroIsoFromText(threads, 'thread_id');

    const result = threads.map(t => {
      const h = heroMap.get(t.thread_id);
      const subjectIso = textIsoMap.get(t.thread_id);
      return {
        ...t,
        latest_published_at: t.last_updated_at,
        hero_image_url: h?.hero_image_url || null,
        hero_catalog_image_url: null,
        hero_source_name: null,
        hero_iso_code: subjectIso || h?.hero_iso_code || null
      };
    });

    // Fallback image search for items missing hero images (capped + timeout)
    const _noImg = result.filter(t => !t.hero_image_url).slice(0, 10);
    if (_noImg.length) {
      await Promise.race([
        Promise.all(_noImg.map(async (t) => {
          try {
            const url = await findFallbackImage(t);
            if (url) t.hero_image_url = url;
          } catch (e) { /* silent */ }
        })),
        new Promise(r => setTimeout(r, 6000))  // 6s max for fallback batch
      ]);
    }

    // Apply title-based country boost reranking
    result.forEach(t => { t._titleBoost = getTitleCountryBoost(t); });
    result.sort((a, b) => {
      const sa = a.status === 'active' ? 0 : a.status === 'cooling' ? 1 : 2;
      const sb = b.status === 'active' ? 0 : b.status === 'cooling' ? 1 : 2;
      if (sa !== sb) return sa - sb;
      return ((b.importance || 0) * b._titleBoost) - ((a.importance || 0) * a._titleBoost);
    });
    result.forEach(t => { delete t._titleBoost; });

    return result;
    });

    res.json(_cached);
  } catch (err) {
    console.error("[threads/latest]", err.message, err.stack);
    res.status(500).json({ error: "Failed to fetch threads", detail: req.user?.is_admin ? err.message : undefined });
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
  const candidatePoolSize = Math.max(limit * 8, 400);
  try {
    // 20s in-memory TTL — global ticker fans out heavily; one query per
    // (limit, hours) per window is plenty. Yes, the random sample becomes
    // shared across users in the window — that's fine and avoids hammering
    // the DB with ORDER BY RANDOM() across the full recent corpus on every
    // page open. We instead bound the candidate set to the newest few
    // hundred/thousand rows, then shuffle within that smaller pool.
    const rows = await ttlCached(`articles/recent:${limit}:${hours}`, 20_000, async () => {
      const { rows } = await pool.query(`
        WITH recent_pool AS (
          SELECT a.id
          FROM news_articles a
          WHERE a.published_at >= NOW() - ($2 || ' hours')::interval
            AND a.title IS NOT NULL
          ORDER BY a.published_at DESC
          LIMIT $3
        ),
        sampled_ids AS (
          SELECT id
          FROM recent_pool
          ORDER BY RANDOM()
          LIMIT $1
        )
        SELECT
          a.id, a.title, a.translated_title, a.summary,
          a.published_at, a.url,
          COALESCE(a.image_url, img_a.public_url) AS image_url,
          COALESCE(ns.name, ys.name) AS source_name,
          ns.source_summary,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          co.name AS country_name, co.iso_code
        FROM sampled_ids s
        JOIN news_articles a ON a.id = s.id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN countries co ON co.id = a.country_id
        ORDER BY a.published_at DESC
      `, [limit, hours, candidatePoolSize]);
      return rows;
    });
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

// ── Audio blob cache: avoid re-fetching 8MB from DB on every segment skip ──
// Holds the most recently accessed episode's audio blob + segments in memory.
// Expires after 10 minutes of inactivity. One entry only (episodes are
// listened to sequentially, so only the active one matters).
const _audioCache = { id: null, buf: null, segs: null, ts: 0 };
const AUDIO_CACHE_TTL = 10 * 60 * 1000; // 10 min

async function getAudioCached(episodeId) {
  const now = Date.now();
  if (_audioCache.id === episodeId && _audioCache.buf && (now - _audioCache.ts) < AUDIO_CACHE_TTL) {
    _audioCache.ts = now; // refresh TTL
    return { buf: _audioCache.buf, segs: _audioCache.segs };
  }
  const { rows } = await pool.query(
    `SELECT audio_data, segments FROM briefing_episodes WHERE id = $1 AND audio_data IS NOT NULL`,
    [episodeId]
  );
  if (!rows.length) return null;
  _audioCache.id = episodeId;
  _audioCache.buf = rows[0].audio_data;
  _audioCache.segs = rows[0].segments;
  _audioCache.ts = now;
  return { buf: _audioCache.buf, segs: _audioCache.segs };
}

// GET /api/briefing/audio/:id/:segIdx — serves one segment's MP3 slice (CBR 128kbps, 16 bytes/ms)
app.get("/api/briefing/audio/:id/:segIdx", async (req, res) => {
  try {
    const episodeId = parseInt(req.params.id);
    const segIdx    = parseInt(req.params.segIdx);
    const cached = await getAudioCached(episodeId);
    if (!cached) return res.status(404).json({ error: "Audio not found" });
    const { buf, segs } = cached;
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

// GET /api/briefing/audio/:id — streams the full MP3 audio for an episode
app.get("/api/briefing/audio/:id", async (req, res) => {
  try {
    const episodeId = parseInt(req.params.id);
    const cached = await getAudioCached(episodeId);
    if (!cached) return res.status(404).json({ error: "Audio not found" });
    const buf = cached.buf;
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

// GET /api/briefing/recent — past briefings index (date-indexed archive)
app.get("/api/briefing/recent", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 90);
    const { rows } = await pool.query(`
      SELECT id, target_date, headline, status, generated_at,
             (audio_data IS NOT NULL) AS has_audio
      FROM briefing_episodes
      WHERE user_id IS NULL AND status = 'ready'
        AND location_type IS NULL
      ORDER BY target_date DESC
      LIMIT $1
    `, [limit]);
    res.json(rows);
  } catch (err) {
    console.error("[briefing/recent]", err.message);
    res.status(500).json({ error: "Failed to fetch recent briefings" });
  }
});

// GET /api/briefing/episode/:id — fetch a specific past briefing by ID
app.get("/api/briefing/episode/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, target_date, headline, voiceover_script, segments, status, generated_at,
             (audio_data IS NOT NULL) AS has_audio
      FROM briefing_episodes
      WHERE id = $1 AND status = 'ready'
      LIMIT 1
    `, [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: "Briefing not found" });

    // Free-tier weekly access gate
    if (req.user?.id) {
      const tier = req.user.tier || "free";
      const access = await checkBriefingAccess(req.user.id, rows[0].id, tier).catch(() => ({ allowed: true }));
      if (!access.allowed) {
        return res.status(403).json({
          error: access.resetNote || "Weekly briefing limit reached",
          limitReached: true, used: access.used, limit: access.limit, requiredTier: "pro",
        });
      }
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("[briefing/episode]", err.message);
    res.status(500).json({ error: "Failed to fetch briefing" });
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

// ── Data analytics panels ─────────────────────────────────────────────────
// GET /api/briefing/:episodeId/panels — all panels for a briefing, grouped by segment_index
app.get("/api/briefing/:episodeId/panels", async (req, res) => {
  try {
    const episodeId = parseInt(req.params.episodeId, 10);
    if (!Number.isFinite(episodeId)) return res.status(400).json({ error: "bad id" });
    const rows = await dataPanels.loadPanels(pool, { type: 'briefing_segment', id: episodeId });
    // Group by segment_index for the frontend
    const grouped = {};
    for (const r of rows) {
      const k = String(r.segment_index ?? '_');
      (grouped[k] = grouped[k] || []).push(r);
    }
    res.json({ episode_id: episodeId, panels_by_segment: grouped, count: rows.length });
  } catch (err) {
    console.error("[briefing/panels]", err.message);
    res.status(500).json({ error: "Failed to load panels" });
  }
});

// GET /api/threads/:threadId/panels — returns cached panels only (auto-generation disabled to cut Claude costs)
app.get("/api/threads/:threadId/panels", async (req, res) => {
  try {
    const threadId = parseInt(req.params.threadId, 10);
    if (!Number.isFinite(threadId)) return res.status(400).json({ error: "bad id" });
    const rows = await dataPanels.loadPanels(pool, { type: 'thread', id: threadId });
    res.json({ thread_id: threadId, panels: rows, count: rows.length });
  } catch (err) {
    console.error("[threads/panels]", err.message);
    res.status(500).json({ error: "Failed to load thread panels" });
  }
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
  // Cap cache at 500 entries (there are ~200 countries, so this is generous)
  if (keywordCountryIdCache.size >= 500) keywordCountryIdCache.clear();
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

// Shared helper: attach prefetched article refs to keyword responses
async function _sendWithPrefetchRefs(req, res, rows, logTag) {
  const prefetchN = clampQueryInt(req.query.prefetch_refs || 0, 0, 0, 50);
  if (prefetchN > 0 && rows.length > 0) {
    const topKws = rows.slice(0, prefetchN).map(r => r.keyword);
    try {
      // Use a lateral join to get top 10 articles per keyword efficiently
      const refResult = await pool.query(`
        WITH kw_list AS (
          SELECT UNNEST($1::text[]) AS keyword
        )
        SELECT kl.keyword, sub.*
        FROM kw_list kl
        CROSS JOIN LATERAL (
          SELECT
            a.id,
            COALESCE(a.translated_title, a.title) AS title,
            a.title AS original_title,
            COALESCE(a.translated_summary, a.summary) AS summary,
            a.published_at, a.article_url, a.url,
            COALESCE(a.image_url, img_a.public_url) AS image_url,
            COALESCE(ns.name, ys.name) AS source_name,
            COALESCE(ns.bias, 'unknown') AS source_bias,
            a.media_type, a.video_id,
            a.base_priority
          FROM article_keywords ak
          JOIN news_articles a ON a.id = ak.article_id
          LEFT JOIN news_sources ns ON ns.id = a.source_id
          LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
          LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
          LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
          WHERE LOWER(ak.keyword) = LOWER(kl.keyword)
            AND a.published_at > NOW() - INTERVAL '14 days'
          ORDER BY a.base_priority DESC NULLS LAST, a.published_at DESC
          LIMIT 10
        ) sub
      `, [topKws]);

      const refMap = {};
      for (const r of refResult.rows) {
        const kw = r.keyword.toLowerCase();
        if (!refMap[kw]) refMap[kw] = [];
        delete r.keyword;
        refMap[kw].push(r);
      }
      return res.json({ keywords: rows, refs: refMap });
    } catch (refErr) {
      console.warn(`${logTag} prefetch refs failed:`, refErr.message);
    }
  }
  return res.json(rows);
}

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
        // New format: { keywords, refs } with pre-baked article references
        if (dbCached.keywords && dbCached.refs) {
          const rows = dbCached.keywords.slice(0, limitInt);
          const prefetchN = clampQueryInt(req.query.prefetch_refs || 0, 0, 0, 50);
          if (prefetchN > 0) return res.json({ keywords: rows, refs: dbCached.refs });
          return res.json(rows);
        }
        // Legacy format: plain array — return as-is, no expensive prefetch
        return res.json(Array.isArray(dbCached) ? dbCached.slice(0, limitInt) : dbCached);
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

    // Non-cached path: return keywords without prefetch (cron handles prefetch)
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
        // New format: { keywords, refs } with pre-baked article references
        if (dbCached.keywords && dbCached.refs) {
          const rows = dbCached.keywords.filter((row) => !isDateLikeKeyword(row && row.keyword)).slice(0, limitInt);
          const prefetchN = clampQueryInt(req.query.prefetch_refs || 0, 0, 0, 50);
          if (prefetchN > 0) return res.json({ keywords: rows, refs: dbCached.refs });
          return res.json(rows);
        }
        // Legacy format: plain array — return as-is, no expensive prefetch
        const cachedFiltered = (Array.isArray(dbCached) ? dbCached : []).filter((row) => !isDateLikeKeyword(row && row.keyword)).slice(0, limitInt);
        return res.json(cachedFiltered);
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

    const filtered = rows.filter((row) => !isDateLikeKeyword(row && row.keyword)).slice(0, limitInt);

    // Non-cached path: return keywords without prefetch (cron handles prefetch)
    res.json(filtered);
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
// Returns keywords that frequently appear alongside the given keyword
// within the same articles over the specified time window.
app.get("/api/keywords/cooccurrence", async (req, res) => {
  const keyword = normalizeLowerString(req.query.keyword);
  if (!keyword) return res.json([]);
  const daysInt = clampQueryInt(req.query.days, 7, 1, 365);
  const limitInt = clampQueryInt(req.query.limit, 12, 1, 50);
  const cacheKey = makeKeywordCacheKey("cooccurrence", [
    keyword,
    daysInt,
    limitInt,
  ]);

  try {
    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.top);
    const rows = await getCachedKeywordPayload(
      cacheKey,
      KEYWORD_ROUTE_TTLS.top,
      async () => {
        const { rows } = await pool.query(
          `SELECT ak2.normalized_keyword AS keyword, COUNT(DISTINCT ak2.article_id) AS count
           FROM article_keywords ak1
           JOIN articles a ON a.id = ak1.article_id AND a.published_at >= NOW() - ($2 || ' days')::interval
           JOIN article_keywords ak2 ON ak2.article_id = ak1.article_id
             AND ak2.normalized_keyword IS NOT NULL
             AND ak2.normalized_keyword <> $1
           WHERE ak1.normalized_keyword = $1
           GROUP BY ak2.normalized_keyword
           ORDER BY count DESC
           LIMIT $3`,
          [keyword, String(daysInt), limitInt]
        );
        return rows;
      }
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
    const ambient = req.query.ambient === "1" || req.query.ambient === "true";
    // Ambient gate: tier 2/3/4 sources + base_priority >= 2.0. Appended to both
    // the local/global branches below via an inline CTE-style filter.
    const ambientFilter = ambient
      ? `AND COALESCE(ns.fetch_tier, 1) IN (2, 3, 4) AND COALESCE(a.base_priority, 0) >= 2.0`
      : "";

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
          ${ambientFilter}
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
          ${ambientFilter}
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
   Source Intelligence — /api/news/sources-stats
========================================= */
app.get("/api/news/sources-stats", async (req, res) => {
  try {
    const data = await ttlCached('sources-stats:all', 300_000, async () => {
      // 1. Country distribution — total articles per country (last 30 days)
      const countryDistQ = pool.query(`
        SELECT co.name AS country, co.iso_code, COUNT(*)::int AS articles
        FROM news_articles a
        JOIN countries co ON co.id = a.country_id
        WHERE a.published_at > NOW() - INTERVAL '30 days'
          AND a.country_id IS NOT NULL
        GROUP BY co.id, co.name, co.iso_code
        ORDER BY articles DESC
        LIMIT 50
      `);

      // 2. Country rankings — avg articles per day (last 30 days)
      const countryRankQ = pool.query(`
        SELECT co.name AS country, co.iso_code,
               COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
        FROM news_articles a
        JOIN countries co ON co.id = a.country_id
        WHERE a.published_at > NOW() - INTERVAL '30 days'
          AND a.country_id IS NOT NULL
        GROUP BY co.id, co.name, co.iso_code
        HAVING COUNT(*) >= 5
        ORDER BY "avgPerDay" DESC
        LIMIT 30
      `);

      // 3. City rankings — avg articles per day (last 30 days)
      const cityRankQ = pool.query(`
        SELECT ci.name AS city, co.name AS country,
               COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
        FROM news_articles a
        JOIN cities ci ON ci.id = a.city_id
        JOIN countries co ON co.id = ci.country_id
        WHERE a.published_at > NOW() - INTERVAL '30 days'
          AND a.city_id IS NOT NULL
        GROUP BY ci.id, ci.name, co.name
        HAVING COUNT(*) >= 3
        ORDER BY "avgPerDay" DESC
        LIMIT 30
      `);

      // 4. Source rankings — avg articles per day (last 30 days)
      const sourceRankQ = pool.query(`
        SELECT COALESCE(ns.name, ys.name) AS source,
               COALESCE(ns.site_url, ys.site_url) AS site_url,
               COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
        FROM news_articles a
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        WHERE a.published_at > NOW() - INTERVAL '30 days'
        GROUP BY COALESCE(ns.name, ys.name), COALESCE(ns.site_url, ys.site_url)
        HAVING COUNT(*) >= 3
        ORDER BY "avgPerDay" DESC
        LIMIT 30
      `);

      // 5. Countries by distinct source count
      const sourceCountryQ = pool.query(`
        SELECT co.name AS country, co.iso_code,
               COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id))::int AS "sourceCount"
        FROM news_articles a
        JOIN countries co ON co.id = a.country_id
        WHERE a.published_at > NOW() - INTERVAL '30 days'
          AND a.country_id IS NOT NULL
        GROUP BY co.id, co.name, co.iso_code
        HAVING COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id)) >= 1
        ORDER BY "sourceCount" DESC
        LIMIT 30
      `);

      const [countryDist, countryRank, cityRank, sourceRank, sourceCountry] =
        await Promise.all([countryDistQ, countryRankQ, cityRankQ, sourceRankQ, sourceCountryQ]);

      return {
        countryDistribution:    countryDist.rows,
        countryRankings:        countryRank.rows.map(r => ({ ...r, avgPerDay: parseFloat(r.avgPerDay) })),
        cityRankings:           cityRank.rows.map(r => ({ ...r, avgPerDay: parseFloat(r.avgPerDay) })),
        sourceRankings:         sourceRank.rows.map(r => ({ ...r, avgPerDay: parseFloat(r.avgPerDay) })),
        countriesBySourceCount: sourceCountry.rows,
      };
    });
    res.json(data);
  } catch (err) {
    console.error("Sources stats error:", err);
    res.status(500).json({ error: "Failed to fetch source stats" });
  }
});

/* =========================================
   Globe Statistics — /api/globe-stats
   Aggregates data from external adapters (World Bank, FRED, EIA, OWID)
   with aggressive caching (1 hour) since these are slow external APIs.
========================================= */
app.get("/api/globe-stats", async (req, res) => {
  try {
    const data = await ttlCached('globe-stats:all', 3_600_000, async () => {
      const dataSources = require('./dataSources');
      const results = {};

      // Helper: fetch from an adapter, return latest value or null
      async function latest(adapterName, indicator, opts = {}) {
        try {
          const adapter = dataSources.getAdapter(adapterName);
          if (!adapter) return null;
          const data = await adapter.fetch({ indicator, ...opts });
          if (!data || !data.series || !data.series.length) return null;
          // Get the most recent non-null value
          const values = data.series[0].values;
          for (let i = values.length - 1; i >= 0; i--) {
            if (values[i] != null) return { value: values[i], unit: data.unit, source: data.source_url };
          }
          return null;
        } catch { return null; }
      }

      // Helper: fetch World Bank for top countries
      async function wbTopCountries(indicator, countries, years) {
        try {
          const adapter = dataSources.getAdapter('worldbank');
          if (!adapter) return null;
          const data = await adapter.fetch({ indicator, countries, years });
          return data;
        } catch { return null; }
      }

      // ── Commodities (FRED + EIA) ──
      const commodityFetches = {
        oil:       latest('fred', 'DCOILWTICO'),
        natgas:    latest('eia', 'NG.RNGWHHD.D'),
      };

      // ── Economic (World Bank — global aggregates) ──
      const topEconomies = ['United States', 'China', 'Japan', 'Germany', 'India', 'United Kingdom'];
      const recentYears = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 5 + i);
      const economicFetches = {
        gdp:          wbTopCountries('NY.GDP.MKTP.CD', topEconomies, recentYears),
        gdp_growth:   latest('worldbank', 'NY.GDP.MKTP.KD.ZG', { countries: ['World'], years: recentYears }),
        inflation:    latest('worldbank', 'FP.CPI.TOTL.ZG', { countries: ['World'], years: recentYears }),
        unemployment: latest('worldbank', 'SL.UEM.TOTL.ZS', { countries: ['World'], years: recentYears }),
        interest:     latest('fred', 'FEDFUNDS'),
        debt_gdp:     latest('fred', 'GFDEBTN'),
      };

      // ── Demographics (World Bank) ──
      const demoFetches = {
        population:  latest('worldbank', 'SP.POP.TOTL', { countries: ['World'], years: recentYears }),
        life_expect: latest('worldbank', 'SP.DYN.LE00.IN', { countries: ['World'], years: recentYears }),
      };

      // ── Energy (World Bank + EIA) ──
      const energyFetches = {
        co2_capita: latest('worldbank', 'EN.ATM.CO2E.PC', { countries: ['World'], years: recentYears }),
      };

      // ── Military (World Bank) ──
      const geoFetches = {
        military: wbTopCountries('MS.MIL.XPND.CD', ['United States', 'China', 'Russia', 'India', 'Saudi Arabia', 'United Kingdom'], recentYears),
      };

      // Collect all named fetches
      const allKeys = [];
      const allPromises = [];
      for (const group of [commodityFetches, economicFetches, demoFetches, energyFetches, geoFetches]) {
        for (const [key, promise] of Object.entries(group)) {
          allKeys.push(key);
          allPromises.push(promise);
        }
      }

      const settled = await Promise.allSettled(allPromises);
      for (let i = 0; i < allKeys.length; i++) {
        const r = settled[i];
        if (r.status === 'fulfilled' && r.value != null) {
          const v = r.value;
          // For simple latest-value results
          if (v.value != null) {
            results[allKeys[i]] = v.value;
          }
          // For multi-country series results (from wbTopCountries)
          else if (v.series) {
            results[allKeys[i]] = v;
          }
        }
      }

      return results;
    });
    res.json(data);
  } catch (err) {
    console.error("Globe stats error:", err);
    res.status(500).json({ error: "Failed to fetch globe stats" });
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

// ── Story builder automation ─────────────────────────────────────────────
// Both builders call pool.end() when done, so they must run as child
// processes. Threads (48h breaking meta-story) run every 30 minutes so
// cross-source convergence is fresh. Timelines (7d umbrella arcs) run
// every 2h since they're slower-moving.
function spawnBuilder(scriptName, label) {
  const tag = `[${label}]`;
  console.log(`${tag} starting...`);
  const proc = spawn(process.execPath, [path.join(__dirname, scriptName)], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", d => process.stdout.write(d));
  proc.stderr.on("data", d => process.stderr.write(d));
  proc.on("exit", code => console.log(`${tag} exited (code ${code})`));
  proc.on("error", err => console.error(`${tag} spawn error: ${err.message}`));
}

// Breaking threads — 48h window, cross-source convergence. Staggered 3 min
// after boot so keywordCron gets first dibs on the DB pool.
setTimeout(() => spawnBuilder("storyThreadBuilder.js", "threadBuilder startup"), 3 * 60_000);
setInterval(() => spawnBuilder("storyThreadBuilder.js", "threadBuilder"),   30 * 60 * 1000).unref?.(); // every 30m

// Umbrella timelines — 30d window, parabolic weighting. Runs once per day.
// Staggered 6 min after boot so it doesn't collide with threadBuilder startup.
setTimeout(() => spawnBuilder("storyTimelineBuilder.js", "timelineBuilder startup"), 6 * 60_000);
setInterval(() => spawnBuilder("storyTimelineBuilder.js", "timelineBuilder"), 24 * 60 * 60 * 1000).unref?.(); // once daily

startArticleListener().catch(console.error);

// ── Cache warming — keep threads & timelines hot so no user hits a cold query ──
// The TTL cache is 120s. We refresh every 90s so the cache never expires.
// First warm runs 5s after boot (after the pool is ready).
async function _warmFeedCaches() {
  const http = require('http');
  const base = `http://localhost:${PORT}`;
  const urls = [
    `${base}/api/news/search?limit=25&offset=0`,
    `${base}/api/threads/latest?limit=30`,
    `${base}/api/timelines/latest?limit=30`,
    `${base}/api/flows?mode=aggregate&view_mode=country&limit=500`,
  ];
  for (const url of urls) {
    try {
      await new Promise((resolve, reject) => {
        const r = http.get(url, res => {
          res.resume(); // drain
          res.on('end', resolve);
        });
        r.on('error', reject);
        r.setTimeout(15000, () => { r.destroy(); reject(new Error('timeout')); });
      });
    } catch (e) {
      console.warn('[cache-warm]', url, e.message);
    }
  }
}
setTimeout(_warmFeedCaches, 5000);
setInterval(_warmFeedCaches, 90_000).unref?.();

// ── World Leaders tweets (oEmbed, admin-curated) ────────────────────────
const { processTweetUrls } = require('./twitterFetcher');

// Public: get curated leader tweets
app.get('/api/leader-tweets', async (req, res) => {
  const iso   = (req.query.iso || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const cacheKey = `leader-tweets:${iso || 'all'}:${limit}`;
  try {
    const cached = ttlCached(cacheKey, 60_000, async () => {
      const q = iso
        ? `SELECT id, tweet_id, tweet_url, twitter_handle, leader_name, leader_title,
                  country, iso_code, tweet_text, oembed_html, pinned, created_at
           FROM leader_tweets WHERE iso_code = $1
           ORDER BY pinned DESC, created_at DESC LIMIT $2`
        : `SELECT id, tweet_id, tweet_url, twitter_handle, leader_name, leader_title,
                  country, iso_code, tweet_text, oembed_html, pinned, created_at
           FROM leader_tweets
           ORDER BY pinned DESC, created_at DESC LIMIT $1`;
      const params = iso ? [iso, limit] : [limit];
      const { rows } = await pool.query(q, params);
      return rows;
    });
    const rows = await cached;
    res.json({ tweets: rows, count: rows.length });
  } catch (err) {
    console.error('[leader-tweets]', err.message);
    res.status(500).json({ error: 'Failed to load leader tweets' });
  }
});

// Admin: add tweet URLs (newline or comma separated)
app.post('/api/admin/leader-tweets', async (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { urls } = req.body;
  if (!urls || typeof urls !== 'string') return res.status(400).json({ error: 'urls string required' });
  try {
    const results = await processTweetUrls(pool, urls, req.user.id);
    res.json({ results });
  } catch (err) {
    console.error('[admin/leader-tweets]', err.message);
    res.status(500).json({ error: 'Failed to process tweets' });
  }
});

// Admin: delete a curated tweet
app.delete('/api/admin/leader-tweets/:id', async (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM leader_tweets WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Admin: toggle pin
app.patch('/api/admin/leader-tweets/:id/pin', async (req, res) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await pool.query(
      'UPDATE leader_tweets SET pinned = NOT pinned WHERE id = $1 RETURNING id, pinned', [req.params.id]
    );
    res.json(rows[0] || { error: 'Not found' });
  } catch (err) {
    res.status(500).json({ error: 'Pin toggle failed' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount
    }
  });
});

// ── Start server with graceful shutdown ───────────────────────────────────
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully`);
  server.close(() => {
    console.log('HTTP server closed');
    pool.end().then(() => {
      console.log('DB pool drained');
      process.exit(0);
    });
  });
  // Force exit after 30s if connections don't drain
  setTimeout(() => {
    console.error('Forced exit — connections did not drain in 30s');
    process.exit(1);
  }, 30_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
