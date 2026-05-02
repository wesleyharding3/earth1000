// Cap the web tier's DB connection pool BEFORE db.js loads. The default
// (60) was set when web was the only DB consumer; with worker, fetcher,
// and many crons all sharing Postgres max_connections=103, the web's 60
// + everyone else routinely pushed past the limit and triggered the
// "remaining connection slots are reserved for SUPERUSER" (53300)
// failures that took down /api/threads/latest, /api/flows, etc.
//
// Production logs consistently show web pool usage between 5-20 active
// connections. 40 is generous (2× the observed peak) while leaving room
// in the 103-connection budget for every cron we run alongside.
process.env.DB_POOL_MAX = "40";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const pool = require("./db");
const { startArticleListener } = require("./articleListener");
const { getRankedArticles, getRankedCityArticles, getRankedFeedArticles } = require("./rankingService");
const { countryVarianceRerank, diversityRerank, calculatePriority, FLOW_CITY_PENALTY } = require("./priorityEngine");
const { translateText } = require("./translator");
const { generateLocationBriefing } = require("./locationBriefingGenerator");
const dataPanels = require("./dataPanelGenerator");
const Anthropic = new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY });
const { resolveImagesForArticles } = require("./imageResolver");
// Shared heatmap-resolver — also used by briefingGenerator.js to
// pre-resolve heatmap segments at generation time so the briefing
// playback never triggers a Claude call.
const heatmapResolver = require("./heatmapResolver");
const jwt = require("jsonwebtoken");
const payments = require("./payments");
const sba = require("./supabaseAdmin");
const { checkTranslation, checkExplanation, checkKwExplanation, checkBriefingAccess, checkCustomBriefing } = require("./tierLimits");
const credits = require("./creditLedger");

// Turn a creditLedger access object into a JSON-safe block for API
// responses. Infinity (admins, effectively unlimited) serialises as null
// and gets an explicit `admin: true` flag so the frontend meter can
// render "∞" without guessing.
function _creditsBlock(access) {
  if (!access) return null;
  const fix = (v) => (v === Infinity ? null : v);
  return {
    cost:            fix(access.cost) ?? 0,
    remaining:       fix(access.remaining),
    base_remaining:  fix(access.base_remaining),
    addon_remaining: fix(access.addon_remaining) ?? 0,
    weekly_limit:    fix(access.weekly_limit),
    admin:           !!access.admin,
  };
}
const { extractArticleSignals } = require("./sentimentLexicon");
const { findBucketImage, guaranteeHeroImage } = require("./imageFallback");
const { loadGazetteer: loadNationGazetteer, extractNations } = require("./nationExtractor");
const {
  logEditorEvent,
  snapshotThread: snapshotThreadRow,
  snapshotTimeline: snapshotTimelineRow,
} = require("./editorEventLogger");

const app = express();
console.log("Node version:", process.version);

// Trust the Render edge proxy so req.ip resolves to the real client IP via
// X-Forwarded-For. Without this, every visitor's IP looks like the Render
// load-balancer's internal address, which collapses every per-IP rate-limit
// (apiLimiter / heavyLimiter / searchLimiter) into a SINGLE GLOBAL bucket
// shared by the entire userbase.
//
// Concrete prior failure: heavyLimiter caps /api/flows at 30 req/min and
// is supposed to be per-user. With trust-proxy off, all browsers shared the
// 30/min budget — one user clicking through several flow-arc threads in a
// minute starved the budget for everyone else, who then saw the limiter's
// instant 429 as "Failed to load" with no loading spinner. Setting trust
// proxy=1 (single hop) tells express-rate-limit to key off the original
// client IP from X-Forwarded-For. Render only adds one hop, so 1 is the
// safe choice — using `true` would let a malicious client forge the header.
app.set('trust proxy', 1);

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
// Expensive endpoints: 80 req/min per IP. Bumped from 30 because a real
// user clicking through several thread flow-arc cards fires 5-8 /api/flows
// requests per switch (arcs, routes-by-mode, source filters) — the old 30
// cap could trip after 4-5 thread interactions, and (worse) before the
// trust-proxy fix the cap was effectively GLOBAL across all users. Now
// per-user with the cache (180s TTL on /api/flows) absorbing repeats, 80
// gives plenty of room for active exploration without exposing the DB to
// abuse.
const heavyLimiter = rateLimit({ windowMs: 60_000, max: 80 });
// Search: 60 req/min per IP
const searchLimiter = rateLimit({ windowMs: 60_000, max: 60 });
// AI / external-cost endpoints (Claude, DeepL, etc.). Each call costs real
// money per request, so the cap is much tighter than the general API limit.
// 20/min is generous for legitimate use — translating a card cluster, hitting
// "Explain" a few times, asking the heatmap a couple of questions — without
// letting a single IP rack up a $$$ bill or DOS the upstream AI provider.
// Per-user tier quotas (checkTranslation, requireTier) gate by user id; this
// limiter is a complementary per-IP guard for unauthenticated/anon paths.
const aiLimiter = rateLimit({ windowMs: 60_000, max: 20 });
// Account mutations (currently just DELETE /api/account). Destructive and
// hits Supabase admin API; should never fire more than a handful of times
// from a single IP in normal use. 10/min gives room for retries while
// blocking automated abuse if a token leaks.
const authLimiter = rateLimit({ windowMs: 60_000, max: 10 });
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
  // /api/ai/flow-context uses XHR with `withCredentials = true` so that
  // SSE streams survive long enough for browsers that treat cookieless
  // requests as third-party. Credentials mode requires the server to
  // echo Allow-Credentials AND a specific origin (not `*`) — the origin
  // list above already resolves to a concrete string per request, so
  // toggling this on is safe.
  credentials: true,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(express.json());

// ── Browser caching headers for read-heavy GET endpoints ──
// Sets Cache-Control with stale-while-revalidate + stale-if-error so
// Cloudflare serves cached responses instantly, refreshes in background,
// and falls back to stale content if origin 5xxs (e.g. DB cold-cache
// timeouts). This is the fix for "first load fails, retry works":
// after one success the result is cached, and stale-if-error guarantees
// the next cold-cache slow query never surfaces as a 500 to the client.
//
// TTL philosophy:
//   - Flows, threads, timelines change slowly (new entity mentions trickle
//     over hours) — prefer longer cache.
//   - Search / articles / feed are time-sensitive — keep short.
//   - Static reference data (countries, cities) — cache aggressively.
const SIE = ', stale-if-error=86400';   // serve stale up to 24h if origin 5xx
// Order matters: the middleware breaks on first prefix match, so list
// specific routes BEFORE their broader umbrella (e.g. /api/threads/latest
// must come before /api/threads/).
const SWR_ROUTES = {
  // ── Thread surfaces ──────────────────────────────────────────────
  '/api/threads/latest':      's-maxage=120, stale-while-revalidate=300' + SIE,
  '/api/threads/by-country/': 's-maxage=120, stale-while-revalidate=300' + SIE,
  '/api/threads/id/':         's-maxage=120, stale-while-revalidate=300' + SIE,
  '/api/threads/':            's-maxage=60,  stale-while-revalidate=300' + SIE, // catches /:id/timeline, /:threadId/panels
  // ── Timeline surfaces ────────────────────────────────────────────
  '/api/timelines/latest':    's-maxage=120, stale-while-revalidate=300' + SIE,
  '/api/timelines/':          's-maxage=60,  stale-while-revalidate=300' + SIE, // catches /:id/articles
  // ── Search / recent (time-sensitive) ─────────────────────────────
  '/api/news/search':         's-maxage=30,  stale-while-revalidate=60'  + SIE,
  '/api/articles/recent':     's-maxage=30,  stale-while-revalidate=60'  + SIE,
  // ── Flow arcs ────────────────────────────────────────────────────
  '/api/flows':               's-maxage=300, stale-while-revalidate=900' + SIE,
  // ── Country / city / region panels (pure public reads) ──────────
  '/api/news/city/':          's-maxage=60,  stale-while-revalidate=300' + SIE,
  '/api/news/country/':       's-maxage=60,  stale-while-revalidate=300' + SIE,
  '/api/news/region/':        's-maxage=60,  stale-while-revalidate=300' + SIE,
  '/api/sentiment/':          's-maxage=300, stale-while-revalidate=900' + SIE,
  '/api/stats/location':      's-maxage=120, stale-while-revalidate=600' + SIE,
  '/api/globe-stats':         's-maxage=120, stale-while-revalidate=600' + SIE,
  '/api/environment':         's-maxage=300, stale-while-revalidate=900' + SIE,
  // ── Keywords (AI-derived GETs are deterministic by query string) ─
  '/api/keywords/trending':   's-maxage=600, stale-while-revalidate=1800' + SIE,
  '/api/keywords/rising':     's-maxage=600, stale-while-revalidate=1800' + SIE,
  '/api/keywords/autocomplete':'s-maxage=300, stale-while-revalidate=900' + SIE,
  '/api/keywords/cooccurrence':'s-maxage=300, stale-while-revalidate=900' + SIE,
  '/api/keywords/top':        's-maxage=300, stale-while-revalidate=900' + SIE,
  '/api/keywords/trend':      's-maxage=300, stale-while-revalidate=900' + SIE,
  '/api/keywords/articles':   's-maxage=120, stale-while-revalidate=600' + SIE,
  '/api/keywords/':           's-maxage=120, stale-while-revalidate=600' + SIE, // catches /:keyword/references
  // ── Clusters ─────────────────────────────────────────────────────
  '/api/clusters/':           's-maxage=300, stale-while-revalidate=900' + SIE,
  // ── Briefing (audio/panels/recent — not admin editor) ────────────
  '/api/briefing/today':      's-maxage=120, stale-while-revalidate=300' + SIE,
  '/api/briefing/recent':     's-maxage=120, stale-while-revalidate=300' + SIE,
  '/api/briefing/episode/':   's-maxage=300, stale-while-revalidate=900' + SIE,
  '/api/briefing/voices':     's-maxage=3600,stale-while-revalidate=86400'+ SIE,
  '/api/briefing/music/':     's-maxage=3600,stale-while-revalidate=86400'+ SIE,
  '/api/briefing/audio/':     's-maxage=86400,stale-while-revalidate=604800'+ SIE, // rendered audio never changes
  '/api/briefing/':           's-maxage=120, stale-while-revalidate=300' + SIE, // catches /:episodeId/panels
  // ── Reference data (almost static) ───────────────────────────────
  '/api/countries/all':       's-maxage=300, stale-while-revalidate=600' + SIE,
  '/api/countries':           's-maxage=300, stale-while-revalidate=600' + SIE,
  '/api/cities/all':          's-maxage=300, stale-while-revalidate=600' + SIE,
  '/api/cities':              's-maxage=300, stale-while-revalidate=600' + SIE,
  '/api/regions':             's-maxage=600, stale-while-revalidate=3600'+ SIE,
  '/api/commodities':         's-maxage=3600,stale-while-revalidate=86400'+ SIE,
  '/api/land/geojson':        's-maxage=86400,stale-while-revalidate=604800'+ SIE,
  '/api/tags':                's-maxage=300, stale-while-revalidate=900' + SIE,
  '/api/exports':             's-maxage=600, stale-while-revalidate=3600'+ SIE,
  '/api/imports':             's-maxage=600, stale-while-revalidate=3600'+ SIE,
  // ── Stats / heatmap / misc ───────────────────────────────────────
  '/api/news/sources-stats':  's-maxage=120, stale-while-revalidate=300' + SIE,
  '/api/heatmap/':            's-maxage=120, stale-while-revalidate=300' + SIE,
  '/api/leader-tweets':       's-maxage=120, stale-while-revalidate=300' + SIE,
};
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') {
    for (const [route, header] of Object.entries(SWR_ROUTES)) {
      if (req.path.startsWith(route.replace('/api', ''))) {
        res.set('Cache-Control', `public, ${header}`);
        break;
      }
    }
  }
  next();
});

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

// ── Disk-persisted snapshot of the default news feed ─────────────────────
// So a cold server boot (deploy, restart, crash) never serves an empty page
// while the cache warms up. We load whatever was last-good into _ttlCache
// before any user request can arrive, and rewrite the file on every
// successful default-feed compute.
const _FEED_SNAPSHOT_FILE = require('path').join(__dirname, '.feed-snapshot.json');
// Boot-time pre-warm keys. Bumped from v8 → v9 in the cache rewrite that
// added per-country dispersion to _finalizeSearchResults — see the long
// comment in that function. Keep these in lock-step with the cacheKey
// template used by /api/news/search default-query path.
//
// cities:all and countries:all added because the bootstrap of the mobile
// + desktop clients depends on those endpoints — when /api/countries
// 500s on cold start (typically because the Postgres pool was saturated
// at the moment of request, which we've seen happen when other services
// hold all the slots) the entire app boots into an unusable state with
// "Bootstrap: countries empty" warnings and the tutorial's country-
// selection chapters silently no-op. Snapshotting these to disk means
// a freshly-deployed replica can serve last-known-good data via
// ttlCached's stale-if-error path even when its first DB query fails.
// Both endpoints are essentially-static (countries change ~never,
// cities change a few times a week), so serving stale is fine.
const _SNAPSHOT_KEYS = new Set([
  'news/search:default:v9:25:0',
  'news/search:default:v9:24:0',
  'cities:all',
  'countries:all',
  // globe-stats:all added because the producer falls back to {} when
  // the DB read fails (getDbKeywordCache silently swallows pool errors)
  // — cron failures + DB saturation both surface there. With a disk
  // snapshot, the boot sequence reads the last successful response,
  // marks it stale, and serves it via stale-while-revalidate while
  // the DB recovers. Without this, /api/globe-stats returns {} for
  // up to 90 s after every cold boot and the dashboard renders blank.
  'globe-stats:all',
]);
try {
  const raw = require('fs').readFileSync(_FEED_SNAPSHOT_FILE, 'utf8');
  const snap = JSON.parse(raw);
  for (const [k, v] of Object.entries(snap || {})) {
    // expires in the near past → next request gets served stale immediately
    // via ttlCached's stale-while-revalidate path, while fresh data computes.
    _ttlCache.set(k, { expires: Date.now() - 1, value: v });
  }
  console.log(`[feed-snapshot] loaded ${Object.keys(snap || {}).length} keys from disk`);
} catch (_) { /* no snapshot yet — fine on first boot */ }

function _persistFeedSnapshot() {
  const out = {};
  for (const key of _SNAPSHOT_KEYS) {
    const hit = _ttlCache.get(key);
    if (hit && hit.value) out[key] = hit.value;
  }
  if (!Object.keys(out).length) return;
  require('fs').writeFile(_FEED_SNAPSHOT_FILE, JSON.stringify(out), () => {});
}

// Per-key expiry jitter — when this server runs as multiple Render
// replicas, each replica has its own in-process _ttlCache. All replicas
// that warm a key at the same instant will also expire that key at the
// same instant, and on the next request they all simultaneously
// produce a fresh value (cross-process thundering herd: pg_stat_activity
// showed 13 copies of the same producer query running in parallel).
//
// In-process coalescing (the _ttlInflight Map below) already prevents
// N requests on a single replica from firing N producers — that part
// works. What it can't prevent is N replicas all expiring together.
//
// The fix is decorrelation, not coordination: spread each replica's
// expiry by ±10% of the configured TTL so replicas drift apart over
// time. After a few cycles, replicas are firing producers at staggered
// moments instead of all at once. Cross-process coalescing (e.g. via
// Redis or pg_try_advisory_lock) would be cleaner but requires either
// new infrastructure or burning a connection slot just to acquire the
// lock — counter-productive when slot saturation is the very thing we
// were investigating.
function _jitteredExpiry(ttlMs) {
  // Multiply by [0.9, 1.1). +ttlMs/10 random offset across replicas.
  const factor = 0.9 + Math.random() * 0.2;
  return Date.now() + Math.round(ttlMs * factor);
}

async function ttlCached(key, ttlMs, producer) {
  const now = Date.now();
  const hit = _ttlCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  // Stale-while-revalidate: serve stale data while refreshing in background.
  // If the cache expired within the last 2× TTL, return stale immediately
  // and kick off a background refresh so the next request gets fresh data.
  if (hit && hit.expires > now - ttlMs * 2) {
    if (!_ttlInflight.has(key)) {
      const bg = (async () => {
        try {
          const value = await producer();
          _ttlCache.set(key, { expires: _jitteredExpiry(ttlMs), value });
      if (_SNAPSHOT_KEYS.has(key)) _persistFeedSnapshot();
        } catch (_) {} finally { _ttlInflight.delete(key); }
      })();
      _ttlInflight.set(key, bg);
    }
    return hit.value; // serve stale immediately
  }
  const inflight = _ttlInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const value = await producer();
      _ttlCache.set(key, { expires: _jitteredExpiry(ttlMs), value });
      if (_SNAPSHOT_KEYS.has(key)) _persistFeedSnapshot();

      return value;
    } catch (err) {
      // App-level stale-if-error: if the producer failed (cold-cache timeout,
      // transient DB error) and we have ANY previously-cached value — even
      // long-expired — serve it rather than 500-ing. Cloudflare also has
      // stale-if-error for CDN-level fallback, but that only helps once CF
      // has a cached response to fall back to. This covers the in-process
      // case and gives the user a working page while we log the error.
      if (hit) {
        console.warn(`[ttlCached:${key}] producer failed, serving stale: ${err.message}`);
        return hit.value;
      }
      throw err;
    } finally {
      _ttlInflight.delete(key);
    }
  })();
  _ttlInflight.set(key, p);
  return p;
}

// Periodic pruning of expired TTL cache entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _ttlCache) {
    // Evict entries that have been stale for more than 5× their original TTL
    if (entry.expires < now - 300_000) _ttlCache.delete(key);
  }
}, 120_000).unref?.();

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
// Tiny token-verification cache. Supabase projects on newer plans issue
// ES256-signed JWTs (asymmetric — you see `"alg":"ES256","kid":"…"` in the
// header) that HS256 verification with SUPABASE_JWT_SECRET can't validate.
// When local verify fails we fall back to sba.auth.getUser(token), which
// asks Supabase's auth server to verify with the right key. That's a
// round-trip, so we cache {sub,email,exp} by token for 60s.
const _tokenCache = new Map(); // token -> { sub, email, expMs }
const _TOKEN_CACHE_MS = 60_000;
function _cacheClaims(token, sub, email, expUnix) {
  const expMs = Math.min(
    Date.now() + _TOKEN_CACHE_MS,
    (Number(expUnix) || 0) * 1000
  );
  _tokenCache.set(token, { sub, email, expMs });
  // LRU-ish: keep cache size bounded.
  if (_tokenCache.size > 500) {
    const firstKey = _tokenCache.keys().next().value;
    _tokenCache.delete(firstKey);
  }
}
async function _verifyBearerToken(token) {
  // 1. Cache hit.
  const cached = _tokenCache.get(token);
  if (cached && cached.expMs > Date.now()) return { sub: cached.sub, email: cached.email };
  if (cached) _tokenCache.delete(token);

  // 2. Local HS256 verify — fast path for legacy projects still on the
  //    shared-secret signing algorithm.
  if (SUPABASE_JWT_SECRET) {
    try {
      const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
      _cacheClaims(token, payload.sub, payload.email, payload.exp);
      return { sub: payload.sub, email: payload.email };
    } catch (_) { /* fall through to Supabase-backed verify */ }
  }

  // 3. Remote verify via Supabase Admin client. Handles ES256/RS256 keys
  //    and any future rotation without us needing to ship a JWKS fetcher.
  try {
    const { data, error } = await sba.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    // Supabase doesn't return `exp` directly on getUser response — decode
    // the token body without verifying just to extract the expiry claim.
    let expUnix = 0;
    try {
      const body = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      expUnix = body?.exp || 0;
    } catch (_) {}
    _cacheClaims(token, data.user.id, data.user.email || null, expUnix);
    return { sub: data.user.id, email: data.user.email || null };
  } catch (_) {
    return null;
  }
}

async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();
  const token = authHeader.slice(7);
  if (!token) return next();

  const claims = await _verifyBearerToken(token);
  if (!claims?.sub) return next(); // invalid / expired / unverifiable

  req.user = { id: claims.sub, email: claims.email, is_admin: false, tier: "free" };

  // Split admin lookup and subscription lookup into two independent queries.
  // A single combined SELECT with the nested `subscriptions(subscription_tiers(name))`
  // relation was silently returning `data = null` whenever the nested join
  // tripped (PostgREST schema cache quirks, missing FK, etc.) — which
  // cascaded into `req.user.is_admin = false` even for genuine admins and
  // 403-ed them out of `requireTier('pro')`.
  try {
    const { data: profile, error: profileErr } = await sba
      .from("profiles")
      .select("is_admin")
      .eq("id", req.user.id)
      .maybeSingle();
    if (profileErr) {
      console.warn("[optionalAuth] profile lookup failed:", profileErr.message);
    } else if (profile) {
      req.user.is_admin = profile.is_admin === true;
    }
  } catch (e) {
    console.warn("[optionalAuth] profile exception:", e.message);
  }

  // Tier resolution is independent — even if it fails, admins still pass
  // requireTier via the is_admin short-circuit.
  try {
    const { data: subs, error: subsErr } = await sba
      .from("subscriptions")
      .select("status, updated_at, tier_id")
      .eq("user_id", req.user.id)
      .eq("status", "active");
    if (subsErr) {
      console.warn("[optionalAuth] subs lookup failed:", subsErr.message);
    } else {
      const activeSub = pickBestActiveSubscription(subs || []);
      const tierRow = await resolveTierRecordById(activeSub?.tier_id);
      req.user.tier = tierRow?.name || "free";
    }
  } catch (e) {
    console.warn("[optionalAuth] subs exception:", e.message);
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
    // Diagnostic: show what the gate actually observed so a misclassified
    // admin/enterprise user ends up in the logs rather than silently 403-ed.
    console.warn(
      `[requireTier] 403 uid=${req.user.id} is_admin=${req.user.is_admin} ` +
      `tier=${req.user.tier} required=${minTier}`
    );
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
   Internal hero-cache invalidation — called by heroImageValidator.js
   after it marks article images dead / alive. Drops the relevant
   thread/timeline keys from the in-process _ttlCache so the next user
   request re-runs the hero SQL (which already filters on image_dead_at)
   instead of serving the cached response that still points at the dead
   URL. Protected by INTERNAL_CACHE_INVALIDATE_SECRET header so it's not
   a public DoS surface. Called once per validator run, small body.
========================================= */
app.post("/api/internal/cache/invalidate-hero", express.json(), (req, res) => {
  const secret = process.env.INTERNAL_CACHE_INVALIDATE_SECRET;
  if (!secret) return res.status(503).json({ error: "not configured" });
  if (req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const threadIds   = Array.isArray(req.body?.threadIds)   ? req.body.threadIds.map(n => parseInt(n, 10)).filter(Boolean)   : [];
  const timelineIds = Array.isArray(req.body?.timelineIds) ? req.body.timelineIds.map(n => parseInt(n, 10)).filter(Boolean) : [];
  let cleared = 0;

  // Per-entity keys used by the flow + hero builders. Clear every
  // variant so the next request misses cache and re-runs the SQL.
  for (const id of threadIds) {
    for (const k of [`flows/thread:${id}`, `threads/${id}/articles`]) {
      if (_ttlCache.delete(k)) cleared++;
    }
  }
  for (const id of timelineIds) {
    for (const k of [`flows/timeline:${id}`]) {
      if (_ttlCache.delete(k)) cleared++;
    }
  }

  // The LATEST-list endpoints (/api/threads/latest, /api/timelines/latest)
  // cache a single key each. The hero URLs inside those payloads may now
  // be dead — clear them too so the next fetch rebuilds.
  for (const k of [..._ttlCache.keys()].filter(k =>
       k.startsWith('threads/latest:') || k.startsWith('timelines/latest:'))) {
    _ttlCache.delete(k);
    cleared++;
  }

  res.json({ ok: true, cleared, threads: threadIds.length, timelines: timelineIds.length });
});

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
  // start/end (seconds) clip the video. Featured-media segments use these
  // so the iframe loads pre-positioned and we don't flash 0:00 before
  // seekTo lands.
  const startSec = parseInt(req.query.start, 10);
  const endSec   = parseInt(req.query.end,   10);

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
  if (Number.isFinite(startSec) && startSec > 0) params.set('start', String(startSec));
  if (Number.isFinite(endSec)   && endSec   > 0) params.set('end',   String(endSec));

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="referrer" content="origin">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:#000}
iframe{width:100%;height:100%;border:none}</style></head>
<body><iframe id="ytplayer" src="https://www.youtube.com/embed/${videoId}?${params}"
referrerpolicy="origin"
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
   Retention — Daily streaks + badge counts
   =========================================
   Two user-state surfaces that compound on every other engagement
   mechanic in the app:

     1. user_streaks       — current/longest day streak with a small
                             1-freeze-per-week grace so a single
                             missed day doesn't burn a 30-day streak.

     2. user_last_seen     — per (user, surface) timestamp; lets the
                             client compute "N new since you visited"
                             badges on threads/lines tabs.

   See migrations/20260429_user_streaks_and_last_seen.sql for full
   schema rationale. Endpoints:

     POST /api/streaks/tick    — body: { localDate: 'YYYY-MM-DD' }
     GET  /api/streaks/me
     GET  /api/badges/me       — counts of new threads/lines since last seen
     POST /api/badges/seen     — body: { surface: 'threads'|'lines'|'briefing' }
========================================= */

const _STREAK_FREEZES_PER_WEEK = 1;
const _BADGE_SURFACES = new Set(['threads', 'lines', 'briefing']);

app.post('/api/streaks/tick', async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  const userId = req.user.id;
  const localDate = String(req.body?.localDate || '');
  // Strict ISO-date parse — server trusts client's local YYYY-MM-DD,
  // so the absolute minimum is shape-validation. Streak-fraud surface
  // is harmless (gaming your own counter) but malformed input would
  // throw deep inside Postgres.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return res.status(400).json({ error: 'Invalid localDate (expected YYYY-MM-DD)' });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT current_streak, longest_streak, last_active_date,
              freezes_used, freeze_week_start
         FROM user_streaks WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );

    // Compute "this week's start" once on the server using ISO-week
    // semantics (Monday-anchored). DATE-only so DST shifts can't
    // double-count a week.
    const { rows: wkRows } = await client.query(
      `SELECT date_trunc('week', $1::date)::date AS week_start`,
      [localDate]
    );
    const thisWeekStart = wkRows[0].week_start;

    let current, longest, lastActive, freezesUsed, freezeWeek, gained = false;

    if (!existing.length) {
      // First-ever tick for this user.
      current = 1; longest = 1; lastActive = localDate;
      freezesUsed = 0; freezeWeek = thisWeekStart; gained = true;
      await client.query(
        `INSERT INTO user_streaks
           (user_id, current_streak, longest_streak, last_active_date,
            freezes_used, freeze_week_start)
         VALUES ($1, $2, $3, $4::date, $5, $6::date)`,
        [userId, current, longest, lastActive, freezesUsed, freezeWeek]
      );
    } else {
      const r = existing[0];
      current     = r.current_streak;
      longest     = r.longest_streak;
      lastActive  = r.last_active_date;
      freezesUsed = r.freezes_used;
      freezeWeek  = r.freeze_week_start;

      // Reset the per-week freeze budget if we crossed an ISO week.
      // Done BEFORE the diff check so a freeze used in week N doesn't
      // count against week N+1.
      const sameWeek =
        freezeWeek &&
        new Date(freezeWeek).toISOString().slice(0, 10) ===
          new Date(thisWeekStart).toISOString().slice(0, 10);
      if (!sameWeek) {
        freezesUsed = 0;
        freezeWeek  = thisWeekStart;
      }

      // Compute day delta in the user's local DATE space.
      const { rows: dRows } = await client.query(
        `SELECT ($1::date - $2::date) AS diff`,
        [localDate, lastActive]
      );
      const daysDiff = parseInt(dRows[0].diff, 10);

      if (daysDiff <= 0) {
        // Already ticked today (or — defensively — clock skew put us
        // in the past). No change. Still write back to refresh
        // updated_at so the row's heartbeat advances.
        gained = false;
      } else if (daysDiff === 1) {
        current += 1; gained = true;
      } else if (daysDiff === 2 && freezesUsed < _STREAK_FREEZES_PER_WEEK) {
        // Single missed day, freeze available — keep the streak alive
        // and grow it (user IS active today).
        current += 1; freezesUsed += 1; gained = true;
      } else {
        // Streak broken — start over at 1 today.
        current = 1; gained = true;
      }
      longest = Math.max(longest, current);

      await client.query(
        `UPDATE user_streaks
            SET current_streak    = $1,
                longest_streak    = $2,
                last_active_date  = $3::date,
                freezes_used      = $4,
                freeze_week_start = $5::date,
                updated_at        = NOW()
          WHERE user_id = $6`,
        [current, longest, localDate, freezesUsed, freezeWeek, userId]
      );
      lastActive = localDate;
    }

    await client.query('COMMIT');
    res.json({
      current,
      longest,
      last_active_date: lastActive,
      freezes_used: freezesUsed,
      freezes_per_week: _STREAK_FREEZES_PER_WEEK,
      gained,
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('[streaks/tick]', err.message);
    res.status(500).json({ error: 'Failed to update streak' });
  } finally {
    if (client) client.release();
  }
});

app.get('/api/streaks/me', async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  try {
    const { rows } = await pool.query(
      `SELECT current_streak, longest_streak, last_active_date,
              freezes_used, freeze_week_start
         FROM user_streaks WHERE user_id = $1`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.json({
        current: 0, longest: 0,
        last_active_date: null,
        freezes_used: 0, freezes_per_week: _STREAK_FREEZES_PER_WEEK,
      });
    }
    const r = rows[0];
    res.json({
      current: r.current_streak,
      longest: r.longest_streak,
      last_active_date: r.last_active_date,
      freezes_used: r.freezes_used,
      freezes_per_week: _STREAK_FREEZES_PER_WEEK,
    });
  } catch (err) {
    console.error('[streaks/me]', err.message);
    res.status(500).json({ error: 'Failed to load streak' });
  }
});

app.get('/api/badges/me', async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  try {
    // Anyone with no last_seen for a surface gets a 7-day fallback so
    // first-time signed-in users see a SOFT badge ("hey, look here")
    // rather than a maxed-out one ("9999 new threads since 1970").
    const FALLBACK_AGE_MS = 7 * 24 * 3600 * 1000;
    const { rows: lastSeenRows } = await pool.query(
      `SELECT surface, last_seen_at FROM user_last_seen WHERE user_id = $1`,
      [req.user.id]
    );
    const seenMap = new Map(lastSeenRows.map(r => [r.surface, r.last_seen_at]));
    const fallback = new Date(Date.now() - FALLBACK_AGE_MS);
    const since = (s) => seenMap.get(s) || fallback;

    // Two cheap COUNT queries — both tables have an index on
    // last_updated_at via existing /latest endpoints' usage patterns.
    const [{ rows: t }, { rows: l }] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS n FROM story_threads
          WHERE last_updated_at > $1`,
        [since('threads')]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM story_timelines
          WHERE last_updated_at > $1`,
        [since('lines')]
      ),
    ]);

    res.json({
      threads: t[0]?.n || 0,
      lines:   l[0]?.n || 0,
    });
  } catch (err) {
    console.error('[badges/me]', err.message);
    res.status(500).json({ error: 'Failed to load badges' });
  }
});

app.post('/api/badges/seen', async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  const surface = String(req.body?.surface || '').trim();
  if (!_BADGE_SURFACES.has(surface)) {
    return res.status(400).json({ error: 'Invalid surface' });
  }
  try {
    await pool.query(
      `INSERT INTO user_last_seen (user_id, surface, last_seen_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, surface)
       DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [req.user.id, surface]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[badges/seen]', err.message);
    res.status(500).json({ error: 'Failed to update last-seen' });
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
    // Inner ORDER BY controls the DISTINCT-ON dedup (pick the most recent
    // row per article_id when multiple article_locations rows collide).
    // Outer ORDER BY controls the user-visible ordering. These used to be
    // combined in one clause which sorted the final result by a.id ASC
    // (oldest article ids first) — hence the "showing oldest articles"
    // bug report. Splitting them fixes that while preserving dedup.
    const tagInnerTie = tagId ? `at.score DESC` : `a.published_at DESC`;
    const tagOuter    = tagId ? `sub.score DESC NULLS LAST, sub.published_at DESC NULLS LAST`
                              : `sub.published_at DESC NULLS LAST`;

    const { rows } = await pool.query(`
      SELECT sub.*
      FROM (
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
          a.duration_seconds${tagId ? ",\n          at.score AS score" : ""}
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
        ORDER BY a.id, ${tagInnerTie}
      ) sub
      ORDER BY ${tagOuter}
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
    const countryId = parseInt(req.params.countryId);
    if (!Number.isFinite(countryId)) return res.status(400).json({ error: "Invalid countryId" });

    const limit  = parseOptionalPositiveInt(req.query.limit);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const tagId  = req.query.tag ? parseInt(req.query.tag) : null;
    const ambient = req.query.ambient === "1" || req.query.ambient === "true";

    // TTL cache so concurrent fan-out on the same feed (many clients hitting
    // the same Cloudflare origin on cache miss) collapses to one DB query.
    // Ambient feeds are a passive spotlight rotation — they don't need
    // to-the-second freshness, so we cache them for 5 min. Non-ambient
    // feeds stay on the 60s TTL that matches the Cloudflare s-maxage.
    // Ambient buckets were the dominant source of 3-second cold queries
    // in the logs; the longer TTL collapses repeat page-load fan-out.
    const cacheKey = `country-feed:v1:${countryId}:${limit || 'all'}:${offset}:${tagId || 'none'}:${ambient ? 'amb' : 'std'}`;
    const ttlMs = ambient ? 300_000 : 60_000;
    const ranked = await ttlCached(cacheKey, ttlMs, () =>
      getRankedArticles(countryId, { limit, offset, tagId, ambient })
    );
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
    // See the city/global handler for the DISTINCT-ON ordering note.
    const tagInnerTie = tagId ? `at.score DESC` : `a.published_at DESC`;
    const tagOuter    = tagId ? `sub.score DESC NULLS LAST, sub.published_at DESC NULLS LAST`
                              : `sub.published_at DESC NULLS LAST`;

    const { rows } = await pool.query(`
      SELECT sub.*
      FROM (
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
          a.duration_seconds${tagId ? ",\n          at.score AS score" : ""}
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
        ORDER BY a.id, ${tagInnerTie}
      ) sub
      ORDER BY ${tagOuter}
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
  // Pull a modest multiple of the limit so the per-source cap in
  // _finalizeSearchResults has real overflow to push past the top slice.
  // Without overflow room, concentrated country_boost² sends 6-8 articles
  // from the same 3 publishers into a 26-row pool, and the cap alone
  // can't help — there's nothing further down to replace them with.
  // 4× at default limit=24 → ~97 rows; still small enough that SQL stays
  // on the hot index path (LIMIT 100 against (published_at, country_id)).
  const POOL_MULTIPLIER = 4;
  const poolLimit = (effectiveLimit + 1) * POOL_MULTIPLIER;
  const params = [poolLimit, offset];

  // ── Tier 1: Full ranked query with 15s timeout ──
  // Structured as two CTE phases so the expensive image-join only
  // processes the ~100 ranked rows, not the full 72h candidate set:
  //
  //   Phase 1 (ranked): priority-order & LIMIT without image joins.
  //     Cheap — uses the base_priority + published_at indices.
  //   Phase 2 (select *): LATERAL image lookup per ranked row only.
  //     At most ~100 index lookups vs thousands before.
  //
  // Previous monolithic inner-SELECT forced the planner to LEFT JOIN
  // article_image_assignments (a multi-million-row table) for every
  // article in the 72h window BEFORE applying ORDER BY + LIMIT. Over a
  // remote connection that regularly hit the 15s statement_timeout and
  // fell through to Tier 2, destroying the country_boost weighting.
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 6000');
    const { rows } = await client.query(`
      WITH ranked AS (
        SELECT
          a.id, a.source_id, a.youtube_source_id,
          a.title, a.translated_title, a.url, a.article_url,
          a.summary, a.translated_summary,
          a.image_url,
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
          a.media_type, a.video_id, a.duration_seconds,
          -- VIDEO_BOOST (1.5×): videos are ~0.2% of ingest volume (99 /
          -- 43 500 in a typical 24 h window) but carry comparable
          -- base_priority to text articles. Without this multiplier the
          -- top-100 ranked pool contains zero videos on most days, so
          -- users effectively never see YouTube content in the feed.
          -- 1.5× puts a priority-0.7 video on par with a priority-1.05
          -- article — enough to surface a few per feed page without
          -- turning the main feed into a video stream. _finalizeSearch
          -- Results re-applies this same multiplier in the JS final_
          -- priority computation so the sort stays consistent.
          (
            (COALESCE(a.base_priority, 0) * 0.15 + GREATEST(
              POWER(0.5, EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 21600.0),
              0.02
            ) * 0.85)
            * POWER(COALESCE(cfb.boost_score, 1.0), 2.0)
            * CASE WHEN a.media_type = 'video' OR a.video_id IS NOT NULL THEN 2.5 ELSE 1.0 END
          ) AS _rank
        FROM news_articles a
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN languages l ON l.id = ns.language_id
        JOIN countries src_co ON src_co.id = a.country_id
        LEFT JOIN country_feed_boost cfb ON cfb.country_id = a.country_id
        WHERE a.city_id IS NULL
          AND a.published_at > NOW() - INTERVAL '72 hours'
          AND COALESCE(a.base_priority, 0) > 0.05
        ORDER BY _rank DESC
        LIMIT $1 OFFSET $2
      )
      SELECT r.*, ia.public_url AS catalog_image_url
      FROM ranked r
      LEFT JOIN LATERAL (
        SELECT img.public_url
        FROM article_image_assignments aia
        JOIN image_assets img ON img.id = aia.image_id
        WHERE aia.article_id = r.id
        LIMIT 1
      ) ia ON TRUE
      ORDER BY r._rank DESC
    `, params);
    return _finalizeSearchResults(rows, effectiveLimit, offset);
  } catch (err) {
    console.warn('[news/search] Tier 1 timed out (6s), falling back:', err.message);
  } finally {
    // Reset timeout to pool default before returning connection
    await client.query('SET statement_timeout = 45000').catch(() => {});
    client.release();
  }

  // ── Tier 2: Lightweight — no image joins, source join only, 3s timeout ──
  // IMPORTANT: orders by the same priority formula as Tier 1 (minus
  // country_boost, which requires the country_feed_boost join that's
  // absent here). Previously Tier 2 did `ORDER BY published_at DESC`,
  // which silently destroyed priority-ranking whenever Tier 1 timed out
  // — the user saw recency-sorted noise instead of the ranked feed.
  const client2 = await pool.connect();
  try {
    await client2.query('SET statement_timeout = 3000');
    const { rows } = await client2.query(`
      SELECT * FROM (
        SELECT
          a.id, a.source_id, a.youtube_source_id,
          a.title, a.translated_title, a.url, a.article_url,
          a.summary, a.translated_summary,
          a.image_url,
          NULL AS catalog_image_url,
          a.published_at, a.sentiment_score,
          NULL AS language, a.base_priority,
          COALESCE(ns.name, ys.name) AS source_name,
          NULL AS source_summary,
          COALESCE(ns.bias, 'unknown') AS source_bias,
          NULL AS site_url,
          src_co.iso_code, src_co.name AS country_name, src_co.flag AS country_flag,
          1.0 AS country_boost,
          GREATEST(
            POWER(0.5, EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 21600.0),
            0.02
          ) AS recency_decay,
          a.media_type, a.video_id, a.duration_seconds
        FROM news_articles a
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        JOIN countries src_co ON src_co.id = a.country_id
        WHERE a.city_id IS NULL
          AND a.published_at > NOW() - INTERVAL '48 hours'
          AND COALESCE(a.base_priority, 0) > 0.05
      ) sub
      -- Video boost (1.5×) applied to the sort expression — see Tier 1
      -- for the rationale. Falls through to a pure rank comparison
      -- without any inline CASE in the SELECT so the subquery's column
      -- list stays portable with Tier 1.
      ORDER BY (sub.base_priority * 0.15 + sub.recency_decay * 0.85)
             * CASE WHEN sub.media_type = 'video' OR sub.video_id IS NOT NULL THEN 2.5 ELSE 1.0 END DESC
      LIMIT $1 OFFSET $2
    `, params);
    return _finalizeSearchResults(rows, effectiveLimit, offset);
  } catch (err2) {
    console.warn('[news/search] Tier 2 timed out (3s), falling back to bare minimum:', err2.message);
  } finally {
    await client2.query('SET statement_timeout = 45000').catch(() => {});
    client2.release();
  }

  // ── Tier 3: Bare minimum — just articles + country, no joins, 10s cap ──
  // This is the floor: must always return *something* so the endpoint never
  // 500s in the common "cold Postgres + Tiers 1/2 timed out" case. Wrapped
  // in try/catch so even a pathological failure yields an empty articles
  // array rather than an exception that bubbles to a 500 response.
  const client3 = await pool.connect();
  try {
    await client3.query('SET statement_timeout = 10000');
    const { rows } = await client3.query(`
      SELECT * FROM (
        SELECT
          a.id, a.source_id, a.youtube_source_id,
          a.title, a.translated_title, a.url, a.article_url,
          a.summary, a.translated_summary, a.image_url,
          NULL AS catalog_image_url,
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
        WHERE a.city_id IS NULL
          AND a.published_at > NOW() - INTERVAL '24 hours'
          AND COALESCE(a.base_priority, 0) > 0.05
      ) sub
      -- Video boost (1.5×) — same rationale as Tier 1/Tier 2.
      ORDER BY (sub.base_priority * 0.15 + sub.recency_decay * 0.85)
             * CASE WHEN sub.media_type = 'video' OR sub.video_id IS NOT NULL THEN 2.5 ELSE 1.0 END DESC
      LIMIT $1 OFFSET $2
    `, params);
    return _finalizeSearchResults(rows, effectiveLimit, offset);
  } catch (err3) {
    console.warn('[news/search] Tier 3 floor failed (10s), returning empty:', err3.message);
    return { total: 0, articles: [] };
  } finally {
    await client3.query('SET statement_timeout = 45000').catch(() => {});
    client3.release();
  }
}

// Last-good cache for /api/news/search default-query path. Survives any
// transient empty-tier returns so a starved DB pool never causes the Feed
// to flash zero. Bounded to a handful of (limit, offset) keys so it can't
// grow unbounded.
const _newsSearchLastGood = new Map();
const NEWS_LASTGOOD_TTL   = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
  const cutoff = Date.now() - NEWS_LASTGOOD_TTL;
  for (const [k, v] of _newsSearchLastGood) if (v.ts < cutoff) _newsSearchLastGood.delete(k);
}, 5 * 60 * 1000).unref();

// ── User Preference Boost Engine ──────────────────────────────────────────
// Fetches preferences from Supabase and applies personalized ranking boosts.
// Operates post-cache so the underlying DB queries remain shared across users.

const _userPrefCache = new Map(); // userId → { prefs, ts }
const USER_PREF_TTL = 300_000;    // 5 min cache per user

async function _fetchUserPrefs(userId) {
  if (!userId) return null;
  const cached = _userPrefCache.get(userId);
  if (cached && Date.now() - cached.ts < USER_PREF_TTL) return cached.prefs;
  try {
    const { data, error } = await sba
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data || !data.onboarding_completed) {
      _userPrefCache.set(userId, { prefs: null, ts: Date.now() });
      return null;
    }
    _userPrefCache.set(userId, { prefs: data, ts: Date.now() });
    return data;
  } catch (e) {
    // Table may not exist yet — silent
    _userPrefCache.set(userId, { prefs: null, ts: Date.now() });
    return null;
  }
}

// Map user interest topics/sectors to primary_category values used in threads/timelines
const TOPIC_TO_CATEGORIES = {
  'climate':        ['environment', 'climate'],
  'environment':    ['environment', 'climate'],
  'conflict':       ['conflict', 'military'],
  'economy':        ['economy', 'finance', 'trade'],
  'politics':       ['politics', 'diplomacy', 'governance'],
  'diplomacy':      ['diplomacy', 'politics'],
  'technology':     ['technology', 'science'],
  'health':         ['health', 'pandemic'],
  'energy':         ['energy'],
  'finance':        ['finance', 'economy'],
  'human rights':   ['human_rights', 'society'],
  'migration':      ['migration', 'society'],
  'trade':          ['trade', 'economy'],
  'security':       ['security', 'military', 'conflict'],
  'military':       ['military', 'conflict', 'defense'],
  'science':        ['science', 'technology'],
  'culture':        ['culture', 'society'],
  'society':        ['society', 'culture'],
  'sports':         ['sports'],
  'education':      ['education'],
  'agriculture':    ['agriculture'],
  'manufacturing':  ['manufacturing', 'industry'],
  'defense':        ['military', 'defense'],
  'infrastructure': ['infrastructure'],
  'media':          ['media'],
  'real estate':    ['real_estate'],
  'tourism':        ['tourism'],
  'transportation': ['transportation'],
};

// Build a reusable boost config from raw preferences
function _buildPrefBoosts(prefs) {
  if (!prefs) return null;
  const homeIso = (prefs.home_country || '').toLowerCase();
  const regionIsos = new Set(
    (prefs.interest_regions || [])
      .filter(r => r.iso)
      .map(r => r.iso.toLowerCase())
  );
  const excludedIsos = new Set(
    (prefs.excluded_countries || [])
      .filter(r => r.iso)
      .map(r => r.iso.toLowerCase())
  );
  // Merge topics + sectors into a unified category set
  const prefCategories = new Set();
  for (const t of [...(prefs.interest_topics || []), ...(prefs.interest_sectors || [])]) {
    const mapped = TOPIC_TO_CATEGORIES[t.toLowerCase()] || [t.toLowerCase()];
    for (const c of mapped) prefCategories.add(c);
  }
  const prefLangs = new Set(
    (prefs.languages || []).map(l => l.toLowerCase().slice(0, 2))
  );
  // diversity: 0 = centrist focus, 100 = full spectrum (left+right boosted)
  return { homeIso, regionIsos, excludedIsos, prefCategories, prefLangs, diversity: prefs.diversity_pref ?? 100 };
}

// Apply preference boosts to news articles (modifies final_priority in-place)
// Also filters out excluded countries and applies diversity/bias weighting.
function _applyNewsPrefBoosts(articles, boosts) {
  if (!boosts) return articles;

  // Filter out excluded countries first
  if (boosts.excludedIsos.size) {
    articles = articles.filter(r => !boosts.excludedIsos.has((r.iso_code || '').toLowerCase()));
  }

  // Diversity/bias: 100 = full spectrum (boost left+right), 0 = centrist focus (boost center)
  // source_bias values: 'left', 'left-center', 'center', 'right-center', 'right', 'unknown'
  const divNorm = boosts.diversity / 100;  // 0..1

  for (const r of articles) {
    let mult = 1.0;
    const iso = (r.iso_code || '').toLowerCase();
    // Home country: strong boost
    if (boosts.homeIso && iso === boosts.homeIso) mult *= 1.4;
    // Interest regions
    else if (boosts.regionIsos.size && boosts.regionIsos.has(iso)) mult *= 1.25;
    // Language preference
    const lang = (r.language || '').toLowerCase().slice(0, 2);
    if (boosts.prefLangs.size && lang && boosts.prefLangs.has(lang)) mult *= 1.15;
    // Bias-aware diversity boost
    const bias = (r.source_bias || 'unknown').toLowerCase();
    if (bias !== 'unknown') {
      const isEdge = bias === 'left' || bias === 'right';
      const isCenter = bias === 'center' || bias === 'left-center' || bias === 'right-center';
      if (divNorm >= 0.6 && isEdge) {
        // High diversity: boost left/right sources
        mult *= 1.0 + (divNorm - 0.5) * 0.6; // up to 1.3x at 100
      } else if (divNorm <= 0.4 && isCenter) {
        // Low diversity (centrist focus): boost center sources
        mult *= 1.0 + (0.5 - divNorm) * 0.6; // up to 1.3x at 0
      } else if (divNorm <= 0.4 && isEdge) {
        // Low diversity: demote edge sources
        mult *= 0.7 + divNorm * 0.75; // 0.7 at 0, ~1.0 at 0.4
      }
    }
    if (mult !== 1.0) r.final_priority = (r.final_priority || 0) * mult;
  }
  return articles;
}

// Apply preference boosts to threads/timelines (returns modified array)
function _applyThreadPrefBoosts(items, boosts) {
  if (!boosts) return items;

  // Filter out threads/timelines whose ONLY nations are excluded
  if (boosts.excludedIsos.size) {
    items = items.filter(t => {
      const nations = (t.primary_nations || []).map(n => n.toLowerCase());
      if (!nations.length) return true; // no nation info → keep
      return !nations.every(n => boosts.excludedIsos.has(n));
    });
  }

  for (const t of items) {
    let mult = 1.0;
    const nations = (t.primary_nations || []).map(n => n.toLowerCase());
    const cat = (t.primary_category || '').toLowerCase();
    // Home country in primary_nations
    if (boosts.homeIso && nations.includes(boosts.homeIso)) mult *= 1.4;
    // Interest regions overlap
    else if (boosts.regionIsos.size && nations.some(n => boosts.regionIsos.has(n))) mult *= 1.25;
    // Topic/sector category match
    if (boosts.prefCategories.size && boosts.prefCategories.has(cat)) mult *= 1.2;
    t._prefMult = mult;
  }
  // Re-sort within status groups using boosted importance
  items.sort((a, b) => {
    const sa = a.status === 'active' ? 0 : a.status === 'cooling' ? 1 : 2;
    const sb = b.status === 'active' ? 0 : b.status === 'cooling' ? 1 : 2;
    if (sa !== sb) return sa - sb;
    return ((b.importance || 0) * (b._prefMult || 1)) - ((a.importance || 0) * (a._prefMult || 1));
  });
  items.forEach(t => { delete t._prefMult; });
  return items;
}

// Re-sort articles by boosted final_priority, then re-apply the same
// iterative per-source cap that _finalizeSearchResults uses. Previous
// implementation called `diversityRerank` with COOLDOWN_SLOTS=5, which
// on a 25-article page dominated by ~5 pref-boosted publishers (home
// country + region) produced a rigid 5-way rotation: slot 1 UNIMEDIA,
// 2 NATIONEN, 3 AL KHALEEJ, 4 DIARIO, 5 LA CROIX, 6 UNIMEDIA, … exactly
// the pattern the user was seeing on the Feed tab when signed in.
//
// The new behavior preserves the intent of the pref system (home/region
// articles surface first) without the forced rotation artifact.
function _prefResort(articles) {
  if (articles.length < 2) return;
  // Sort strictly by boosted final_priority
  articles.sort((a, b) => (b.final_priority || 0) - (a.final_priority || 0));
  // Apply iterative cap (starts at 2/source, relaxes if pool lacks
  // diversity) — matches the cap in _finalizeSearchResults so the
  // personalized slice never shows more than 2 articles per publisher
  // unless variety is genuinely limited.
  const keyOf = (r) => r.source_id
    ? `s:${r.source_id}`
    : r.youtube_source_id
      ? `y:${r.youtube_source_id}`
      : `n:${r.source_name || "unknown"}`;
  const targetSize = articles.length;
  let capped = articles;
  for (let cap = 2; cap <= 10; cap += 1) {
    const counts = new Map();
    const picked = [];
    for (const r of articles) {
      const k = keyOf(r);
      const n = counts.get(k) || 0;
      if (n < cap) {
        picked.push(r);
        counts.set(k, n + 1);
      }
      if (picked.length >= targetSize) break;
    }
    if (picked.length >= targetSize) {
      capped = picked;
      break;
    }
  }
  articles.splice(0, articles.length, ...capped);
}

// Kept in sync with the SQL video_boost in _executeNewsSearch so the JS
// final_priority matches the server-side _rank ordering. Changing one
// without the other will produce subtle ranking drift.
//
// Chosen empirically: the pool contains ~99 videos vs ~43 000 text
// articles per 24 h window. At 1.5× zero videos surfaced in the top
// 100; at 2.0× one did; at 2.5× ~12 did. 2.5× puts a priority-0.7
// video at an effective rank comparable to a priority-1.05 text
// article, which lands 2–3 videos per 24-slot feed page. If this ever
// needs to go higher we're over-boosting — tune the feed UX instead
// (dedicated video tab, etc).
const VIDEO_BOOST = 2.5;
const isVideoRow = (r) =>
  r && (r.media_type === 'video' || (r.video_id != null && r.video_id !== ''));

function _finalizeSearchResults(rows, effectiveLimit, offset) {
  // Compute final_priority with country_boost² + video_boost on top of
  // the SQL priority (which already includes both in the ORDER BY). The
  // JS re-apply is needed because the SQL ordering is LIMIT-truncated
  // before this point; we need final_priority present on each row for
  // the cap's tie-break sort below.
  let scored = rows.map(r => ({
    ...r,
    final_priority: (
      (r.base_priority || 0) * 0.15 + (r.recency_decay || 0) * 0.85
    ) * Math.pow(r.country_boost || 1, 2.0) * (isVideoRow(r) ? VIDEO_BOOST : 1.0)
  }));

  // SQL already ordered by the same formula, but defense-in-depth in
  // case the tier-2/tier-3 fallbacks (ORDER BY published_at DESC) ran
  // instead — sort the JS-side score so the cap always operates on a
  // priority-ordered list.
  scored.sort((a, b) => (b.final_priority || 0) - (a.final_priority || 0));

  // Per-source AND per-country cap with graceful relaxation.
  //
  // History: the per-source cap alone (max 2 articles per publisher)
  // gave good dispersion in the FIRST page (offset=0), but pages 2+
  // (offset≥25) were dominated by a single high-boost country —
  // typically Russia trending across 10-15 publishers. The cap-2-per-
  // source let through 20-30 Russian articles in a 100-row pool, all
  // higher priority than the trickle of non-RU articles ranked below
  // them, so the page sliced at top-25 and returned an all-RU page.
  //
  // The fix adds a per-COUNTRY cap proportional to the slice size
  // (~32% — strong but not monoculture). Cap 8 in a 25-slot page
  // means at most 8 Russian articles per page; the remaining 17 slots
  // come from other countries even if those articles rank lower in
  // raw priority. Source cap stays at 2 inside that.
  //
  // Why iterate-and-relax: keeps the slice in strict priority order
  // (no ugly "tail" of demoted articles tacked onto the end) while
  // adapting to genuinely thin pools. Both caps relax together if the
  // pool can't fill the slice.
  const sourceKeyOf = (r) => r.source_id
    ? `s:${r.source_id}`
    : r.youtube_source_id
      ? `y:${r.youtube_source_id}`
      : `n:${r.source_name || "unknown"}`;
  const countryKeyOf = (r) => (r.iso_code || 'unknown').toLowerCase();

  // ~32% — visible trend without monoculture. floor at 4 so smaller
  // page sizes (e.g. 12) still allow some country presence.
  const COUNTRY_CAP_BASE = Math.max(4, Math.ceil(effectiveLimit * 0.32));

  const MAX_CAP = 10; // hard ceiling on the per-source relax
  const MAX_COUNTRY_CAP = effectiveLimit; // ultimate fallback = no country cap
  let chosen = [];
  // Two-axis relax: try strict (source=2, country=base), then walk both
  // up together. Stops at the first combination that fills the slice.
  let filled = false;
  for (let cap = 2; cap <= MAX_CAP && !filled; cap += 1) {
    for (let countryCap = COUNTRY_CAP_BASE; countryCap <= MAX_COUNTRY_CAP && !filled; countryCap += 2) {
      const sourceCounts = new Map();
      const countryCounts = new Map();
      chosen = [];
      for (const r of scored) {
        const sk = sourceKeyOf(r);
        const ck = countryKeyOf(r);
        const sc = sourceCounts.get(sk) || 0;
        const cc = countryCounts.get(ck) || 0;
        if (sc < cap && cc < countryCap) {
          chosen.push(r);
          sourceCounts.set(sk, sc + 1);
          countryCounts.set(ck, cc + 1);
          if (chosen.length >= effectiveLimit) break;
        }
      }
      if (chosen.length >= effectiveLimit) filled = true;
    }
  }

  // Guaranteed video slot(s).
  //
  // Video base_priority is comparable to text articles (~0.72 avg), but
  // videos are ~0.2% of ingest volume (99 videos vs 43 500 articles /
  // 24h typical). Even with the 1.5× boost applied in the SQL _rank
  // and the JS final_priority above, on a busy text-heavy day videos
  // can still lose the cap race to higher-volume text publishers. This
  // safety net ensures at least MIN_VIDEOS_IN_FEED videos land in the
  // returned slice whenever the candidate pool contained any videos —
  // by swapping the lowest-ranked text article in the chosen slice for
  // the highest-ranked video still in the pool but not chosen.
  //
  // Kept cheap: never promotes more videos than the pool holds, never
  // drops a video below its natural position if it's already chosen.
  const MIN_VIDEOS_IN_FEED = 2;
  const poolVideos   = scored.filter(isVideoRow);
  const chosenVideos = chosen.filter(isVideoRow);
  const deficit      = Math.min(MIN_VIDEOS_IN_FEED, poolVideos.length) - chosenVideos.length;
  if (deficit > 0) {
    const chosenSet      = new Set(chosen.map(r => r.id));
    const promotableVids = poolVideos
      .filter(v => !chosenSet.has(v.id))
      .sort((a, b) => (b.final_priority || 0) - (a.final_priority || 0))
      .slice(0, deficit);
    // Sort chosen by priority ascending so we replace the weakest slots.
    // Only replace TEXT articles — never swap a video out for another
    // video, and never bump a top-ranked text article beyond slot 0.
    const replaceableIdx = chosen
      .map((r, i) => ({ i, r }))
      .filter(({ r }) => !isVideoRow(r))
      .sort((a, b) => (a.r.final_priority || 0) - (b.r.final_priority || 0))
      .slice(0, promotableVids.length)
      .map(x => x.i);
    for (let i = 0; i < promotableVids.length; i++) {
      const slot = replaceableIdx[i];
      if (slot == null) break;
      chosen[slot] = promotableVids[i];
    }
    // Re-sort chosen by final_priority DESC so the promoted videos land
    // where their scores deserve, not at the slot we swapped into.
    chosen.sort((a, b) => (b.final_priority || 0) - (a.final_priority || 0));
  }

  // Country-spread interleave — even with a country cap of 8 in a 25-slot
  // page, a strict priority sort can still produce "8 Russia in a row,
  // then 17 others" because the high-boost country naturally ranks first
  // throughout the cap-filtered pool. Reorder so no more than 2
  // consecutive articles share a country, while staying as close to
  // priority order as possible.
  //
  // Algorithm: greedy. Walk the priority-ordered list; for each slot,
  // pick the highest-priority remaining article that doesn't violate the
  // "no 3-in-a-row same country" rule. If no such article exists (the
  // pool is genuinely country-thin at this point), take the next anyway
  // — better to render than to deadlock.
  //
  // Cost: O(n²) worst case on n=25, ~625 ops. Sub-millisecond. No async,
  // no shared state — purely a reorder of the chosen array.
  if (chosen.length > 3) {
    const remaining = chosen.slice();
    const reordered = [];
    while (remaining.length) {
      let pickIdx = 0;
      for (let i = 0; i < remaining.length; i++) {
        const ck = countryKeyOf(remaining[i]);
        const last = reordered.length;
        const wouldBeThirdInARow = last >= 2
          && countryKeyOf(reordered[last - 1]) === ck
          && countryKeyOf(reordered[last - 2]) === ck;
        if (!wouldBeThirdInARow) { pickIdx = i; break; }
        // else keep scanning; pickIdx stays 0 as the fallback
      }
      reordered.push(remaining[pickIdx]);
      remaining.splice(pickIdx, 1);
    }
    chosen = reordered;
  }

  // Fallback — if even MAX_CAP relax doesn't reach effectiveLimit, pool
  // is genuinely thin. Return what we have rather than padding.
  const articles = chosen.slice(0, effectiveLimit);
  const hasMore = scored.length > articles.length;

  return { total: offset + articles.length + (hasMore ? 1 : 0), articles };
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

    // ── Fast path: default query (no filters) → serve from TTL cache ──
    // Ranking contract:
    //   SQL ORDER BY (base*0.15 + recency*0.85) * country_boost²  (pool of ~100)
    //   ↓
    //   JS final_priority = same formula (no language boost — removed)
    //   ↓
    //   Per-source cap with graceful relaxation (starts at 2, bumps as
    //   needed) → replaces diversityRerank + countryVarianceRerank
    //   ↓
    //   take top effectiveLimit, strict priority order preserved
    //
    // Cache key is per (limit, offset). 60s TTL mirrors the Cloudflare edge
    // cache. Version bumped to v5 for the cap-relaxation + language-boost
    // removal; forces fresh results for all clients.
    const isDefaultQuery = !fromIds && !aboutIds && !keyword && !fromDate && !toDate && !req.query.tag;
    const effectiveLimit = limit || 24;
    if (isDefaultQuery) {
      const cacheKey = `news/search:default:v9:${effectiveLimit}:${offset}`;
      let cached = await ttlCached(cacheKey, 60_000, async () => {
        return await _executeNewsSearch({ effectiveLimit, offset });
      });
      // ── Last-good fallback ──────────────────────────────────────────
      // When all three tiers time out (DB pool starved or under heavy
      // contention), _executeNewsSearch returns {total:0, articles:[]}
      // and ttlCached caches that empty value for the next 60s — which
      // is exactly the "feed shows 0 articles for a minute" bug. Track
      // the last non-empty response per cache key and serve it instead
      // when the live path empties out, so the Feed never flashes to
      // zero just because the database hiccupped.
      if (cached && Array.isArray(cached.articles) && cached.articles.length > 0) {
        _newsSearchLastGood.set(cacheKey, { data: cached, ts: Date.now() });
      } else {
        const lg = _newsSearchLastGood.get(cacheKey);
        if (lg && (Date.now() - lg.ts) < NEWS_LASTGOOD_TTL) {
          console.warn(`[news/search] live empty, serving last-good age=${Math.round((Date.now() - lg.ts) / 1000)}s`);
          cached = lg.data;
        }
      }

      // Per-user preference pass re-orders the cached slice for logged-in
      // callers. Only the current slice (not a full 500-row pool) is
      // re-sorted — pref boosts are multiplicative on final_priority so
      // an article already near the top still wins after the pass.
      const prefs = req.user?.id ? await _fetchUserPrefs(req.user.id) : null;
      if (prefs) {
        const boosts = _buildPrefBoosts(prefs);
        const personalized = {
          ...cached,
          articles: _applyNewsPrefBoosts(cached.articles.map(a => ({ ...a })), boosts)
        };
        _prefResort(personalized.articles);
        res.set("Cache-Control", "private, max-age=30");
        return res.json(personalized);
      }

      // Shared default → safe for Cloudflare edge cache. s-maxage=90 gives
      // the edge a slightly longer hot window than the in-process 60s TTL
      // so most users hit the CDN, not our origin. stale-while-revalidate
      // smooths expiry; stale-if-error covers cold-DB / transient 5xx by
      // letting CF serve the last good response for up to an hour if origin
      // returns an error.
      res.set("Cache-Control", "public, max-age=30, s-maxage=90, stale-while-revalidate=300, stale-if-error=3600");
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
      // The OLD version did `COALESCE(title) ILIKE '%kw%' OR COALESCE(summary)
      // ILIKE '%kw%' OR EXISTS(... WHERE ak.article_id = a.id AND ak.keyword
      // ILIKE '%kw%' OR ak.normalized_keyword = ?)`. Three problems made it
      // hang past Render's 45s gateway:
      //   1. Leading-wildcard ILIKE on title/summary forces seqscan over
      //      the whole 7-day pool (~150K rows) — no index is usable.
      //   2. EXISTS was correlated to the outer row (`= a.id`), firing the
      //      subquery once per candidate.
      //   3. ak.keyword ILIKE '%kw%' inside the EXISTS adds another non-
      //      indexable scan against article_keywords (~tens of millions of
      //      rows).
      // Same fix the flows endpoint already uses (see line ~2700): drop the
      // title/summary text scan entirely (article_keywords IS the curated
      // index for this lookup) and convert EXISTS into an UNCORRELATED
      // IN (subquery) so the keyword set is computed once. Hits both
      // idx_ak_normalized (exact) and idx_ak_keyword_gin (prefix via
      // tsquery 'kw:*'). Fast-keyword case (single-word "trump") drops from
      // 45s+timeout → ~1–2s.
      const kwLc = keyword.toLowerCase().trim();
      params.push(kwLc);
      const exactKwParam = params.length;
      params.push(kwLc + ':*');
      const tsKwParam = params.length;
      conditions.push(`a.id IN (
        SELECT ak.article_id FROM article_keywords ak
        WHERE ak.normalized_keyword = $${exactKwParam}
           OR to_tsvector('simple', ak.keyword) @@ to_tsquery('simple', $${tsKwParam})
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

    // ── Four-phase query ──────────────────────────────────────────────
    // Phase 1 (candidates CTE): narrow to a bounded POOL via the
    //   idx_news_articles_nocity_published (published_at DESC) WHERE city_id IS NULL
    //   index. This is an index range scan — on 307k rows across 3 days the
    //   range scan returns under 100ms. POOL_SIZE is intentionally wide so
    //   that even with tier 1 (wire-service) volume dominating the raw feed,
    //   enough tier 3 / tier 4 articles fall inside the pool for the
    //   per-tier caps below to have meaningful candidates to keep.
    //
    // Phase 2 (capped CTE): apply per-tier caps to cut wire-service noise.
    //   Tier 1 (wires) → keep 5 most-recent.
    //   Tier 2          → keep 10.
    //   Tier 3          → keep 15.
    //   Tier 4 (quality)→ keep all.
    //   ROW_NUMBER() OVER (PARTITION BY fetch_tier ORDER BY published_at DESC)
    //   labels each article's per-tier rank within the pool; the WHERE keeps
    //   only rows under the cap. Done in SQL (vs. bouncing ids through JS)
    //   because it's one CTE and stays inside a single round-trip.
    //
    // Phase 3 (ranked CTE): compute the priority expression over the capped
    //   pool and ORDER BY it. Sort cost is O(capped rows), typically <500.
    //
    // Phase 4 (outer SELECT): apply LIMIT/OFFSET, then hydrate the expensive
    //   joins (news_sources, article_image_assignments, languages, country
    //   boost, location-about) on ONLY the top-N ranked rows. Prior query
    //   ran all joins on every matching row BEFORE sorting — the reason it
    //   blew past 12s on a 176k-row candidate set.
    //
    // Per-source cap on the candidate pool. A single outlet (wire services,
    // big aggregators) can spray dozens of articles per hour and otherwise
    // dominate the most-recent-N pool. ROW_NUMBER() over the pool keyed by
    // source blocks any one source from taking more than MAX_PER_SOURCE
    // slots, letting quieter quality sources reach the ranker. The window
    // function runs on the already-bounded POOL_SIZE rows (sub-ms) so this
    // is effectively free query-wise.
    const POOL_SIZE = 6000;
    const MAX_PER_SOURCE = 20;
    const poolParam = params.length + 1;
    params.push(POOL_SIZE);

    const filteredQuery = `
      WITH candidates AS (
        SELECT ${needsLocJoin ? "DISTINCT ON (a.id)" : ""} a.id, a.published_at,
          COALESCE(a.source_id::text, 'yt:' || a.youtube_source_id::text) AS source_key
        FROM news_articles a
        ${needsLocJoin ? "JOIN article_locations al ON al.article_id = a.id" : ""}
        ${whereClause}
        ORDER BY ${needsLocJoin ? "a.id, " : ""}a.published_at DESC
        LIMIT $${poolParam}
      ),
      source_ranked AS (
        SELECT id, published_at,
          ROW_NUMBER() OVER (
            PARTITION BY source_key
            ORDER BY published_at DESC
          ) AS source_rank
        FROM candidates
      ),
      capped AS (
        SELECT id, published_at
        FROM source_ranked
        WHERE source_rank <= ${MAX_PER_SOURCE}
      ),
      ranked AS (
        SELECT
          a.id,
          a.source_id,
          a.youtube_source_id,
          a.title,
          a.translated_title,
          a.url,
          a.article_url,
          a.summary,
          a.translated_summary,
          a.image_url AS raw_image_url,
          a.published_at,
          a.sentiment_score,
          a.base_priority,
          a.media_type,
          a.video_id,
          a.duration_seconds,
          a.country_id,
          COALESCE(cfb.boost_score, 1.0) AS country_boost,
          GREATEST(
            POWER(0.5, EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 21600.0),
            0.02
          ) AS recency_decay
        FROM capped c
        JOIN news_articles a ON a.id = c.id
        LEFT JOIN country_feed_boost cfb ON cfb.country_id = a.country_id
        ORDER BY (
          (COALESCE(a.base_priority, 0) * 0.15
            + GREATEST(
                POWER(0.5, EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 21600.0),
                0.02
              ) * 0.85)
          * POWER(COALESCE(cfb.boost_score, 1.0), 2.0)
        ) DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      )
      SELECT
        r.id, r.source_id, r.youtube_source_id,
        r.title, r.translated_title, r.url, r.article_url,
        r.summary, r.translated_summary,
        COALESCE(r.raw_image_url, img_a.public_url) AS image_url,
        img_a.public_url AS catalog_image_url,
        r.published_at, r.sentiment_score,
        l.iso_code_2 AS language,
        r.base_priority,
        COALESCE(ns.name, ys.name) AS source_name,
        ns.source_summary,
        COALESCE(ns.bias, 'unknown') AS source_bias,
        COALESCE(ns.site_url, ys.site_url) AS site_url,
        src_co.iso_code,
        src_co.name        AS country_name,
        src_co.flag        AS country_flag,
        r.country_boost,
        r.recency_decay,
        r.media_type, r.video_id, r.duration_seconds
      FROM ranked r
      LEFT JOIN news_sources ns ON ns.id = r.source_id
      LEFT JOIN youtube_sources ys ON ys.id = r.youtube_source_id
      LEFT JOIN languages l ON l.id = ns.language_id
      JOIN countries src_co ON src_co.id = r.country_id
      LEFT JOIN LATERAL (
        SELECT img.public_url
        FROM article_image_assignments aia
        JOIN image_assets img ON img.id = aia.image_id
        WHERE aia.article_id = r.id
        ORDER BY COALESCE(aia.refreshed_at, aia.assigned_at) DESC NULLS LAST
        LIMIT 1
      ) img_a ON TRUE
      ORDER BY (
        (COALESCE(r.base_priority, 0) * 0.15 + r.recency_decay * 0.85)
        * POWER(COALESCE(r.country_boost, 1.0), 2.0)
      ) DESC
    `;

    // Wrap SQL + base-rerank in the in-process TTL cache. Concurrent requests
    // for the same filter collapse into one DB query; stale-while-revalidate
    // serves the previous result instantly while a background refresh runs.
    // Cache key covers every filter that influences the result — if two
    // callers pass the same filter combo, the pipeline runs once.
    //
    // User-preference boosts are NOT cached here: they're per-user and
    // lightweight, so we re-apply them to a shallow copy after the cache hit.
    const tagQ = req.query.tag ? String(req.query.tag) : '';
    const fromKey  = fromIds  ? fromIds.slice().sort((a,b)=>a-b).join(',') : '';
    const aboutKey = aboutIds ? aboutIds.slice().sort((a,b)=>a-b).join(',') : '';
    const filterCacheKey =
      `news/search:filtered:v2:${effectiveLimit}:${offset}` +
      `:from=${fromKey}:about=${aboutKey}:kw=${keyword || ''}` +
      `:fd=${fromDate || ''}:td=${toDate || ''}:tag=${tagQ}`;

    const cachedSlice = await ttlCached(filterCacheKey, 60_000, async () => {
      // Cap at 10s. Without it, runaway keyword scans (the bug behind the
      // 45s "Failed to fetch" the user reported) ran until Render's gateway
      // dropped the connection, returning no response at all. With SET LOCAL
      // statement_timeout, Postgres aborts at 10s, the catch fires, and we
      // return a clean degraded response the frontend can surface as an
      // error message instead of an indefinite spinner. BEGIN/COMMIT
      // wrapper because SET LOCAL outside a transaction is a silent no-op.
      const client = await pool.connect();
      let rows;
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 10000');
        const result = await client.query(filteredQuery, params);
        await client.query('COMMIT');
        rows = result.rows;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.warn('[news/search] Filtered query failed:', err.message);
        rows = [];
      } finally {
        client.release();
      }

      const hasMore = rows.length > effectiveLimit;
      if (hasMore) rows.pop();

      let baseResults = rows.map(r => ({
        ...r,
        final_priority: (
          (r.base_priority || 0) * 0.15 + (r.recency_decay || 0) * 0.85
        ) * (r.country_boost || 1)
      }));

      // Light reranking only when we have enough rows to benefit.
      // Two passes: publisher variance then country variance (terminal).
      if (baseResults.length >= 8) {
        baseResults = diversityRerank(baseResults.map(r => ({ ...r, priority: r.final_priority })));
        baseResults = countryVarianceRerank(baseResults);
      }

      return { results: baseResults, hasMore };
    });

    const hasMore = cachedSlice.hasMore;
    // Shallow-copy so per-user preference boosts don't mutate the cached array
    let results = cachedSlice.results.map(r => ({ ...r }));

    // Apply user preference boosts (per-user, not cached)
    const _fPrefs = req.user?.id ? await _fetchUserPrefs(req.user.id) : null;
    if (_fPrefs) {
      results = _applyNewsPrefBoosts(results, _buildPrefBoosts(_fPrefs));
    }

    // Re-rank by boosted final_priority while preserving publisher variance.
    _prefResort(results);

    // Filtered queries vary by query-string; Cloudflare will hash by URL so
    // each distinct filter gets its own edge entry. Short s-maxage since
    // filter-space is huge and we don't want stale personalized results.
    // stale-if-error lets the edge ride out a cold-DB blip for up to 1h.
    if (!req.user?.id) {
      res.set("Cache-Control", "public, max-age=15, s-maxage=45, stale-while-revalidate=180, stale-if-error=3600");
    } else {
      res.set("Cache-Control", "private, max-age=15");
    }
    res.json({ total: offset + results.length + (hasMore ? 1 : 0), articles: results });

  } catch (err) {
    // Never 500 on search — the feed failing visibly is worse than showing
    // an empty state the retry button can refresh. Cloudflare must NOT cache
    // this fallback, or a transient DB blip would pin the edge to empty.
    console.error("Search error:", err.message);
    res.set("Cache-Control", "no-store");
    res.status(200).json({ total: 0, articles: [], degraded: true });
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

/* =========================================
   Keyword Suggestions (autocomplete)
   Draws from: keyword_daily_stats (extracted keywords),
               countries, cities — unified & deduped.
========================================= */
app.get("/api/keyword-suggestions", searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 15, 30);
    if (q.length < 1) return res.json([]);

    // Optional `types` filter: comma-separated list from
    //   { keyword, country, city }
    // When present, restricts results to those types. Used by the News
    // Flows keyword input (which wants ONLY keywords — countries belong
    // in the From/About fields) and the heatmap keyword tab. Default
    // behavior (no `types` param) is unchanged: returns all three
    // sources merged, for legacy callers.
    const typesRaw = String(req.query.types || '').trim().toLowerCase();
    const allowed = typesRaw
      ? new Set(typesRaw.split(',').map(s => s.trim()).filter(Boolean))
      : null; // null = "no filter, return everything"
    const wantKeyword = !allowed || allowed.has('keyword');
    const wantCountry = !allowed || allowed.has('country');
    const wantCity    = !allowed || allowed.has('city');

    // Range bounds for prefix lookup. Keywords are already stored lowercase
    // (see keywordExtractor.js:80), so we don't need LOWER() — and dropping it
    // is what lets the existing btree indexes on `keyword` actually serve this
    // query. Prefix LIKE on default-collation text does NOT use a btree index,
    // but a range comparison `keyword >= lo AND keyword < hi` does.
    const qHi = q + '\uFFFF'; // last BMP code unit; sorts after any practical keyword
    // Cache key includes the types filter so distinct callers don't
    // accidentally serve each other's narrower / wider result sets.
    const cacheKey = `kw-suggest:${q}:${limit}:${typesRaw || 'all'}`;
    const results = await ttlCached(cacheKey, 120_000, async () => {
      // Three sources, run in parallel. Each is gated on the caller's
      // `types` filter so we don't burn a query for a result the caller
      // told us to drop. `noop` returns an empty rows shape so the
      // merge step downstream can stay one-shape.
      const noop = Promise.resolve({ rows: [] });
      const [kwRows, countryRows, cityRows] = await Promise.all([
        wantKeyword ? pool.query(`
          SELECT keyword AS name, SUM(total_count)::bigint AS weight, 'keyword' AS type
          FROM keyword_daily_stats
          WHERE date >= CURRENT_DATE - INTERVAL '30 days'
            AND source_country_id IS NULL AND about_country_id IS NULL
            AND keyword >= $1 AND keyword < $2
            AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = keyword)
          GROUP BY keyword
          ORDER BY weight DESC
          LIMIT $3
        `, [q, qHi, limit]).catch(e => { console.error("kw-suggest keyword query err:", e.message, e.stack); return { rows: [] }; }) : noop,
        wantCountry ? pool.query(`
          SELECT name, population::int AS weight, 'country' AS type
          FROM countries WHERE LOWER(name) LIKE $1 || '%'
          ORDER BY population DESC LIMIT $2
        `, [q, limit]).catch(e => { console.error("kw-suggest country query err:", e.message); return { rows: [] }; }) : noop,
        wantCity ? pool.query(`
          SELECT name, COALESCE(population,0)::int AS weight, 'city' AS type
          FROM cities WHERE is_active = true AND LOWER(name) LIKE $1 || '%'
          ORDER BY population DESC NULLS LAST LIMIT $2
        `, [q, limit]).catch(e => { console.error("kw-suggest city query err:", e.message); return { rows: [] }; }) : noop,
      ]);

      // Merge, dedup by lowercase name, sort by weight desc.
      // pg returns bigint as a string; coerce so the numeric sort works.
      const seen = new Set();
      const merged = [];
      for (const row of [...kwRows.rows, ...countryRows.rows, ...cityRows.rows]) {
        const key = row.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ name: row.name, type: row.type, weight: Number(row.weight) || 0 });
      }
      merged.sort((a, b) => b.weight - a.weight);
      return merged.slice(0, limit);
    });

    res.json(results);
  } catch (err) {
    console.error("Keyword suggestions error:", err);
    res.status(500).json({ error: "Failed to fetch suggestions" });
  }
});

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
    // 600s (10 min) instead of 180s. News-flow aggregations don't need
    // sub-3-min freshness for the user-facing globe; the cron-driven
    // article ingestion runs slower than that anyway, and hot keywords
    // (trump, ukraine, etc.) are the bulk of traffic — keeping them
    // warmer cuts cold-miss frequency dramatically.
    const _flowCacheKey = `flows:${mode}:${viewMode}:${limit}:${fromDate||''}:${toDate||''}:${fromCountry||''}:${fromCity||''}:${aboutCountry||''}:${aboutCity||''}:${keyword||''}:${normalize}`;
    const _flowResult = await ttlCached(_flowCacheKey, 600_000, async () => {

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

    // Keyword filter.
    //
    // The previous version used `EXISTS (... WHERE ak.article_id = a.id
    // AND ak.keyword ILIKE 'trump%')`. Two problems:
    //
    //   1. EXISTS was correlated to the outer row (`= a.id`), so the
    //      subquery fired once per candidate flow row. With a top-2
    //      keyword like "trump" matching ~150K articles, this blew the
    //      6s statement_timeout (set on line ~2517 below) and the route
    //      returned `{error:"Failed to fetch flows"}`. User reported
    //      "no response" — that was the timeout, not an empty result.
    //   2. `ILIKE 'trump%'` cannot use the `idx_ak_keyword` btree (default
    //      collation) so it sequentially scanned article_keywords (~M rows)
    //      every time the EXISTS fired.
    //
    // Fix: rewrite as an UNCORRELATED `IN (subquery)`. Postgres materializes
    // the article_id set once via hash semi-join. The subquery itself uses:
    //   - idx_ak_normalized btree for the exact `normalized_keyword = $`
    //   - idx_ak_keyword_gin (gin tsvector) for prefix match via
    //     `to_tsvector('simple', ak.keyword) @@ to_tsquery('simple', 'trump:*')`
    //     which IS index-backed and supports lexeme-prefix (`:*`) — the
    //     fast equivalent of `ILIKE 'trump%'` without the seqscan.
    //
    // Multi-word inputs (e.g. "donald trump") get joined with `&` so all
    // tokens must appear; non-word chars are stripped to prevent users
    // injecting tsquery syntax (`! | ( )` etc.).
    if (keyword) {
      const kwLower = keyword.toLowerCase().trim();
      params.push(kwLower);
      const exactParam = params.length;
      const tsTokens = kwLower.replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
      if (tsTokens.length) {
        const tsQuery = tsTokens.map(w => w + ':*').join(' & ');
        params.push(tsQuery);
        const tsParam = params.length;
        conditions.push(`a.id IN (
          SELECT ak.article_id FROM article_keywords ak
          WHERE ak.normalized_keyword = $${exactParam}
             OR to_tsvector('simple', ak.keyword) @@ to_tsquery('simple', $${tsParam})
        )`);
      } else {
        // Pure non-word input — only the exact normalized lookup is meaningful.
        conditions.push(`a.id IN (
          SELECT ak.article_id FROM article_keywords ak
          WHERE ak.normalized_keyword = $${exactParam}
        )`);
      }
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

      // Dedicated client with per-statement timeout so a slow cold query
      // fails fast instead of holding the pool and cascading retries.
      // SET LOCAL only takes effect inside a transaction — without an
      // explicit BEGIN, each query runs in its own implicit transaction
      // that ends immediately, so the SET LOCAL was a silent no-op
      // (queries actually ran under the pool's default 45s timeout).
      // Wrapping SET LOCAL + SELECT in a real transaction so the cap
      // actually applies. ROLLBACK on error so the connection returns
      // to the pool clean, no half-open transaction state.
      // Cap at 10s (was 6s). Cold-start queries on Render with a hot
      // keyword like "trump" sometimes take 7–8s on a cold buffer cache;
      // the old 6s timeout aborted them, returning {error:"Failed to
      // fetch flows"} and the user retried — taking another cold miss.
      // 10s lets the warmup query through; the cache then absorbs subsequent
      // hits at <10ms.
      const client = await pool.connect();
      let rows;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = 10000");
        ({ rows } = await client.query(aggregateQuery, params));
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }

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
      
      // Fetch extra articles for normalization (3x limit, capped at 3000)
      const fetchLimit = normalize ? Math.min(limit * 3, 3000) : limit;
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

      // See aggregate-mode block above for the BEGIN/COMMIT rationale —
      // SET LOCAL outside a transaction is a silent no-op. 10s cap to
      // match aggregate mode (see rationale above).
      const client = await pool.connect();
      let rows;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = 10000");
        ({ rows } = await client.query(`
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
      `, params));
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }

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
    // Guard against ERR_HTTP_HEADERS_SENT: if res.json(_cached) started
    // streaming and then threw (e.g. JSON serialization mid-write, client
    // disconnect race), setting status/headers here crashes the process
    // with an unhandled rejection — which was taking down the whole server
    // and producing 502 storms on queued OPTIONS preflights. Only send an
    // error response if the response hasn't already been committed.
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to fetch article flows", detail: req.user?.is_admin ? err.message : undefined });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
});

/* =========================================
   Route articles — articles on a specific aggregate route
   Used by the Flow Articles Panel to expand aggregate arc bars
========================================= */
app.get("/api/flows/route-articles", searchLimiter, async (req, res) => {
  try {
    const srcId = parseInt(req.query.src_id, 10);
    const dstId = parseInt(req.query.dst_id, 10);
    const srcType = req.query.src_type || 'country';
    const dstType = req.query.dst_type || 'country';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const fromDate = req.query.from_date || null;
    const toDate = req.query.to_date || null;

    if (!srcId || !dstId) return res.status(400).json({ error: "src_id and dst_id required" });

    const cacheKey = `route-articles:${srcType}:${srcId}:${dstType}:${dstId}:${fromDate||''}:${toDate||''}:${limit}`;
    const result = await ttlCached(cacheKey, 60_000, async () => {
      const params = [];
      const where = ['al.routing_type IN (\'content\', \'source\')'];

      // Source filter
      if (srcType === 'city') {
        params.push(srcId); where.push(`a.city_id = $${params.length}`);
      } else {
        params.push(srcId); where.push(`a.country_id = $${params.length}`);
      }
      // Destination filter
      if (dstType === 'city') {
        params.push(dstId); where.push(`al.city_id = $${params.length}`);
      } else {
        params.push(dstId); where.push(`al.country_id = $${params.length}`);
      }
      // Date filters
      if (fromDate) { params.push(fromDate); where.push(`a.published_at >= $${params.length}::date`); }
      if (toDate)   { params.push(toDate);   where.push(`a.published_at < $${params.length}::date + interval '1 day'`); }

      params.push(limit);
      const { rows } = await pool.query(`
        SELECT
          a.id,
          COALESCE(a.translated_title, a.title) AS title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          COALESCE(a.image_url, img_a.public_url) AS image_url,
          a.published_at,
          a.article_url,
          COALESCE(ns.name, ys.name) AS source_name,
          a.sentiment_score
        FROM article_locations al
        JOIN news_articles a ON a.id = al.article_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.published_at DESC
        LIMIT $${params.length}
      `, params);

      return rows;
    });

    res.json(result);
  } catch (err) {
    console.error("Route articles error:", err);
    res.status(500).json({ error: "Failed to fetch route articles" });
  }
});

/* =========================================
   Flows for a thread (all articles in the thread)
   Returns arcs between the story's curated focal countries.

   Source-of-truth is `story_threads.primary_nations` — the same
   ISO-code array that renders the flag chips at the bottom of the
   thread card in the UI. Earlier versions of this endpoint derived
   countries from `article_entity_mentions` across every constituent
   article, which dragged in backdrop mentions (e.g. a Lebanon
   ceasefire thread picking up Italy/China/Venezuela because articles
   name-dropped them in passing). We now only fall back to entity
   extraction when a thread has no primary_nations at all, and even
   then we tighten the role filter to subject/actor only + raise the
   confidence floor so passing mentions don't leak in.
========================================= */
app.get("/api/flows/thread/:id", async (req, res) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ error: "Invalid thread ID" });

    const _cached = await ttlCached(`flows/thread:${threadId}`, 300_000, async () => {
      return await _buildTieredFlows({
        kind: 'thread',
        id: threadId,
        rowTable: 'story_threads',
        articleJoinTable: 'story_thread_articles',
        articleJoinKey: 'thread_id',
      });
    });
    res.json(_cached);
  } catch (err) {
    console.error("[flows/thread]", err.message);
    res.status(500).json({ error: "Failed to fetch thread flows", detail: req.user?.is_admin ? err.message : undefined });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier-aware flow builder, shared between /api/flows/thread/:id and
// /api/flows/timeline/:id.
//
// Model (per product design):
//   • primary_nations   = 1–3 countries the story is fundamentally about
//   • secondary_nations = up to 8 supporters/commenters/downstream actors
//   • Flow topology:
//       - primary mesh:    all N*(N-1)/2 pairs among primaries → `_tier:'primary'`
//       - primary→secondary spider: each primary × each secondary → `_tier:'secondary'`
//       - single-primary:  skip mesh entirely, only draw spider
//   • Arc-count cap (design decision C): if total > MAX_ARCS, drop weakest
//     spider edges first. Primary mesh is always preserved.
//
// Legacy fallback: if the row has empty primary + secondary (pre-tier data or
// extraction gap), fall through to the old entity-extraction / content-routing
// logic and return untiered flows so the frontend can render them as plain
// routing arcs (pre-tier behavior).
// ═══════════════════════════════════════════════════════════════════════════
const TIER_MAX_ARCS           = 20;   // hard cap per endpoint response
const TIER_MAX_SECONDARIES    = 8;    // matches classifier's cap
const TIER_FALLBACK_LIMIT     = 10;   // for legacy linear-chain fallback

async function _buildTieredFlows({ kind, id, rowTable, articleJoinTable, articleJoinKey }) {
  // 1. Pull tier arrays + use them to compute involved country coords.
  const { rows: rowRs } = await pool.query(
    `SELECT primary_nations, secondary_nations FROM ${rowTable} WHERE id = $1`,
    [id]
  );
  if (!rowRs.length) return { flows: [], maxCount: 0, tier_primary: [], tier_secondary: [] };

  const primaryIsos   = _normIsoArr(rowRs[0].primary_nations);
  const secondaryIsos = _normIsoArr(rowRs[0].secondary_nations).slice(0, TIER_MAX_SECONDARIES);
  const tieredIsos    = [...primaryIsos, ...secondaryIsos];

  // If the row has ANY tier info (primary or secondary), use the tier
  // path — even when it can't produce ≥2 arcs. A single-primary / no-
  // secondary row represents an explicit "this story is about ONE
  // country" classification; falling through to the legacy entity
  // chain would inject noise (e.g. Mexico story suddenly showing arcs
  // to EC/SD/ML from incidental mentions). Returning empty tier flows
  // lets the frontend's single-country highlight path take over.
  if (primaryIsos.length + secondaryIsos.length >= 1) {
    // 2. Fetch coords + per-country mention_count in one shot so arc weights
    //    reflect how loudly each country figures in the thread/line's articles.
    //
    // Performance: the previous version ran a CORRELATED subquery inside
    // the SELECT list, meaning it re-scanned
    // story_thread_articles ⨝ article_entity_mentions ⨝ entities ONCE PER
    // focal country (up to 11× per request). For a 100-article thread
    // that's ~11 × thousands of joined rows. On Render this pushed past
    // the client's 45s fetch ceiling and produced AbortError storms.
    //
    // Rewrite: compute all per-country counts in a SINGLE pass via CTE
    // with GROUP BY, then LEFT JOIN the focal list. One scan, one group.
    // Complements the partial index on entities(country_code) added in
    // migrations/20260424_thread_flows_indexes.sql.
    const { rows: coords } = await pool.query(`
      WITH focal AS (
        SELECT UPPER(TRIM(iso)) AS iso_upper
        FROM unnest($1::text[]) AS iso
      ),
      counts AS (
        SELECT UPPER(e.country_code) AS iso_upper,
               COUNT(DISTINCT aem.article_id)::int AS mention_count
          FROM ${articleJoinTable} sta
          JOIN article_entity_mentions aem ON aem.article_id = sta.article_id
          JOIN entities e ON e.id = aem.entity_id
         WHERE sta.${articleJoinKey} = $2
           AND e.entity_type = 'location'
           AND e.country_code IS NOT NULL
         GROUP BY UPPER(e.country_code)
      )
      SELECT
        co.id, co.name AS place,
        co.latitude AS lat, co.longitude AS lon,
        co.iso_code AS iso,
        COALESCE(c.mention_count, 0)::int AS mention_count
      FROM focal f
      JOIN countries co ON UPPER(co.iso_code) = f.iso_upper
      LEFT JOIN counts c ON c.iso_upper = f.iso_upper
    `, [tieredIsos, id]);

    // Index by ISO for topology building; skip any ISO we can't resolve
    // to coordinates (supranational entries like "EU" won't have a row).
    const byIso = new Map();
    for (const c of coords) {
      const iso = String(c.iso || '').toUpperCase();
      byIso.set(iso, {
        id: c.id, place: c.place, iso,
        lat: parseFloat(c.lat), lon: parseFloat(c.lon),
        type: 'country',
        mention_count: Number(c.mention_count || 0),
      });
    }
    const resolvedPrimaries  = primaryIsos.filter(i => byIso.has(i));
    const resolvedSecondaries = secondaryIsos.filter(i => byIso.has(i));

    // Even when we can't produce ≥2 arcs, still return tier-aware shape
    // so the frontend can honor the "don't fall back to routing noise"
    // contract above. Only the arc-building branches require ≥2 nodes.
    {
      const flows = [];

      // 3a. Primary mesh — all pairs among primaries. Skip entirely when
      // there's only one primary (per design decision Q3:B).
      if (resolvedPrimaries.length >= 2) {
        for (let i = 0; i < resolvedPrimaries.length; i++) {
          for (let j = i + 1; j < resolvedPrimaries.length; j++) {
            const a = byIso.get(resolvedPrimaries[i]);
            const b = byIso.get(resolvedPrimaries[j]);
            flows.push({
              src: { lat: a.lat, lon: a.lon, place: a.place, id: a.id, type: 'country', iso: a.iso },
              dst: { lat: b.lat, lon: b.lon, place: b.place, id: b.id, type: 'country', iso: b.iso },
              count: (a.mention_count + b.mention_count) || 1,
              _tier: 'primary',
            });
          }
        }
      }

      // 3b. Primary→secondary spider — each primary to each secondary.
      const spiderFlows = [];
      for (const pIso of resolvedPrimaries) {
        const p = byIso.get(pIso);
        for (const sIso of resolvedSecondaries) {
          const s = byIso.get(sIso);
          spiderFlows.push({
            src: { lat: p.lat, lon: p.lon, place: p.place, id: p.id, type: 'country', iso: p.iso },
            dst: { lat: s.lat, lon: s.lon, place: s.place, id: s.id, type: 'country', iso: s.iso },
            count: s.mention_count || 1,
            _tier: 'secondary',
          });
        }
      }

      // 3c. Arc cap — keep all primary mesh; drop weakest spider edges
      // until total fits under TIER_MAX_ARCS (design decision Q6:C).
      spiderFlows.sort((a, b) => b.count - a.count);
      const spiderBudget = Math.max(0, TIER_MAX_ARCS - flows.length);
      flows.push(...spiderFlows.slice(0, spiderBudget));

      const maxCount = flows.length ? Math.max(...flows.map(f => f.count), 1) : 1;
      return {
        flows,
        maxCount,
        tier_primary:   resolvedPrimaries,
        tier_secondary: resolvedSecondaries,
      };
    }
  }

  // ── LEGACY FALLBACK ────────────────────────────────────────────────────
  // Row has empty/sparse tier data (pre-sweep row or extraction gap). Use
  // the old entity → content-routing chain and return untiered flows so
  // the frontend renders them as plain routing arcs.
  const { rows: entityCountries } = await pool.query(`
    SELECT DISTINCT
      co.id, co.name AS place, co.latitude AS lat, co.longitude AS lon,
      co.iso_code AS iso,
      'country' AS type,
      MIN(CASE aem.role WHEN 'subject' THEN 1 WHEN 'actor' THEN 2 ELSE 3 END) AS role_rank,
      COUNT(DISTINCT sta.article_id) AS mention_count
    FROM ${articleJoinTable} sta
    JOIN article_entity_mentions aem ON aem.article_id = sta.article_id
    JOIN entities e ON e.id = aem.entity_id
    JOIN countries co ON LOWER(co.iso_code) = LOWER(e.country_code)
    WHERE sta.${articleJoinKey} = $1
      AND e.entity_type = 'location'
      AND aem.role IN ('subject', 'actor')
      AND aem.confidence >= 0.7
    GROUP BY co.id, co.name, co.latitude, co.longitude, co.iso_code
    ORDER BY role_rank, mention_count DESC
    LIMIT ${TIER_FALLBACK_LIMIT}
  `, [id]);

  let involvedCountries = entityCountries;

  if (involvedCountries.length < 2) {
    const { rows: contentCountries } = await pool.query(`
      SELECT
        co.id, co.name AS place, co.latitude AS lat, co.longitude AS lon,
        co.iso_code AS iso,
        'country' AS type,
        COUNT(DISTINCT al.article_id) AS mention_count
      FROM ${articleJoinTable} sta
      JOIN article_locations al ON al.article_id = sta.article_id
      JOIN countries co ON co.id = al.country_id
      WHERE sta.${articleJoinKey} = $1
        AND al.routing_type = 'content'
      GROUP BY co.id, co.name, co.latitude, co.longitude, co.iso_code
      ORDER BY mention_count DESC
      LIMIT ${TIER_FALLBACK_LIMIT}
    `, [id]);
    involvedCountries = contentCountries;
  }

  if (involvedCountries.length < 2) {
    return { flows: [], maxCount: 0, tier_primary: [], tier_secondary: [] };
  }

  // Legacy: consecutive pairs, no tier markers.
  const flows = [];
  for (let i = 0; i < involvedCountries.length - 1; i++) {
    const src = involvedCountries[i];
    const dst = involvedCountries[i + 1];
    flows.push({
      src: { lat: parseFloat(src.lat), lon: parseFloat(src.lon),
             place: src.place, id: src.id, type: 'country', iso: src.iso },
      dst: { lat: parseFloat(dst.lat), lon: parseFloat(dst.lon),
             place: dst.place, id: dst.id, type: 'country', iso: dst.iso },
      count: (parseInt(src.mention_count) || 0) + (parseInt(dst.mention_count) || 0)
    });
  }
  const maxCount = flows.length ? Math.max(...flows.map(f => f.count), 1) : 1;
  return { flows, maxCount, tier_primary: [], tier_secondary: [] };
}

function _normIsoArr(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  for (const v of arr) {
    const iso = String(v || '').trim().toUpperCase();
    if (/^[A-Z]{2,3}$/.test(iso)) seen.add(iso);
  }
  return [...seen];
}

/* =========================================
   Articles constituent of a thread.
   Used by the thread-flow Live Arcs panel, which — unlike the News
   Flows discovery tool — treats the arc list as the story's article
   roster rather than a route-article lookup. Returns everything the
   client needs to render a bar + expanded card, including the
   article's home ISO so the eye-button can fall back to home-country
   highlight when /api/flows/article/:id is empty.
========================================= */
app.get("/api/threads/:id/articles", async (req, res) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ error: "Invalid thread ID" });

    const _cached = await ttlCached(`threads/${threadId}/articles`, 180_000, async () => {
      // src = article's home country (publisher / origin).
      // dst = primary destination country this article is ABOUT, pulled from
      //       article_locations with 'content' routing preferred over 'source'.
      //       LATERAL takes the top-ranked row per article so each bar gets
      //       exactly one src → dst even when an article mentions several
      //       places. If dst resolves to the same country as src (e.g. domestic
      //       story), front-end will display just the origin.
      const { rows } = await pool.query(`
        SELECT
          a.id,
          COALESCE(a.translated_title, a.title)     AS title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          -- news_articles.image_url is NULL for most articles; the real
          -- artwork lives in the assigned catalog image. Same COALESCE
          -- chain that /api/admin/threads/:id uses so the expanded-card
          -- image consistently has something to render.
          COALESCE(a.image_url, img_a.public_url)   AS image_url,
          COALESCE(ns.name, ys.name)                AS source_name,
          a.article_url                              AS url,
          a.published_at,
          src_co.iso_code                            AS src_iso,
          src_co.name                                AS src_country_name,
          src_ci.name                                AS src_city_name,
          src_co.latitude                            AS src_lat,
          src_co.longitude                           AS src_lon,
          dst.dst_iso,
          dst.dst_country_name,
          dst.dst_city_name,
          dst.dst_lat,
          dst.dst_lon,
          dst.routing_type                           AS dst_routing_type,
          sta.is_anchor,
          sta.relevance_score
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        LEFT JOIN countries src_co ON src_co.id = a.country_id
        LEFT JOIN cities    src_ci ON src_ci.id = a.city_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img_a ON img_a.id = aia.image_id
        LEFT JOIN LATERAL (
          SELECT
            dco.iso_code AS dst_iso,
            dco.name     AS dst_country_name,
            dci.name     AS dst_city_name,
            COALESCE(dci.latitude,  dco.latitude)  AS dst_lat,
            COALESCE(dci.longitude, dco.longitude) AS dst_lon,
            al.routing_type
          FROM article_locations al
          LEFT JOIN countries dco ON dco.id = al.country_id
          LEFT JOIN cities    dci ON dci.id = al.city_id
          WHERE al.article_id = a.id
            AND al.routing_type IN ('content', 'source')
            AND al.country_id IS NOT NULL
            AND al.country_id <> a.country_id   -- prefer true cross-border dst
          ORDER BY
            CASE al.routing_type WHEN 'content' THEN 0 ELSE 1 END,
            -- al.id does NOT exist on article_locations (the table has no
            -- surrogate pk in this schema; rows are identified by the
            -- (article_id, country_id, city_id, routing_type) tuple). Using
            -- it as a tiebreak crashed the whole endpoint with a 500 so the
            -- thread-flow Live Arcs panel silently fell back to showing
            -- route arcs instead of the constituent articles. Tiebreak on
            -- country_id for determinism; city-specific rows win over
            -- country-only rows since NULL sorts last.
            al.city_id ASC NULLS LAST,
            al.country_id ASC
          LIMIT 1
        ) dst ON TRUE
        WHERE sta.thread_id = $1
        ORDER BY sta.is_anchor DESC NULLS LAST,
                 a.published_at DESC
        LIMIT 80
      `, [threadId]);
      return { thread_id: threadId, articles: rows, count: rows.length };
    });
    res.json(_cached);
  } catch (err) {
    console.error("[threads/articles]", err.message);
    res.status(500).json({ error: "Failed to fetch thread articles", detail: req.user?.is_admin ? err.message : undefined });
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
// Pre-computes bucketed aggregates for every time-series combo the client
// can request. Earlier iterations omitted 7d_hour and 14d_hour with a
// "too large to pre-compute" note — but the pre-compute query already caps
// rows at LIMIT 20000 (country) + LIMIT 40000 (city) per preset, so each
// preset is bounded at ~60k rows regardless of the article volume. Adding
// these two closes the hole where users switching to hourly bucket on 7d
// or 14d would fall into the live-query branch and hit the 90s statement
// timeout on cold buffer cache.
async function refreshHeatmapTsSnapshots() {
  const tsPresets = [
    { key: '7d_day',   days: 7,  trunc: 'day'  },   // most requested
    { key: '7d_hour',  days: 7,  trunc: 'hour' },   // was live-only; now pre-computed
    { key: '14d_day',  days: 14, trunc: 'day'  },
    { key: '14d_hour', days: 14, trunc: 'hour' },   // was live-only; now pre-computed
    { key: '3d_hour',  days: 3,  trunc: 'hour' },
    { key: '3d_day',   days: 3,  trunc: 'day'  },
    { key: '1d_hour',  days: 1,  trunc: 'hour' },
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

// GET|POST /api/admin/refresh-heatmap — triggered by Render cron every 30 min
// Accepts both GET (Render cron jobs hit URLs via GET) and POST.
// Auth: pass secret as query param ?key= or Authorization header.
//
// ACKNOWLEDGE-AND-WORK pattern: respond 200 immediately, then do the
// heavy aggregation asynchronously. The cron just needs confirmation it
// kicked off a refresh — it doesn't need to wait for the 4 presets ×
// 2 aggregations × flat+ts (potentially 15+ min under DB pressure).
// Previously the curl timed out waiting, marking the cron as failed
// even though the DB work was completing fine in the background.
let _heatmapRefreshInFlight = false;
app.all("/api/admin/refresh-heatmap", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  const queryKey = req.query.key;
  if (!secret || (auth !== `Bearer ${secret}` && queryKey !== secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Prevent overlapping runs — if a previous invocation is still working
  // (because the DB is slow under backfill load), ack but skip a new one.
  if (_heatmapRefreshInFlight) {
    return res.json({ ok: true, status: "already_running", skipped: true });
  }

  // Ack the cron immediately — it just needs "yes I got it"
  res.json({ ok: true, status: "accepted", note: "running in background" });

  // Do the actual work async. Never throws out of here — all errors logged.
  _heatmapRefreshInFlight = true;
  const t0 = Date.now();
  (async () => {
    try {
      const flatResults = await refreshHeatmapSnapshots();
      let tsResults = [];
      try {
        tsResults = await refreshHeatmapTsSnapshots();
      } catch (e) {
        console.error('[heatmap-ts-refresh] failed:', e.message);
        tsResults = [{ ok: false, error: e.message }];
      }
      const elapsed = Date.now() - t0;
      console.log(`[heatmap-refresh] completed in ${elapsed}ms (flat + ts)`);
      for (const k of _ttlCache.keys()) {
        if (k.startsWith('heatmap:')) _ttlCache.delete(k);
      }
    } catch (err) {
      console.error("[heatmap-refresh] background error:", err.message, err.stack);
    } finally {
      _heatmapRefreshInFlight = false;
    }
  })();
});

// ── Briefing Editor Admin Routes ──────────────────────────────────────────
async function requireAdmin(req, res, next) {
  // Local-dev bypass — let the Claude Preview / localhost editor pages
  // hit admin endpoints without Supabase auth. Gated on an env flag so
  // production deploys never accidentally enable it.
  if (process.env.DEV_EDITOR_BYPASS === '1') {
    req.user = req.user || {};
    req.user.is_admin = true;
    return next();
  }
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
    // Single indexed read off story_threads — no join to story_thread_articles
    // or news_articles. The previous query did ~7700 primary-key lookups into
    // news_articles to check each article's published_at, which ran ~30s on
    // cold cache and routinely tripped the 45s pool statement_timeout (→ 500).
    //
    // We use st.article_count (denormalized on story_threads) as the recent-
    // article count. It's close enough for the editor's "thread has content"
    // check and is free. hasVideo was computed but never consumed by the
    // editor UI, so it's gone. 60s TTL coalesces concurrent editor reloads.
    // Cache key bumped (v3 → v4) because the ORDER BY changed from
    // importance to recency; older cached payloads would surface in the
    // wrong order until the 60s TTL expired.
    const payload = await ttlCached('briefing-editor/threads:v4', 60_000, async () => {
      const { rows } = await pool.query(`
        SELECT id, title, primary_category, importance, keywords,
               geographic_scope, article_count, last_updated_at
        FROM story_threads
        WHERE status = 'active'
          AND last_updated_at > NOW() - INTERVAL '3 days'
          AND COALESCE(article_count, 0) >= 1
          AND COALESCE(scope, 'global') = 'global'
        ORDER BY last_updated_at DESC, importance DESC
        LIMIT 100
      `);
      return {
        threads: rows.map(r => ({
          ...r,
          recent_articles: r.article_count || 0,
          video_count: 0,
          hasVideo: false,
          keywords: Array.isArray(r.keywords) ? r.keywords : (r.keywords ? [r.keywords] : []),
          geographic_scope: Array.isArray(r.geographic_scope) ? r.geographic_scope : (r.geographic_scope ? [r.geographic_scope] : [])
        }))
      };
    });
    res.json(payload);
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

    // oEmbed is the source of truth for embeddability. YouTube's own API
    // returns 200 only when the video is publicly embeddable. 401/403
    // specifically signals embedding disabled by owner; 404 means the
    // video is gone. Anything else (5xx, network failure) is treated as
    // transient and falls through to the (now tightened) embed-HTML check.
    let title = 'YouTube Video', author = '';
    let oembedOk = false;
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const resp = await fetch(oembedUrl);
      if (resp.ok) {
        const data = await resp.json();
        title = data.title || 'Unknown';
        author = data.author_name || '';
        oembedOk = true;
      } else if (resp.status === 401 || resp.status === 403) {
        return res.status(400).json({ error: 'Video is not embeddable (embedding disabled by owner)' });
      } else if (resp.status === 404) {
        return res.status(400).json({ error: 'Video not found or unavailable' });
      }
    } catch (_) {}

    // Secondary embed-HTML inspection. Only runs when oEmbed didn't
    // confirm embeddability (5xx / network failure). Regexes are
    // STRUCTURED — they must match an actual JSON playabilityStatus
    // object, not stray occurrences of the enum strings that YouTube's
    // embed JS ships in its localisation / enum dictionaries. An earlier
    // broader match was denying every video because "UNPLAYABLE" appears
    // in YouTube's compiled JS regardless of the specific video's state.
    //
    // X-Frame-Options SAMEORIGIN from youtube-nocookie.com on a
    // server-side fetch is also NOT a reliable signal of embed blocking
    // — that header controls browser framing, not fetch permissibility.
    // Removing that check (it was false-positiving every video).
    if (!oembedOk) {
      try {
        const embedResp = await fetch(`https://www.youtube-nocookie.com/embed/${videoId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(6000)
        });
        if (embedResp.ok) {
          const embedHtml = await embedResp.text();
          // Match the actual JSON shape: "playabilityStatus":{"status":"<NOT OK>"}
          // Allows whitespace variation. Enum strings appearing elsewhere
          // in the JS bundle (as part of type declarations, localisation
          // tables, etc.) no longer cause false positives.
          const statusMatch = embedHtml.match(
            /"playabilityStatus"\s*:\s*\{\s*"status"\s*:\s*"([A-Z_]+)"/
          );
          const statusValue = statusMatch?.[1] || null;
          const blockedStatuses = ['UNPLAYABLE', 'ERROR', 'LOGIN_REQUIRED', 'CONTENT_CHECK_REQUIRED'];
          if (statusValue && blockedStatuses.includes(statusValue)) {
            let reason = 'Video is blocked from embedding on third-party sites';
            const reasonMatch = embedHtml.match(/"reason"\s*:\s*"([^"]{1,200})"/);
            const subMatch    = embedHtml.match(/"subreason"\s*:\s*"([^"]{1,200})"/);
            if (reasonMatch) reason = reasonMatch[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
            if (subMatch)   reason += ' — ' + subMatch[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
            return res.status(400).json({ error: reason });
          }
        }
      } catch (_) {}
    }

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

// Upload background music for a briefing episode (raw binary body)
app.put('/api/admin/briefing-editor/music/:episodeId', requireAdmin, express.raw({ type: ['audio/*', 'video/mp4'], limit: '25mb' }), async (req, res) => {
  try {
    const { episodeId } = req.params;
    const filename = decodeURIComponent(req.headers['x-music-filename'] || 'music.mp3');
    const contentType = req.headers['content-type'] || 'audio/mpeg';

    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'No music data received' });
    }

    await pool.query(
      `UPDATE briefing_episodes
       SET music_data = $1, music_meta = $2
       WHERE id = $3`,
      [req.body, JSON.stringify({ filename, content_type: contentType, size: req.body.length }), episodeId]
    );

    console.log(`[briefing-editor] music uploaded for episode ${episodeId}: ${filename} (${(req.body.length / 1024 / 1024).toFixed(1)} MB)`);
    res.json({ ok: true, size: req.body.length });
  } catch (err) {
    console.error('[briefing-editor] music upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload music' });
  }
});

// Delete background music from episode
app.delete('/api/admin/briefing-editor/music/:episodeId', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `UPDATE briefing_episodes SET music_data = NULL, music_meta = NULL WHERE id = $1`,
      [req.params.episodeId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete music' });
  }
});

// Serve background music for playback
app.get('/api/briefing/music/:episodeId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT music_data, music_meta FROM briefing_episodes WHERE id = $1 AND music_data IS NOT NULL`,
      [req.params.episodeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No music for this episode' });

    const meta = rows[0].music_meta || {};
    res.set('Content-Type', meta.content_type || 'audio/mpeg');
    res.set('Content-Length', rows[0].music_data.length);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(rows[0].music_data);
  } catch (err) {
    console.error('[briefing] music serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve music' });
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

/* =========================================
   Thread Admin — CRUD + Merge
   ========================================= */

// List threads for admin (richer than the briefing-editor endpoint)
app.get('/api/admin/threads', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const search = (req.query.search || '').trim().toLowerCase();
    const cacheKey = `admin/threads:${limit}:${search}`;

    // 60s TTL cache matches the timelines endpoint. Admin edits invalidate
    // cache via the mutation endpoints below if needed; otherwise the
    // editor sees fresh data within a minute.
    const payload = await ttlCached(cacheKey, 60_000, async () => {
      const params = [limit];
      const clauses = ["st.status = 'active'", 'st.article_count >= 1'];
      if (search) { params.push(`%${search}%`); clauses.push(`(LOWER(st.title) LIKE $${params.length} OR LOWER(st.description) LIKE $${params.length} OR LOWER(ARRAY_TO_STRING(st.keywords, ' ')) LIKE $${params.length})`); }

      // Use a dedicated client with a short statement_timeout so the hero
      // image lookup can't block the response indefinitely when the DB is
      // under write pressure (e.g. image backfill running).
      const client = await pool.connect();
      try {
        await client.query("SET statement_timeout = 3000");

        const { rows: pageRows } = await client.query(`
          SELECT
            st.id, st.title, st.description, st.primary_category,
            st.geographic_scope, st.importance, st.keywords, st.primary_nations,
            st.article_count, st.status, st.last_updated_at,
            st.distinct_source_count, st.breaking_signal_score,
            NULL::text AS custom_image_url   -- story_threads has no image_url column; hero is resolved from constituent articles below
          FROM story_threads st
          WHERE ${clauses.join(' AND ')}
          ORDER BY st.last_updated_at DESC NULLS LAST
          LIMIT $1
        `, params);

        // Hero images are best-effort: if the join times out (e.g. DB under
        // write load), we still return thread metadata and leave hero_image_url
        // null. The editor will just render placeholders for affected rows.
        let rows = pageRows;
        if (pageRows.length) {
          const pageIds = pageRows.map(r => r.id);
          try {
            await client.query("SET statement_timeout = 2500");
            const { rows: heroRows } = await client.query(`
              SELECT DISTINCT ON (sta.thread_id)
                sta.thread_id, a.image_url
              FROM story_thread_articles sta
              JOIN news_articles a ON a.id = sta.article_id
              WHERE sta.thread_id = ANY($1)
                AND a.image_url IS NOT NULL
                AND a.image_url <> ''
              ORDER BY sta.thread_id, a.published_at DESC
            `, [pageIds]);
            const heroMap = new Map(heroRows.map(r => [r.thread_id, r.image_url]));
            rows = pageRows.map(r => ({
              ...r,
              hero_image_url: r.custom_image_url || heroMap.get(r.id) || null
            }));
          } catch (heroErr) {
            console.warn('[admin/threads] hero image lookup skipped:', heroErr.message);
            rows = pageRows.map(r => ({
              ...r,
              hero_image_url: r.custom_image_url || null
            }));
          }
        }

        return { threads: rows };
      } finally {
        client.release();
      }
    });

    res.json(payload);
  } catch (err) {
    console.error('[admin/threads] list error:', err.message);
    res.status(500).json({ error: 'Failed to list threads' });
  }
});

// Get thread detail with articles
app.get('/api/admin/threads/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const { rows: threadRows } = await pool.query(`
      SELECT id, title, description, primary_category, geographic_scope,
             importance, keywords, primary_nations, secondary_nations,
             article_count, status, last_updated_at,
             distinct_source_count, breaking_signal_score,
             NULL::text AS image_url   -- column doesn't exist on story_threads
      FROM story_threads WHERE id = $1
    `, [id]);
    if (!threadRows.length) return res.status(404).json({ error: 'Thread not found' });

    const { rows: articles } = await pool.query(`
      SELECT a.id, COALESCE(a.translated_title, a.title) AS title,
             COALESCE(a.translated_summary, a.summary) AS summary,
             COALESCE(img.public_url, '') AS image_url, a.article_url, a.published_at,
             COALESCE(ns.name, ys.name) AS source_name,
             sta.relevance_score, sta.is_anchor
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img ON img.id = aia.image_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE sta.thread_id = $1
      ORDER BY sta.is_anchor DESC, a.published_at DESC
      LIMIT 50
    `, [id]);

    res.json({ thread: threadRows[0], articles });
  } catch (err) {
    console.error('[admin/threads] detail error:', err.message);
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

// Update thread fields (title, description, category, importance, keywords, status, image)
app.put('/api/admin/threads/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const { title, description, primary_category, importance, keywords, primary_nations, secondary_nations, status, geographic_scope, image_url } = req.body;
    const sets = []; const params = [];
    let pi = 1;

    // Shared ISO-list normalizer: accept array or comma-separated string,
    // uppercase/trim each code, drop empties + anything that isn't a
    // plausible ISO 2-3 letter code. Keeps admin curation tolerant of
    // pasted formats while rejecting garbage.
    const _parseIsoList = (v) => {
      const arr = Array.isArray(v) ? v : String(v || '').split(',');
      return arr.map(k => String(k || '').trim().toUpperCase())
                .filter(k => /^[A-Z]{2,3}$/.test(k));
    };

    if (title !== undefined)            { sets.push(`title = $${pi++}`);            params.push(title); }
    if (description !== undefined)      { sets.push(`description = $${pi++}`);      params.push(description); }
    if (primary_category !== undefined) { sets.push(`primary_category = $${pi++}`); params.push(primary_category); }
    if (importance !== undefined)       { sets.push(`importance = $${pi++}`);       params.push(parseFloat(importance) || 5); }
    if (keywords !== undefined)         { sets.push(`keywords = $${pi++}`);         params.push(Array.isArray(keywords) ? keywords : keywords.split(',').map(k => k.trim())); }
    if (primary_nations !== undefined)   { sets.push(`primary_nations = $${pi++}`);   params.push(_parseIsoList(primary_nations)); }
    if (secondary_nations !== undefined) { sets.push(`secondary_nations = $${pi++}`); params.push(_parseIsoList(secondary_nations)); }
    if (status !== undefined)           { sets.push(`status = $${pi++}`);           params.push(status); }
    if (geographic_scope !== undefined) { sets.push(`geographic_scope = $${pi++}`); params.push(geographic_scope); }
    // image_url intentionally skipped — story_threads has no image_url column.
    // Setting it blew up the whole UPDATE with a 500. Hero images live on
    // constituent articles; a per-thread override column would need a migration.

    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    const before = await snapshotThreadRow(pool, id);

    sets.push(`last_updated_at = NOW()`);
    params.push(id);
    await pool.query(`UPDATE story_threads SET ${sets.join(', ')} WHERE id = $${pi}`, params);

    const after = await snapshotThreadRow(pool, id);
    logEditorEvent(pool, {
      eventType: 'thread.update',
      entityType: 'thread',
      entityId: id,
      editorId: req.user?.id || null,
      before, after,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/threads] update error:', err.message);
    res.status(500).json({ error: 'Failed to update thread' });
  }
});

// Merge threads: absorb source threads into a target, optionally create a new combined thread
app.post('/api/admin/threads/merge', requireAdmin, async (req, res) => {
  try {
    const { target_id, source_ids, new_title, new_description, new_category } = req.body;
    if (!target_id || !source_ids?.length) return res.status(400).json({ error: 'target_id and source_ids[] required' });

    const targetId = parseInt(target_id, 10);
    const srcIds = source_ids.map(id => parseInt(id, 10)).filter(id => id && id !== targetId);
    if (!srcIds.length) return res.status(400).json({ error: 'No valid source threads to merge' });

    const beforeTarget = await snapshotThreadRow(pool, targetId);
    const beforeSources = {};
    for (const sid of srcIds) beforeSources[sid] = await snapshotThreadRow(pool, sid);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Move articles from source threads to target (skip duplicates)
      for (const srcId of srcIds) {
        await client.query(`
          INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor, added_at)
          SELECT $1, article_id, relevance_score, false, added_at
          FROM story_thread_articles
          WHERE thread_id = $2
          ON CONFLICT (thread_id, article_id) DO NOTHING
        `, [targetId, srcId]);
      }

      // Merge keywords from sources into target
      await client.query(`
        UPDATE story_threads SET
          keywords = (
            SELECT ARRAY(SELECT DISTINCT UNNEST(keywords) FROM story_threads WHERE id = ANY($1::int[]))
          ),
          article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $2),
          last_updated_at = NOW()
        WHERE id = $2
      `, [[targetId, ...srcIds], targetId]);

      // Apply new metadata if provided
      if (new_title || new_description || new_category) {
        const sets = []; const params = []; let pi = 1;
        if (new_title)       { sets.push(`title = $${pi++}`);            params.push(new_title); }
        if (new_description) { sets.push(`description = $${pi++}`);      params.push(new_description); }
        if (new_category)    { sets.push(`primary_category = $${pi++}`); params.push(new_category); }
        params.push(targetId);
        await client.query(`UPDATE story_threads SET ${sets.join(', ')} WHERE id = $${pi}`, params);
      }

      // Mark source threads as dormant
      await client.query(`UPDATE story_threads SET status = 'dormant' WHERE id = ANY($1::int[])`, [srcIds]);

      await client.query('COMMIT');

      const { rows } = await client.query('SELECT article_count FROM story_threads WHERE id = $1', [targetId]);

      const afterTarget = await snapshotThreadRow(pool, targetId);
      logEditorEvent(pool, {
        eventType: 'thread.merge',
        entityType: 'thread',
        entityId: targetId,
        editorId: req.user?.id || null,
        before: beforeTarget,
        after: afterTarget,
        context: {
          source_ids: srcIds,
          sources_before: beforeSources,
          new_title: new_title || null,
          new_description: new_description || null,
          new_category: new_category || null,
        },
      });

      res.json({ ok: true, target_id: targetId, articles_merged: rows[0]?.article_count || 0, sources_retired: srcIds.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[admin/threads] merge error:', err.message);
    res.status(500).json({ error: 'Failed to merge threads' });
  }
});

// Split a thread: move a subset of its articles into a NEW thread and
// leave the rest on the original. Editor uses this when a thread has
// drifted to cover two distinct stories.
app.post('/api/admin/threads/:id/split', requireAdmin, async (req, res) => {
  try {
    const srcId = parseInt(req.params.id, 10);
    if (!srcId) return res.status(400).json({ error: 'Invalid ID' });

    const {
      article_ids,                   // articles to move into the new thread
      new_title,
      new_description,
      new_category,
      new_importance,
      new_keywords,
      new_primary_nations,
      new_geographic_scope,
      new_status,                    // default 'active'
    } = req.body || {};

    if (!Array.isArray(article_ids) || !article_ids.length) {
      return res.status(400).json({ error: 'article_ids[] required' });
    }
    if (!new_title) return res.status(400).json({ error: 'new_title required' });

    const moveIds = article_ids.map(x => parseInt(x, 10)).filter(Boolean);
    if (!moveIds.length) return res.status(400).json({ error: 'No valid article_ids' });

    const beforeSrc = await snapshotThreadRow(pool, srcId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Load source thread for metadata defaults
      const { rows: srcRows } = await client.query(
        `SELECT id, primary_category, importance, keywords, primary_nations, geographic_scope
         FROM story_threads WHERE id = $1`, [srcId]);
      if (!srcRows.length) throw new Error('Source thread not found');
      const src = srcRows[0];

      // Create new thread
      const { rows: newRows } = await client.query(`
        INSERT INTO story_threads
          (title, description, primary_category, importance, keywords,
           primary_nations, geographic_scope, status, article_count,
           first_seen_at, last_updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,NOW(),NOW())
        RETURNING id
      `, [
        new_title,
        new_description || null,
        new_category || src.primary_category,
        new_importance != null ? parseFloat(new_importance) : (src.importance || 5),
        Array.isArray(new_keywords) ? new_keywords
          : (typeof new_keywords === 'string' ? new_keywords.split(',').map(s=>s.trim()) : src.keywords || []),
        Array.isArray(new_primary_nations) ? new_primary_nations
          : (typeof new_primary_nations === 'string' ? new_primary_nations.split(',').map(s=>s.trim().toUpperCase()) : src.primary_nations || []),
        new_geographic_scope || src.geographic_scope || 'global',
        new_status || 'active'
      ]);
      const newId = newRows[0].id;

      // Move the requested articles to the new thread. Delete from source
      // first, then insert into new so we keep the (thread_id, article_id)
      // primary key uniqueness contract.
      const { rows: movedRows } = await client.query(`
        DELETE FROM story_thread_articles
        WHERE thread_id = $1 AND article_id = ANY($2::int[])
        RETURNING article_id, relevance_score, is_anchor, added_at
      `, [srcId, moveIds]);

      for (const r of movedRows) {
        await client.query(`
          INSERT INTO story_thread_articles
            (thread_id, article_id, relevance_score, is_anchor, added_at)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (thread_id, article_id) DO NOTHING
        `, [newId, r.article_id, r.relevance_score, r.is_anchor, r.added_at]);
      }

      // Refresh article_count on both threads
      await client.query(
        `UPDATE story_threads SET article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1),
                                  last_updated_at = NOW()
         WHERE id = $1`, [srcId]);
      await client.query(
        `UPDATE story_threads SET article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1),
                                  last_updated_at = NOW()
         WHERE id = $1`, [newId]);

      await client.query('COMMIT');

      const afterSrc = await snapshotThreadRow(pool, srcId);
      const afterNew = await snapshotThreadRow(pool, newId);
      logEditorEvent(pool, {
        eventType: 'thread.split',
        entityType: 'thread',
        entityId: srcId,
        editorId: req.user?.id || null,
        before: beforeSrc,
        after: afterSrc,
        context: {
          new_thread_id: newId,
          new_thread_snapshot: afterNew,
          moved_article_ids: movedRows.map(r => r.article_id),
          new_title, new_description: new_description || null,
          new_category: new_category || null,
          new_importance: new_importance ?? null,
          new_keywords: new_keywords ?? null,
          new_primary_nations: new_primary_nations ?? null,
          new_geographic_scope: new_geographic_scope || null,
        },
      });

      res.json({ ok: true, new_thread_id: newId, moved_articles: movedRows.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[admin/threads] split error:', err.message);
    res.status(500).json({ error: 'Failed to split thread: ' + err.message });
  }
});

// Hard-delete a thread and its junction rows. The articles themselves are
// NOT deleted — only the thread grouping and its article memberships.
app.delete('/api/admin/threads/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const before = await snapshotThreadRow(pool, id);
    // Capture which articles were attached so the miner can learn
    // "editor tends to delete threads with this pattern of sources".
    const { rows: articleRows } = await pool.query(
      `SELECT article_id FROM story_thread_articles WHERE thread_id = $1`, [id]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM story_thread_articles WHERE thread_id = $1', [id]);
      const { rowCount } = await client.query('DELETE FROM story_threads WHERE id = $1', [id]);
      await client.query('COMMIT');
      if (!rowCount) return res.status(404).json({ error: 'Thread not found' });

      logEditorEvent(pool, {
        eventType: 'thread.delete',
        entityType: 'thread',
        entityId: id,
        editorId: req.user?.id || null,
        before,
        after: null,
        context: { attached_article_ids: articleRows.map(r => r.article_id) },
      });

      res.json({ ok: true, deleted_id: id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[admin/threads] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete thread: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Timeline admin CRUD — parallel to threads (Layer 1 of editor completeness)
// ═══════════════════════════════════════════════════════════════════════════

// List timelines for the editor
app.get('/api/admin/timelines', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'active';
    const { rows } = await pool.query(`
      SELECT id, title, description, scope, status, importance, primary_category,
             geographic_scope, keywords, primary_nations, article_count,
             distinct_source_count, last_updated_at
      FROM story_timelines
      WHERE ($1 = 'all' OR status = $1)
      ORDER BY importance DESC, last_updated_at DESC
      LIMIT 500
    `, [status]);
    res.json({ timelines: rows });
  } catch (err) {
    console.error('[admin/timelines] list error:', err.message);
    res.status(500).json({ error: 'Failed to list timelines' });
  }
});

// Get a single timeline + its articles (for editor detail panel)
app.get('/api/admin/timelines/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const { rows: tlRows } = await pool.query(`
      SELECT id, title, description, scope, status, importance, primary_category,
             geographic_scope, keywords, primary_nations, secondary_nations,
             article_count, distinct_source_count, last_updated_at,
             NULL::text AS image_url
      FROM story_timelines WHERE id = $1
    `, [id]);
    if (!tlRows.length) return res.status(404).json({ error: 'Timeline not found' });

    const { rows: articles } = await pool.query(`
      SELECT a.id, COALESCE(a.translated_title, a.title) AS title,
             COALESCE(a.translated_summary, a.summary) AS summary,
             COALESCE(NULLIF(a.image_url, ''), img.public_url, '') AS image_url,
             a.article_url, a.published_at,
             COALESCE(ns.name, ys.name) AS source_name,
             sta.relevance_score
      FROM story_timeline_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img ON img.id = aia.image_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE sta.timeline_id = $1
      ORDER BY a.published_at DESC
      LIMIT 100
    `, [id]);

    res.json({ timeline: tlRows[0], articles });
  } catch (err) {
    console.error('[admin/timelines] detail error:', err.message);
    res.status(500).json({ error: 'Failed to get timeline' });
  }
});

// Update a timeline's editable fields
app.put('/api/admin/timelines/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const {
      title, description, scope, primary_category, importance,
      keywords, primary_nations, secondary_nations, status, geographic_scope
    } = req.body || {};

    const sets = []; const params = [];
    let pi = 1;

    // Tolerant ISO-list parser — accept array or comma string, normalize
    // to uppercase, drop anything that isn't a 2-3 letter ISO code.
    const _parseIsoList = (v) => {
      const arr = Array.isArray(v) ? v : String(v || '').split(',');
      return arr.map(k => String(k || '').trim().toUpperCase())
                .filter(k => /^[A-Z]{2,3}$/.test(k));
    };

    if (title !== undefined)            { sets.push(`title = $${pi++}`);            params.push(title); }
    if (description !== undefined)      { sets.push(`description = $${pi++}`);      params.push(description); }
    if (scope !== undefined)            { sets.push(`scope = $${pi++}`);            params.push(scope || null); }
    if (primary_category !== undefined) { sets.push(`primary_category = $${pi++}`); params.push(primary_category); }
    if (importance !== undefined)       { sets.push(`importance = $${pi++}`);       params.push(parseFloat(importance) || 5); }
    if (keywords !== undefined)         {
      sets.push(`keywords = $${pi++}`);
      params.push(Array.isArray(keywords) ? keywords : String(keywords || '').split(',').map(k=>k.trim()).filter(Boolean));
    }
    if (primary_nations !== undefined)   { sets.push(`primary_nations = $${pi++}`);   params.push(_parseIsoList(primary_nations)); }
    if (secondary_nations !== undefined) { sets.push(`secondary_nations = $${pi++}`); params.push(_parseIsoList(secondary_nations)); }
    if (status !== undefined)           { sets.push(`status = $${pi++}`);           params.push(status); }
    if (geographic_scope !== undefined) { sets.push(`geographic_scope = $${pi++}`); params.push(geographic_scope); }

    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    const before = await snapshotTimelineRow(pool, id);

    sets.push(`last_updated_at = NOW()`);
    params.push(id);

    try {
      await pool.query(`UPDATE story_timelines SET ${sets.join(', ')} WHERE id = $${pi}`, params);
    } catch (err) {
      // story_timelines_scope_unique violation → surface a clean 409
      if (err.code === '23505') return res.status(409).json({ error: 'Scope already in use by another timeline' });
      throw err;
    }

    const after = await snapshotTimelineRow(pool, id);
    logEditorEvent(pool, {
      eventType: 'timeline.update',
      entityType: 'timeline',
      entityId: id,
      editorId: req.user?.id || null,
      before, after,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/timelines] update error:', err.message);
    res.status(500).json({ error: 'Failed to update timeline' });
  }
});

// Merge timelines into a target (mirrors /api/admin/threads/merge)
app.post('/api/admin/timelines/merge', requireAdmin, async (req, res) => {
  try {
    const { target_id, source_ids, new_title, new_description, new_category, new_scope } = req.body || {};
    if (!target_id || !source_ids?.length) return res.status(400).json({ error: 'target_id and source_ids[] required' });

    const targetId = parseInt(target_id, 10);
    const srcIds = source_ids.map(x => parseInt(x, 10)).filter(x => x && x !== targetId);
    if (!srcIds.length) return res.status(400).json({ error: 'No valid source timelines to merge' });

    const beforeTarget = await snapshotTimelineRow(pool, targetId);
    const beforeSources = {};
    for (const sid of srcIds) beforeSources[sid] = await snapshotTimelineRow(pool, sid);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Move articles from source timelines into target, skipping duplicates
      for (const srcId of srcIds) {
        await client.query(`
          INSERT INTO story_timeline_articles
            (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor, added_at)
          SELECT $1, article_id, parabolic_weight, relevance_score, false, added_at
          FROM story_timeline_articles
          WHERE timeline_id = $2
          ON CONFLICT (timeline_id, article_id) DO NOTHING
        `, [targetId, srcId]);
      }

      // Union keywords, recompute counts
      await client.query(`
        UPDATE story_timelines SET
          keywords = (
            SELECT ARRAY(SELECT DISTINCT UNNEST(keywords) FROM story_timelines WHERE id = ANY($1::int[]))
          ),
          article_count = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $2),
          distinct_source_count = (
            SELECT COUNT(DISTINCT COALESCE(a.source_id::text, a.youtube_source_id::text))
            FROM story_timeline_articles sta
            JOIN news_articles a ON a.id = sta.article_id
            WHERE sta.timeline_id = $2
          ),
          last_updated_at = NOW()
        WHERE id = $2
      `, [[targetId, ...srcIds], targetId]);

      // Apply overrides if provided. `new_scope` may collide with the
      // unique constraint — handle that with a clean 409.
      if (new_title || new_description || new_category || new_scope) {
        const sets = []; const params = []; let pi = 1;
        if (new_title)       { sets.push(`title = $${pi++}`);            params.push(new_title); }
        if (new_description) { sets.push(`description = $${pi++}`);      params.push(new_description); }
        if (new_category)    { sets.push(`primary_category = $${pi++}`); params.push(new_category); }
        if (new_scope)       { sets.push(`scope = $${pi++}`);            params.push(new_scope); }
        params.push(targetId);
        try {
          await client.query(`UPDATE story_timelines SET ${sets.join(', ')} WHERE id = $${pi}`, params);
        } catch (err) {
          if (err.code === '23505') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'new_scope already in use by another timeline' });
          }
          throw err;
        }
      }

      // Retire source timelines. We null out their scope so the unique
      // constraint doesn't block a future timeline from claiming the same
      // slug, and mark status='merged' so they're excluded from editor
      // lists and builder re-use.
      await client.query(
        `UPDATE story_timelines SET status = 'merged', scope = NULL, last_updated_at = NOW()
         WHERE id = ANY($1::int[])`, [srcIds]);

      await client.query('COMMIT');

      const { rows } = await client.query(
        'SELECT article_count FROM story_timelines WHERE id = $1', [targetId]);

      const afterTarget = await snapshotTimelineRow(pool, targetId);
      logEditorEvent(pool, {
        eventType: 'timeline.merge',
        entityType: 'timeline',
        entityId: targetId,
        editorId: req.user?.id || null,
        before: beforeTarget,
        after: afterTarget,
        context: {
          source_ids: srcIds,
          sources_before: beforeSources,
          new_title: new_title || null,
          new_description: new_description || null,
          new_category: new_category || null,
          new_scope: new_scope || null,
        },
      });

      res.json({
        ok: true,
        target_id: targetId,
        articles_merged: rows[0]?.article_count || 0,
        sources_retired: srcIds.length
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[admin/timelines] merge error:', err.message);
    res.status(500).json({ error: 'Failed to merge timelines: ' + err.message });
  }
});

// Split a timeline (mirrors thread split)
app.post('/api/admin/timelines/:id/split', requireAdmin, async (req, res) => {
  try {
    const srcId = parseInt(req.params.id, 10);
    if (!srcId) return res.status(400).json({ error: 'Invalid ID' });

    const {
      article_ids,
      new_title,
      new_description,
      new_scope,
      new_category,
      new_importance,
      new_keywords,
      new_primary_nations,
      new_geographic_scope,
      new_status,
    } = req.body || {};

    if (!Array.isArray(article_ids) || !article_ids.length) {
      return res.status(400).json({ error: 'article_ids[] required' });
    }
    if (!new_title) return res.status(400).json({ error: 'new_title required' });

    const moveIds = article_ids.map(x => parseInt(x, 10)).filter(Boolean);
    if (!moveIds.length) return res.status(400).json({ error: 'No valid article_ids' });

    const beforeSrc = await snapshotTimelineRow(pool, srcId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: srcRows } = await client.query(
        `SELECT id, primary_category, importance, keywords, primary_nations,
                geographic_scope, lookback_days, parabolic_peak_hours
         FROM story_timelines WHERE id = $1`, [srcId]);
      if (!srcRows.length) throw new Error('Source timeline not found');
      const src = srcRows[0];

      let newId;
      try {
        const { rows: newRows } = await client.query(`
          INSERT INTO story_timelines
            (title, description, scope, primary_category, importance, keywords,
             primary_nations, geographic_scope, status, article_count,
             lookback_days, parabolic_peak_hours,
             first_seen_at, last_updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,NOW(),NOW())
          RETURNING id
        `, [
          new_title,
          new_description || null,
          new_scope || null,
          new_category || src.primary_category,
          new_importance != null ? parseFloat(new_importance) : (src.importance || 5),
          Array.isArray(new_keywords) ? new_keywords
            : (typeof new_keywords === 'string' ? new_keywords.split(',').map(s=>s.trim()) : src.keywords || []),
          Array.isArray(new_primary_nations) ? new_primary_nations
            : (typeof new_primary_nations === 'string' ? new_primary_nations.split(',').map(s=>s.trim().toUpperCase()) : src.primary_nations || []),
          new_geographic_scope || src.geographic_scope || 'global',
          new_status || 'active',
          src.lookback_days || 7,
          src.parabolic_peak_hours || 24,
        ]);
        newId = newRows[0].id;
      } catch (err) {
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'new_scope already in use' });
        }
        throw err;
      }

      const { rows: movedRows } = await client.query(`
        DELETE FROM story_timeline_articles
        WHERE timeline_id = $1 AND article_id = ANY($2::int[])
        RETURNING article_id, parabolic_weight, relevance_score, is_anchor, added_at
      `, [srcId, moveIds]);

      for (const r of movedRows) {
        await client.query(`
          INSERT INTO story_timeline_articles
            (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor, added_at)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (timeline_id, article_id) DO NOTHING
        `, [newId, r.article_id, r.parabolic_weight, r.relevance_score, r.is_anchor, r.added_at]);
      }

      // Refresh article_count on both sides
      for (const tid of [srcId, newId]) {
        await client.query(`
          UPDATE story_timelines
          SET article_count = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1),
              last_updated_at = NOW()
          WHERE id = $1
        `, [tid]);
      }

      await client.query('COMMIT');

      const afterSrc = await snapshotTimelineRow(pool, srcId);
      const afterNew = await snapshotTimelineRow(pool, newId);
      logEditorEvent(pool, {
        eventType: 'timeline.split',
        entityType: 'timeline',
        entityId: srcId,
        editorId: req.user?.id || null,
        before: beforeSrc,
        after: afterSrc,
        context: {
          new_timeline_id: newId,
          new_timeline_snapshot: afterNew,
          moved_article_ids: movedRows.map(r => r.article_id),
          new_title, new_description: new_description || null,
          new_scope: new_scope || null,
          new_category: new_category || null,
          new_importance: new_importance ?? null,
          new_keywords: new_keywords ?? null,
          new_primary_nations: new_primary_nations ?? null,
          new_geographic_scope: new_geographic_scope || null,
        },
      });

      res.json({ ok: true, new_timeline_id: newId, moved_articles: movedRows.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[admin/timelines] split error:', err.message);
    res.status(500).json({ error: 'Failed to split timeline: ' + err.message });
  }
});

// Remove a single article from a timeline
app.delete('/api/admin/timelines/:timelineId/articles/:articleId', requireAdmin, async (req, res) => {
  try {
    const timelineId = parseInt(req.params.timelineId, 10);
    const articleId  = parseInt(req.params.articleId, 10);
    if (!timelineId || !articleId) return res.status(400).json({ error: 'Invalid IDs' });

    const before = await snapshotTimelineRow(pool, timelineId);

    await pool.query('DELETE FROM story_timeline_articles WHERE timeline_id = $1 AND article_id = $2', [timelineId, articleId]);
    await pool.query(`
      UPDATE story_timelines
      SET article_count = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1),
          last_updated_at = NOW()
      WHERE id = $1
    `, [timelineId]);

    const after = await snapshotTimelineRow(pool, timelineId);
    logEditorEvent(pool, {
      eventType: 'timeline.remove_article',
      entityType: 'timeline',
      entityId: timelineId,
      editorId: req.user?.id || null,
      before, after,
      context: { article_id: articleId },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/timelines] remove article error:', err.message);
    res.status(500).json({ error: 'Failed to remove article' });
  }
});

// Hard-delete a timeline. Junction rows cascade via FK (ON DELETE CASCADE)
// on story_timeline_articles; data panels are scoped differently (no FK)
// so we clear them explicitly.
app.delete('/api/admin/timelines/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const before = await snapshotTimelineRow(pool, id);
    const { rows: articleRows } = await pool.query(
      `SELECT article_id FROM story_timeline_articles WHERE timeline_id = $1`, [id]);
    const { rows: panelRows } = await pool.query(
      `SELECT id FROM data_panels WHERE scope_type = 'timeline' AND scope_id = $1`, [id]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM data_panels WHERE scope_type = 'timeline' AND scope_id = $1`, [id]);
      await client.query('DELETE FROM story_timeline_articles WHERE timeline_id = $1', [id]);
      const { rowCount } = await client.query('DELETE FROM story_timelines WHERE id = $1', [id]);
      await client.query('COMMIT');
      if (!rowCount) return res.status(404).json({ error: 'Timeline not found' });

      logEditorEvent(pool, {
        eventType: 'timeline.delete',
        entityType: 'timeline',
        entityId: id,
        editorId: req.user?.id || null,
        before,
        after: null,
        context: {
          attached_article_ids: articleRows.map(r => r.article_id),
          deleted_panel_ids: panelRows.map(r => r.id),
        },
      });

      res.json({ ok: true, deleted_id: id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[admin/timelines] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete timeline: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Regions editor — polygon boundaries for the middle-ground story layer
//
// The regions table (164 rows) has centroid_lat/lng for each cultural /
// geographic region. These endpoints expose + mutate the new polygon
// `geom` column so the in-browser editor (www/region-editor.html) can
// enrich each region with a proper boundary. All read/write on wire is
// GeoJSON; PostGIS is the storage layer via ST_GeomFromGeoJSON /
// ST_AsGeoJSON. snap_to_coast is a per-region flag the editor honors
// (land-bounded regions default TRUE; oceanic / archipelago regions
// flipped FALSE so the ocean can be part of the polygon).
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/regions — full FeatureCollection. Regions with no geom
// drawn yet come back with geometry=null so the editor can show them in
// the "empty" list.
app.get('/api/admin/regions', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id, name, slug, continent_id, color, population,
        centroid_lng::float AS centroid_lng,
        centroid_lat::float AS centroid_lat,
        snap_to_coast,
        geom_updated_at,
        CASE WHEN geom IS NULL THEN NULL
             ELSE ST_AsGeoJSON(geom)::json END AS geometry
      FROM regions
      ORDER BY name
    `);
    const features = rows.map(r => ({
      type: 'Feature',
      id: r.id,
      geometry: r.geometry,
      properties: {
        id: r.id, name: r.name, slug: r.slug,
        continent_id: r.continent_id,
        color: r.color, population: r.population,
        centroid: [r.centroid_lng, r.centroid_lat],
        snap_to_coast: r.snap_to_coast,
        geom_updated_at: r.geom_updated_at,
        has_geom: !!r.geometry,
      },
    }));
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('[admin/regions] list error:', err.message);
    res.status(500).json({ error: 'Failed to list regions' });
  }
});

// GET /api/admin/regions/near — MUST come before /:id so "near" isn't
// treated as a numeric id. Returns neighbor polygons overlapping the
// given bbox for editor snap targeting.
app.get('/api/admin/regions/near', requireAdmin, async (req, res) => {
  try {
    const parts = String(req.query.bbox || '').split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      return res.status(400).json({ error: 'bbox=minLng,minLat,maxLng,maxLat required' });
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    const excludeId = parseInt(req.query.exclude, 10) || 0;
    const { rows } = await pool.query(`
      SELECT
        id, name, slug,
        ST_AsGeoJSON(geom)::json AS geometry
      FROM regions
      WHERE geom IS NOT NULL
        AND id <> $5
        AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      LIMIT 80
    `, [minLng, minLat, maxLng, maxLat, excludeId]);
    res.json({
      type: 'FeatureCollection',
      features: rows.map(r => ({
        type: 'Feature', id: r.id,
        geometry: r.geometry,
        properties: { id: r.id, name: r.name, slug: r.slug },
      })),
    });
  } catch (err) {
    console.error('[admin/regions/near] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch neighbor regions' });
  }
});

// GET /api/admin/regions/:id — single region as GeoJSON Feature.
app.get('/api/admin/regions/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });
    const { rows } = await pool.query(`
      SELECT
        id, name, slug, continent_id, color, population,
        centroid_lng::float AS centroid_lng,
        centroid_lat::float AS centroid_lat,
        snap_to_coast,
        geom_updated_at,
        CASE WHEN geom IS NULL THEN NULL
             ELSE ST_AsGeoJSON(geom)::json END AS geometry
      FROM regions WHERE id = $1
    `, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Region not found' });
    const r = rows[0];
    res.json({
      type: 'Feature',
      id: r.id,
      geometry: r.geometry,
      properties: {
        id: r.id, name: r.name, slug: r.slug,
        continent_id: r.continent_id,
        color: r.color, population: r.population,
        centroid: [r.centroid_lng, r.centroid_lat],
        snap_to_coast: r.snap_to_coast,
        geom_updated_at: r.geom_updated_at,
        has_geom: !!r.geometry,
      },
    });
  } catch (err) {
    console.error('[admin/regions] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch region' });
  }
});

// PATCH /api/admin/regions/:id — save geom and/or flags.
//
// Body accepts any subset of:
//   { geometry: <GeoJSON Polygon | MultiPolygon | null>,
//     snap_to_coast: boolean,
//     color: string,
//     name: string, slug: string, continent_id: int, population: int }
//
// Polygon geometries are auto-upcast to MultiPolygon via ST_Multi so the
// column type stays consistent regardless of how the editor serialized.
// Passing geometry=null clears the geom (unpaints the region).
app.patch('/api/admin/regions/:id', requireAdmin, express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const b = req.body || {};
    const sets = []; const params = []; let pi = 1;
    let geomTouched = false;

    if ('geometry' in b) {
      geomTouched = true;
      if (b.geometry === null) {
        sets.push(`geom = NULL`);
        sets.push(`geom_updated_at = NOW()`);
      } else {
        if (typeof b.geometry !== 'object' || !b.geometry.type) {
          return res.status(400).json({ error: 'geometry must be a GeoJSON Polygon or MultiPolygon' });
        }
        // Sanitize on the way in so the column (strict MultiPolygon) is
        // always satisfied regardless of editor state:
        //   ST_SetSRID            — tag input as WGS84 (4326)
        //   ST_MakeValid          — heal self-intersections from sloppy drags
        //                           (returns a GeometryCollection when it has to
        //                           split a bowtie polygon into multiple parts,
        //                           or demote a degenerate edge to a LineString)
        //   ST_CollectionExtract  — pull only the polygon components (type=3)
        //                           out of that collection, discarding any
        //                           stray LineStrings / Points the fix produced
        //   ST_Multi              — ensure result is always MultiPolygon, never
        //                           a bare Polygon, so the column type is stable
        // This combo is the canonical PostGIS recipe for "save whatever the
        // editor drew, no matter how messy."
        sets.push(`geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($${pi++}::text), 4326)), 3))`);
        params.push(JSON.stringify(b.geometry));
        sets.push(`geom_updated_at = NOW()`);
      }
    }
    if ('snap_to_coast' in b) { sets.push(`snap_to_coast = $${pi++}`); params.push(!!b.snap_to_coast); }
    if ('color' in b)         { sets.push(`color = $${pi++}`);         params.push(b.color || null); }
    if ('name' in b)          { sets.push(`name = $${pi++}`);          params.push(String(b.name || '').trim()); }
    if ('slug' in b)          { sets.push(`slug = $${pi++}`);          params.push(String(b.slug || '').trim()); }
    if ('continent_id' in b)  { sets.push(`continent_id = $${pi++}`);  params.push(b.continent_id); }
    if ('population' in b)    { sets.push(`population = $${pi++}`);    params.push(b.population); }

    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    try {
      await pool.query(`UPDATE regions SET ${sets.join(', ')} WHERE id = $${pi}`, params);
    } catch (err) {
      // Invalid GeoJSON from the editor shows up as a Postgres error here;
      // surface the message to the editor so the user sees why save failed.
      if (geomTouched && /geojson|linear ring|self-intersection|invalid/i.test(err.message)) {
        return res.status(400).json({ error: 'Invalid polygon geometry: ' + err.message });
      }
      throw err;
    }

    // Return the saved row back, rendered the same way as GET. Editor can
    // drop it straight in place without re-querying.
    const { rows } = await pool.query(`
      SELECT
        id, name, slug, continent_id, color, population,
        centroid_lng::float AS centroid_lng,
        centroid_lat::float AS centroid_lat,
        snap_to_coast, geom_updated_at,
        CASE WHEN geom IS NULL THEN NULL
             ELSE ST_AsGeoJSON(geom)::json END AS geometry
      FROM regions WHERE id = $1
    `, [id]);
    const r = rows[0];
    res.json({
      type: 'Feature',
      id: r.id,
      geometry: r.geometry,
      properties: {
        id: r.id, name: r.name, slug: r.slug,
        continent_id: r.continent_id,
        color: r.color, population: r.population,
        centroid: [r.centroid_lng, r.centroid_lat],
        snap_to_coast: r.snap_to_coast,
        geom_updated_at: r.geom_updated_at,
        has_geom: !!r.geometry,
      },
    });
  } catch (err) {
    console.error('[admin/regions] patch error:', err.message);
    res.status(500).json({ error: 'Failed to save region' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Manual (curator-created) Lines
//
// Create Lines that the organic thread→line pipeline would never surface
// because their constituent stories never spike hard enough for 3-sources-
// in-24h thread creation. Once created, the normal umbrella phase in
// storyTimelineBuilder picks them up on every run and attaches matching
// articles from the last 7 days. For historical catchup at creation
// time, POST /backfill-articles runs a one-shot scan over a wider
// window. Manual Lines are immune to the multi-thread quality gate
// (story_timelines.is_manual = TRUE).
// ═══════════════════════════════════════════════════════════════════════════

// Same umbrella scoring the builder uses (entityTierClassifier + loop in
// storyTimelineBuilder.runArticleUmbrellaPhase). Duplicated here to keep
// the builder's internal IIFE clean.
//
// Threshold note: the real-time umbrella phase uses 4.0 but also scores
// on entity overlap (+2.5 per shared entity). This backfill path skips
// entities (loading deep_context for thousands of candidates would be
// expensive), so 3.0 here compensates — equivalent to "nation match +
// at least one keyword or title-token hit" instead of requiring the
// stronger entity signal.
const UMBRELLA_ATTACH_THRESHOLD_FOR_BACKFILL = 3.0;
const UMBRELLA_CAP_PER_BACKFILL_RUN          = 500;

function _parseIsoListField(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return arr.map(k => String(k || '').trim().toUpperCase())
            .filter(k => /^[A-Z]{2,3}$/.test(k));
}
function _normKwList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return arr.map(k => String(k || '').trim()).filter(Boolean);
}

function _slugifyName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

// POST /api/admin/timelines — create a manual Line.
//
// Body:
//   {
//     name, description, keywords: [], primary_category,
//     geographic_scope, importance,
//     primary_nations: [], secondary_nations: []
//   }
//
// On success: returns the new row. Caller can immediately POST to
// /api/admin/timelines/:id/backfill-articles to pull historical coverage.
app.post('/api/admin/timelines', requireAdmin, express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });

    const keywords        = _normKwList(b.keywords);
    const primaryNations  = _parseIsoListField(b.primary_nations);
    const secondaryNations = _parseIsoListField(b.secondary_nations);
    const slug            = b.slug ? _slugifyName(b.slug) : _slugifyName(name);
    if (!slug) return res.status(400).json({ error: 'could not derive slug from name' });

    // Guard: avoid slug collisions with existing rows. Append -manual or
    // -manual-N until a free slot is found.
    let finalSlug = slug;
    let suffix = 0;
    while (true) {
      const { rows } = await pool.query(
        `SELECT 1 FROM story_timelines WHERE scope = $1 LIMIT 1`,
        [finalSlug]
      );
      if (!rows.length) break;
      suffix++;
      finalSlug = `${slug}-manual${suffix > 1 ? `-${suffix}` : ''}`;
      if (suffix > 20) return res.status(409).json({ error: 'slug collision — pick a different name' });
    }

    const { rows } = await pool.query(`
      INSERT INTO story_timelines
        (title, description, scope, status, importance, primary_category,
         geographic_scope, keywords, primary_nations, secondary_nations,
         article_count, first_seen_at, last_updated_at,
         is_manual, created_by)
      VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9,
              0, NOW(), NOW(),
              TRUE, $10)
      RETURNING id, title, scope, status, importance, primary_category,
                geographic_scope, keywords, primary_nations, secondary_nations,
                article_count, first_seen_at, last_updated_at, is_manual, created_by
    `, [
      name,
      String(b.description || '').slice(0, 2000),
      finalSlug,
      parseFloat(b.importance) || 5,
      b.primary_category || 'politics',
      b.geographic_scope || 'global',
      keywords,
      primaryNations,
      secondaryNations,
      req.user?.id || req.user?.email || 'admin',
    ]);

    const created = rows[0];

    // Log for audit parity with the rest of the editor.
    try {
      logEditorEvent(pool, {
        eventType: 'timeline.manual_create',
        entityType: 'timeline',
        entityId: created.id,
        editorId: req.user?.id || null,
        before: null,
        after: created,
      });
    } catch (_) {}

    res.json({ ok: true, timeline: created });
  } catch (err) {
    console.error('[admin/timelines] manual create error:', err.message);
    res.status(500).json({ error: 'Failed to create manual Line: ' + err.message });
  }
});

// POST /api/admin/timelines/:id/backfill-articles?days=90
//
// One-shot historical catch-up for manual (or any) Line. Pulls articles
// published in the last N days that match the Line's primary_nations
// ∪ keywords, scores them against the Line's umbrella, and attaches
// anything scoring >= UMBRELLA_ATTACH_THRESHOLD_FOR_BACKFILL (4.0).
//
// Same algorithm and thresholds as storyTimelineBuilder's umbrella
// phase, just with a configurable (wider) lookback window. Returns
// { scanned, attached, lookback_days }.
app.post('/api/admin/timelines/:id/backfill-articles', requireAdmin, async (req, res) => {
  try {
    const timelineId = parseInt(req.params.id, 10);
    if (!timelineId) return res.status(400).json({ error: 'Invalid ID' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);

    const { rows: tlRows } = await pool.query(`
      SELECT id, title, keywords, primary_nations, secondary_nations
      FROM story_timelines WHERE id = $1
    `, [timelineId]);
    if (!tlRows.length) return res.status(404).json({ error: 'Timeline not found' });
    const line = tlRows[0];

    const nations = (line.primary_nations || []).concat(line.secondary_nations || [])
      .map(s => String(s || '').trim().toUpperCase())
      .filter(s => /^[A-Z]{2,3}$/.test(s));
    // Normalize keywords the same way keywordNormalizer does — lowercase,
    // strip diacritics, strip punctuation. This matches what's stored in
    // article_keywords.normalized_keyword so the pre-filter actually hits.
    const keywords = (line.keywords || [])
      .map(k => String(k || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      )
      .filter(Boolean);

    if (!nations.length && !keywords.length) {
      return res.status(400).json({ error: 'Line has no primary_nations or keywords to match articles against' });
    }

    // Pre-filter: articles published in the window, attached-nowhere-yet
    // on this Line, that share at least one nation OR normalized keyword.
    // UNION of two indexed branches keeps this fast even at 365 days.
    const { rows: candidates } = await pool.query(`
      SELECT DISTINCT ON (id) id, title, published_at, iso_code
      FROM (
        SELECT a.id, a.title, a.published_at, co.iso_code
        FROM news_articles a
        JOIN countries co ON co.id = a.country_id
        WHERE cardinality($2::text[]) > 0
          AND a.published_at >= NOW() - ($4 * INTERVAL '1 day')
          AND co.iso_code = ANY($2::text[])
          AND NOT EXISTS (
            SELECT 1 FROM story_timeline_articles sta
            WHERE sta.timeline_id = $1 AND sta.article_id = a.id
          )
        UNION
        SELECT a.id, a.title, a.published_at, co.iso_code
        FROM article_keywords ak
        JOIN news_articles a ON a.id = ak.article_id
        LEFT JOIN countries co ON co.id = a.country_id
        WHERE cardinality($3::text[]) > 0
          AND ak.normalized_keyword = ANY($3::text[])
          AND a.published_at >= NOW() - ($4 * INTERVAL '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM story_timeline_articles sta
            WHERE sta.timeline_id = $1 AND sta.article_id = a.id
          )
      ) u
      ORDER BY id, published_at DESC
      LIMIT ${UMBRELLA_CAP_PER_BACKFILL_RUN * 4}
    `, [timelineId, nations, keywords, days]);

    if (!candidates.length) {
      return res.json({ ok: true, scanned: 0, attached: 0, lookback_days: days });
    }

    // Per-article scoring mirrors storyTimelineBuilder's umbrella scoring.
    // We pull article_keywords for the candidate set in bulk (one query).
    const candIds = candidates.map(c => Number(c.id));
    const { rows: akRows } = await pool.query(`
      SELECT article_id, COALESCE(normalized_keyword, LOWER(keyword)) AS kw
      FROM article_keywords WHERE article_id = ANY($1::int[])
    `, [candIds]);
    const kwByArticle = new Map();
    for (const r of akRows) {
      if (!kwByArticle.has(r.article_id)) kwByArticle.set(r.article_id, new Set());
      kwByArticle.get(r.article_id).add(r.kw);
    }

    // Title tokenizer matching storyTimelineBuilder (drops stopwords, min 3 chars)
    const TITLE_STOP = new Set([
      'the','a','an','of','in','on','at','to','for','and','or','but','is','are','was','were',
      'with','from','by','as','that','this','its','it','after','before','over','under',
      'new','old','first','last','top','all','some','any','news','report','update',
      'coverage','story','analysis',
    ]);
    const tokTitle = (t) => new Set(String(t || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !TITLE_STOP.has(w)));

    const lineNationSet  = new Set(nations);
    const lineKwSet      = new Set(keywords);
    // Title tokens come from the Line's own title (e.g. "Ethiopia Tigray
    // Recovery" → {"ethiopia","tigray","recovery"}) so articles whose
    // titles mention those words score higher.
    const lineTitleToks  = tokTitle(line.title || '');
    const intersect = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

    // Weights identical to the builder (see W_* constants).
    const W_ENTITY = 2.5, W_NATION = 2.5, W_KEYWORD = 1.0, W_TITLE = 0.4;
    const ENTITY_CAP = 6, KEYWORD_CAP = 8;

    const qualified = [];
    for (const c of candidates) {
      const artNations = new Set(c.iso_code ? [String(c.iso_code).toUpperCase()] : []);
      const artKws     = kwByArticle.get(Number(c.id)) || new Set();
      const artTtk     = tokTitle(c.title);

      const nat = intersect(artNations, lineNationSet);
      const kw  = Math.min(KEYWORD_CAP, intersect(artKws, lineKwSet));
      const ttk = intersect(artTtk, lineTitleToks);
      // No entity scoring in this lightweight path — article_deep_context
      // for every candidate would be expensive; keywords + nations +
      // title tokens is enough to score honestly for backfill.

      const score = nat * W_NATION + kw * W_KEYWORD + ttk * W_TITLE;
      if (score >= UMBRELLA_ATTACH_THRESHOLD_FOR_BACKFILL) {
        qualified.push({ articleId: Number(c.id), score });
      }
    }

    // Rank + cap. Strongest matches in first.
    qualified.sort((a, b) => b.score - a.score);
    const toAttach = qualified.slice(0, UMBRELLA_CAP_PER_BACKFILL_RUN);

    let attached = 0;
    if (toAttach.length) {
      const ids  = toAttach.map(a => a.articleId);
      const rels = toAttach.map(a => a.score);
      const r = await pool.query(`
        INSERT INTO story_timeline_articles
          (timeline_id, article_id, relevance_score, parabolic_weight, is_anchor, added_at)
        SELECT $1, unnest($2::int[]), unnest($3::float8[]), 1.0, false, NOW()
        ON CONFLICT (timeline_id, article_id) DO NOTHING
      `, [timelineId, ids, rels]);
      attached = r.rowCount || 0;

      // Bump last_updated_at + article_count.
      await pool.query(`
        UPDATE story_timelines
           SET last_updated_at = NOW(),
               article_count   = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1)
         WHERE id = $1
      `, [timelineId]);
    }

    res.json({
      ok: true,
      scanned: candidates.length,
      qualified: qualified.length,
      attached,
      lookback_days: days,
    });
  } catch (err) {
    console.error('[admin/timelines] backfill error:', err.message);
    res.status(500).json({ error: 'Backfill failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Editorial rule miner — Layer 3
// Trigger a fresh mine of editor_events → editorial_rules.
// Also expose a read endpoint so the admin UI can inspect / toggle rules.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/mine-rules', requireAdmin, async (req, res) => {
  try {
    const { run: runMiner } = require('./editorialRuleMiner');
    const { invalidateCache } = require('./editorialRuleInjector');
    const result = await runMiner({ db: pool });
    invalidateCache(); // so the next Claude call picks up fresh rules
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin/mine-rules] error:', err.message);
    res.status(500).json({ error: 'Mine failed: ' + err.message });
  }
});

app.get('/api/admin/editorial-rules', requireAdmin, async (req, res) => {
  try {
    const entityType = req.query.entity_type || null;
    const { rows } = await pool.query(`
      SELECT id, rule_key, entity_type, scope, rule_text, override_text,
             pattern, confidence, sample_count, last_seen_at, last_mined_at,
             enabled
      FROM editorial_rules
      WHERE ($1::text IS NULL OR entity_type = $1 OR entity_type = 'both')
      ORDER BY enabled DESC, confidence DESC, sample_count DESC
      LIMIT 200
    `, [entityType]);
    res.json({ rules: rows });
  } catch (err) {
    console.error('[admin/editorial-rules] list error:', err.message);
    res.status(500).json({ error: 'List failed' });
  }
});

// Toggle / edit a rule (enabled flag + optional override_text)
app.put('/api/admin/editorial-rules/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });
    const { enabled, override_text } = req.body || {};
    const sets = []; const params = []; let pi = 1;
    if (enabled !== undefined)       { sets.push(`enabled = $${pi++}`);       params.push(!!enabled); }
    if (override_text !== undefined) { sets.push(`override_text = $${pi++}`); params.push(override_text || null); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);
    await pool.query(`UPDATE editorial_rules SET ${sets.join(', ')} WHERE id = $${pi}`, params);
    try { require('./editorialRuleInjector').invalidateCache(); } catch {}
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/editorial-rules] update error:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

// Backfill primary_nations from explicit mentions in thread/timeline
// title + description ONLY. We deliberately do NOT scan article bodies
// here — that pulled in any country a publisher happened to name in a
// summary even when the story wasn't about it (Iran-leak threads were
// attaching Paraguay/Georgia, etc.). The strict gazetteer in
// nationExtractor.js handles canonical names, demonyms, aliases, major
// cities, and ambiguity guards (Georgia/Jordan/Chad/Niger/Mali).
app.post('/api/admin/backfill-nations', requireAdmin, async (req, res) => {
  try {
    const gaz = await loadNationGazetteer(pool);

    let threadCount = 0;
    // Skip local-scope threads — they already have explicit
    // primary_nations from localStoryBuilder (one country per thread).
    const { rows: threads } = await pool.query(`
      SELECT id, title, description FROM story_threads
      WHERE status IN ('active','cooling','dormant')
        AND COALESCE(scope, 'global') = 'global'
    `);
    for (const t of threads) {
      const arr = extractNations((t.title || '') + ' \n ' + (t.description || ''), gaz);
      await pool.query('UPDATE story_threads SET primary_nations = $1 WHERE id = $2', [arr, t.id]);
      threadCount++;
    }

    let timelineCount = 0;
    const { rows: timelines } = await pool.query(`
      SELECT id, title, description FROM story_timelines
      WHERE status IN ('active','cooling','dormant')
    `);
    for (const t of timelines) {
      const arr = extractNations((t.title || '') + ' \n ' + (t.description || ''), gaz);
      await pool.query('UPDATE story_timelines SET primary_nations = $1 WHERE id = $2', [arr, t.id]);
      timelineCount++;
    }

    console.log(`[backfill-nations] Updated ${threadCount} threads, ${timelineCount} timelines`);
    res.json({ ok: true, threads: threadCount, timelines: timelineCount });
  } catch (err) {
    console.error('[backfill-nations] error:', err.message);
    res.status(500).json({ error: 'Backfill failed: ' + err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   User Preferences — Onboarding questionnaire + feed personalization
   Stored in Supabase user_preferences table.
   ═══════════════════════════════════════════════════════════════ */

// Admin: create the user_preferences table in Supabase
app.post('/api/admin/create-preferences-table', requireAdmin, async (req, res) => {
  try {
    const { error } = await sba.rpc('exec_sql', { sql: `
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        home_country TEXT,
        interest_regions JSONB NOT NULL DEFAULT '[]',
        interest_topics JSONB NOT NULL DEFAULT '[]',
        interest_sectors JSONB NOT NULL DEFAULT '[]',
        languages JSONB NOT NULL DEFAULT '[]',
        diversity_pref INTEGER NOT NULL DEFAULT 50,
        depth_pref TEXT NOT NULL DEFAULT 'both',
        onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN
        CREATE POLICY "Users can view own preferences" ON user_preferences FOR SELECT USING (auth.uid() = user_id);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE POLICY "Users can insert own preferences" ON user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE POLICY "Users can update own preferences" ON user_preferences FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `});
    if (error) {
      // rpc may not exist — provide SQL for manual execution
      console.warn('[preferences] Could not auto-create table:', error.message);
      return res.status(200).json({
        ok: false,
        message: 'Table creation via RPC failed. Run the SQL in Supabase SQL Editor manually.',
        sql_file: 'migrations/20260414_user_preferences.sql'
      });
    }
    res.json({ ok: true, message: 'user_preferences table created' });
  } catch (err) {
    console.error('[preferences] create table error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/preferences — fetch current user's preferences
app.get('/api/user/preferences', optionalAuth, async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { data, error } = await sba
      .from('user_preferences')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json(data || { onboarding_completed: false });
  } catch (err) {
    // Table may not exist yet
    if (err.code === '42P01' || err.message?.includes('user_preferences')) {
      return res.json({ onboarding_completed: false, _tableNotFound: true });
    }
    console.error('[preferences] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/user/preferences — upsert user preferences
app.put('/api/user/preferences', optionalAuth, async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const {
      home_country, interest_regions, excluded_countries, interest_topics,
      interest_sectors, languages, diversity_pref,
      depth_pref, onboarding_completed
    } = req.body;

    const row = {
      user_id: req.user.id,
      updated_at: new Date().toISOString()
    };
    if (home_country !== undefined)         row.home_country = home_country;
    if (interest_regions !== undefined)      row.interest_regions = interest_regions;
    if (excluded_countries !== undefined)    row.excluded_countries = excluded_countries;
    if (interest_topics !== undefined)       row.interest_topics = interest_topics;
    if (interest_sectors !== undefined)      row.interest_sectors = interest_sectors;
    if (languages !== undefined)             row.languages = languages;
    if (diversity_pref !== undefined)        row.diversity_pref = diversity_pref;
    if (depth_pref !== undefined)            row.depth_pref = depth_pref;
    if (onboarding_completed !== undefined)  row.onboarding_completed = onboarding_completed;

    const { data, error } = await sba
      .from('user_preferences')
      .upsert(row, { onConflict: 'user_id' })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[preferences] PUT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Remove an article from a thread
app.delete('/api/admin/threads/:threadId/articles/:articleId', requireAdmin, async (req, res) => {
  try {
    const threadId = parseInt(req.params.threadId, 10);
    const articleId = parseInt(req.params.articleId, 10);
    if (!threadId || !articleId) return res.status(400).json({ error: 'Invalid IDs' });

    const before = await snapshotThreadRow(pool, threadId);

    await pool.query('DELETE FROM story_thread_articles WHERE thread_id = $1 AND article_id = $2', [threadId, articleId]);
    await pool.query('UPDATE story_threads SET article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1) WHERE id = $1', [threadId]);

    const after = await snapshotThreadRow(pool, threadId);
    logEditorEvent(pool, {
      eventType: 'thread.remove_article',
      entityType: 'thread',
      entityId: threadId,
      editorId: req.user?.id || null,
      before, after,
      context: { article_id: articleId },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/threads] remove article error:', err.message);
    res.status(500).json({ error: 'Failed to remove article' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RANKING OVERRIDES + PREFERENCE LEARNING
// ═══════════════════════════════════════════════════════════════════════════

// Get ranked list with overrides applied
app.get('/api/admin/rankings/:entityType', requireAdmin, async (req, res) => {
  try {
    const entityType = req.params.entityType; // 'thread' or 'timeline'
    if (!['thread', 'timeline'].includes(entityType)) return res.status(400).json({ error: 'Invalid entity type' });

    const table = entityType === 'thread' ? 'story_threads' : 'story_timelines';

    // Load entities
    const { rows: entities } = await pool.query(`
      SELECT id, title, primary_category, importance, article_count, status,
             last_updated_at, ${entityType === 'thread' ? 'distinct_source_count, breaking_signal_score' : 'distinct_source_count, parabolic_weight_sum'}
      FROM ${table}
      WHERE status IN ('active', 'cooling')
        AND article_count >= 2
      ORDER BY importance DESC, article_count DESC
      LIMIT 500
    `);

    // Load overrides
    const { rows: overrides } = await pool.query(
      `SELECT entity_id, pinned_rank, boost FROM ranking_overrides WHERE entity_type = $1`,
      [entityType]
    );
    const overrideMap = new Map(overrides.map(o => [o.entity_id, o]));

    // Load learned weights
    const { rows: weights } = await pool.query(
      `SELECT feature_name, weight, sample_count FROM ranking_model_weights WHERE entity_type = $1`,
      [entityType]
    );
    const weightMap = new Map(weights.map(w => [w.feature_name, { weight: w.weight, samples: w.sample_count }]));

    // Compute learned score for each entity
    const now = Date.now();
    const scored = entities.map(e => {
      const ageHours = e.last_updated_at ? (now - new Date(e.last_updated_at).getTime()) / 3600000 : 999;
      const features = {
        importance:     e.importance || 5,
        article_count:  e.article_count || 0,
        source_count:   e.distinct_source_count || 0,
        breaking_signal: e.breaking_signal_score || 0,
        recency_hours:  ageHours,
        is_conflict:    ['conflict', 'military'].includes(e.primary_category) ? 1 : 0,
        is_politics:    ['politics', 'diplomacy'].includes(e.primary_category) ? 1 : 0,
        is_economy:     e.primary_category === 'economy' ? 1 : 0,
      };

      let learnedScore = 0;
      for (const [feat, val] of Object.entries(features)) {
        const w = weightMap.get(feat);
        if (w) learnedScore += w.weight * val;
      }

      const override = overrideMap.get(e.id);
      const boost = override?.boost || 0;

      return {
        ...e,
        learned_score: +(learnedScore + boost).toFixed(3),
        pinned_rank: override?.pinned_rank || null,
        boost: boost,
        features,
      };
    });

    // Sort: pinned items get their exact position, others by learned_score
    scored.sort((a, b) => b.learned_score - a.learned_score);

    // Insert pinned items at their positions
    const pinned = scored.filter(e => e.pinned_rank != null).sort((a, b) => a.pinned_rank - b.pinned_rank);
    const unpinned = scored.filter(e => e.pinned_rank == null);

    const final = [...unpinned];
    for (const p of pinned) {
      const idx = Math.max(0, Math.min(final.length, p.pinned_rank - 1));
      final.splice(idx, 0, p);
    }

    // Add rank numbers
    final.forEach((e, i) => { e.rank = i + 1; });

    res.json({
      entities: final,
      weights: Object.fromEntries(weights.map(w => [w.feature_name, { weight: w.weight, samples: w.sample_count }])),
      total_feedback: weights.reduce((s, w) => Math.max(s, w.sample_count), 0),
    });
  } catch (err) {
    console.error('[admin/rankings] error:', err.message);
    res.status(500).json({ error: 'Failed to load rankings' });
  }
});

// Save ranking adjustment (override + feedback log)
app.post('/api/admin/rankings/:entityType/adjust', requireAdmin, async (req, res) => {
  try {
    const entityType = req.params.entityType;
    if (!['thread', 'timeline'].includes(entityType)) return res.status(400).json({ error: 'Invalid entity type' });

    const { entity_id, old_rank, new_rank, old_importance, new_importance, pinned_rank, boost, features } = req.body;
    if (!entity_id) return res.status(400).json({ error: 'entity_id required' });

    const table = entityType === 'thread' ? 'story_threads' : 'story_timelines';

    // Upsert override
    if (pinned_rank != null || boost != null) {
      await pool.query(`
        INSERT INTO ranking_overrides (entity_type, entity_id, pinned_rank, boost, pinned_by, pinned_at)
        VALUES ($1, $2, $3, $4, 'admin', NOW())
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET
          pinned_rank = COALESCE($3, ranking_overrides.pinned_rank),
          boost = COALESCE($4, ranking_overrides.boost),
          pinned_by = 'admin',
          pinned_at = NOW()
      `, [entityType, entity_id, pinned_rank || null, boost || 0]);
    }

    // Update importance if changed
    if (new_importance != null && new_importance !== old_importance) {
      await pool.query(`UPDATE ${table} SET importance = $1 WHERE id = $2`, [new_importance, entity_id]);
    }

    // Log feedback for learning
    if (old_rank != null && new_rank != null) {
      const feat = features || {};
      await pool.query(`
        INSERT INTO ranking_feedback
          (entity_type, entity_id, old_rank, new_rank, old_importance, new_importance,
           article_count, source_count, breaking_signal, category, status, age_hours, feedback_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'admin')
      `, [
        entityType, entity_id, old_rank, new_rank,
        old_importance || null, new_importance || null,
        feat.article_count || null, feat.source_count || null,
        feat.breaking_signal || null, feat.category || null,
        feat.status || null, feat.age_hours || null,
      ]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/rankings] adjust error:', err.message);
    res.status(500).json({ error: 'Failed to save adjustment' });
  }
});

// Clear override for an entity
app.delete('/api/admin/rankings/:entityType/:entityId', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM ranking_overrides WHERE entity_type = $1 AND entity_id = $2`,
      [req.params.entityType, parseInt(req.params.entityId, 10)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear override' });
  }
});

// Retrain model from feedback
app.post('/api/admin/rankings/:entityType/retrain', requireAdmin, async (req, res) => {
  try {
    const entityType = req.params.entityType;
    if (!['thread', 'timeline'].includes(entityType)) return res.status(400).json({ error: 'Invalid entity type' });

    // Load all feedback
    const { rows: feedback } = await pool.query(
      `SELECT * FROM ranking_feedback WHERE entity_type = $1 ORDER BY created_at`,
      [entityType]
    );

    if (feedback.length < 3) {
      return res.json({ ok: true, message: 'Not enough feedback yet (need 3+)', samples: feedback.length });
    }

    // Simple online gradient descent on feature weights
    // Goal: learn weights so that higher-ranked items get higher scores
    const FEATURES = ['importance', 'article_count', 'source_count', 'breaking_signal', 'recency_hours', 'is_conflict', 'is_politics', 'is_economy'];
    const LR = 0.001; // learning rate
    const DECAY = 0.995; // slight regularization

    // Load current weights as starting point
    const { rows: currentWeights } = await pool.query(
      `SELECT feature_name, weight FROM ranking_model_weights WHERE entity_type = $1`,
      [entityType]
    );
    const weights = {};
    for (const feat of FEATURES) weights[feat] = 0;
    for (const w of currentWeights) weights[w.feature_name] = w.weight;

    // For each feedback: if item moved UP (new_rank < old_rank), its features
    // should produce a HIGHER score → increase weights for its positive features.
    // If moved DOWN, decrease weights.
    let updates = 0;
    for (const fb of feedback) {
      if (fb.old_rank == null || fb.new_rank == null) continue;
      const direction = fb.old_rank - fb.new_rank; // positive = promoted, negative = demoted
      if (direction === 0) continue;

      const signal = Math.sign(direction) * Math.min(Math.abs(direction), 10) * 0.1;
      const ageHours = fb.age_hours || 0;

      const featureVals = {
        importance:      fb.old_importance || 5,
        article_count:   fb.article_count || 0,
        source_count:    fb.source_count || 0,
        breaking_signal: fb.breaking_signal || 0,
        recency_hours:   ageHours,
        is_conflict:     ['conflict', 'military'].includes(fb.category) ? 1 : 0,
        is_politics:     ['politics', 'diplomacy'].includes(fb.category) ? 1 : 0,
        is_economy:      fb.category === 'economy' ? 1 : 0,
      };

      for (const feat of FEATURES) {
        const val = featureVals[feat] || 0;
        if (val === 0) continue;
        // Normalize large features
        const normVal = feat === 'article_count' ? Math.log1p(val) :
                        feat === 'recency_hours' ? Math.min(val / 100, 1) :
                        feat === 'source_count' ? Math.log1p(val) :
                        val;
        weights[feat] = weights[feat] * DECAY + LR * signal * normVal;
      }
      updates++;
    }

    // Persist updated weights
    for (const feat of FEATURES) {
      await pool.query(`
        INSERT INTO ranking_model_weights (entity_type, feature_name, weight, updated_at, sample_count)
        VALUES ($1, $2, $3, NOW(), $4)
        ON CONFLICT (entity_type, feature_name) DO UPDATE SET
          weight = $3, updated_at = NOW(), sample_count = $4
      `, [entityType, feat, +weights[feat].toFixed(6), feedback.length]);
    }

    res.json({
      ok: true,
      samples: feedback.length,
      updates,
      weights: Object.fromEntries(FEATURES.map(f => [f, +weights[f].toFixed(6)])),
    });
  } catch (err) {
    console.error('[admin/rankings] retrain error:', err.message);
    res.status(500).json({ error: 'Failed to retrain' });
  }
});

// The standalone /briefing-editor page was retired — all briefing editing
// now lives in the unified /editor (www/earth-editor.html). Redirect any
// stale bookmarks instead of 404ing.
app.get('/briefing-editor', (_req, res) => res.redirect(301, '/editor'));

// Serve tweet curator page
app.get('/tweet-curator', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'tweet-curator.html'));
});

// Serve unified editor platform
app.get('/editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'earth-editor.html'));
});

// Serve region polygon editor
app.get('/region-editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'region-editor.html'));
});

// Privacy + Terms — public legal pages, linked from auth modal, settings
// sub-view, and pricing modal. URLs here are also what we put in App
// Store Connect's Privacy Policy URL field. No auth required.
app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'privacy.html'));
});
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'privacy.html'));
});
app.get('/terms.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'terms.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'terms.html'));
});
app.get('/notices.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'notices.html'));
});
app.get('/notices', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'notices.html'));
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
    // Pre-computed bucketed snapshots covering every UI-reachable combo.
    // When this lookup table drifts from refreshHeatmapTsSnapshots() above,
    // cold-cache timeouts reappear — keep them synchronized.
    const TS_SNAPSHOT_PRESETS = {
      '1_hour':  '1d_hour',  '1_day':  '1d_day',
      '3_hour':  '3d_hour',  '3_day':  '3d_day',
      '7_hour':  '7d_hour',  '7_day':  '7d_day',
      '14_hour': '14d_hour', '14_day': '14d_day',
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
        params.push(keyword.toLowerCase().trim());
        const kwExact = `$${params.length}`;
        params.push(`${keyword.toLowerCase().trim()}%`);
        const kwPrefix = `$${params.length}`;
        where.push(`EXISTS (
          SELECT 1 FROM article_keywords ak
          WHERE ak.article_id = a.id
          AND (ak.normalized_keyword = ${kwExact} OR ak.keyword ILIKE ${kwPrefix})
        )`);
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
      // Use article-derived recency (not last_updated_at) — see the
      // long comment in /api/threads/latest for the rationale.
      // Timelines have the same skew problem: cosmetic operations bump
      // last_updated_at without any new article actually being added.
      const { rows: timelines } = await pool.query(`
        SELECT
          t.id AS timeline_id, t.title, t.description, t.scope,
          t.primary_category, t.geographic_scope, t.importance, t.keywords,
          t.primary_nations, t.secondary_nations, t.article_count, t.distinct_source_count, t.parabolic_weight_sum,
          t.historical_anchors, t.status, t.last_updated_at,
          COALESCE(lp.latest_pub, t.last_updated_at) AS true_latest_published_at,
          COALESCE(t.is_manual, FALSE) AS is_manual
        FROM story_timelines t
        LEFT JOIN LATERAL (
          SELECT MAX(na.published_at) AS latest_pub
          FROM story_timeline_articles sta
          JOIN news_articles na ON na.id = sta.article_id
          WHERE sta.timeline_id = t.id
        ) lp ON true
        WHERE t.status IN ('active','cooling','dormant')
          AND (t.article_count >= 2 OR COALESCE(t.is_manual, FALSE) = TRUE)
        ORDER BY
          -- Status first: active → dormant → cooling. Importance second.
          -- See /api/threads/latest for full rationale.
          CASE t.status WHEN 'active' THEN 0 WHEN 'dormant' THEN 1 WHEN 'cooling' THEN 2 ELSE 3 END,
          t.importance DESC NULLS LAST,
          CASE WHEN t.primary_category IN ('politics','military','diplomacy','economy','conflict') THEN 0
               WHEN t.primary_category IN ('environment','climate') THEN 2
               ELSE 1 END,
          t.parabolic_weight_sum DESC,
          true_latest_published_at DESC NULLS LAST
        LIMIT $1
      `, [limit]);

      if (!timelines.length) return [];

      // Hero images for timelines: prefer native publisher scrape, fall
      // back to article_image_assignments (populated by backfillImages.js).
      //
      // The earlier version ONLY looked at a.image_url, which meant every
      // timeline whose articles had null/dead native images returned no
      // hero — even though backfillImages has assigned on-topic fallback
      // images for those same articles in article_image_assignments. The
      // bucket/Wikimedia fallback below was trying to cover that gap but
      // was capped at 20 timelines inside a 6s Promise.race, so long lists
      // or slow runs still ended up imageless.
      //
      // DISTINCT ON ordering: within a timeline, prefer articles that have
      // a native image over those that only have an assignment; within each
      // tier, prefer most recent. COALESCE picks native first, assignment
      // second.
      const timelineIds = timelines.map(t => t.timeline_id);
      const { rows: heroes } = await pool.query(`
        SELECT DISTINCT ON (sta.timeline_id)
          sta.timeline_id,
          -- Dead-URL aware COALESCE: pick alive scraped first, alive
          -- catalog second. heroImageValidator.js marks dead URLs on
          -- news_articles.image_dead_at / image_assets.dead_at; this
          -- filter makes the DISTINCT ON natural fallback (next-most-
          -- recent alive article) kick in automatically.
          COALESCE(
            NULLIF(CASE WHEN a.image_dead_at IS NULL THEN a.image_url END, ''),
            CASE WHEN img.dead_at IS NULL THEN img.public_url END
          ) AS hero_image_url,
          COALESCE(ns.name, ys.name) AS hero_source_name,
          co.iso_code AS hero_iso_code
        FROM story_timeline_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img ON img.id = aia.image_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        LEFT JOIN countries co ON co.id = a.country_id
        WHERE sta.timeline_id = ANY($1)
          AND (
            (a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL)
            OR (img.public_url IS NOT NULL AND img.dead_at IS NULL)
          )
        ORDER BY sta.timeline_id,
          CASE WHEN a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL THEN 0 ELSE 1 END,
          a.published_at DESC
      `, [timelineIds]);

      const heroMap = new Map(heroes.map(h => [h.timeline_id, h]));
      const textIsoMap = await resolveHeroIsoFromText(timelines, 'timeline_id');

      // Per-timeline distinct-language and distinct-source-country counts.
      // Mirrors the thread-latest counts query — see that block for context.
      const { rows: tlCountsRows } = await pool.query(`
        SELECT sta.timeline_id,
               COUNT(DISTINCT a.country_id)
                 FILTER (WHERE a.country_id IS NOT NULL) AS source_country_count,
               COUNT(DISTINCT COALESCE(ns.language_id, ys.language_id))
                 FILTER (WHERE COALESCE(ns.language_id, ys.language_id) IS NOT NULL) AS language_count
        FROM story_timeline_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        LEFT JOIN news_sources ns ON ns.id = a.source_id
        LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
        WHERE sta.timeline_id = ANY($1::int[])
        GROUP BY sta.timeline_id
      `, [timelineIds]);
      const tlCountsMap = new Map(tlCountsRows.map(r => [
        r.timeline_id,
        { source_country_count: parseInt(r.source_country_count, 10) || 0,
          language_count:       parseInt(r.language_count,       10) || 0 },
      ]));

      const mapped = timelines.map(t => {
        const h = heroMap.get(t.timeline_id);
        const subjectIso = textIsoMap.get(t.timeline_id);
        const counts = tlCountsMap.get(t.timeline_id) || { source_country_count: 0, language_count: 0 };
        return {
          ...t,
          // Expose `id` alongside `timeline_id` / `thread_id`. The SQL aliases
          // t.id AS timeline_id, so without this, clients that expect `tl.id`
          // (e.g. earth-editor.html's loadTlSavedPanels(tl.id)) would fire
          // requests with literal "undefined" in the URL.
          id: t.timeline_id,
          thread_id: t.timeline_id,
          // article-derived recency (see threads/latest comment)
          latest_published_at: t.true_latest_published_at || t.last_updated_at,
          hero_image_url: h?.hero_image_url || null,
          hero_catalog_image_url: null,
          hero_source_name: h?.hero_source_name || null,
          hero_iso_code: subjectIso || h?.hero_iso_code || null,
          source_country_count: counts.source_country_count,
          language_count:       counts.language_count,
        };
      });
      // Fallback image search for timelines missing hero images.
      // Bucket-first (country → keyword → category) before Wikimedia.
      const _noImgTl = mapped.filter(t => !t.hero_image_url).slice(0, 20);
      if (_noImgTl.length) {
        await Promise.race([
          Promise.all(_noImgTl.map(async (t) => {
            try {
              const bucketUrl = await findBucketImage(t, pool);
              if (bucketUrl) t.hero_image_url = bucketUrl;
            } catch (e) { /* silent */ }
          })),
          new Promise(r => setTimeout(r, 6000))
        ]);
      }
      // Final-line guarantee: hero_image_url MUST be non-empty. Falls back
      // to country flag (hero_iso_code → primary_nations[0]), then to a
      // neutral globe SVG data URL as a last resort.
      mapped.forEach(guaranteeHeroImage);
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
    // Apply user preference boosts (post-cache, per-user)
    const _tlPrefs = req.user?.id ? await _fetchUserPrefs(req.user.id) : null;
    if (_tlPrefs) {
      const personalized = _cached.map(t => ({ ...t }));
      _applyThreadPrefBoosts(personalized, _buildPrefBoosts(_tlPrefs));
      return res.json(personalized);
    }
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

// GET /api/timelines/:id/events
//
// Returns the chronological event structure produced by storyTimeline
// Builder's Phase C extraction pass (story_timeline_events). The
// cluster-detail panel renders this in its Timeline section — one
// row per event, ordered newest-first, showing the day, the anchor
// article's title, and the Claude-written description. Replaces the
// old threads path which just dumped articles chronologically (a flat
// list, not an actual narrative).
app.get("/api/timelines/:id/events", async (req, res) => {
  try {
    const timelineId = parseInt(req.params.id, 10);
    if (!timelineId) return res.status(400).json({ error: "Invalid timeline ID" });
    const { rows } = await pool.query(`
      SELECT
        ste.id,
        ste.event_date,
        ste.event_title,
        ste.event_description,
        ste.anchor_article_id,
        ste.article_ids,
        ste.source_count,
        ste.importance,
        ste.updated_at,
        -- Hydrate the anchor article's basic fields so the UI can link
        -- straight to it without a second round-trip.
        a.article_url  AS anchor_url,
        a.image_url    AS anchor_image_url,
        a.published_at AS anchor_published_at,
        COALESCE(ns.name, ys.name) AS anchor_source_name,
        co.iso_code    AS anchor_iso_code,
        co.name        AS anchor_country_name
      FROM story_timeline_events ste
      LEFT JOIN news_articles a ON a.id = ste.anchor_article_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE ste.timeline_id = $1
      ORDER BY ste.event_date DESC, ste.id DESC
      LIMIT 200
    `, [timelineId]);
    res.json({ events: rows });
  } catch (err) {
    console.error("[timelines/events]", err.message);
    res.status(500).json({ error: "Failed to fetch timeline events" });
  }
});

// GET /api/timelines/:id/density
//
// Daily (or weekly) article-volume histogram for a timeline, used by the
// Line-level density ruler. Returns one bucket per day up to 120 days,
// auto-switching to weekly buckets for longer timelines. Each bucket
// includes the top headline of that window (highest parabolic_weight,
// tie-broken by most-recent published_at) so the ruler can annotate
// peaks without a second round-trip.
app.get("/api/timelines/:id/density", async (req, res) => {
  try {
    const timelineId = parseInt(req.params.id, 10);
    if (!timelineId) return res.status(400).json({ error: "Invalid timeline ID" });

    // Determine the timeline's active window from its articles, so the
    // ruler covers the real coverage span (not the DB insert range).
    const { rows: spanRows } = await pool.query(`
      SELECT
        MIN(a.published_at)::date AS start_date,
        MAX(a.published_at)::date AS end_date,
        COUNT(*)::int              AS total
      FROM story_timeline_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      WHERE sta.timeline_id = $1
        AND a.published_at IS NOT NULL
    `, [timelineId]);

    const span = spanRows[0];
    if (!span || !span.start_date || !span.end_date || span.total === 0) {
      return res.json({ bucket: 'day', start_date: null, end_date: null, buckets: [] });
    }

    const startDate = new Date(span.start_date);
    const endDate   = new Date(span.end_date);
    const spanDays  = Math.max(1, Math.round((endDate - startDate) / 86400000) + 1);
    const bucket    = spanDays > 120 ? 'week' : 'day';
    const truncUnit = bucket === 'week' ? 'week' : 'day';

    // Aggregate counts per bucket, and for each bucket pick the top
    // article (highest parabolic_weight, then most recent). LATERAL
    // gives us one row per bucket without a correlated subquery.
    const { rows } = await pool.query(`
      WITH bucketed AS (
        SELECT
          date_trunc($2, a.published_at)::date AS bucket_date,
          sta.article_id,
          sta.parabolic_weight,
          a.published_at,
          COALESCE(a.translated_title, a.title) AS headline
        FROM story_timeline_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        WHERE sta.timeline_id = $1
          AND a.published_at IS NOT NULL
      ),
      counts AS (
        SELECT bucket_date, COUNT(*)::int AS count
        FROM bucketed
        GROUP BY bucket_date
      )
      SELECT
        c.bucket_date AS date,
        c.count,
        top.headline  AS top_headline,
        top.article_id AS top_article_id
      FROM counts c
      LEFT JOIN LATERAL (
        SELECT b.article_id, b.headline
        FROM bucketed b
        WHERE b.bucket_date = c.bucket_date
        ORDER BY b.parabolic_weight DESC NULLS LAST, b.published_at DESC
        LIMIT 1
      ) top ON true
      ORDER BY c.bucket_date ASC
    `, [timelineId, truncUnit]);

    res.json({
      bucket,
      start_date: span.start_date,
      end_date:   span.end_date,
      total:      span.total,
      buckets:    rows.map(r => ({
        date:           r.date,
        count:          r.count,
        top_headline:   r.top_headline,
        top_article_id: r.top_article_id,
      })),
    });
  } catch (err) {
    console.error("[timelines/density]", err.message);
    res.status(500).json({ error: "Failed to fetch timeline density" });
  }
});

// GET /api/timelines/:id/threads
//
// Returns the threads that graduated into this timeline via
// story_threads.timeline_id (set by storyTimelineBuilder's Phase B
// promotion pass, or by the one-shot relinkExistingTimelines script).
// Consumed by the cluster-detail panel to surface constituent threads
// as a source type alongside articles + videos. Ordered by recency so
// the latest thread in the story sits on top.
app.get("/api/timelines/:id/threads", async (req, res) => {
  try {
    const timelineId = parseInt(req.params.id, 10);
    if (!timelineId) return res.status(400).json({ error: "Invalid timeline ID" });
    const { rows } = await pool.query(`
      SELECT
        t.id AS thread_id,
        t.title,
        t.description,
        t.primary_category,
        t.importance,
        t.article_count,
        t.distinct_source_count,
        t.status,
        t.keywords,
        t.primary_nations,
        t.first_seen_at,
        t.last_updated_at
      FROM story_threads t
      WHERE t.timeline_id = $1
      ORDER BY t.last_updated_at DESC NULLS LAST, t.importance DESC
      LIMIT 100
    `, [timelineId]);
    res.json({ threads: rows });
  } catch (err) {
    console.error("[timelines/threads]", err.message);
    res.status(500).json({ error: "Failed to fetch timeline threads" });
  }
});

// GET /api/flows/timeline/:id — flow arcs for a timeline
// Uses entity extraction (subject/actor/location roles) to show only
// countries directly involved in the story, not every reporting country.
app.get("/api/flows/timeline/:id", async (req, res) => {
  try {
    const timelineId = parseInt(req.params.id, 10);
    if (!timelineId) return res.status(400).json({ error: "Invalid timeline ID" });

    const _cached = await ttlCached(`flows/timeline:${timelineId}`, 300_000, async () => {
      return await _buildTieredFlows({
        kind: 'timeline',
        id: timelineId,
        rowTable: 'story_timelines',
        articleJoinTable: 'story_timeline_articles',
        articleJoinKey: 'timeline_id',
      });
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
// GET /api/country-meta
//
// Static country metadata (currency, languages) keyed by ISO 3166-1 alpha-2.
// Sourced from REST Countries v3.1, baked at build time into
// data/country-meta.json. Served with a long cache because this data
// almost never changes — annual at most.
//
// Frontend uses this to render the facts header bar on each country panel
// (population, GDP, language count, currency name).
const _countryMetaCache = (() => {
  try {
    return require('fs').readFileSync('data/country-meta.json', 'utf8');
  } catch (_) {
    return JSON.stringify({});
  }
})();
app.get("/api/country-meta", (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
  res.set('Content-Type', 'application/json');
  res.send(_countryMetaCache);
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
    // scope=local  → only scope='local' threads, matched via primary_nations
    //                (fast — localStoryBuilder sets primary_nations=[iso]
    //                directly so no entity-mention scan is needed)
    // scope=global → only existing global threads, via entity matching
    //                (original behaviour)
    // scope=<anything else / absent> → global-only (backwards compat)
    const scope = String(req.query.scope || "").toLowerCase().trim();

    // ── Fast path: local threads are explicitly tagged with
    //    primary_nations=[iso], so skip the entity-mention CTE entirely
    //    and just filter story_threads directly.
    if (scope === 'local') {
      const rows = await ttlCached(`threads/local-by-country:${iso}:${days}:${limit}`, 45_000, async () => {
        const { rows } = await pool.query(`
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
            (SELECT COUNT(*) FROM story_thread_articles sta
              JOIN news_articles a ON a.id = sta.article_id
             WHERE sta.thread_id = t.id
               AND a.published_at > NOW() - ($2 || ' days')::interval)::int AS in_country_articles,
            NULL::numeric AS avg_sentiment,
            t.last_updated_at AS last_in_country_at,
            COALESCE(t.importance, 0) * 1000
              + COALESCE(t.breaking_signal_score, 0) * 100 AS feed_score
          FROM story_threads t
          WHERE t.scope = 'local'
            AND t.status IN ('active', 'cooling')
            AND t.primary_nations @> ARRAY[$1]::text[]
            AND t.last_updated_at > NOW() - ($2 || ' days')::interval
          ORDER BY t.importance DESC NULLS LAST, t.last_updated_at DESC
          LIMIT $3
        `, [iso, String(days), limit]);
        // Attach hero images + flag fallback so these render with the
        // same card shape as the global list.
        for (const row of rows) {
          const { rows: hero } = await pool.query(`
            SELECT
              COALESCE(
                NULLIF(CASE WHEN a.image_dead_at IS NULL THEN a.image_url END, ''),
                CASE WHEN img.dead_at IS NULL THEN img.public_url END
              ) AS hero_image_url,
              co.iso_code AS hero_iso_code
            FROM story_thread_articles sta
            JOIN news_articles a ON a.id = sta.article_id
            LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
            LEFT JOIN image_assets img ON img.id = aia.image_id
            LEFT JOIN countries co ON co.id = a.country_id
            WHERE sta.thread_id = $1
              AND (
                (a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL)
                OR (img.public_url IS NOT NULL AND img.dead_at IS NULL)
              )
            ORDER BY a.published_at DESC
            LIMIT 1
          `, [row.thread_id]);
          row.hero_image_url = hero[0]?.hero_image_url || null;
          row.hero_iso_code  = hero[0]?.hero_iso_code  || iso;
        }
        rows.forEach(guaranteeHeroImage);
        return rows;
      });
      return res.json(rows);
    }

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
          COALESCE(
            NULLIF(CASE WHEN a.image_dead_at IS NULL THEN a.image_url END, ''),
            CASE WHEN img.dead_at IS NULL THEN img.public_url END
          ) AS hero_image_url,
          co.iso_code AS hero_iso_code
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
        LEFT JOIN image_assets img ON img.id = aia.image_id
        LEFT JOIN countries co ON co.id = a.country_id
        WHERE sta.thread_id = rt.thread_id
          AND (
            (a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL)
            OR (img.public_url IS NOT NULL AND img.dead_at IS NULL)
          )
        ORDER BY
          CASE WHEN a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL THEN 0 ELSE 1 END,
          a.published_at DESC
        LIMIT 1
      ) h ON TRUE
      ORDER BY rt.importance DESC NULLS LAST,
               rt.feed_score DESC,
               rt.in_country_articles DESC,
               rt.last_in_country_at DESC,
               rt.last_updated_at DESC
    `, [iso, String(days), limit]);
      // Override hero_iso_code with subject country parsed from geographic_scope text
      for (const row of rows) {
        const subjectIso = await pickCountryIsoFromText(row.geographic_scope);
        if (subjectIso) row.hero_iso_code = subjectIso;
      }
      // Bucket fallback for rows missing hero images, capped with a short race
      const _noImgBc = rows.filter(r => !r.hero_image_url).slice(0, 20);
      if (_noImgBc.length) {
        await Promise.race([
          Promise.all(_noImgBc.map(async (r) => {
            try {
              const bucketUrl = await findBucketImage(r, pool);
              if (bucketUrl) r.hero_image_url = bucketUrl;
            } catch (_) { /* silent */ }
          })),
          new Promise(r => setTimeout(r, 4000))
        ]);
      }
      // Final-line guarantee: flag → globe
      rows.forEach(guaranteeHeroImage);
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

    // Use article-derived recency (not last_updated_at) — see the long
    // comment in /api/threads/latest for the rationale.
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
        st.breaking_signal_score,
        COALESCE(lp.latest_pub, st.last_updated_at) AS true_latest_published_at
      FROM story_threads st
      LEFT JOIN LATERAL (
        SELECT MAX(na.published_at) AS latest_pub
        FROM story_thread_articles sta
        JOIN news_articles na ON na.id = sta.article_id
        WHERE sta.thread_id = st.id
      ) lp ON true
      WHERE st.id = $1
        AND st.article_count >= 1
      LIMIT 1
    `, [threadId]);

    if (!rows.length) return res.status(404).json({ error: "Thread not found" });

    const thread = rows[0];
    const { rows: heroRows } = await pool.query(`
      SELECT
        COALESCE(
          NULLIF(CASE WHEN a.image_dead_at IS NULL THEN a.image_url END, ''),
          CASE WHEN img.dead_at IS NULL THEN img.public_url END
        ) AS hero_image_url,
        co.iso_code AS hero_iso_code
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img ON img.id = aia.image_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE sta.thread_id = $1
        AND (
          (a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL)
          OR (img.public_url IS NOT NULL AND img.dead_at IS NULL)
        )
      ORDER BY
        CASE WHEN a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL THEN 0 ELSE 1 END,
        a.published_at DESC
      LIMIT 1
    `, [threadId]);

    const hero = heroRows[0] || {};
    const subjectIso = await pickCountryIsoFromText(thread.geographic_scope);
    let bucketUrl = null;
    if (!hero.hero_image_url) {
      try { bucketUrl = await findBucketImage(thread, pool); } catch (_) {}
    }
    const payload = {
      ...thread,
      latest_published_at: thread.true_latest_published_at || thread.last_updated_at,
      hero_image_url: hero.hero_image_url || bucketUrl || null,
      hero_catalog_image_url: null,
      hero_source_name: null,
      hero_iso_code: subjectIso || hero.hero_iso_code || null
    };
    guaranteeHeroImage(payload);
    res.json(payload);
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
    const _cached = await ttlCached(_cacheKey, 180_000, async () => {  // 3 min (was 2)

    // Step 1: get threads — single fast query on story_threads only,
    // no JOINs, no regex, no correlated subqueries.
    const params = [limit];
    const dateClauses = [];
    if (fromDate) { params.push(fromDate); dateClauses.push(`st.last_updated_at >= $${params.length}::date`); }
    if (toDate)   { params.push(toDate);   dateClauses.push(`st.last_updated_at <  ($${params.length}::date + INTERVAL '1 day')`); }
    const dateWhere = dateClauses.length ? `AND ${dateClauses.join(' AND ')}` : '';

    // Exclude scope='local' rows — those are domestic single-country
    // threads produced by localStoryBuilder.js and are surfaced ONLY on
    // the country panels (via /api/threads/by-country/:iso?scope=local).
    // The main feed is global threads only — that's the project's focus
    // surface and locals were burying it. COALESCE handles legacy rows
    // created before the `scope` column existed (default = 'global').
    // ── true article-derived recency ───────────────────────────────────
    // story_threads.last_updated_at gets bumped by non-article events too:
    //   - refreshStaleThreadContexts re-titles via Claude (storyThreadBuilder.js)
    //   - article ejects (storyThreadBuilder.js eject path)
    // So a thread that's been quiet for a week can have last_updated_at
    // = 2 hours ago and look "active" to the client.
    //
    // The truth is MAX(news_articles.published_at) joined through
    // story_thread_articles. We surface that as `latest_published_at`
    // and use it for ordering. Falls back to last_updated_at only when
    // the thread has zero articles (shouldn't happen given article_count
    // >= 2 below, but kept as a safety net).
    //
    // Production diagnosis that motivated this fix: thread #8509
    // "Antisemitic Hate Crimes Surge Across Western Nations" had
    // status=dormant (correct) and last_updated_at=11h (a stale Claude
    // re-title bump) but its true latest article was 107h ago — a 96h
    // skew. The client mapped last_updated_at → latest_published_at and
    // re-classified it as 'active' on the basis of the bumped value.
    const { rows: threads } = await pool.query(`
      SELECT
        st.id AS thread_id, st.title, st.description, st.primary_category,
        st.geographic_scope, st.importance, st.keywords, st.primary_nations,
        st.article_count, st.status, st.last_updated_at,
        COALESCE(lp.latest_pub, st.last_updated_at) AS true_latest_published_at
      FROM story_threads st
      LEFT JOIN LATERAL (
        SELECT MAX(na.published_at) AS latest_pub
        FROM story_thread_articles sta
        JOIN news_articles na ON na.id = sta.article_id
        WHERE sta.thread_id = st.id
      ) lp ON true
      WHERE st.article_count >= 2
        AND st.status IN ('active', 'cooling', 'dormant')
        AND COALESCE(st.scope, 'global') = 'global'
        ${dateWhere}
      ORDER BY
        -- Status first: active → dormant → cooling → other (per request).
        -- Importance second within each status bucket. Note dormant
        -- ranks BEFORE cooling intentionally — established stories with
        -- depth read better than transition-state ones.
        CASE st.status
          WHEN 'active'  THEN 0
          WHEN 'dormant' THEN 1
          WHEN 'cooling' THEN 2
          ELSE 3
        END,
        st.importance DESC NULLS LAST,
        CASE WHEN st.primary_category IN ('politics','military','diplomacy','economy','conflict') THEN 0
             WHEN st.primary_category IN ('environment','climate') THEN 2
             ELSE 1 END,
        st.article_count DESC,
        true_latest_published_at DESC NULLS LAST
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

    // Step 2: batch-fetch hero images. Rule for threads:
    //   1. Prefer most-recent constituent article with a native
    //      (publisher-scraped) a.image_url.
    //   2. Fall back to an assigned image from article_image_assignments
    //      (populated by backfillImages.js + imageResolver.js). This is
    //      the layer that gives us on-topic fallback art for articles
    //      whose publisher scrape returned empty / 404'd.
    //   3. Only when BOTH are absent does the findBucketImage/Wikimedia
    //      path below run.
    //
    // Earlier versions explicitly skipped step 2 on the theory that
    // thread-level bucket lookup was more on-topic. In practice most
    // thread rows ended up with hero_image_url = null because the bucket
    // pass is capped at 20 items inside a 6s race and frequently times
    // out. Restoring the assignment fallback unblocks thousands of
    // thread cards that already have perfectly good images sitting in
    // article_image_assignments.
    const threadIds = threads.map(t => t.thread_id);
    const { rows: heroes } = await pool.query(`
      SELECT DISTINCT ON (sta.thread_id)
        sta.thread_id,
        COALESCE(
          NULLIF(CASE WHEN a.image_dead_at IS NULL THEN a.image_url END, ''),
          CASE WHEN img.dead_at IS NULL THEN img.public_url END
        ) AS hero_image_url,
        co.iso_code AS hero_iso_code
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN article_image_assignments aia ON aia.article_id = a.id
      LEFT JOIN image_assets img ON img.id = aia.image_id
      LEFT JOIN countries co ON co.id = a.country_id
      WHERE sta.thread_id = ANY($1)
        AND (
          (a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL)
          OR (img.public_url IS NOT NULL AND img.dead_at IS NULL)
        )
      ORDER BY sta.thread_id,
        CASE WHEN a.image_url IS NOT NULL AND a.image_url <> '' AND a.image_dead_at IS NULL THEN 0 ELSE 1 END,
        a.published_at DESC
    `, [threadIds]);

    const heroMap = new Map(heroes.map(h => [h.thread_id, h]));

    // Resolve hero ISO from country names mentioned in title/description
    // so hero flags reflect thread subject countries, not article origin.
    const textIsoMap = await resolveHeroIsoFromText(threads, 'thread_id');

    // Per-thread distinct-language and distinct-source-country counts.
    // Used by the thread/timeline detail panel to show how many different
    // languages the thread's articles were written in, and how many
    // different source countries they came from — a cross-coverage
    // diversity signal for the reader. Aggregated in one query keyed by
    // thread_id, then merged into the result map below.
    const { rows: countsRows } = await pool.query(`
      SELECT sta.thread_id,
             COUNT(DISTINCT a.country_id)
               FILTER (WHERE a.country_id IS NOT NULL) AS source_country_count,
             COUNT(DISTINCT COALESCE(ns.language_id, ys.language_id))
               FILTER (WHERE COALESCE(ns.language_id, ys.language_id) IS NOT NULL) AS language_count
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN news_sources ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE sta.thread_id = ANY($1::int[])
      GROUP BY sta.thread_id
    `, [threadIds]);
    const countsMap = new Map(countsRows.map(r => [
      r.thread_id,
      { source_country_count: parseInt(r.source_country_count, 10) || 0,
        language_count:       parseInt(r.language_count,       10) || 0 },
    ]));

    const result = threads.map(t => {
      const h = heroMap.get(t.thread_id);
      const subjectIso = textIsoMap.get(t.thread_id);
      const counts = countsMap.get(t.thread_id) || { source_country_count: 0, language_count: 0 };
      return {
        ...t,
        // Use the true article-derived recency, not the spurious-bump-prone
        // last_updated_at. See the LATERAL join above for the long-form
        // rationale. The client's applyRecencyStatus reads this field.
        latest_published_at: t.true_latest_published_at || t.last_updated_at,
        hero_image_url: h?.hero_image_url || null,
        hero_catalog_image_url: null,
        hero_source_name: null,
        hero_iso_code: subjectIso || h?.hero_iso_code || null,
        source_country_count: counts.source_country_count,
        language_count:       counts.language_count,
      };
    });

    // Fallback image search for items missing hero images.
    //
    // Rule: prefer an image from our own bucket (image_assets) that is
    // explicitly tagged with a country from the thread's primary_nations,
    // a keyword from its keywords, or its primary_category. Only fall
    // back to Wikimedia Commons if nothing matches in the bucket — that
    // path is slow (external fetch) and usually less thematic.
    const _noImg = result.filter(t => !t.hero_image_url).slice(0, 20);
    if (_noImg.length) {
      await Promise.race([
        Promise.all(_noImg.map(async (t) => {
          try {
            const bucketUrl = await findBucketImage(t, pool);
            if (bucketUrl) t.hero_image_url = bucketUrl;
          } catch (e) { /* silent */ }
        })),
        new Promise(r => setTimeout(r, 6000))
      ]);
    }
    // Final-line guarantee: every thread returned has a non-empty
    // hero_image_url, even if it's just a country flag or generic globe.
    result.forEach(guaranteeHeroImage);

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

    // Apply user preference boosts (post-cache, per-user)
    const _thPrefs = req.user?.id ? await _fetchUserPrefs(req.user.id) : null;
    if (_thPrefs) {
      const personalized = _cached.map(t => ({ ...t }));
      _applyThreadPrefBoosts(personalized, _buildPrefBoosts(_thPrefs));
      return res.json(personalized);
    }
    res.json(_cached);
  } catch (err) {
    console.error("[threads/latest]", err.message, err.stack);
    res.status(500).json({ error: "Failed to fetch threads", detail: req.user?.is_admin ? err.message : undefined });
  }
});

// POST /api/cluster-node/summary — 200-word unbiased Claude-generated description using deep article search
// Cached in-process for 10 min keyed by mode + id: same entity → same summary
// until new articles materially shift the context. Cloudflare can't cache
// POSTs, but ttlCached dedups concurrent and near-concurrent requests so a
// single Claude call serves fan-out from many clients viewing the same node.
//
// Accepts either { thread_id } or { timeline_id }. Threads join
// story_thread_articles + story_threads; timelines join
// story_timeline_articles + story_timelines. Prompt + length constraint
// (exactly 200 words, two paragraphs) is identical for both so the
// Analysis section renders with consistent depth regardless of kind.
app.post("/api/cluster-node/summary", aiLimiter, async (req, res) => {
  const { thread_id, timeline_id, force } = req.body || {};
  const threadId   = parseInt(thread_id,   10);
  const timelineId = parseInt(timeline_id, 10);
  const isTimeline = Number.isFinite(timelineId) && timelineId > 0;
  const isThread   = Number.isFinite(threadId)   && threadId   > 0;
  if (!isTimeline && !isThread) {
    return res.status(400).json({ error: "thread_id or timeline_id required" });
  }
  const mode = isTimeline ? "timeline" : "thread";
  const id   = isTimeline ? timelineId : threadId;
  const cacheKey = `cluster-node-summary:${mode}:${id}`;

  // Credit gate. Cluster analysis is the most expensive call type
  // (Haiku ~$0.013 per response) — 13 credits. Signed-in required.
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  const _access = await credits.consumeCredits(user.id, user.tier || 'free', 'cluster_analysis', { referenceId: `${mode}:${id}`, isAdmin: !!user.is_admin })
    .catch(() => ({ allowed: false }));
  if (!_access.allowed) {
    return res.status(429).json({
      error:        'Not enough credits for Cluster Analysis',
      limitReached: true,
      cost:         _access.cost,
      remaining:    _access.remaining,
      weekly_limit: _access.weekly_limit,
      resetNote:    'Weekly credits reset Monday 00:00 UTC. Add-on packs available.',
    });
  }

  // `force: true` comes from the regenerate ↻ icon in the UI —
  // invalidate the in-process TTL cache so the next producer call
  // hits Claude fresh instead of serving the stale analysis.
  if (force === true) {
    try { _ttlCache.delete(cacheKey); } catch (_) {}
  }

  try {
    const cached = await ttlCached(cacheKey, 600_000, async () => {
    // Deep article search: fetch articles for this thread or timeline with
    // full context. Ordering anchors/recency prefers the most narratively
    // representative sample when truncated to 30.
    const articlesQuery = isTimeline
      ? {
          text: `
            SELECT
              a.title, a.translated_title, a.summary, a.translated_summary,
              a.published_at, a.media_type,
              COALESCE(ns.name, ys.name) AS source_name,
              co.name AS country_name
            FROM story_timeline_articles sta
            JOIN news_articles a ON a.id = sta.article_id
            LEFT JOIN news_sources ns ON ns.id = a.source_id
            LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
            LEFT JOIN countries co ON co.id = a.country_id
            WHERE sta.timeline_id = $1
            ORDER BY sta.is_anchor DESC, sta.parabolic_weight DESC NULLS LAST, a.published_at DESC
            LIMIT 30
          `,
          params: [id],
        }
      : {
          text: `
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
          `,
          params: [id],
        };
    const { rows: articles } = await pool.query(articlesQuery.text, articlesQuery.params);

    // Entity metadata.
    const metaQuery = isTimeline
      ? { text: `SELECT title, description, primary_category, keywords FROM story_timelines WHERE id = $1`, params: [id] }
      : { text: `SELECT title, description, primary_category, keywords FROM story_threads   WHERE id = $1`, params: [id] };
    const { rows: metaRows } = await pool.query(metaQuery.text, metaQuery.params);
    const meta = metaRows[0];

    if (!articles.length && !meta) {
      // Signal 404 through the cache by returning a sentinel; the caller
      // branches on it to preserve the HTTP status code.
      return { _notFound: true };
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

    const kindLabel = isTimeline ? "Line" : "Thread";
    const entityContext = meta
      ? `${kindLabel}: "${meta.title}"\nCategory: ${meta.primary_category || "General"}\nDescription: ${meta.description || ""}\nKeywords: ${(meta.keywords || []).slice(0, 15).join(", ")}`
      : "";

    const prompt = `You are an impartial global news analyst with web_search access. Return ONLY valid JSON. No markdown, no code fences, no commentary outside the JSON object.

Schema:
{
  "overview": "string",
  "primary_actors":   [ { "name": "United States", "context": "string" } ],
  "secondary_actors": [ { "name": "Germany",        "context": "string" } ]
}

Rules:
- Treat the articles below as your starting point. Re-read every article carefully — secondary actors are often mentioned only briefly (as treaty partners, joint-statement co-signatories, named companies/NGOs operating in the story, supply-chain links, aid providers, diaspora communities, etc.). Find those mentions before deciding who to include.
- If the articles are thin on WHY a candidate actor matters, you MUST use the web_search tool to verify the actual relationship before including them. Suggested queries:
    * "<actor> <primary actor> <topic-keyword>"
    * "<actor> <named organization or individual from articles>"
    * "<actor> <story-specific term from the title or summaries>"
  Up to 4 web searches per response. Accuracy matters more than speed.
- overview: ~400 characters summarizing the broader geopolitical or societal arc of this ${kindLabel}, synthesizing the most important developments from the articles below.
- primary_actors: 1–3 entries for the countries / institutions / parties most central to the story. Each context ~250 characters covering their role, stakes, and exposure with SPECIFIC details (named officials, dates, dollar amounts, named programs).
- secondary_actors: 0–4 entries — INCLUDE ONLY actors with documentable, concrete connections (named operational involvement, named bilateral mechanism, named company/NGO active in the story, named diaspora/supply-chain link). When in doubt, OMIT — a shorter, sharper list is better than a padded one. Each context ~200 characters explaining the SPECIFIC tie to the primary actors.
- Every secondary actor context must give a SPECIFIC, CONCRETE reason this actor is in the story. Acceptable concrete answers include:
    * Direct operational involvement (sent rescuers, equipment, aid, sanctions, public statements).
    * Bilateral institutional ties cited in coverage (treaty membership, named MoU, joint commission).
    * Named companies, NGOs, or individuals from the actor active in the story (with the company/person named).
    * Diaspora, labor migration, or supply-chain links with specifics (which industry, what scale).
- FORBIDDEN — these phrases are non-answers and waste the user's time. Do NOT produce any of:
    * "no direct involvement"
    * "no apparent direct connection"
    * "tangential", "peripheral", "minimal direct connection", "indirect relevance"
    * "would be indirect through international standards / mining industry / global frameworks / broader networks"
    * "no operational role", "no documented participation", "no material stake"
  If after re-reading articles AND web-searching you genuinely cannot find a real connection, OMIT the actor from secondary_actors entirely. Do not produce vague filler.
- Factual, neutral, specific. No speculation, no opinions, no bullets. Keep proper noun casing consistent in the "name" field.

${entityContext}

Articles:
${articleContext}`;

    // Bumped max_tokens 1400 → 6000 because Anthropic's web_search server
    // tool injects search results inline into the response context. Each
    // search adds ~600 tokens of result snippets; with up to 4 searches
    // plus the final ~1400-token JSON output we can blow through a small
    // budget. Web-search is server-managed (no manual tool loop here) —
    // the API runs queries transparently and returns the final text.
    const response = await Anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 6000,
      tools: [
        // Anthropic-hosted web search. Capped at 4 to bound latency.
        // Used to verify concrete actor connections when the article
        // context is too thin to ground a specific claim. Same tool
        // pattern as /api/heatmap/ask and /api/ai/flow-context.
        { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
      ],
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = (response?.content || [])
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .join("")
      .trim();
    const structured = _flowCtxExtractJson(rawText) || {};
    // Scrub Claude's web_search citation markup ("<cite index=…>")
    // from every text field before pushing it into a block — otherwise
    // the literal tags surface inline in the rendered analysis prose.
    const overview = _stripClaudeCitations(String(structured?.overview || ""));
    const primary = Array.isArray(structured?.primary_actors)   ? structured.primary_actors   : [];
    const secondary = Array.isArray(structured?.secondary_actors) ? structured.secondary_actors : [];

    const blocks = [];
    if (overview) {
      blocks.push({ kind: "summary", badge: "Story", title: "Overview", text: overview });
    }
    for (const a of primary) {
      const name = _stripClaudeCitations(String(a?.name || ""));
      const ctx  = _stripClaudeCitations(String(a?.context || ""));
      if (!ctx) continue;
      blocks.push({ kind: "primary", badge: "Primary actor", title: name || "Primary actor", text: ctx });
    }
    for (const a of secondary) {
      const name = _stripClaudeCitations(String(a?.name || ""));
      const ctx  = _stripClaudeCitations(String(a?.context || ""));
      if (!ctx) continue;
      blocks.push({ kind: "secondary", badge: "Secondary actor", title: name || "Secondary actor", text: ctx });
    }
    if (!blocks.length) {
      blocks.push({
        kind: "summary", badge: "Story", title: "Overview",
        text: _stripClaudeCitations(String(rawText || "Analysis unavailable for this entity right now.")).slice(0, 900),
      });
    }

    return { blocks };
    });

    if (cached?._notFound) return res.status(404).json({ error: `No data found for this ${mode}` });
    res.json({ ...cached, credits: _creditsBlock(_access) });
  } catch (err) {
    console.error("[cluster-node/summary]", err.message);
    res.status(500).json({ error: "Summary generation failed" });
  }
});

// POST /api/ai/flow-context — streaming AI explanation for thread/timeline
// flow arcs. Two scopes: "entities" (relationship across all on-screen ISOs)
// and "flow" (specific arc or current timeline segment). Pro-gated.
//
// Request body:
//   scope:            "entities" | "flow"
//   mode:             "thread"   | "timeline"
//   thread_id?:       number (when mode === "thread")
//   timeline_id?:     number (when mode === "timeline"; currently a thread id)
//   segment_idx?:     number (timeline only)
//   segment?:         { title, date, article_ids[] }
//   theme?:           string (thread/timeline title)
//   article_ids?:     number[] (explicit scoping)
//   visible_entities: string[] (ISO codes currently lit on screen)
//   active_arc?:      { src_iso, dst_iso, count } (flow scope only)
//
// Streams Server-Sent Events with a structured payload:
//   data: {"type":"structured","blocks":[...]}\n\n
// then terminates with `data: [DONE]\n\n`.
function _flowCtxNormalizeIso(value) {
  return String(value || '').trim().toUpperCase();
}

function _flowCtxNormalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function _flowCtxExtractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try { return JSON.parse(unfenced); } catch (_) {}

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Citation-markup scrubber for AI analysis text.
//
// When Claude uses the Anthropic-hosted web_search tool (added to the
// flow-context and cluster-node/summary endpoints to verify secondary-
// country connections), the model often wraps cited spans in inline
// citation markup like:
//
//   <cite index="1-6,1-7">Mali's defense minister was killed</cite>
//
// That markup is meant for downstream rendering pipelines that resolve
// the indexes back to source URLs. Our frontend treats `text` as a
// plain string typed character-by-character into the analysis panel,
// so the raw `<cite>` tags surface as visible artifacts in the UI.
//
// This helper strips the opening and closing `<cite ...>` / `</cite>`
// tags while preserving the inner text. It also tidies up any
// double-spaces or stray whitespace before punctuation that the strip
// can leave behind (e.g. "rising in Ukraine ." → "rising in Ukraine.").
//
// Defensive: handles unclosed/malformed tags, mixed casing, attribute
// variants (`index`, `data-index`, etc.), and non-string inputs.
function _stripClaudeCitations(s) {
  if (typeof s !== 'string' || !s) return s == null ? '' : String(s);
  return s
    // Strip <cite ...> opening + </cite> closing tags. The \b after
    // "cite" prevents accidentally matching <citation> or <citing>.
    .replace(/<\/?cite\b[^>]*>/gi, '')
    // Collapse runs of internal spaces/tabs left behind by the strip.
    .replace(/[ \t]{2,}/g, ' ')
    // Tidy stray whitespace before punctuation — "Mali ." → "Mali.".
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function _flowCtxNormalizeCountryContexts(expectedCountries, rawContexts) {
  const expected = Array.isArray(expectedCountries) ? expectedCountries : [];
  const contexts = Array.isArray(rawContexts) ? rawContexts : [];
  const unused = new Set(contexts.map((_, idx) => idx));

  // Match each expected country to a context by ISO code (preferred) or
  // by normalized country name. We deliberately do NOT fall back to
  // positional/index matching — the model can reorder or omit entries,
  // and an index pairing scrambles labels (e.g. text about Senegal
  // surfacing under a "United States" header). When no context matches,
  // the expected country is dropped from the output.
  const out = expected.map((country) => {
    const isoCode = _flowCtxNormalizeIso(country?.iso_code || country?.iso);
    const countryName = String(country?.country || country?.name || isoCode).trim();
    const normalizedName = _flowCtxNormalizeName(countryName);

    let matchIdx = -1;
    if (isoCode) {
      matchIdx = contexts.findIndex((entry, entryIdx) =>
        unused.has(entryIdx) &&
        _flowCtxNormalizeIso(entry?.iso_code || entry?.iso) === isoCode
      );
    }
    if (matchIdx < 0 && normalizedName) {
      matchIdx = contexts.findIndex((entry, entryIdx) =>
        unused.has(entryIdx) &&
        _flowCtxNormalizeName(entry?.country || entry?.name) === normalizedName
      );
    }

    const match = matchIdx >= 0 ? contexts[matchIdx] : null;
    if (matchIdx >= 0) unused.delete(matchIdx);

    return {
      iso_code: isoCode,
      country: countryName,
      // Scrub <cite> markup that the web_search-enabled model can
      // emit inline in the JSON string fields.
      context: _stripClaudeCitations(String(match?.context || match?.summary || '')),
    };
  }).filter((entry) => entry.context);

  // If the model returned contexts for countries that weren't in the
  // expected list (or that we couldn't match by iso/name), surface them
  // anyway — labeled with the model's own country name — rather than
  // silently dropping the explanation. Better to show a slightly
  // unexpected country than to mislabel a different country's text.
  for (const idx of unused) {
    const entry = contexts[idx];
    if (!entry) continue;
    const text = _stripClaudeCitations(String(entry?.context || entry?.summary || ''));
    if (!text) continue;
    const iso = _flowCtxNormalizeIso(entry?.iso_code || entry?.iso);
    const name = String(entry?.country || entry?.name || iso || '').trim();
    if (!name) continue;
    out.push({ iso_code: iso, country: name, context: text });
  }

  return out;
}

function _flowCtxBuildStructuredBlocks(eventSummary, primaryContexts, secondaryContexts) {
  const blocks = [];
  // Scrub Claude's web_search citation markup before pushing text into
  // the blocks. Without this, panels render literal "<cite index="…">"
  // tags inline in the analysis prose.
  const summary = _stripClaudeCitations(String(eventSummary || ''));
  if (summary) {
    blocks.push({
      kind: 'summary',
      badge: 'Story',
      title: 'Event summary',
      text: summary,
    });
  }

  for (const ctx of primaryContexts || []) {
    const txt = _stripClaudeCitations(String(ctx?.context || ''));
    if (!txt) continue;
    blocks.push({
      kind: 'primary',
      badge: 'Primary country',
      title: ctx.country || ctx.iso_code || 'Primary country',
      text: txt,
    });
  }

  for (const ctx of secondaryContexts || []) {
    const txt = _stripClaudeCitations(String(ctx?.context || ''));
    if (!txt) continue;
    blocks.push({
      kind: 'secondary',
      badge: 'Secondary country',
      title: ctx.country || ctx.iso_code || 'Secondary country',
      text: txt,
    });
  }

  if (!blocks.length) {
    blocks.push({
      kind: 'summary',
      badge: 'Story',
      title: 'Event summary',
      text: 'Context unavailable for this story right now.',
    });
  }

  return blocks;
}

app.post("/api/ai/flow-context", aiLimiter, requireTier("pro"), async (req, res) => {
  const {
    scope,
    mode,
    thread_id,
    timeline_id,
    segment_idx,
    segment,
    theme,
    article_ids,
    visible_entities,
    active_arc,
  } = req.body || {};

  if (scope !== "entities" && scope !== "flow") {
    return res.status(400).json({ error: "scope must be 'entities' or 'flow'" });
  }
  if (mode !== "thread" && mode !== "timeline") {
    return res.status(400).json({ error: "mode must be 'thread' or 'timeline'" });
  }

  const entityId = mode === "thread" ? parseInt(thread_id, 10) : parseInt(timeline_id, 10);
  if (!entityId) {
    return res.status(400).json({ error: `${mode}_id required` });
  }

  // Credit gate. Flow context = 10 credits per call. Happens BEFORE the
  // SSE stream opens — 429 is a plain JSON if the user can't afford it.
  // The deducted balance is echoed back in the `structured` SSE frame.
  const _user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!_user?.id) return res.status(401).json({ error: "Authentication required" });
  const _fcAccess = await credits.consumeCredits(_user.id, _user.tier || 'free', 'flow_context', { referenceId: `${mode}:${entityId}`, isAdmin: !!_user.is_admin })
    .catch(() => ({ allowed: false }));
  if (!_fcAccess.allowed) {
    return res.status(429).json({
      error:        'Not enough credits for Flow Context',
      limitReached: true,
      cost:         _fcAccess.cost,
      remaining:    _fcAccess.remaining,
      weekly_limit: _fcAccess.weekly_limit,
      resetNote:    'Weekly credits reset Monday 00:00 UTC. Add-on packs available.',
    });
  }

  try {
    // Resolve theme + nation tiers from story_threads (timelines in this app
    // also key into the story_threads table via the /api/threads/:id/timeline
    // endpoint, so the same lookup works for both modes).
    const { rows: threadRows } = await pool.query(
      `SELECT title, primary_nations, secondary_nations
       FROM story_threads WHERE id = $1`,
      [entityId]
    );
    const threadMeta = threadRows[0] || null;

    // Scope article selection. For a timeline segment, prefer the exact
    // article_ids attached to that event. For a specific arc, fetch the
    // subset that mention both endpoints. Otherwise grab a chronological
    // window of the thread's articles.
    const scopedArticleIds = Array.isArray(segment?.article_ids) && segment.article_ids.length
      ? segment.article_ids.map(x => parseInt(x, 10)).filter(Boolean)
      : (Array.isArray(article_ids) ? article_ids.map(x => parseInt(x, 10)).filter(Boolean) : []);

    let articles = [];
    if (scope === "flow" && active_arc?.src_iso && active_arc?.dst_iso) {
      // Arc-specific articles — join article_locations twice to find pieces
      // that mention both the source and destination ISOs in this thread.
      const { rows } = await pool.query(`
        SELECT DISTINCT
          a.id, COALESCE(a.translated_title, a.title) AS title,
          COALESCE(a.translated_summary, a.summary) AS summary,
          a.published_at
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        JOIN article_locations al1 ON al1.article_id = a.id
        JOIN countries c1 ON c1.id = al1.country_id
        JOIN article_locations al2 ON al2.article_id = a.id
        JOIN countries c2 ON c2.id = al2.country_id
        WHERE sta.thread_id = $1
          AND c1.iso_code = $2
          AND c2.iso_code = $3
        ORDER BY a.published_at ASC
        LIMIT 12
      `, [entityId, active_arc.src_iso, active_arc.dst_iso]);
      articles = rows;
    }

    if (!articles.length && scopedArticleIds.length) {
      const { rows } = await pool.query(`
        SELECT a.id, COALESCE(a.translated_title, a.title) AS title,
               COALESCE(a.translated_summary, a.summary) AS summary,
               a.published_at
        FROM news_articles a
        WHERE a.id = ANY($1::int[])
        ORDER BY a.published_at ASC
        LIMIT 20
      `, [scopedArticleIds]);
      articles = rows;
    }

    if (!articles.length) {
      const { rows } = await pool.query(`
        SELECT a.id, COALESCE(a.translated_title, a.title) AS title,
               COALESCE(a.translated_summary, a.summary) AS summary,
               a.published_at
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        WHERE sta.thread_id = $1
        ORDER BY sta.is_anchor DESC, a.published_at ASC
        LIMIT 20
      `, [entityId]);
      articles = rows;
    }

    const primaryIsos = Array.isArray(threadMeta?.primary_nations)
      ? threadMeta.primary_nations.filter(Boolean).map(_flowCtxNormalizeIso)
      : [];
    const secondaryIsos = Array.isArray(threadMeta?.secondary_nations)
      ? threadMeta.secondary_nations.filter(Boolean).map(_flowCtxNormalizeIso)
      : [];
    const visibleIsos = Array.isArray(visible_entities)
      ? visible_entities.filter(Boolean).map(_flowCtxNormalizeIso)
      : [];
    const scopedIsos = [
      ...primaryIsos,
      ...secondaryIsos,
      ...visibleIsos,
      _flowCtxNormalizeIso(active_arc?.src_iso),
      _flowCtxNormalizeIso(active_arc?.dst_iso),
    ].filter(Boolean);

    const isoNameMap = new Map();
    if (scopedIsos.length) {
      const { rows: countryRows } = await pool.query(
        `SELECT iso_code, name FROM countries WHERE iso_code = ANY($1::text[])`,
        [[...new Set(scopedIsos)]]
      );
      countryRows.forEach((row) => isoNameMap.set(_flowCtxNormalizeIso(row.iso_code), row.name));
    }

    const primaryCountries = primaryIsos.map((iso) => ({
      iso_code: iso,
      country: isoNameMap.get(iso) || iso,
    }));
    const secondaryCountries = secondaryIsos.map((iso) => ({
      iso_code: iso,
      country: isoNameMap.get(iso) || iso,
    }));
    const visibleCountryNames = visibleIsos
      .map((iso) => isoNameMap.get(iso) || iso)
      .filter(Boolean);

    // Article block: title + summary only, no sources/dates/countries.
    const articleContext = articles.slice(0, 20).map((a, i) => {
      const summary = (a.summary || "").slice(0, 260).replace(/\s+/g, " ");
      return `${i + 1}. "${a.title || "Untitled"}"\n   ${summary}`;
    }).join("\n");

    const themeLine = theme || threadMeta?.title || "Untitled story";
    const kindLabel = mode === "timeline" ? "line" : "thread";
    const primaryLine = primaryCountries.length
      ? primaryCountries.map((c) => `${c.country} (${c.iso_code})`).join(", ")
      : "None supplied";
    const secondaryLine = secondaryCountries.length
      ? secondaryCountries.map((c) => `${c.country} (${c.iso_code})`).join(", ")
      : "None supplied";
    const visibleLine = visibleCountryNames.length
      ? visibleCountryNames.join(", ")
      : "None supplied";
    const focusLine = scope === "flow"
      ? (active_arc?.src_iso && active_arc?.dst_iso
          ? `Focus on the active route between ${isoNameMap.get(_flowCtxNormalizeIso(active_arc.src_iso)) || active_arc.src_iso} and ${isoNameMap.get(_flowCtxNormalizeIso(active_arc.dst_iso)) || active_arc.dst_iso}, while keeping it anchored in the broader ${kindLabel}.`
          : segment?.title
            ? `Focus on the current ${kindLabel} segment "${segment.title}"${segment?.date ? ` (${segment.date})` : ""}, while keeping it anchored in the broader story.`
            : `Focus on the currently selected slice of the ${kindLabel}.`)
      : `Focus on the overall ${kindLabel}.`;

    const prompt = `You are an impartial geopolitical analyst with web_search access. Return ONLY valid JSON. No markdown, no code fences, no commentary outside the JSON object.

Schema:
{
  "event_summary": "string",
  "primary_country_contexts": [
    { "iso_code": "US", "country": "United States", "context": "string" }
  ],
  "secondary_country_contexts": [
    { "iso_code": "DE", "country": "Germany", "context": "string" }
  ]
}

Rules:
- Treat the articles below as your starting point. Re-read every article — secondary countries are often mentioned only briefly (in a joint statement, as a treaty partner, as an aid provider, as a supply-chain link, as the home of a named company, as a venue for a related summit, etc.). Find that mention.
- If the articles do not clearly explain a secondary country's connection to the primary actors, you MUST use the web_search tool. Suggested queries:
    * "<country> <primary country> <topic-keyword>"
    * "<country> <named organization or individual from articles>"
    * "<country> <story-specific term, e.g. 'Sinaloa mine rescue', 'mining sector ties Mexico'>"
  Use up to 4 web searches per response if needed. Accuracy matters more than speed.
- event_summary: aim for about 400 characters describing the event itself and the latest developments.
- For each primary country listed below, include exactly one object in primary_country_contexts, in the same order. Each context should be around 250 characters and explain that country's role, stakes, or exposure in the story.
- For each secondary country listed below, include exactly one object in secondary_country_contexts, in the same order. Each context should be around 200 characters.
- Every secondary country context must give a SPECIFIC, CONCRETE reason this country is associated with the story. Acceptable concrete answers include:
    * Direct operational involvement (sent rescuers, equipment, aid, sanctions, statements).
    * Bilateral institutional ties cited in coverage (treaty membership, joint commission, named MoU).
    * Named companies, NGOs, or individuals from the country active in the story.
    * Diaspora, labor migration, or supply-chain links specifically relevant to the event.
    * Identifying the SPECIFIC article passage that caused this country to be tagged ("Article #7 lists this country in a G7 communiqué on mining safety alongside Mexico's response").
- FORBIDDEN — these phrases are non-answers and waste the user's time. Do NOT produce any of:
    * "no direct involvement"
    * "no apparent direct connection"
    * "tangential", "peripheral", "minimal direct connection", "indirect relevance"
    * "would be indirect through international standards / mining industry / global frameworks / broader networks"
    * "no operational role", "no documented participation", "no material stake"
  If after re-reading articles AND web-searching you genuinely cannot find a real connection, the correct response is to identify the SPECIFIC article passage that caused this country to be listed as secondary, e.g. "Listed because Article #4 quotes a G7 statement that included Mexico's response to the rescue alongside this country." Always be concrete.
- Clarity matters more than exact character counts. It is okay to go over when needed.
- Keep the prose factual, neutral, and specific. No speculation, no opinions, no bullets.

Story title: ${themeLine}
Story type: ${kindLabel}
Scope focus: ${focusLine}
Primary countries: ${primaryLine}
Secondary countries: ${secondaryLine}
Visible countries on screen: ${visibleLine}
Selected route: ${active_arc?.src_iso && active_arc?.dst_iso ? `${isoNameMap.get(_flowCtxNormalizeIso(active_arc.src_iso)) || active_arc.src_iso} -> ${isoNameMap.get(_flowCtxNormalizeIso(active_arc.dst_iso)) || active_arc.dst_iso}` : "None"}
Current segment: ${segment?.title ? `${segment.title}${segment?.date ? ` (${segment.date})` : ""}` : "None"}

Constituent articles:
${articleContext || "(no article context available)"}`;

    // Open the SSE stream.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const sendEvent = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const sendDone = () => res.write(`data: [DONE]\n\n`);

    let streamClosed = false;
    req.on("close", () => { streamClosed = true; });

    // Bumped max_tokens 1400 → 6000 because Anthropic's web_search server
    // tool injects search results inline into the response context. Each
    // search adds ~600 tokens of result snippets; with up to 4 searches
    // plus the final ~1400-token JSON output we can blow through a small
    // budget. Web-search is server-managed (no manual tool loop here) —
    // the API runs queries transparently and returns the final text.
    const response = await Anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 6000,
      tools: [
        // Anthropic-hosted web search. Capped at 4 to bound latency.
        // The model uses these to verify secondary-country connections
        // when the article context is too thin to ground a concrete
        // answer. Same tool pattern as the heatmap/ask endpoint.
        { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
      ],
      messages: [{ role: "user", content: prompt }],
    });
    const rawText = (response?.content || [])
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .join("")
      .trim();
    const structured = _flowCtxExtractJson(rawText) || {};
    const eventSummary = String(structured?.event_summary || rawText || "").trim();
    const normalizedPrimaryContexts = _flowCtxNormalizeCountryContexts(
      primaryCountries,
      structured?.primary_country_contexts
    );
    const normalizedSecondaryContexts = _flowCtxNormalizeCountryContexts(
      secondaryCountries,
      structured?.secondary_country_contexts
    );
    const blocks = _flowCtxBuildStructuredBlocks(
      eventSummary,
      normalizedPrimaryContexts,
      normalizedSecondaryContexts
    );

    if (!streamClosed) {
      sendEvent({ type: "structured", blocks, credits: _creditsBlock(_fcAccess) });
      sendDone();
      res.end();
    }
  } catch (err) {
    console.error("[ai/flow-context]", err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: "AI context generation failed" });
    }
    try {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } catch (_) {}
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
    const rows = await ttlCached(`articles/recent:${limit}:${hours}`, 60_000, async () => {  // 60s (was 20s)
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
             (audio_data IS NOT NULL) AS has_audio,
             (music_data IS NOT NULL) AS has_music
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
             (audio_data IS NOT NULL) AS has_audio,
             (music_data IS NOT NULL) AS has_music
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

/* =============================================================
   Share routes — public, unauthenticated.

   Three entity types:
     • thread   /share/thread/:id        → HTML preview + deep link
     • line     /share/line/:id          → HTML preview + deep link
     • heatmap  /share/heatmap?q=…&mode= → HTML preview + deep link

   Image PNGs at the same paths with `.png` suffix:
     /share/thread/:id.png, /share/line/:id.png, /share/heatmap.png

   The HTML response carries Open Graph + Twitter Card tags so
   iMessage / X / Discord / Slack render the watermarked image.
   For users on iOS with the app installed, the URL opens directly
   into the right panel via Universal Links (configured separately
   via /.well-known/apple-app-site-association).
============================================================== */
const shareImg = require('./shareImageGenerator');

const SHARE_HOST = process.env.SHARE_HOST || 'https://earth00.com';
const APP_DEEP_LINK_HOST = SHARE_HOST.replace(/^https?:\/\//, '');

// AASA file — required for iOS Universal Links. Apple fetches this from
// the apex of the share host and validates app id + paths. Served at
// `/.well-known/apple-app-site-association` with content-type
// application/json (NOT application/json with .json extension; Apple is
// picky about the path).
app.get('/.well-known/apple-app-site-association', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    applinks: {
      apps: [],
      details: [
        {
          // {TEAM_ID}.{BUNDLE_ID} — must exactly match the iOS target.
          appID: '2N4Y8MAZB2.com.earth00.app',
          // Paths the Universal Link should claim. Wildcards keep the
          // entitlement scoped to share routes only — leaves the rest of
          // earth00.com (marketing pages, etc.) unaffected.
          paths: [
            '/share/thread/*',
            '/share/line/*',
            '/share/heatmap',
            '/share/heatmap?*',
            '/share/flows',
            '/share/flows?*',
          ],
        },
      ],
    },
  });
});

// HTML wrapper that serves OG meta tags + a JS redirect into the app
// (or a graceful fallback to the App Store / web). Used by all three
// share routes — the data fields differ but the wrapper is shared.
function _shareHtml({ title, description, imageUrl, canonicalUrl, deepLinkPath }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} · Earth00</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${esc(description)}">
<!-- Open Graph -->
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:image:width" content="${shareImg.W}">
<meta property="og:image:height" content="${shareImg.H}">
<meta property="og:url" content="${esc(canonicalUrl)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Earth00">
<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(imageUrl)}">
${process.env.APPLE_APP_APPLE_ID ? `<!-- Apple smart app banner (lets iOS Safari show "Open in App") -->
<meta name="apple-itunes-app" content="app-id=${process.env.APPLE_APP_APPLE_ID}, app-argument=${esc(deepLinkPath)}">` : ''}
<style>
  body { margin: 0; background: #060a14; color: #f4ead2; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
  img.preview { width: 100%; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.5); }
  h1 { font-size: 28px; line-height: 1.25; margin: 24px 0 8px; }
  p { color: rgba(255,255,255,0.62); line-height: 1.6; }
  a.cta {
    display: inline-block; margin-top: 24px;
    padding: 14px 22px; border-radius: 999px;
    background: rgba(212,168,67,0.18); color: #f4ead2;
    border: 1px solid rgba(212,168,67,0.55);
    text-decoration: none; font-weight: 600; letter-spacing: 0.04em;
  }
  a.cta:hover { background: rgba(212,168,67,0.28); }
  .footer { margin-top: 36px; opacity: 0.4; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; }
</style>
</head>
<body>
  <div class="wrap">
    <img class="preview" src="${esc(imageUrl)}" alt="${esc(title)}">
    <h1>${esc(title)}</h1>
    <p>${esc(description)}</p>
    <a class="cta" href="${esc(deepLinkPath)}">Open in Earth00</a>
    <div class="footer">earth00.com</div>
  </div>
  <script>
    // Universal Link attempt — the app intercepts when installed. If
    // not installed, the app-argument deep link is a no-op and the
    // user stays on the web page.
    setTimeout(() => { try { window.location.href = ${JSON.stringify(deepLinkPath)}; } catch (_) {} }, 250);
  </script>
</body>
</html>`;
}

// ── Thread share ─────────────────────────────────────────────────────
// IMPORTANT: this route is registered BEFORE /share/thread/:id.png, so a
// request for /share/thread/8735.png lands here with id = "8735.png".
// `parseInt("8735.png")` returns 8735, and without this guard the HTML
// route would happily render and return text/html — silently shadowing
// the PNG route that OG scrapers / image fetchers actually need.
// Bail out so Express falls through to the .png route below.
app.get('/share/thread/:id', async (req, res, next) => {
  if (req.params.id && req.params.id.endsWith('.png')) return next();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send('Invalid id');
    const { rows } = await pool.query(
      `SELECT id, title, description, primary_category,
              importance, primary_nations
         FROM story_threads WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).send('Thread not found');
    const t = rows[0];
    const isos = (t.primary_nations || []).slice(0, 6);
    const title = t.title || 'Untitled story';
    const description = (t.description || `A story tracked across ${isos.length || 'multiple'} countries on Earth00.`).slice(0, 200);
    const imageUrl = `${SHARE_HOST}/share/thread/${id}.png`;
    const canonicalUrl = `${SHARE_HOST}/share/thread/${id}`;
    const deepLinkPath = `${SHARE_HOST}/share/thread/${id}`;
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_shareHtml({ title, description, imageUrl, canonicalUrl, deepLinkPath }));
  } catch (err) {
    console.error('[share/thread]', err.message);
    res.status(500).send('Share page error');
  }
});

app.get('/share/thread/:id.png', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).end();
    // Coverage counts are usually passed in the URL by the client
    // (?l=51&c=107&a=1338) since the panel/card already has them from
    // /api/threads/latest — no reason to re-aggregate news_articles
    // server-side. We accept them when present and only fall back to a
    // budgeted DB query for cold link-preview scrapes that arrive
    // without params (e.g. a Twitter bot fetching the URL nobody has
    // shared in-app yet). The fallback is wrapped in try/catch with a
    // 3s statement_timeout so a slow aggregation degrades the OG card
    // to "no coverage line" instead of erroring the whole render.
    const qLang     = parseInt(req.query.l, 10);
    const qCountry  = parseInt(req.query.c, 10);
    const qArticles = parseInt(req.query.a, 10);
    const haveQueryCounts = Number.isFinite(qLang) && Number.isFinite(qCountry);

    // Hero image is intentionally NOT fetched here. story_threads doesn't
    // store it as a column — it's computed by /api/threads/latest via a
    // JOIN through story_thread_articles → news_articles → image_assets.
    // Replicating that JOIN per share request to populate a single image
    // panel was the root cause of the production 500 (column missing on
    // first attempt, multi-second JOIN on the workaround). The OG card
    // ships title + chrome + chips + footer without the right-panel hero
    // image — clean dark layout, brand-consistent, no third-party CDN
    // dependency on the render path.
    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.primary_category, t.primary_nations,
              t.last_updated_at, t.article_count
         FROM story_threads t
        WHERE t.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).end();
    const t = rows[0];

    let languageCount = haveQueryCounts ? qLang    : null;
    let countryCount  = haveQueryCounts ? qCountry : null;
    if (!haveQueryCounts) {
      try {
        const countsClient = await pool.connect();
        try {
          await countsClient.query(`SET LOCAL statement_timeout='3s'`);
          const { rows: countsRows } = await countsClient.query(
            `SELECT
               (SELECT COUNT(DISTINCT a.language)::int
                  FROM story_thread_articles sta
                  JOIN news_articles a ON a.id = sta.article_id
                 WHERE sta.thread_id = $1) AS language_count,
               (SELECT COUNT(DISTINCT a.country_id)::int
                  FROM story_thread_articles sta
                  JOIN news_articles a ON a.id = sta.article_id
                 WHERE sta.thread_id = $1) AS source_country_count`,
            [id]
          );
          languageCount = countsRows[0]?.language_count ?? null;
          countryCount  = countsRows[0]?.source_country_count ?? null;
        } finally {
          countsClient.release();
        }
      } catch (e) {
        console.warn(`[share/thread.png] coverage counts skipped for ${id}: ${e.message}`);
      }
    }
    // Article count: prefer client-passed value, fall back to the
    // denormalized story_threads.article_count which is always present.
    const articleCount = Number.isFinite(qArticles) ? qArticles : (t.article_count || 0);
    const png = await shareImg.generate({
      kind: 'thread',
      // Cache key: last_updated_at + counts. Hero is no longer in the
      // mix (see SELECT comment above) so it drops out of the key too.
      cacheKey: `thread:${id}:${new Date(t.last_updated_at || 0).getTime()}:${articleCount}:${languageCount ?? 'x'}:${countryCount ?? 'x'}`,
      title:                t.title,
      isos:                 (t.primary_nations || []).slice(0, 6),
      category:             t.primary_category,
      articleCount,
      languageCount,
      countryCount,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400');
    res.send(png);
  } catch (err) {
    // Echo the underlying error message back as a custom header (and
    // log it loudly) so we can diagnose prod 500s without needing
    // direct access to Render logs. Cloudflare strips most response
    // bodies on 500 but preserves headers, so `curl -I` surfaces it.
    console.error('[share/thread.png]', err && (err.stack || err.message || err));
    try { res.setHeader('X-Share-Error', String(err?.message || err).slice(0, 240)); } catch (_) {}
    res.status(500).end();
  }
});

// ── Line / Timeline share ────────────────────────────────────────────
// Same shadowing guard as /share/thread/:id — see comment above. Without
// this, /share/line/123.png would render the HTML route's response.
app.get('/share/line/:id', async (req, res, next) => {
  if (req.params.id && req.params.id.endsWith('.png')) return next();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send('Invalid id');
    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.description, t.primary_category,
              t.primary_nations,
              (SELECT COUNT(*)::int FROM story_threads st WHERE st.timeline_id = t.id) AS thread_count
         FROM story_timelines t
        WHERE t.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).send('Line not found');
    const t = rows[0];
    const isos = (t.primary_nations || []).slice(0, 6);
    const title = t.title || 'Untitled timeline';
    const description = (t.description || `Story line tracked on Earth00 across ${isos.length || 'multiple'} countries with ${t.thread_count} thread${t.thread_count === 1 ? '' : 's'}.`).slice(0, 200);
    const imageUrl = `${SHARE_HOST}/share/line/${id}.png`;
    const canonicalUrl = `${SHARE_HOST}/share/line/${id}`;
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_shareHtml({ title, description, imageUrl, canonicalUrl, deepLinkPath: canonicalUrl }));
  } catch (err) {
    console.error('[share/line]', err.message);
    res.status(500).send('Share page error');
  }
});

app.get('/share/line/:id.png', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).end();
    // See /share/thread/:id.png for the full rationale on query-string
    // passthrough. Same shape: client embeds counts in the URL when it
    // has them, server uses them and skips the heavy aggregation.
    const qLang     = parseInt(req.query.l, 10);
    const qCountry  = parseInt(req.query.c, 10);
    const qArticles = parseInt(req.query.a, 10);
    const haveQueryCounts = Number.isFinite(qLang) && Number.isFinite(qCountry);

    // Hero image is intentionally NOT fetched here — see thread.png for
    // full rationale. Lines additionally never had hero columns of their
    // own; the prior code tried to pull a hero from the most-recent
    // child thread, but story_threads doesn't have those columns either.
    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.primary_category, t.primary_nations,
              t.last_updated_at,
              COALESCE(
                (SELECT SUM(article_count)::int
                   FROM story_threads st WHERE st.timeline_id = t.id),
                0
              ) AS article_count
         FROM story_timelines t
        WHERE t.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).end();
    const t = rows[0];

    let languageCount = haveQueryCounts ? qLang    : null;
    let countryCount  = haveQueryCounts ? qCountry : null;
    if (!haveQueryCounts) {
      try {
        const countsClient = await pool.connect();
        try {
          await countsClient.query(`SET LOCAL statement_timeout='3s'`);
          const { rows: countsRows } = await countsClient.query(
            `SELECT
               (SELECT COUNT(DISTINCT a.language)::int
                  FROM story_thread_articles sta
                  JOIN news_articles a ON a.id = sta.article_id
                  JOIN story_threads st ON st.id = sta.thread_id
                 WHERE st.timeline_id = $1) AS language_count,
               (SELECT COUNT(DISTINCT a.country_id)::int
                  FROM story_thread_articles sta
                  JOIN news_articles a ON a.id = sta.article_id
                  JOIN story_threads st ON st.id = sta.thread_id
                 WHERE st.timeline_id = $1) AS source_country_count`,
            [id]
          );
          languageCount = countsRows[0]?.language_count ?? null;
          countryCount  = countsRows[0]?.source_country_count ?? null;
        } finally {
          countsClient.release();
        }
      } catch (e) {
        console.warn(`[share/line.png] coverage counts skipped for ${id}: ${e.message}`);
      }
    }
    const articleCount = Number.isFinite(qArticles) ? qArticles : (t.article_count || 0);
    const png = await shareImg.generate({
      kind: 'line',
      cacheKey: `line:${id}:${new Date(t.last_updated_at || 0).getTime()}:${articleCount}:${languageCount ?? 'x'}:${countryCount ?? 'x'}`,
      title:                t.title,
      isos:                 (t.primary_nations || []).slice(0, 6),
      category:             t.primary_category,
      articleCount,
      languageCount,
      countryCount,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400');
    res.send(png);
  } catch (err) {
    // Same diagnostic header as /share/thread/:id.png — see comment there.
    console.error('[share/line.png]', err && (err.stack || err.message || err));
    try { res.setHeader('X-Share-Error', String(err?.message || err).slice(0, 240)); } catch (_) {}
    res.status(500).end();
  }
});

// ── Heatmap share ────────────────────────────────────────────────────
// Heatmaps don't have stable ids — they're a (question, mode) pair plus
// the cached resolver result. We accept the question as a query param
// and look up the cache row by its hash; if the hash is missing or the
// query is malformed we render a generic "Earth00 Map This" card.
const _crypto = require('crypto');
function _heatmapHash(question, mode) {
  const normalized = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return _crypto.createHash('sha256').update(`${mode}|${normalized}`).digest('hex');
}

app.get('/share/heatmap', async (req, res) => {
  try {
    const question = String(req.query.q || '').trim();
    const mode = String(req.query.mode || 'percent').toLowerCase();
    if (!question) return res.status(400).send('Missing q parameter');
    const hash = _heatmapHash(question, mode);
    const { rows } = await pool.query(
      `SELECT mode, legend, values
         FROM heatmap_qa_cache
        WHERE question_hash = $1 AND mode = $2 LIMIT 1`,
      [hash, mode]
    );
    const cached = rows[0];
    const valuesArr = (cached?.values || []).filter(v => v && v.iso);
    const countriesCount = valuesArr.length;
    const title = question.slice(0, 200);
    const description = `${countriesCount} countries · Map This view on Earth00`;
    const qsParams = new URLSearchParams({ q: question });
    if (mode && mode !== 'percent') qsParams.set('mode', mode);
    const imageUrl = `${SHARE_HOST}/share/heatmap.png?${qsParams}`;
    const canonicalUrl = `${SHARE_HOST}/share/heatmap?${qsParams}`;
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_shareHtml({ title, description, imageUrl, canonicalUrl, deepLinkPath: canonicalUrl }));
  } catch (err) {
    console.error('[share/heatmap]', err.message);
    res.status(500).send('Share page error');
  }
});

app.get('/share/heatmap.png', async (req, res) => {
  try {
    const question = String(req.query.q || '').trim();
    const mode = String(req.query.mode || 'percent').toLowerCase();
    if (!question) return res.status(400).end();
    const hash = _heatmapHash(question, mode);
    const { rows } = await pool.query(
      `SELECT mode, values
         FROM heatmap_qa_cache
        WHERE question_hash = $1 AND mode = $2 LIMIT 1`,
      [hash, mode]
    );
    const valuesArr = (rows[0]?.values || []).filter(v => v && v.iso);
    // Top 6 ISOs by value, descending. Used as the chip row.
    const topIsos = valuesArr
      .slice()
      .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))
      .slice(0, 6)
      .map(v => String(v.iso).toUpperCase());

    const png = await shareImg.generate({
      kind: 'heatmap',
      cacheKey: `heatmap:${hash}`,
      question,
      mode,
      countriesCount: valuesArr.length,
      topIsos,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400');
    res.send(png);
  } catch (err) {
    console.error('[share/heatmap.png]', err.message);
    res.status(500).end();
  }
});

// ── News Flows share ─────────────────────────────────────────────────
// Same pattern as heatmap — params describe the view filters; the share
// endpoint hashes them for cache key. Two visual modes:
//   • aggregate  — top N flows over the entire date range, all rendered
//   • timeseries — auto-pick the peak-activity day inside the range,
//                  render only flows whose article published on that day,
//                  add a "▶ REPLAY ON EARTH00" badge so the still hints
//                  at the link's animated payoff
//
// Filter params mirror /api/flows for parity:
//   ?mode=aggregate|timeseries
//   ?keyword=…                — matches news_articles via article_keywords
//   ?from_date=YYYY-MM-DD     — window start (default: now-7d)
//   ?to_date=YYYY-MM-DD       — window end   (default: now)
//   ?from_country=<id>        — source country filter
//   ?about_country=<id>       — destination country filter
//   ?view_mode=country|city|region (default: country)
//
// Cache key includes the full normalized param set so unrelated filters
// don't collide. Cache is stale-tolerant for 24h on the CDN since each
// filter combination's underlying data only changes when new articles
// arrive (and the in-process LRU keeps the SVG render off the hot path).
function _flowsShareHash(params) {
  const norm = {
    mode: String(params.mode || 'aggregate').toLowerCase(),
    keyword: String(params.keyword || '').toLowerCase().trim(),
    from_date: String(params.from_date || '').trim(),
    to_date: String(params.to_date || '').trim(),
    from_country: String(params.from_country || '').trim(),
    about_country: String(params.about_country || '').trim(),
    view_mode: String(params.view_mode || 'country').toLowerCase(),
  };
  return _crypto.createHash('sha256')
    .update(JSON.stringify(norm))
    .digest('hex')
    .slice(0, 16);
}

// Given the same filter set the user is viewing, fetch flow rows from
// PostgreSQL. Returns { rows, meta } where meta.peakDate is the YYYY-MM-DD
// with the highest article count in the window (only meaningful when
// mode=timeseries). For aggregate mode we don't compute peak — meta.peakDate
// stays null.
async function _flowsShareData({ mode, keyword, from_date, to_date, from_country, about_country, view_mode }) {
  const conditions = [`al.routing_type IN ('content', 'source')`];
  const params = [];

  if (from_date) { params.push(from_date); conditions.push(`a.published_at >= $${params.length}::date`); }
  if (to_date)   { params.push(to_date);   conditions.push(`a.published_at < $${params.length}::date + interval '1 day'`); }
  if (!from_date && !to_date) {
    conditions.push(`a.published_at > NOW() - INTERVAL '7 days'`);
  }
  if (from_country)  { params.push(parseInt(from_country, 10));  conditions.push(`a.country_id = $${params.length}`); }
  if (about_country) { params.push(parseInt(about_country, 10)); conditions.push(`al.country_id = $${params.length}`); }

  // Keyword: same pattern as /api/flows — uncorrelated IN(subquery) with
  // tsvector prefix match for index-backed lookup.
  if (keyword) {
    const kwLower = String(keyword).toLowerCase().trim();
    params.push(kwLower);
    const exactParam = params.length;
    const tsTokens = kwLower.replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (tsTokens.length) {
      const tsQuery = tsTokens.map(w => w + ':*').join(' & ');
      params.push(tsQuery);
      const tsParam = params.length;
      conditions.push(`a.id IN (
        SELECT ak.article_id FROM article_keywords ak
        WHERE ak.normalized_keyword = $${exactParam}
           OR to_tsvector('simple', ak.keyword) @@ to_tsquery('simple', $${tsParam})
      )`);
    } else {
      conditions.push(`a.id IN (SELECT ak.article_id FROM article_keywords ak WHERE ak.normalized_keyword = $${exactParam})`);
    }
  }

  if (view_mode === 'city' || view_mode === 'region') {
    conditions.push(`a.city_id IS NOT NULL`);
    conditions.push(`al.city_id IS NOT NULL`);
    conditions.push(`a.city_id != al.city_id`);
  } else {
    conditions.push(`a.country_id != al.country_id`);
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  // Aggregate-style: group by src/dst, return top 40 with counts. Used
  // for both modes; for timeseries we additionally narrow the WHERE to
  // the peak day after a quick bucketing pass.
  let peakDate = null;
  if (mode === 'timeseries') {
    // Quick bucketing query to find the day with the highest flow count.
    // Indexed on a.published_at; cheap even with the keyword filter.
    const bucketSql = `
      SELECT a.published_at::date AS day, COUNT(*) AS c
      FROM article_locations al
      JOIN news_articles a ON a.id = al.article_id
      ${whereClause}
      GROUP BY a.published_at::date
      ORDER BY c DESC
      LIMIT 1
    `;
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL statement_timeout = 6000`);
      const { rows: bRows } = await client.query(bucketSql, params);
      if (bRows.length && bRows[0].day) {
        const d = new Date(bRows[0].day);
        peakDate = d.toISOString().slice(0, 10);
      }
    } finally {
      client.release();
    }

    if (peakDate) {
      // Narrow the conditions to the peak day. Push two new params; record
      // their indices so the next query sees them.
      params.push(peakDate); conditions.push(`a.published_at >= $${params.length}::date`);
      params.push(peakDate); conditions.push(`a.published_at < $${params.length}::date + interval '1 day'`);
    }
  }

  const finalWhere = 'WHERE ' + conditions.join(' AND ');
  const aggSql = `
    SELECT
      COUNT(*)::int                                    AS weight,
      AVG(a.sentiment_score)                           AS avg_sentiment,
      COALESCE(src_city.latitude,  src_co.latitude)    AS src_lat,
      COALESCE(src_city.longitude, src_co.longitude)   AS src_lon,
      COALESCE(src_city.name,      src_co.name)        AS src_place,
      src_co.iso_code                                  AS src_iso,
      COALESCE(dst_city.latitude,  dst_co.latitude)    AS dst_lat,
      COALESCE(dst_city.longitude, dst_co.longitude)   AS dst_lon,
      COALESCE(dst_city.name,      dst_co.name)        AS dst_place,
      dst_co.iso_code                                  AS dst_iso
    FROM article_locations al
    JOIN news_articles a   ON a.id = al.article_id
    JOIN countries src_co  ON src_co.id = a.country_id
    JOIN countries dst_co  ON dst_co.id = al.country_id
    LEFT JOIN cities src_city ON src_city.id = a.city_id
    LEFT JOIN cities dst_city ON dst_city.id = al.city_id
    ${finalWhere}
    GROUP BY
      COALESCE(src_city.latitude,  src_co.latitude),
      COALESCE(src_city.longitude, src_co.longitude),
      COALESCE(src_city.name,      src_co.name),
      src_co.iso_code,
      COALESCE(dst_city.latitude,  dst_co.latitude),
      COALESCE(dst_city.longitude, dst_co.longitude),
      COALESCE(dst_city.name,      dst_co.name),
      dst_co.iso_code
    ORDER BY weight DESC
    LIMIT 40
  `;

  const client = await pool.connect();
  let rows;
  try {
    await client.query(`SET LOCAL statement_timeout = 8000`);
    ({ rows } = await client.query(aggSql, params));
  } finally {
    client.release();
  }

  return { rows: rows || [], peakDate };
}

function _formatDateLabel(fromDate, toDate) {
  const fmt = (s) => {
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  };
  const f = fmt(fromDate);
  const t = fmt(toDate);
  if (f && t) return `${f} – ${t}`;
  if (t) return `THROUGH ${t}`;
  if (f) return `FROM ${f}`;
  return 'PAST 7 DAYS';
}

app.get('/share/flows', async (req, res) => {
  try {
    const mode = String(req.query.mode || 'aggregate').toLowerCase();
    const theme = String(req.query.theme || req.query.keyword || '').trim();
    const dateLabel = _formatDateLabel(req.query.from_date, req.query.to_date);
    const titleBase = theme ? `${theme} · Story Flows` : 'Global Story Flows on Earth00';
    const description = mode === 'timeseries'
      ? `Peak-activity frame from a time-series of news flows on Earth00. ${dateLabel}.`
      : `Aggregate global news flows on Earth00. ${dateLabel}.`;
    const qsParams = new URLSearchParams();
    Object.entries(req.query).forEach(([k, v]) => { if (v != null && String(v).trim() !== '') qsParams.set(k, v); });
    const imageUrl = `${SHARE_HOST}/share/flows.png?${qsParams}`;
    const canonicalUrl = `${SHARE_HOST}/share/flows?${qsParams}`;
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_shareHtml({ title: titleBase, description, imageUrl, canonicalUrl, deepLinkPath: canonicalUrl }));
  } catch (err) {
    console.error('[share/flows]', err.message);
    res.status(500).send('Share page error');
  }
});

app.get('/share/flows.png', async (req, res) => {
  try {
    const mode = String(req.query.mode || 'aggregate').toLowerCase();
    const params = {
      mode,
      keyword:       req.query.keyword,
      from_date:     req.query.from_date,
      to_date:       req.query.to_date,
      from_country:  req.query.from_country,
      about_country: req.query.about_country,
      view_mode:     req.query.view_mode,
    };
    const cacheKey = `flows:${_flowsShareHash(params)}`;
    const { rows, peakDate } = await _flowsShareData(params);

    // Build top-place chip set: 3 dominant origins + 3 dominant destinations
    // by aggregated weight. Dedupe + uppercase ISO; order = top origin,
    // top destination, second origin, second destination, etc., so the
    // chip row reads as alternating src/dst poles.
    const srcWeight = new Map();
    const dstWeight = new Map();
    for (const r of rows) {
      if (r.src_iso) srcWeight.set(r.src_iso, (srcWeight.get(r.src_iso) || 0) + (Number(r.weight) || 1));
      if (r.dst_iso) dstWeight.set(r.dst_iso, (dstWeight.get(r.dst_iso) || 0) + (Number(r.weight) || 1));
    }
    const topSrc = [...srcWeight.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const topDst = [...dstWeight.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const interleaved = [];
    for (let i = 0; i < 3; i++) {
      if (topSrc[i]) interleaved.push(topSrc[i]);
      if (topDst[i] && !interleaved.includes(topDst[i])) interleaved.push(topDst[i]);
    }
    const topPlaces = interleaved.slice(0, 6);

    const peakLabelParts = [];
    if (peakDate) {
      const d = new Date(peakDate + 'T00:00:00Z');
      const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
      peakLabelParts.push(`PEAK · ${monthDay}`);
    } else if (mode === 'timeseries') {
      peakLabelParts.push('PEAK FRAME');
    }

    const arcs = rows.map(r => ({
      srcLat:   Number(r.src_lat),
      srcLon:   Number(r.src_lon),
      dstLat:   Number(r.dst_lat),
      dstLon:   Number(r.dst_lon),
      srcPlace: r.src_place,
      dstPlace: r.dst_place,
      srcIso:   r.src_iso,
      dstIso:   r.dst_iso,
      weight:   Number(r.weight) || 1,
    })).filter(a => Number.isFinite(a.srcLat) && Number.isFinite(a.dstLat));

    const png = await shareImg.generate({
      kind: 'flows',
      cacheKey,
      title:     String(req.query.theme || req.query.keyword || '').trim(),
      mode:      mode === 'timeseries' ? 'timeseries' : 'aggregate',
      dateLabel: _formatDateLabel(req.query.from_date, req.query.to_date),
      peakLabel: peakLabelParts.join(' '),
      arcs,
      topPlaces,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400');
    res.send(png);
  } catch (err) {
    console.error('[share/flows.png]', err.message);
    res.status(500).end();
  }
});


// GET /api/credits/me — current user's credit balance + costs per feature.
// Used by the frontend to render a "X credits left this week" meter and
// inline cost hints on each AI button.
app.get("/api/credits/me", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  try {
    const bal = await credits.getBalance(user.id, user.tier || 'free', { isAdmin: !!user.is_admin });
    // Serialise Infinity → null with admin:true so JSON survives the round
    // trip; the frontend meter treats either as "unlimited".
    const safeBal = JSON.parse(JSON.stringify(bal, (_k, v) => v === Infinity ? null : v));
    res.json(safeBal);
  } catch (err) {
    console.error('[credits/me]', err.message);
    res.status(500).json({ error: 'Failed to load credit balance' });
  }
});

/* =============================================================
   Push notifications — Phase 1 endpoints

   Schema lives in migrations/20260428_push_notifications.sql.
   Sender lives in apnsClient.js. Cron worker lives in
   notificationDispatcher.js (run every 5 min via the platform
   scheduler — no in-process timer here).
============================================================== */

// POST /api/notifications/register-device
// Save (or refresh) the user's APNs device token. Idempotent — same
// (user, platform, token) just bumps last_seen_at.
app.post("/api/notifications/register-device", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  try {
    const { platform, token, p256dh, auth, app_id, timezone } = req.body || {};
    if (!platform || !token) {
      return res.status(400).json({ error: "platform and token are required" });
    }
    if (!['ios', 'web'].includes(platform)) {
      return res.status(400).json({ error: "platform must be 'ios' or 'web'" });
    }
    // Phase 1 ships iOS-first. Web Push is wired in the schema but not
    // dispatched yet; reject for now so we don't accept tokens we can't honor.
    if (platform === 'web') {
      return res.status(501).json({ error: "Web Push not yet enabled" });
    }
    await pool.query(
      `INSERT INTO push_subscriptions
         (user_id, platform, token, p256dh, auth, app_id, active, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
       ON CONFLICT (user_id, platform, token) DO UPDATE
         SET active       = TRUE,
             last_seen_at = NOW(),
             p256dh       = EXCLUDED.p256dh,
             auth         = EXCLUDED.auth,
             app_id       = EXCLUDED.app_id`,
      [user.id, platform, token, p256dh || null, auth || null, app_id || null]
    );
    // First-touch: stamp a preferences row with the device timezone so
    // quiet hours work out of the box. ON CONFLICT keeps any user edits.
    if (timezone) {
      await pool.query(
        `INSERT INTO notification_preferences (user_id, timezone)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id, String(timezone).slice(0, 64)]
      );
    } else {
      await pool.query(
        `INSERT INTO notification_preferences (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[notif/register-device]', err.message);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// POST /api/notifications/unregister-device
// Soft-delete on logout / opt-out. Keeps the row for audit but stops sends.
app.post("/api/notifications/unregister-device", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  try {
    const { token, platform } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });
    await pool.query(
      `UPDATE push_subscriptions SET active = FALSE
         WHERE user_id = $1 AND token = $2 AND platform = $3`,
      [user.id, token, platform || 'ios']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notif/unregister-device]', err.message);
    res.status(500).json({ error: 'Failed to unregister device' });
  }
});

// GET /api/notifications/preferences
// Returns prefs + subscription list. Falls back to schema defaults when
// no row exists, matching what the dispatcher assumes.
app.get("/api/notifications/preferences", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  try {
    const [{ rows: prefRows }, { rows: subRows }, { rows: deviceRows }] = await Promise.all([
      pool.query(`SELECT * FROM notification_preferences WHERE user_id = $1`, [user.id]),
      pool.query(
        `SELECT id, target_type, target_value, created_at
           FROM notification_subscriptions
          WHERE user_id = $1
          ORDER BY created_at ASC`,
        [user.id]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS active_devices
           FROM push_subscriptions
          WHERE user_id = $1 AND active = TRUE`,
        [user.id]
      ),
    ]);
    const prefs = prefRows[0] || {
      enabled:               true,
      daily_briefing_on:     true,
      thread_alerts_on:      true,
      quiet_hours_start:     22,
      quiet_hours_end:       7,
      timezone:              'UTC',
      max_per_day:           3,
      thread_importance_min: 7.0,
    };
    res.json({
      preferences:    prefs,
      subscriptions:  subRows,
      active_devices: deviceRows[0]?.active_devices || 0,
    });
  } catch (err) {
    console.error('[notif/preferences GET]', err.message);
    res.status(500).json({ error: 'Failed to load preferences' });
  }
});

// PUT /api/notifications/preferences
// Patch update — only fields present in the body get written.
app.put("/api/notifications/preferences", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  try {
    const allowed = [
      'enabled', 'daily_briefing_on', 'thread_alerts_on',
      'quiet_hours_start', 'quiet_hours_end', 'timezone',
      'max_per_day', 'thread_importance_min',
    ];
    const sets = [];
    const params = [user.id];
    for (const key of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
        params.push(req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });
    // Upsert so we don't 404 on first-time write before any other endpoint
    // created the row.
    await pool.query(
      `INSERT INTO notification_preferences (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );
    await pool.query(
      `UPDATE notification_preferences SET ${sets.join(', ')} WHERE user_id = $1`,
      params
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notif/preferences PUT]', err.message);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

// POST /api/notifications/subscriptions
// Add a country (and later: entity, keyword) subscription.
app.post("/api/notifications/subscriptions", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  try {
    const { target_type, target_value } = req.body || {};
    if (!target_type || !target_value) {
      return res.status(400).json({ error: 'target_type and target_value are required' });
    }
    if (!['country', 'entity', 'keyword'].includes(target_type)) {
      return res.status(400).json({ error: "target_type must be 'country', 'entity', or 'keyword'" });
    }
    // Phase 1 ships countries. Reject other types so we don't accept
    // subscriptions we won't honor in the dispatcher.
    if (target_type !== 'country') {
      return res.status(501).json({ error: `${target_type} subscriptions not yet enabled` });
    }
    // Country values are ISO 3166-1 alpha-2, uppercased + length-gated.
    const value = String(target_value).trim().toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(value)) {
      return res.status(400).json({ error: 'country must be a 2-3 letter ISO code' });
    }
    await pool.query(
      `INSERT INTO notification_subscriptions (user_id, target_type, target_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, target_type, target_value) DO NOTHING`,
      [user.id, target_type, value]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notif/subscriptions POST]', err.message);
    res.status(500).json({ error: 'Failed to add subscription' });
  }
});

// DELETE /api/notifications/subscriptions
// Remove a subscription. Body: { target_type, target_value }.
app.delete("/api/notifications/subscriptions", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  try {
    const { target_type, target_value } = req.body || {};
    if (!target_type || !target_value) {
      return res.status(400).json({ error: 'target_type and target_value are required' });
    }
    const value = String(target_value).trim().toUpperCase();
    await pool.query(
      `DELETE FROM notification_subscriptions
         WHERE user_id = $1 AND target_type = $2 AND target_value = $3`,
      [user.id, target_type, value]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notif/subscriptions DELETE]', err.message);
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

// POST /api/notifications/opened
// Stamp opened_at on a delivery row when the user taps the notification.
// Body: { dedup_key } from the deep-link payload.
app.post("/api/notifications/opened", async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });
  try {
    const { dedup_key } = req.body || {};
    if (!dedup_key) return res.status(400).json({ error: 'dedup_key required' });
    await pool.query(
      `UPDATE notification_log SET opened_at = NOW()
         WHERE dedup_key = $1 AND user_id = $2 AND opened_at IS NULL`,
      [dedup_key, user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    // Non-fatal — open-tracking isn't critical path.
    console.warn('[notif/opened]', err.message);
    res.json({ ok: true });
  }
});


// GET /api/threads/:threadId/panels — returns cached panels + a computed
// "Coverage by source country" pie prepended. The pie is computed live on
// the thread's article set each request (cheap GROUP BY) so it's always
// current; the generator-built analytics panels (loadPanels) come from the
// data_panels table behind it.
app.get("/api/threads/:threadId/panels", async (req, res) => {
  try {
    const threadId = parseInt(req.params.threadId, 10);
    if (!Number.isFinite(threadId)) return res.status(400).json({ error: "bad id" });
    const [coverage, rows] = await Promise.all([
      computeCoveragePiePanel(pool, { type: 'thread', id: threadId }),
      dataPanels.loadPanels(pool, { type: 'thread', id: threadId }),
    ]);
    const panels = [...(coverage ? [coverage] : []), ...rows];
    res.json({ thread_id: threadId, panels, count: panels.length });
  } catch (err) {
    console.error("[threads/panels]", err.message);
    res.status(500).json({ error: "Failed to load thread panels" });
  }
});

// GET /api/timelines/:timelineId/panels — coverage pie only for now
// (timelines don't have generator-built analytics panels yet).
app.get("/api/timelines/:timelineId/panels", async (req, res) => {
  try {
    const timelineId = parseInt(req.params.timelineId, 10);
    if (!Number.isFinite(timelineId)) return res.status(400).json({ error: "bad id" });
    const coverage = await computeCoveragePiePanel(pool, { type: 'timeline', id: timelineId });
    const panels = coverage ? [coverage] : [];
    res.json({ timeline_id: timelineId, panels, count: panels.length });
  } catch (err) {
    console.error("[timelines/panels]", err.message);
    res.status(500).json({ error: "Failed to load timeline panels" });
  }
});

// Coverage-by-source-country pie. One aggregate query joins the thread /
// timeline's articles to `countries` on news_articles.country_id (the
// source country at ingestion). Top 8 slices named; everything past 8 is
// collapsed into a single "+N more" slice so the chart stays readable for
// threads with 30+ source countries in their long tail.
async function computeCoveragePiePanel(pool, { type, id }) {
  const table = type === 'timeline' ? 'story_timeline_articles' : 'story_thread_articles';
  const col   = type === 'timeline' ? 'timeline_id' : 'thread_id';

  // Combined query: both the all-time per-country distribution (used for
  // the pie's labels/values) AND the recent vs baseline window splits
  // (used for the dynamic trend caption). One round-trip instead of two.
  // Recent = last 48h, baseline = 9 days ago → 48h ago (prior week
  // excluding the recent window). FILTER aggregates Postgres-side so
  // we don't pull every article row to count windows in JS.
  const { rows } = await pool.query(`
    SELECT
      co.iso_code,
      co.name,
      COUNT(DISTINCT a.id)::int AS n,
      COUNT(DISTINCT a.id) FILTER (
        WHERE a.published_at > NOW() - INTERVAL '48 hours'
      )::int AS recent_n,
      COUNT(DISTINCT a.id) FILTER (
        WHERE a.published_at <= NOW() - INTERVAL '48 hours'
          AND a.published_at >  NOW() - INTERVAL '9 days'
      )::int AS baseline_n
      FROM ${table} sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries co ON co.id = a.country_id
     WHERE sta.${col} = $1 AND co.iso_code IS NOT NULL
     GROUP BY co.iso_code, co.name
     ORDER BY n DESC
     LIMIT 32
  `, [id]);
  if (!rows.length) return null;

  const TOP_N = 8;
  const top = rows.slice(0, TOP_N);
  const rest = rows.slice(TOP_N);
  const labels = top.map(r => r.name || r.iso_code);
  const values = top.map(r => r.n);
  if (rest.length) {
    labels.push(`+${rest.length} more`);
    values.push(rest.reduce((s, r) => s + r.n, 0));
  }
  const total = values.reduce((a, b) => a + b, 0);

  return {
    title:      'Coverage by source country',
    subtitle:   `${rows.length} countr${rows.length === 1 ? 'y' : 'ies'} · ${total} article${total === 1 ? '' : 's'}`,
    caption:    _coverageTrendCaption(rows),
    chart_type: 'pie',
    data:       { labels, series: [{ name: 'Articles', values }], unit: 'articles' },
    source_name: 'earth00 (computed)',
    generated_by: 'computed_stats',
  };
}

// ────────────────────────────────────────────────────────────────────────
// Coverage-trend caption synthesis
// ────────────────────────────────────────────────────────────────────────
// Generates a one-line natural-language statement describing how the
// thread's coverage geography is shifting between the recent 48h window
// and the prior week's baseline. Pure SQL aggregation — no Claude call,
// no token cost, computed live on every /api/threads/:id/panels request.
//
// Falls back to the static "Distribution of articles..." line when:
//   • The thread has no baseline data (too new — under ~48h old)
//   • The recent window is too sparse to draw a conclusion (< 5 articles)
//   • No country's share has shifted by > 5 percentage points
//
// Otherwise picks 1-2 risers (countries gaining share) and 1 faller
// (losing share) and composes a sentence in one of these patterns:
//   • Single strong riser:  "Coverage rising in Ukraine — 28% of articles
//                            this week, up from 11%."
//   • Two risers:           "Increased coverage from Ukraine and Poland
//                            in the last 48h."
//   • Riser + faller:       "Coverage rising in Ukraine as France's share
//                            declines."
const _STATIC_COVERAGE_CAPTION =
  'Distribution of the thread\u2019s articles across the source countries they were published in.';

function _coverageTrendCaption(rows) {
  // Sum the windowed counts.
  const totalRecent   = rows.reduce((s, r) => s + (r.recent_n   || 0), 0);
  const totalBaseline = rows.reduce((s, r) => s + (r.baseline_n || 0), 0);

  // Need at least 5 recent articles AND a baseline to compare against,
  // otherwise the deltas are too noisy to mean anything.
  if (totalRecent < 5 || totalBaseline < 5) return _STATIC_COVERAGE_CAPTION;

  // Compute per-country share delta (recent − baseline). Restrict to
  // countries with at least 2 recent articles so a single article
  // can't dominate a tiny thread.
  const deltas = rows
    .filter(r => (r.recent_n || 0) >= 2 || (r.baseline_n || 0) >= 2)
    .map(r => {
      const recentShare   = (r.recent_n   || 0) / totalRecent;
      const baselineShare = (r.baseline_n || 0) / totalBaseline;
      return {
        name:           r.name || r.iso_code,
        iso:            r.iso_code,
        recent_n:       r.recent_n   || 0,
        baseline_n:     r.baseline_n || 0,
        recent_share:   recentShare,
        baseline_share: baselineShare,
        delta:          recentShare - baselineShare,
      };
    });

  // 5-percentage-point threshold weeds out the rounding noise that
  // pure flat-coverage pies produce.
  const SIG = 0.05;
  const risers  = deltas.filter(d => d.delta >=  SIG && d.recent_n >= 2)
                        .sort((a, b) => b.delta - a.delta);
  const fallers = deltas.filter(d => d.delta <= -SIG && d.baseline_n >= 2)
                        .sort((a, b) => a.delta - b.delta);

  if (!risers.length && !fallers.length) return _STATIC_COVERAGE_CAPTION;

  const pct = (x) => Math.round(x * 100);

  // Single strong riser — most informative phrasing, name the share shift.
  if (risers.length === 1 && !fallers.length) {
    const r = risers[0];
    return `Coverage rising in ${r.name} — ${pct(r.recent_share)}% of articles in the last 48h, up from ${pct(r.baseline_share)}% the prior week.`;
  }

  // Two+ risers — pair them up.
  if (risers.length >= 2 && !fallers.length) {
    const [a, b] = risers;
    return `Increased coverage from ${a.name} and ${b.name} in the last 48h (${pct(a.recent_share)}% and ${pct(b.recent_share)}% of recent articles).`;
  }

  // Riser + faller — the contrast tells the most narrative story.
  if (risers.length && fallers.length) {
    const r = risers[0];
    const f = fallers[0];
    if (risers.length >= 2) {
      return `Coverage rising in ${r.name} and ${risers[1].name} as ${f.name}'s share declines (${pct(f.baseline_share)}% → ${pct(f.recent_share)}%).`;
    }
    return `Coverage rising in ${r.name} (${pct(r.baseline_share)}% → ${pct(r.recent_share)}%) as ${f.name}'s share declines.`;
  }

  // Only fallers — coverage is consolidating elsewhere or this thread is
  // cooling. Note who's leaving.
  if (fallers.length) {
    const f = fallers[0];
    return `Coverage easing from ${f.name} — ${pct(f.recent_share)}% of recent articles vs ${pct(f.baseline_share)}% the prior week.`;
  }

  return _STATIC_COVERAGE_CAPTION;
}

// POST /api/briefing/custom — custom briefing with from/about/keyword filters.
// Available to all paid tiers, gated by the credit ledger (debits 200
// credits text-only / 1500 credits with voiceover). The credit cost
// reflects the real Claude+ElevenLabs spend (~$0.10 / ~$1.50). Free users
// get a 401 (must sign in); they technically pass the tier gate but their
// 20-credit/week base allowance is below the 200-credit floor for even the
// cheapest path, so they'll bounce off the credit check with a clear
// "upgrade or buy a credit pack" response. Pro users have 400 credits/week
// → ~2 text briefings/week from base, voiceover via add-on packs.
// Enterprise has 2500 credits/week + a 10/month safety cap.
//
// Returns 422 { insufficient, count, message, suggestions } if < 8 articles
// found and skipCheck is not true. Otherwise generates and returns an episode.
app.post("/api/briefing/custom", async (req, res) => {
  // ── Auth ──────────────────────────────────────────────────────────────
  // Anonymous users don't have a credit balance to debit, and we don't
  // want to spawn pay-per-use billing infrastructure right now — the
  // credit ledger IS the pay-per-use system (buy a pack, spend the
  // credits). So unauthenticated → 401, point them at sign-up.
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const tier = user.tier || "free";
  const isAdmin = !!user.is_admin;
  // ── Credit ledger debit ───────────────────────────────────────────────
  // Cost depends on whether voiceover is requested — TTS is the dominant
  // expense (~$1.20 of ElevenLabs vs ~$0.10 for everything else). Picking
  // the right key BEFORE generation runs means an undercharge can't
  // happen if the user toggles voiceover at the last second on the client.
  // Atomic: if the user doesn't have enough credits, the call is rejected
  // BEFORE any Claude/ElevenLabs work runs. Refunded on failure further
  // down (best effort) so a midstream error doesn't burn the budget.
  const wantsVoiceover = !!req.body?.voiceover;
  const cbFeatureKey = wantsVoiceover ? 'custom_briefing_voice' : 'custom_briefing_text';
  const cbCredits = await credits.consumeCredits(user.id, tier, cbFeatureKey, { isAdmin })
    .catch(() => ({ allowed: false, reason: 'credit_check_error' }));
  if (!cbCredits.allowed) {
    // Suggest the right next step based on tier:
    //   - Free: upgrade to Pro (cheapest path that has any meaningful credit budget).
    //   - Pro voiceover-blocked: hint at credit packs OR Enterprise.
    //   - Pro text-blocked: weekly reset OR credit packs.
    //   - Enterprise blocked: must be a heavy week — credit packs OR wait.
    let suggestedAction;
    if (tier === 'free') {
      suggestedAction = wantsVoiceover
        ? 'Upgrade to Pro for weekly credits or to Enterprise for higher allowance.'
        : 'Upgrade to Pro for weekly credits, or buy a credit pack.';
    } else if (tier === 'pro') {
      suggestedAction = wantsVoiceover
        ? 'Voiceover briefings need 1500 credits — buy an add-on pack ($2 / 500 credits or $6 / 2000) or upgrade to Enterprise.'
        : 'Buy a credit pack or wait for next week\'s allowance (resets Monday 00:00 UTC).';
    } else {
      suggestedAction = 'Buy a credit pack or wait for next week\'s allowance.';
    }
    return res.status(429).json({
      error:        'Not enough credits for a Custom Briefing',
      limitReached: true,
      cost:         cbCredits.cost,
      remaining:    cbCredits.remaining,
      weekly_limit: cbCredits.weekly_limit,
      currentTier:  tier,
      // Recommend Pro to free users (entry tier) and Enterprise to Pro
      // users blocked on voiceover. Null for tiers that just need a pack.
      suggestedTier: tier === 'free' ? 'pro' : (tier === 'pro' && wantsVoiceover ? 'enterprise' : null),
      suggestedAction,
      withVoiceover: wantsVoiceover,
      resetNote:    'Weekly credits reset Monday 00:00 UTC. Add-on packs available.',
    });
  }
  // Belt-and-suspenders: still respect the legacy monthly cap (10/mo for
  // enterprise) so a single user can't exhaust their entire weekly credit
  // pool on one feature. Skip for admins. If the cap is hit, refund the
  // credit debit so the user isn't double-charged.
  if (!isAdmin) {
    const cbAccess = await checkCustomBriefing(user.id, tier).catch(() => ({ allowed: true }));
    if (!cbAccess.allowed) {
      // Refund the credits we just consumed.
      try { await credits.refundCredits(user.id, cbCredits.cost, cbFeatureKey, { reason: 'monthly_cap_exceeded' }); } catch (_) {}
      return res.status(403).json({
        error:        cbAccess.resetNote || "Monthly custom briefing limit reached",
        limitReached: true,
        used:         cbAccess.used,
        limit:        cbAccess.limit,
        creditsRefunded: cbCredits.cost,
      });
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
    let ep;
    try {
      ep = await generateLocationBriefing({
        type: 'country',
        id: null,
        name: locName,
        voiceover: !!voiceover,
        sourceFilter: 'mix',
        voiceId: voiceId || null,
        customFilter: { from, about, keywords, sqlWhere: where, sqlParams: params },
      });
    } catch (genErr) {
      // Refund credits on generation failure — the user shouldn't pay for
      // a briefing they can't watch. Non-fatal if refund itself errors;
      // the failure is already logged.
      try { await credits.refundCredits(user.id, cbCredits.cost, cbFeatureKey, { reason: 'generation_failed', errorMessage: genErr.message }); } catch (_) {}
      throw genErr;
    }
    // Pass credit balance back to client so the meter updates without
    // a separate /api/credits/me round-trip — same pattern as analyze /
    // explain endpoints.
    res.json({ ...ep, credits: cbCredits });
  } catch (err) {
    console.error("[briefing/custom]", err.message);
    res.status(500).json({ error: err.message || "Failed to generate custom briefing" });
  }
});

/* =========================================
   On-demand Translation
========================================= */
app.post("/api/translate", aiLimiter, async (req, res) => {
  const { title, summary, id, targetLang } = req.body || {};
  if (!title && !summary) return res.status(400).json({ error: "No text provided" });

  const target = targetLang || 'EN-US';
  const isEnglishTarget = target.startsWith('EN');

  // ── DB cache-first read ────────────────────────────────────────────
  // When the caller provides an article id AND the target is English,
  // check news_articles.translated_title/summary first. If either is
  // populated, a previous translation already paid the DeepL / Claude
  // cost and stored it — return instantly with zero external call and
  // WITHOUT decrementing the user's translation quota. This is the
  // point of the system-wide cache: the first user to translate an
  // article absorbs the cost; everyone after reads it for free.
  if (id && isEnglishTarget) {
    try {
      const { rows } = await pool.query(
        `SELECT translated_title, translated_summary FROM news_articles WHERE id = $1`,
        [id]
      );
      const cached = rows[0];
      if (cached && (cached.translated_title || cached.translated_summary)) {
        return res.json({
          translatedTitle:   cached.translated_title  || null,
          translatedSummary: cached.translated_summary || null,
          cached: true,
        });
      }
    } catch (e) {
      // Cache lookup failure is non-fatal — fall through to live translation.
      console.warn('[translate] cache lookup failed:', e.message);
    }
  }

  // Tier-based translation limits (only gate MISSES — hits above already
  // returned before this point, so users aren't billed for cached reads).
  // Admins bypass the quota: they're internal/support users whose usage
  // shouldn't count against any cap, same short-circuit as requireTier().
  if (req.user?.id && !req.user.is_admin) {
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
    const baseTarget = target.split('-')[0].toUpperCase();
    const needsClaudeFallback = DEEPL_UNSUPPORTED.has(baseTarget);

    // ── In-process dedup ────────────────────────────────────────────
    // Translation output is deterministic for a given (text, target) pair,
    // so two users translating the same article share one DeepL/Claude
    // call. Key by a short hash so we don't blow up memory on long bodies.
    // DB persistence is intentionally OUTSIDE the cache: id is specific
    // to the calling request, and the UPDATE is idempotent (COALESCE).
    const _crypto = require('crypto');
    const _inputHash = _crypto.createHash('sha1')
      .update(`${title || ''}\u0001${summary || ''}\u0001${target}`)
      .digest('hex').slice(0, 16);
    const _cacheKey = `translate:${_inputHash}`;

    const { translatedTitle, translatedSummary } = await ttlCached(_cacheKey, 600_000, async () => {
      let tt = null, ts = null;
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
          if (title)   tt = arr[i++] || null;
          if (summary) ts = arr[i++] || null;
        } catch (_) {}
      } else {
        [tt, ts] = await Promise.all([
          title   ? translateText(title,   target) : Promise.resolve(null),
          summary ? translateText(summary, target) : Promise.resolve(null),
        ]);
      }
      return { translatedTitle: tt, translatedSummary: ts };
    });

    // Only persist to DB for English translations (to avoid mixing languages across users).
    // Runs on every call (not just cache miss) because id is per-request; the UPDATE
    // is COALESCE-idempotent so a repeat write for the same id is harmless.
    // isEnglishTarget is already declared in the outer scope (used by the cache-first read above).
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
   Tier limits: Free = 1/day, Pro = 5/day, Enterprise = 20/day.
========================================= */
app.post("/api/explain", aiLimiter, async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });

  const tier = user.tier || "free";
  // Credit-based gate (replaces checkExplanation hard cap). Deducts
  // CREDIT_COSTS.article_analysis = 8 credits atomically; 429 on empty.
  const access = await credits.consumeCredits(user.id, tier, 'article_analysis', { isAdmin: !!user.is_admin }).catch(() => ({ allowed: false }));
  if (!access.allowed) {
    return res.status(429).json({
      error:        'Not enough credits for Analysis',
      limitReached: true,
      cost:         access.cost,
      remaining:    access.remaining,
      weekly_limit: access.weekly_limit,
      requiredTier: access.weekly_limit === 0 ? 'pro' : null,
      resetNote:    'Weekly credits reset Monday 00:00 UTC. Add-on packs available.',
    });
  }

  const {
    type, title, summary, keywords = [], description,
    source_name, country_name, city_name, iso_code,
  } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    if (type === "article") {
      const sourceLine = source_name ? `Source: ${source_name}` : "Source: (unknown)";
      const originParts = [];
      if (city_name) originParts.push(city_name);
      if (country_name) originParts.push(country_name);
      else if (iso_code) originParts.push(String(iso_code).toUpperCase());
      const originLine = originParts.length ? `Origin: ${originParts.join(", ")}` : "Origin: (unknown)";

      const prompt = `You are an impartial media analyst. Return ONLY valid JSON. No markdown, no code fences, no prose outside the JSON object.

Schema:
{
  "framing": "string",
  "subject_matter": "string",
  "editorial_bias": "string"
}

Rules:
- framing: ~400 characters. Deeply consider the article as a unit — how its title and summary frame the event, together with the source and its origin city/country. What is foregrounded, what is omitted, what angle does the piece take given who is publishing it and from where.
- subject_matter: ~400 characters. Analyze the subject itself, independent of this article — the real-world event, actors, stakes, and broader significance. Treat it as context a reader would need to make sense of the story.
- editorial_bias: ~350 characters. Identify the editorial bias present in THIS article. Bias is present in 99 out of 100 cases — look hard: slant, loaded language, selective framing, sympathetic vs hostile sourcing, omissions, the source's known orientation, national perspective, or institutional incentives. Name it directly and concretely. Only return "No discernible editorial bias in this piece." in the rare case the writing is genuinely neutral and balanced.
- Factual, specific, no hedging filler. No bullets, no quotes around field values beyond normal usage.

Article title: "${title}"
Summary: ${(summary || "").slice(0, 600)}
${sourceLine}
${originLine}`;

      const response = await Anthropic.messages.create({
        model:      "claude-haiku-4-5",
        max_tokens: 900,
        messages:   [{ role: "user", content: prompt }],
      });
      const rawText = (response?.content || [])
        .map((part) => typeof part?.text === "string" ? part.text : "")
        .join("")
        .trim();
      const structured = _flowCtxExtractJson(rawText) || {};
      // Defensive scrub of <cite> markup. This endpoint doesn't use
      // web_search today, but the same helper applies cheaply and
      // future-proofs the panel against any tool-use additions.
      const framing = _stripClaudeCitations(String(structured?.framing || ""));
      const subject = _stripClaudeCitations(String(structured?.subject_matter || ""));
      const bias    = _stripClaudeCitations(String(structured?.editorial_bias || ""));

      const blocks = [];
      if (framing) blocks.push({ kind: "summary",   badge: "Framing",        title: "Story & origin",    text: framing });
      if (subject) blocks.push({ kind: "primary",   badge: "Subject",        title: "Subject matter",    text: subject });
      if (bias)    blocks.push({ kind: "secondary", badge: "Editorial bias", title: "Editorial bias",    text: bias });
      if (!blocks.length) {
        blocks.push({
          kind: "summary", badge: "Framing", title: "Story & origin",
          text: _stripClaudeCitations(String(rawText || "Analysis unavailable right now.")).slice(0, 900),
        });
      }
      return res.json({ blocks, credits: _creditsBlock(access) });
    }

    const context = `Story thread: "${title}"\nDescription: ${description || summary || ""}\nKeywords: ${(keywords || []).slice(0, 10).join(", ")}`;

    const response = await Anthropic.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 120,
      messages:   [{
        role:    "user",
        content: `You are a concise global news analyst. Write a single plain-English sentence (max 250 characters) explaining the broader significance and context of this news item. No quotes, no markdown, no introductory phrases like "This article" — just the insight.\n\n${context}`,
      }],
    });

    const explanation = (response.content[0]?.text || "").trim().slice(0, 250);
    res.json({ explanation, credits: _creditsBlock(access) });
  } catch (err) {
    console.error("[api/explain]", err.message);
    res.status(500).json({ error: "Explanation generation failed" });
  }
});

/* =========================================
   Keyword AI Context  —  POST /api/keywords/explain
   Reads per-keyword analytics (country breakdown + curated article IDs)
   from `keyword_analytics` (populated 2×/day by keywordAnalyticsCron.js),
   then asks Claude Haiku for a STRUCTURED response the UI renders as an
   inline panel. The country breakdown is NOT asked of Claude — it was
   computed against the real article set in the cron, and comes back to
   the client verbatim. Claude only contributes the "about" + "surge"
   natural-language fields.
========================================= */
app.post("/api/keywords/explain", aiLimiter, async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });

  const tier = user.tier || "free";
  // Credit gate (replaces checkKwExplanation). 7 credits per keyword context.
  const access = await credits.consumeCredits(user.id, tier, 'keyword_context', { isAdmin: !!user.is_admin }).catch(() => ({ allowed: false }));
  if (!access.allowed) {
    return res.status(429).json({
      error:        'Not enough credits for Keyword Context',
      limitReached: true,
      cost:         access.cost,
      remaining:    access.remaining,
      weekly_limit: access.weekly_limit,
      requiredTier: access.weekly_limit === 0 ? 'pro' : null,
      resetNote:    'Weekly credits reset Monday 00:00 UTC. Add-on packs available.',
    });
  }

  const { keyword } = req.body || {};
  if (!keyword) return res.status(400).json({ error: "keyword is required" });

  try {
    const kwLower = String(keyword).toLowerCase().trim();
    // 10-minute cache — same keyword hit by multiple users in a short
    // window shares one Claude call. checkKwExplanation already counted
    // this user's daily quota above.
    const cacheKey = `kw-explain-v2:${kwLower}`;

    const payload = await ttlCached(cacheKey, 600_000, async () => {
      // 1. Pull precomputed rollup from keyword_analytics.
      const { rows: kwRows } = await pool.query(`
        SELECT keyword, display_keyword, total_mentions, recent_mentions,
               country_breakdown, sample_article_ids, refreshed_at
          FROM keyword_analytics
         WHERE keyword = $1
      `, [kwLower]);
      const row = kwRows[0];

      // Fallback for brand-new keywords the cron hasn't touched yet:
      // compute country breakdown + sample ids inline (slower path).
      let countryBreakdown = row?.country_breakdown || [];
      let sampleIds = row?.sample_article_ids || [];
      let totalMentions = row?.total_mentions ?? 0;
      let recentMentions = row?.recent_mentions ?? 0;
      let display = row?.display_keyword || keyword;

      if (!row) {
        // The fallback path runs when keyword_analytics has no entry —
        // e.g. brand-new keyword the cron hasn't touched yet. Use plain
        // column equality so idx_ak_normalized / idx_ak_keyword are
        // hit; the previous `LOWER(COALESCE(...))` predicate was
        // index-hostile and timed out, surfacing as a 500.
        const { rows: fb } = await pool.query(`
          SELECT co.iso_code, co.name, COUNT(DISTINCT a.id)::int AS n,
                 ARRAY_AGG(a.id ORDER BY a.published_at DESC) AS art_ids
            FROM article_keywords ak
            JOIN news_articles a ON a.id = ak.article_id
            LEFT JOIN countries co ON co.id = a.country_id
           WHERE (ak.normalized_keyword = $1
                  OR (ak.normalized_keyword IS NULL AND ak.keyword = $1))
             AND a.published_at > NOW() - INTERVAL '7 days'
             AND co.iso_code IS NOT NULL
           GROUP BY co.iso_code, co.name
           ORDER BY n DESC
           LIMIT 32
        `, [kwLower]);
        const total = fb.reduce((s, r) => s + r.n, 0) || 1;
        const top = fb.slice(0, 8);
        countryBreakdown = top.map(r => ({
          iso: r.iso_code, name: r.name || r.iso_code, n: r.n,
          pct: Math.round((r.n / total) * 1000) / 10,
        }));
        const restN = fb.slice(8).reduce((s, r) => s + r.n, 0);
        if (restN) countryBreakdown.push({ iso: null, name: `+${fb.length - 8} more`, n: restN, pct: Math.round((restN / total) * 1000) / 10 });
        sampleIds = fb.flatMap(r => r.art_ids || []).slice(0, 10);
        recentMentions = total;
      }

      // 2. Hydrate article titles + summaries for the Claude prompt.
      let sampleArticles = [];
      if (sampleIds.length) {
        const { rows } = await pool.query(`
          SELECT a.id,
                 COALESCE(a.translated_title, a.title)     AS title,
                 COALESCE(a.translated_summary, a.summary) AS summary,
                 COALESCE(ns.name, ys.name)                AS source,
                 co.iso_code, co.name AS country_name,
                 a.published_at
            FROM news_articles a
            LEFT JOIN news_sources ns   ON ns.id = a.source_id
            LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
            LEFT JOIN countries co      ON co.id = a.country_id
           WHERE a.id = ANY($1::int[])
        `, [sampleIds]);
        const byId = new Map(rows.map(r => [r.id, r]));
        sampleArticles = sampleIds.map(id => byId.get(id)).filter(Boolean);
      }

      // 3. Claude prompt — structured JSON, no prose outside the object.
      const articleBlock = sampleArticles.slice(0, 10).map(a =>
        `- [${a.source || '?'}${a.country_name ? ', ' + a.country_name : ''}, ${new Date(a.published_at).toISOString().slice(0,10)}] "${(a.title || '').slice(0, 160)}"\n  ${(a.summary || '').slice(0, 220).replace(/\s+/g, ' ')}`
      ).join('\n');
      const countryBlock = countryBreakdown.length
        ? countryBreakdown.map(c => `${c.name} ${c.pct}%`).join(' · ')
        : '(no country breakdown)';

      const prompt = `You are a geopolitical analyst writing an inline context panel for a trending keyword in a news-intelligence dashboard. Return ONLY valid JSON. No markdown fences, no prose outside the object.

Schema:
{
  "about":       "string (≈350 chars, what the keyword represents right now)",
  "surge_reason":"string (≈280 chars, why it's spiking in mentions now)"
}

Rules:
- "about": explain what this keyword is referring to in the current news cycle. Ground it in the articles below — reference the actual events, actors, or stories driving the keyword. Don't define the word generically; describe its news relevance right now.
- "surge_reason": explain why the keyword is trending this week. If the articles point to a specific triggering event (attack, ruling, announcement, release), name it. If it's a slow accumulation of coverage rather than a single spike, say so.
- Both fields: factual, analytical, specific. No filler. No "this keyword refers to" / "this is about" openings — jump straight into the substance.
- Do NOT repeat the country breakdown — it's rendered separately from precomputed data.

Keyword: "${display}"
Mentions last 7 days: ${recentMentions}${totalMentions ? ` (${totalMentions} all-time)` : ''}
Geographic distribution: ${countryBlock}

Sample articles (${sampleArticles.length}):
${articleBlock || '(no articles available)'}`;

      const response = await Anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      const raw = (response?.content || []).map(p => typeof p?.text === 'string' ? p.text : '').join('').trim();
      let structured = {};
      try {
        const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        structured = JSON.parse(unfenced);
      } catch (_) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { structured = JSON.parse(m[0]); } catch (_) {} }
      }

      return {
        keyword:           display,
        about:             String(structured.about || raw || 'Context unavailable.').trim(),
        surge_reason:      String(structured.surge_reason || '').trim(),
        country_breakdown: countryBreakdown,
        total_mentions:    totalMentions,
        recent_mentions:   recentMentions,
        refreshed_at:      row?.refreshed_at || null,
      };
    });

    res.json({ ...payload, credits: _creditsBlock(access) });
  } catch (err) {
    console.error("[api/keywords/explain]", err.message, err.stack || '');
    res.status(500).json({
      error: "Keyword explanation generation failed",
      detail: req.user?.is_admin ? err.message : undefined,
    });
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
  trending: 5 * 60 * 1000,   // 5 min in-memory (DB cache is primary)
  rising: 5 * 60 * 1000,     // 5 min in-memory
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
    // Accept up to 48h old cache — stale data is far better than a slow live query
    if (!sourceCountryId && !aboutCountryId) {
      const dbCached = await getDbKeywordCache("trending", "global", 2880); // 48h max staleness
      if (dbCached) {
        setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.trending);
        if (dbCached.keywords && Array.isArray(dbCached.keywords)) {
          return res.json(dbCached.keywords.slice(0, limitInt));
        }
        return res.json(Array.isArray(dbCached) ? dbCached.slice(0, limitInt) : []);
      }
    }

    // Cache miss — compute live and write-through to DB for next request
    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.trending);
    const isGlobal = !sourceCountryId && !aboutCountryId;
    const rows = await getCachedKeywordPayload(cacheKey, KEYWORD_ROUTE_TTLS.trending, async () => {
      const params = [daysInt];
      const clauses = ["k.date >= CURRENT_DATE - $1::int"];
      appendKeywordCountryClauses(clauses, params, {
        sourceCountryId,
        aboutCountryId,
        defaultGlobal: true,
        alias: "k",
      });
      params.push(limitInt > 50 ? limitInt : 50); // fetch at least 50 for cache
      const limitIdx = params.length;

      // PERF: two-stage aggregation. raw CTE aggregates by the plain
      // keyword column (lets Postgres use idx_kds_global_date_keyword_cover);
      // the outer SELECT joins keyword_translations on the small
      // post-aggregation result and re-aggregates by normalized form.
      // The earlier single-stage form forced a sequential scan because
      // the GROUP BY key was a function expression. See /api/keywords/rising
      // for full rationale.
      //
      // days_active is collapsed via MAX across language variants —
      // approximate but defensible (the dominant variant's day-count
      // typically dominates anyway). Exact COUNT(DISTINCT date) across
      // merged variants would require a third pass over the raw rows.
      const result = await pool.query(
        `WITH raw AS (
           SELECT k.keyword,
                  SUM(k.total_count)::bigint AS mentions,
                  COUNT(DISTINCT k.date)::int AS days_active
           FROM keyword_daily_stats k
           WHERE ${clauses.join("\n             AND ")}
             AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)
           GROUP BY k.keyword
         )
         SELECT
           COALESCE(kt.normalized_keyword, r.keyword) AS keyword,
           SUM(r.mentions)::bigint AS mentions,
           MAX(r.days_active)::int AS days_active
         FROM raw r
         LEFT JOIN keyword_translations kt ON kt.original_keyword = r.keyword
         GROUP BY COALESCE(kt.normalized_keyword, r.keyword)
         HAVING SUM(r.mentions) >= 3
         ORDER BY mentions DESC, COALESCE(kt.normalized_keyword, r.keyword) ASC
         LIMIT $${limitIdx}`,
        params
      );

      const keywords = result.rows;

      // Write-through: save to DB cache so next request is instant
      if (isGlobal && keywords.length > 0) {
        pool.query(`
          INSERT INTO keyword_intelligence_cache (mode, filter_key, results)
          VALUES ($1, $2, $3)
        `, ['trending', 'global', JSON.stringify({ keywords })]).catch(e =>
          console.warn('[keywords/trending] write-through cache failed:', e.message)
        );
      }

      return keywords;
    });

    res.json(Array.isArray(rows) ? rows.slice(0, limitInt) : rows);
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

    // Check DB pre-computed cache for global requests (populated by
    // keywordCron.js). Aggressive 48h TTL: the live fallback aggregates
    // ~2.2M rows/day × 17 days and takes 30s+ end-to-end, so even
    // day-old cache is dramatically better than rebuilding live. The
    // rising signal itself ("what's surging in the last 3 days vs
    // 14-day baseline") doesn't shift meaningfully from minute to
    // minute; a 24-48h refresh is more than enough.
    if (!sourceCountryId && !aboutCountryId) {
      const dbCached = await getDbKeywordCache("rising", "global", 2880); // 48h max staleness
      if (dbCached) {
        setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.rising);
        const cachedArr = (dbCached.keywords && Array.isArray(dbCached.keywords))
          ? dbCached.keywords
          : (Array.isArray(dbCached) ? dbCached : []);
        return res.json(cachedArr.filter((row) => !isDateLikeKeyword(row && row.keyword)).slice(0, limitInt));
      }
    }

    // Cache miss — compute live and write-through
    setKeywordCacheHeaders(res, KEYWORD_ROUTE_TTLS.rising);
    const isGlobal = !sourceCountryId && !aboutCountryId;
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

      // PERF NOTE — three optimizations stack:
      //
      // 1. Two-stage aggregation. recent_raw / baseline_raw aggregate
      //    by the plain keyword column so the partial index
      //    `idx_kds_global_date_kw_count` can serve the heavy GROUP BY.
      //    The translation JOIN happens AFTER on the small post-
      //    aggregation result. (The single-stage form forced a seq
      //    scan because the GROUP BY key was a function expression.)
      //
      // 2. Candidate pruning on baseline_raw. We only USE baseline
      //    counts for keywords that survived recent_raw's HAVING
      //    (i.e. that have ≥2 mentions in the recent window). So we
      //    constrain baseline_raw to ONLY those keywords via an
      //    IN-subquery against recent_raw. On a 14-day baseline
      //    window with ~30M rows, this typically prunes 99%+ of
      //    keyword groups — the difference between 30s and ~1s for
      //    country-filtered queries that bypass the cache.
      //
      // 3. The result then re-aggregates by COALESCE-normalized form
      //    so Russian "выборы" and English "election" don't appear
      //    as two rows.
      const result = await pool.query(
        `WITH recent_raw AS (
           SELECT k.keyword, SUM(k.total_count)::bigint AS recent_count
           FROM keyword_daily_stats k
           WHERE ${recentClauses.join("\n             AND ")}
             AND NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)
           GROUP BY k.keyword
           HAVING SUM(k.total_count) >= 2
         ),
         baseline_raw AS (
           SELECT k.keyword, SUM(k.total_count)::bigint AS baseline_count
           FROM keyword_daily_stats k
           WHERE ${baselineClauses.join("\n             AND ")}
             AND k.keyword IN (SELECT keyword FROM recent_raw)
           GROUP BY k.keyword
         ),
         recent AS (
           SELECT COALESCE(kt.normalized_keyword, r.keyword) AS keyword,
                  SUM(r.recent_count)::bigint AS recent_count
           FROM recent_raw r
           LEFT JOIN keyword_translations kt ON kt.original_keyword = r.keyword
           GROUP BY COALESCE(kt.normalized_keyword, r.keyword)
         ),
         baseline AS (
           SELECT COALESCE(kt.normalized_keyword, b.keyword) AS keyword,
                  SUM(b.baseline_count)::bigint AS baseline_count
           FROM baseline_raw b
           LEFT JOIN keyword_translations kt ON kt.original_keyword = b.keyword
           GROUP BY COALESCE(kt.normalized_keyword, b.keyword)
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

      const keywords = result.rows;

      // Write-through: save to DB cache so next request is instant
      if (isGlobal && keywords.length > 0) {
        pool.query(`
          INSERT INTO keyword_intelligence_cache (mode, filter_key, results)
          VALUES ($1, $2, $3)
        `, ['rising', 'global', JSON.stringify({ keywords })]).catch(e =>
          console.warn('[keywords/rising] write-through cache failed:', e.message)
        );
      }

      return keywords;
    });

    const filtered = (Array.isArray(rows) ? rows : []).filter((row) => !isDateLikeKeyword(row && row.keyword)).slice(0, limitInt);
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
      // Match keyword OR its normalized form so a click on the deduped
      // English label from /api/keywords/trending pulls every source-
      // language variant. The trending list now emits the normalized
      // form (e.g. "election"), and the user expects /top?keyword=election
      // to sum Russian "выборы" + Spanish "elección" + English
      // "election" together — not just the literal English row.
      const clauses = [
        "(k.keyword = $1 OR EXISTS (SELECT 1 FROM keyword_translations kt2 WHERE kt2.original_keyword = k.keyword AND kt2.normalized_keyword = $1))",
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
           COALESCE(kt.normalized_keyword, k.keyword) AS keyword,
           SUM(k.total_count)::bigint AS total_mentions,
           SUM(k.language_group_count)::bigint AS language_groups,
           MIN(k.date) AS first_seen,
           MAX(k.date) AS last_seen
         FROM keyword_daily_stats k
         LEFT JOIN keyword_translations kt
           ON kt.original_keyword = k.keyword
         WHERE ${clauses.join("\n           AND ")}
         GROUP BY COALESCE(kt.normalized_keyword, k.keyword)
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
   Pre-computed by sourcesStatsCron.js (twice daily).
   Reads from keyword_intelligence_cache; accepts up to 24h staleness.
========================================= */
app.get("/api/news/sources-stats", async (req, res) => {
  try {
    const data = await ttlCached('sources-stats:all', 300_000, async () => {
      // Read from DB cache (populated by sourcesStatsCron.js)
      const dbCached = await getDbKeywordCache("sources-stats", "global", 1440); // 24h max staleness
      if (dbCached) return dbCached;

      // Fallback: live queries if cron hasn't run yet (first deploy)
      console.warn('[sources-stats] no cache — running live queries (slow)');
      const [countryDist, countryRank, cityRank, sourceRank, sourceCountry] =
        await Promise.all([
          pool.query(`
            SELECT co.name AS country, co.iso_code, COUNT(*)::int AS articles
            FROM news_articles a JOIN countries co ON co.id = a.country_id
            WHERE a.published_at > NOW() - INTERVAL '30 days' AND a.country_id IS NOT NULL
            GROUP BY co.id, co.name, co.iso_code ORDER BY articles DESC LIMIT 200
          `),
          pool.query(`
            SELECT co.name AS country, co.iso_code,
                   COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
            FROM news_articles a JOIN countries co ON co.id = a.country_id
            WHERE a.published_at > NOW() - INTERVAL '30 days' AND a.country_id IS NOT NULL
            GROUP BY co.id, co.name, co.iso_code HAVING COUNT(*) >= 5 ORDER BY "avgPerDay" DESC LIMIT 200
          `),
          pool.query(`
            SELECT ci.name AS city, co.name AS country,
                   COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
            FROM news_articles a JOIN cities ci ON ci.id = a.city_id JOIN countries co ON co.id = ci.country_id
            WHERE a.published_at > NOW() - INTERVAL '30 days' AND a.city_id IS NOT NULL
            GROUP BY ci.id, ci.name, co.name HAVING COUNT(*) >= 3 ORDER BY "avgPerDay" DESC LIMIT 200
          `),
          pool.query(`
            SELECT COALESCE(ns.name, ys.name) AS source, COALESCE(ns.site_url, ys.site_url) AS site_url,
                   COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400) AS "avgPerDay"
            FROM news_articles a LEFT JOIN news_sources ns ON ns.id = a.source_id LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
            WHERE a.published_at > NOW() - INTERVAL '30 days'
            GROUP BY COALESCE(ns.name, ys.name), COALESCE(ns.site_url, ys.site_url) HAVING COUNT(*) >= 3 ORDER BY "avgPerDay" DESC LIMIT 200
          `),
          pool.query(`
            SELECT co.name AS country, co.iso_code,
                   COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id))::int AS "sourceCount"
            FROM news_articles a JOIN countries co ON co.id = a.country_id
            WHERE a.published_at > NOW() - INTERVAL '30 days' AND a.country_id IS NOT NULL
            GROUP BY co.id, co.name, co.iso_code
            HAVING COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id)) >= 1 ORDER BY "sourceCount" DESC LIMIT 200
          `),
        ]);

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
   Pre-computed by globeStatsCron.js (every 6 hours).
   Reads from keyword_intelligence_cache; accepts up to 24h staleness.
========================================= */
app.get("/api/globe-stats", async (req, res) => {
  try {
    // 90s server-side cache — was 10 min. The DB row is what the cron
    // updates; the in-memory layer's only job is to absorb burst reads
    // so we don't hit Postgres on every API call. 90s is plenty for
    // that (the DB read is a single small JSONB row) and dramatically
    // shortens the "I just ran the cron, why doesn't it show up yet"
    // window. Cloudflare's s-maxage=120 still caps front-end visibility
    // at ~2 min total — see the cacheControlByPath table.
    const data = await ttlCached('globe-stats:all', 90_000, async () => {
      // Read from DB cache (populated by globeStatsCron.js)
      const dbCached = await getDbKeywordCache("globe-stats", "global", 1440); // 24h max staleness
      if (dbCached) return dbCached;

      console.warn('[globe-stats] no cache available — returning empty');
      return {};
    });
    res.json(data);
  } catch (err) {
    console.error("Globe stats error:", err);
    res.status(500).json({ error: "Failed to fetch globe stats" });
  }
});

/* =========================================
   Heatmap Q&A  —  POST /api/heatmap/ask
   Free-form question → Claude tool-use call → country-indexed values.
   Frontend pipes the result into the existing semantic-heatmap renderer.

   Flow:
     1. Hash the normalized question + mode, look up heatmap_qa_cache.
        Hit  → return cached (free, no Claude call, increment hit_count).
        Miss → continue.
     2. Charge credits via creditLedger.
     3. Build the country whitelist from the `countries` table so we can
        validate Claude's output and reject hallucinated ISOs.
     4. Call Claude with a `set_country_values` tool. Tool use locks the
        output shape — no JSON parsing of free text.
     5. Validate, persist to cache, return to client.

   On refusal: Claude can call `decline_question({ reason })` instead of
   `set_country_values`. We persist the refusal so subsequent identical
   asks return instantly without burning credits a second time.
========================================= */
app.post("/api/heatmap/ask", aiLimiter, async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });

  const rawQuestion = String(req.body?.question || "").trim();
  const mode = String(req.body?.mode || "percent").toLowerCase();
  // Cache bypass: ?fresh=1 OR body.fresh=true forces a re-call against
  // Sonnet, useful when the prompt has been strengthened and old rows
  // are stale. Curated rows still get rewritten because we ON CONFLICT
  // UPDATE, so admins can use this judiciously.
  const forceFresh = String(req.query?.fresh || req.body?.fresh || '').toLowerCase() === '1' ||
                     String(req.query?.fresh || req.body?.fresh || '').toLowerCase() === 'true';
  if (!rawQuestion) return res.status(400).json({ error: "question is required" });
  if (rawQuestion.length > 280) return res.status(400).json({ error: "question too long (max 280 chars)" });
  if (!["percent", "rank", "binary"].includes(mode)) {
    return res.status(400).json({ error: "mode must be percent | rank | binary" });
  }

  // Normalize for stable cache key — this same hash is what
  // resolveHeatmap() uses internally; computing it here so the cache
  // hit path can short-circuit before touching credit consumption.
  const normalized = rawQuestion.toLowerCase().replace(/\s+/g, " ").trim();
  const crypto = require('crypto');
  const questionHash = crypto.createHash('sha256').update(`${mode}|${normalized}`).digest('hex');

  try {
    // 1. Cache lookup short-circuit. Pinned curated rows + recent
    //    Claude rows both live here. We pre-check so cache hits
    //    don't burn credits — the resolver itself doesn't enforce
    //    credits (that's an endpoint concern).
    if (!forceFresh) {
      const { rows: cachedRows } = await pool.query(
        `SELECT id, mode, legend, unit, source_note, values, refusal, source
           FROM heatmap_qa_cache
          WHERE question_hash = $1 AND mode = $2
          LIMIT 1`,
        [questionHash, mode]
      );
      if (cachedRows.length) {
        const row = cachedRows[0];
        pool.query(
          `UPDATE heatmap_qa_cache SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE id = $1`,
          [row.id]
        ).catch(() => {});
        return res.json({
          question:    rawQuestion,
          mode:        row.mode,
          legend:      row.legend,
          unit:        row.unit,
          source_note: row.source_note,
          values:      row.values,
          refusal:     row.refusal,
          source:      row.source,
          cache:       'hit',
        });
      }
    }

    // 2. Credit gate (only on miss — cache hits are free).
    const tier = user.tier || "free";
    const access = await credits.consumeCredits(user.id, tier, 'heatmap_qa', { isAdmin: !!user.is_admin }).catch(() => ({ allowed: false }));
    if (!access.allowed) {
      return res.status(429).json({
        error:        'Not enough credits for Heatmap Q&A',
        limitReached: true,
        cost:         access.cost,
        remaining:    access.remaining,
        weekly_limit: access.weekly_limit,
        requiredTier: access.weekly_limit === 0 ? 'pro' : null,
        resetNote:    'Weekly credits reset Monday 00:00 UTC. Add-on packs available.',
      });
    }

    // 3. Delegate to the shared resolver. It runs the Claude call,
    //    fill-in pass, and cache write. forceFresh skips its internal
    //    cache lookup; we already short-circuited cache hits above so
    //    the resolver always proceeds to Claude here.
    const result = await heatmapResolver.resolveHeatmap(rawQuestion, mode, { forceFresh: true });
    return res.json({
      ...result,
      cache: 'miss',
      credits: access.remaining != null ? { remaining: access.remaining, weekly_limit: access.weekly_limit } : undefined,
    });
  } catch (err) {
    console.error('[heatmap-ask]', err);
    return res.status(500).json({ error: 'Heatmap Q&A failed', detail: err.message });
  }
});

/* =========================================
   ADMIN — Heatmap Q&A curation
   ─────────────────────────────────────────
   Sonnet hallucinates on factual recall (e.g. lists Egypt + Cuba as
   having active volcanoes — both false). The /api/heatmap/ask cache
   already has a `source` column distinguishing 'claude' from 'curated'.
   This admin flow lets us:
     1. POST /admin/heatmap/simulate — re-run Sonnet against the live
        prompt, return the full country catalog merged with Sonnet's
        values so the editor can show every country (including ones
        Sonnet omitted).
     2. POST /admin/heatmap/save — overwrite the cache row with hand-
        verified values, flipped to source='curated'. Future calls to
        /api/heatmap/ask hit the cache and never reach Sonnet for that
        question.
     3. GET  /admin/heatmap/saved — list saved curated rows for re-edit.
========================================= */

// Shared helper: builds the system prompt + tools, runs Sonnet, returns
// validated payload. Same prompt as /api/heatmap/ask (which is the whole
// point — admin sees what users see). Doesn't touch cache or credits.
async function _callHeatmapSonnet({ question, mode }) {
  const { rows: countryRows } = await pool.query(
    `SELECT iso_code, name FROM countries WHERE iso_code IS NOT NULL AND length(iso_code) = 2 ORDER BY name`
  );
  const isoSet = new Set(countryRows.map(c => c.iso_code.toUpperCase()));
  const isoCatalog = countryRows.map(c => `${c.iso_code.toUpperCase()} ${c.name}`).join('\n');

  const modeGuidance = mode === 'percent'
    ? 'Each value is a percentage 0–100 (e.g. 87.2 means 87.2% of that country\'s population/area/whatever the question asks).'
    : mode === 'rank'
    ? 'Each value is an integer rank starting at 1 (lower = stronger). Only include the ranked countries; omit unranked ones.'
    : 'Each value is 0 or 1. Include only countries where the answer is 1.';

  const tools = [
    // Server tool — Anthropic-hosted web search. Same cap as the public
    // endpoint so admin sim mirrors what users see.
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 6,
    },
    {
      name: 'set_country_values',
      description: 'Return a per-country value map answering the user question. Call this LAST, after any web_search calls.',
      input_schema: {
        type: 'object',
        required: ['legend', 'values'],
        properties: {
          legend: { type: 'string' },
          unit: { type: 'string' },
          source_note: { type: 'string' },
          values: {
            type: 'array',
            items: {
              type: 'object',
              required: ['iso', 'value'],
              properties: {
                iso: { type: 'string' },
                value: { type: 'number' },
              },
            },
          },
        },
      },
    },
    {
      name: 'decline_question',
      description: 'Decline the question — biased, unanswerable, or no per-country mapping.',
      input_schema: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string' } },
      },
    },
  ];

  // Same prompt body as /api/heatmap/ask. Kept inline rather than
  // extracted because the prompt is policy and we want it readable
  // alongside the endpoint that uses it.
  const systemPrompt = `You answer geographic questions for a globe-based news intelligence dashboard. Your output paints a heatmap.

Available countries (use ONLY these 2-letter ISO codes):
${isoCatalog}

Output rules:
- Mode: ${mode}. ${modeGuidance}
- Use the set_country_values tool when the question has a meaningful per-country answer.
- Use the decline_question tool when the question is biased, value-loaded, has no objective per-country mapping, or asks for something dangerous. Be concise and neutral about the reason.
- Cite specific sources in source_note. Use "AI estimate — verify before citing" only when no source could be verified.

DATA VERIFICATION POLICY:

You have access to a \`web_search\` tool (up to 6 uses). Accuracy beats speed. Use it whenever:
- Specific numbers are asked (population, GDP, area, ranks, percentages) and you are not 100% certain of recent values.
- A defined membership list is referenced (NATO, OPEC, EU, NPT, BRICS, ASEAN, OECD, G20, Schengen, eurozone, Commonwealth) — verify CURRENT membership.
- The topic drifts over time (sanctions, treaties, leaders, currency unions, alliances).
- You can think of obvious candidates but cannot confidently enumerate the full set.
- Coverage of less-Western regions is required and your unaided recall may be Western-biased.

AUTHORITATIVE SOURCES BY DOMAIN (prefer these; cite the one you used):
- Demographics / population: worldbank.org, population.un.org, cia.gov/the-world-factbook, census.gov
- Economics / GDP / trade: worldbank.org, imf.org/data, oec.world, oecd.org
- Geography / topography / peaks / rivers: usgs.gov, naturalearthdata.com, geonames.org, britannica.com, peakbagger.com
- Climate / environment / energy: iea.org, ipcc.ch, ourworldindata.org, noaa.gov, climatewatchdata.org
- Biology / biodiversity: iucnredlist.org, gbif.org, worldwildlife.org, fao.org
- Health: who.int, healthdata.org, unaids.org, unicef.org/data
- Politics / governance / press freedom: freedomhouse.org, v-dem.net, transparency.org, rsf.org
- Languages / religion: ethnologue.com, pewresearch.org
- Military / nuclear: sipri.org, iiss.org, fas.org/issues/nuclear-weapons
- Treaties / international orgs: treaties.un.org, europa.eu, nato.int

Wikipedia is acceptable as a starting point; its country-list articles are usually well-cited.

For RANK mode: "rank by X" means EVERY country with a non-trivial value of X should appear. Do not truncate to a top-10 unless explicitly asked. China at 1 or 2 on population — never absent.

For BINARY mode: be more inclusive than your gut suggests. If you can think of three obvious countries that match, there are probably twenty more. Walk continents — and if uncertain about non-Western entries, web_search.

Aim for high recall on clear positives and strict exclusion of vague matches.`;

  const Anthropic = require('@anthropic-ai/sdk');
  const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await aiClient.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    // Web search injects results inline; allow headroom.
    max_tokens: 12000,
    system: systemPrompt,
    tools,
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: question }],
  });

  const toolUse = (resp.content || []).find(b => b.type === 'tool_use');
  let payload = { legend: null, unit: null, source_note: null, values: [], refusal: null };
  if (!toolUse) throw new Error('Model returned no tool call');
  if (toolUse.name === 'decline_question') {
    payload.refusal = String(toolUse.input?.reason || 'Question cannot be answered as a heatmap.');
  } else if (toolUse.name === 'set_country_values') {
    const raw = toolUse.input || {};
    payload.legend = String(raw.legend || question).slice(0, 120);
    payload.unit = raw.unit ? String(raw.unit).slice(0, 16) : (mode === 'percent' ? '%' : (mode === 'rank' ? 'rank' : ''));
    payload.source_note = String(raw.source_note || 'AI estimate — verify before citing').slice(0, 240);
    const seen = new Set();
    payload.values = (Array.isArray(raw.values) ? raw.values : [])
      .map(v => ({ iso: String(v.iso || '').toUpperCase().trim(), value: Number(v.value) }))
      .filter(v => v.iso && isoSet.has(v.iso) && Number.isFinite(v.value) && !seen.has(v.iso) && (seen.add(v.iso) || true));
  }
  return { payload, countryRows };
}

// Simulate — runs Sonnet, merges with catalog so the editor can
// display every country (including ones Sonnet omitted). Always
// fresh — no cache lookup, no cache write. Caller is admin so we
// don't charge credits.
app.post('/api/admin/heatmap/simulate', requireAdmin, async (req, res) => {
  const question = String(req.body?.question || '').trim();
  const mode = String(req.body?.mode || 'percent').toLowerCase();
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (!['percent', 'rank', 'binary'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be percent | rank | binary' });
  }
  try {
    const { payload, countryRows } = await _callHeatmapSonnet({ question, mode });
    // Also surface any existing cached row so the editor can show
    // "this question was last curated on X" and pre-fill from it.
    const crypto = require('crypto');
    const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim();
    const questionHash = crypto.createHash('sha256').update(`${mode}|${normalized}`).digest('hex');
    const existing = await pool.query(
      `SELECT source, values, legend, unit, source_note, last_hit_at
         FROM heatmap_qa_cache WHERE question_hash=$1 AND mode=$2 LIMIT 1`,
      [questionHash, mode]
    );
    return res.json({
      question,
      mode,
      legend: payload.legend,
      unit: payload.unit,
      source_note: payload.source_note,
      values: payload.values,
      refusal: payload.refusal,
      catalog: countryRows.map(c => ({ iso: c.iso_code.toUpperCase(), name: c.name })),
      existing: existing.rows[0] || null,
    });
  } catch (err) {
    console.error('[admin/heatmap/simulate]', err);
    return res.status(500).json({ error: 'Simulate failed', detail: err.message });
  }
});

// Save — writes (or overwrites) a curated row in heatmap_qa_cache.
// Uses the same hash key as the public endpoint so future user calls
// hit this row instead of re-calling Sonnet.
app.post('/api/admin/heatmap/save', requireAdmin, async (req, res) => {
  const question = String(req.body?.question || '').trim();
  const mode = String(req.body?.mode || 'percent').toLowerCase();
  const legend = String(req.body?.legend || question).slice(0, 120);
  const unit = String(req.body?.unit || (mode === 'percent' ? '%' : mode === 'rank' ? 'rank' : '')).slice(0, 16);
  const source_note = String(req.body?.source_note || 'Curated').slice(0, 240);
  const rawValues = Array.isArray(req.body?.values) ? req.body.values : [];
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (!['percent', 'rank', 'binary'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be percent | rank | binary' });
  }
  try {
    const { rows: countryRows } = await pool.query(
      `SELECT iso_code FROM countries WHERE iso_code IS NOT NULL AND length(iso_code) = 2`
    );
    const isoSet = new Set(countryRows.map(c => c.iso_code.toUpperCase()));
    const seen = new Set();
    const values = rawValues
      .map(v => ({ iso: String(v.iso || '').toUpperCase().trim(), value: Number(v.value) }))
      .filter(v => v.iso && isoSet.has(v.iso) && Number.isFinite(v.value))
      .filter(v => {
        if (mode === 'binary' && v.value !== 1) return false;
        if (mode === 'percent' && (v.value < 0 || v.value > 100)) return false;
        if (mode === 'rank' && v.value < 1) return false;
        if (seen.has(v.iso)) return false;
        seen.add(v.iso);
        return true;
      });

    const crypto = require('crypto');
    const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim();
    const questionHash = crypto.createHash('sha256').update(`${mode}|${normalized}`).digest('hex');
    await pool.query(
      `INSERT INTO heatmap_qa_cache
         (question_hash, question_text, mode, legend, unit, source_note, values, refusal, source, hit_count, last_hit_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'curated', 0, NOW())
       ON CONFLICT (question_hash, mode) DO UPDATE SET
         question_text = EXCLUDED.question_text,
         legend        = EXCLUDED.legend,
         unit          = EXCLUDED.unit,
         source_note   = EXCLUDED.source_note,
         values        = EXCLUDED.values,
         refusal       = NULL,
         source        = 'curated',
         last_hit_at   = NOW()`,
      [questionHash, question, mode, legend, unit, source_note, JSON.stringify(values)]
    );
    return res.json({ ok: true, question, mode, count: values.length });
  } catch (err) {
    console.error('[admin/heatmap/save]', err);
    return res.status(500).json({ error: 'Save failed', detail: err.message });
  }
});

// List saved curated rows so the editor can offer "edit existing".
app.get('/api/admin/heatmap/saved', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT question_hash, question_text, mode, legend, unit, source_note,
              hit_count, last_hit_at, source,
              jsonb_array_length(COALESCE(values::jsonb, '[]'::jsonb)) AS value_count
         FROM heatmap_qa_cache
        WHERE source = 'curated'
        ORDER BY last_hit_at DESC NULLS LAST
        LIMIT 200`
    );
    return res.json({ rows });
  } catch (err) {
    console.error('[admin/heatmap/saved]', err);
    return res.status(500).json({ error: 'List failed', detail: err.message });
  }
});

// Load full curated row for editing (returns values too).
app.get('/api/admin/heatmap/saved/:questionHash/:mode', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM heatmap_qa_cache WHERE question_hash=$1 AND mode=$2 LIMIT 1`,
      [req.params.questionHash, req.params.mode]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[admin/heatmap/saved/get]', err);
    return res.status(500).json({ error: 'Load failed', detail: err.message });
  }
});

/* =========================================
   Account deletion  —  DELETE /api/account
   Required by App Store guideline 5.1.1(v) (since 2022): if a user can
   create an account in the app, they must be able to delete it from
   inside the app. GDPR also requires erasure of personal data.

   What we delete:
     1. Supabase auth user (sba.auth.admin.deleteUser). This triggers
        the ON DELETE CASCADE on user_preferences (see migration #25).
     2. Render Postgres user-keyed tables: user_usage,
        briefing_access_log, custom_briefing_usage, user_credit_balance,
        credit_ledger.
     3. editor_events.editor_id is NULLed (not row-deleted) so the
        editorial audit log preserves the action history without the
        personal identifier — required for editorial-rule mining and
        legitimately within the GDPR allowance for retained anonymized
        records.

   Order matters: Supabase first. If it fails, no data is touched. If
   Postgres steps partially fail after, we still return success —
   auth is gone, the user can't access leftover rows, and a periodic
   cleanup job can sweep orphans later.

   Active PayPal/Apple subscriptions are intentionally NOT cancelled
   here — users must cancel via PayPal's portal or iOS Settings →
   Subscriptions before deleting. The subscription row is preserved so
   late webhooks (renewal, refund) still have a target to update.
========================================= */
app.delete("/api/account", authLimiter, async (req, res) => {
  const user = req.user?.id ? req.user : await resolveSupabaseUserFromRequest(req);
  if (!user?.id) return res.status(401).json({ error: "Authentication required" });

  const userId = user.id;
  const errors = [];

  // 1. Supabase auth — most critical step. If this fails, abort.
  try {
    const { error } = await sba.auth.admin.deleteUser(userId);
    if (error) {
      // 404 from Supabase = user already deleted; treat as success so
      // a retried delete from a stuck client can complete cleanly.
      const msg = String(error.message || error);
      const alreadyGone = /not found|user not found/i.test(msg) || error.status === 404;
      if (!alreadyGone) {
        return res.status(502).json({ error: 'Failed to delete auth account', detail: msg });
      }
    }
  } catch (err) {
    return res.status(502).json({ error: 'Failed to delete auth account', detail: err.message });
  }

  // 2. Render Postgres — best-effort. Log failures but don't block the
  //    response; the user's auth is gone and they have no path back to
  //    their data anyway.
  const wipes = [
    ['user_usage',           `DELETE FROM user_usage           WHERE user_id = $1`],
    ['briefing_access_log',  `DELETE FROM briefing_access_log  WHERE user_id = $1`],
    ['custom_briefing_usage',`DELETE FROM custom_briefing_usage WHERE user_id = $1`],
    ['user_credit_balance',  `DELETE FROM user_credit_balance  WHERE user_id = $1`],
    ['credit_ledger',        `DELETE FROM credit_ledger        WHERE user_id = $1`],
    // Editor events: anonymize rather than delete (see header).
    ['editor_events',        `UPDATE editor_events SET editor_id = NULL WHERE editor_id = $1`],
  ];
  for (const [name, sql] of wipes) {
    try {
      await pool.query(sql, [userId]);
    } catch (err) {
      // Table may not exist in all environments — log and continue.
      errors.push(`${name}: ${err.message}`);
      console.warn(`[account-delete] ${name}: ${err.message}`);
    }
  }

  return res.json({
    deleted: true,
    user_id: userId,
    warnings: errors.length ? errors : undefined,
  });
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

setTimeout(() => runKeywordCron(" startup"), 10_000);           // ~10s after boot
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

// storyThreadBuilder is scheduled as a Render cron — the web service
// does NOT spawn it. Running it from both places would double-fire
// Claude calls and collide on the DB. Keep the cron, not this.

// storyTimelineBuilder, globeStatsCron, and sourcesStatsCron are all
// scheduled as Render crons. Web service does NOT spawn them to avoid
// double-firing and DB contention.

// Database pruning — weekly. Deletes old keyword stats, low-value articles,
// stale image usage logs, and old error logs. Runs 15 min after boot then
// every 7 days. Batched deletes + VACUUM ANALYZE.
setTimeout(() => spawnBuilder("dbPruneCron.js", "dbPrune startup"), 15 * 60_000);
setInterval(() => spawnBuilder("dbPruneCron.js", "dbPrune"), 7 * 24 * 60 * 60 * 1000).unref?.(); // every 7 days

startArticleListener().catch(console.error);

// ── Cache warming — keep threads & timelines hot so no user hits a cold query ──
// The TTL cache is 120s. We refresh every 90s so the cache never expires.
// First warm runs 5s after boot (after the pool is ready).
//
// LONG-TERM TODO: replace these HTTP loopback fetches with direct
// in-process calls to the underlying handlers. Each fetch here costs
// 1 socket + middleware + pool connection, which during fetcher
// bursts compounds with article-ingestion load and starves user
// requests. A direct call would be `await getLatestThreads({limit})`
// straight to the pool, no HTTP. Tracked in the spawn_task chip.
//
// SHORT-TERM: skip a warm cycle entirely when the pool is hot, so a
// fetcher burst doesn't get amplified by 13 self-loopback queries.
function _poolHotForWarm() {
  const max = pool.options?.max ?? 60;
  if ((pool.waitingCount ?? 0) > 0) return true;
  if ((pool.idleCount ?? 0) === 0 && (pool.totalCount ?? 0) >= 0.7 * max) return true;
  return false;
}
async function _warmFeedCaches() {
  if (_poolHotForWarm()) {
    console.log(`[cache-warm] skipped — pool hot (total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount})`);
    return;
  }
  const http = require('http');
  const base = `http://localhost:${PORT}`;
  const urls = [
    `${base}/api/news/search?limit=25&offset=0`,
    `${base}/api/threads/latest?limit=30`,
    `${base}/api/threads/latest?limit=1000`,  // full thread list (stories page)
    `${base}/api/timelines/latest?limit=30`,
    `${base}/api/timelines/latest?limit=1000`, // full timeline list
    `${base}/api/flows?mode=aggregate&view_mode=country&limit=500`,
    `${base}/api/flows?mode=aggregate&view_mode=city&limit=500`,
    `${base}/api/flows?mode=aggregate&view_mode=region&limit=500`,
    `${base}/api/articles/recent?limit=60&hours=48`,  // ticker feed
    `${base}/api/news/sources-stats`,                  // source intelligence
    `${base}/api/globe-stats`,                         // globe stats (commodities, economic, etc.)
    `${base}/api/countries/all`,                       // country list
    `${base}/api/cities/all`,                          // city list
  ];

  for (const url of urls) {
    // Re-check on every URL — a long burst can start mid-warm.
    if (_poolHotForWarm()) {
      console.log(`[cache-warm] aborted mid-cycle — pool hot`);
      return;
    }
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

// Diagnostic — log Postgres's server-wide connection cap once at
// startup so we can tell whether DB_POOL_MAX is realistic. With
// multiple services hitting one DB instance, exceeding max_connections
// causes "Connection terminated unexpectedly" errors that look like
// pool issues but are actually PG rejecting new connections.
setTimeout(async () => {
  try {
    const r = await pool.query(`SHOW max_connections`);
    const cur = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity`);
    console.log(`[pg] max_connections=${r.rows[0].max_connections} current=${cur.rows[0].n} pool_max=${pool.options?.max}`);
  } catch (e) {
    console.warn('[pg] connection cap probe failed:', e.message);
  }
}, 8000);

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

// ── Ensure briefing_episodes has music columns ────────────────────────────
(async () => {
  try {
    await pool.query(`
      ALTER TABLE briefing_episodes ADD COLUMN IF NOT EXISTS music_data bytea;
      ALTER TABLE briefing_episodes ADD COLUMN IF NOT EXISTS music_meta jsonb;
    `);
    console.log('[migration] briefing_episodes music columns ensured');
  } catch (e) {
    console.warn('[migration] music columns:', e.message);
  }
})();

// ── Start server with graceful shutdown ───────────────────────────────────
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully`);
  // Stop accepting new HTTP traffic AND new article-listener work in
  // parallel. The listener's queue is independent of HTTP — without
  // explicit drain, server.close() resolves the moment the last HTTP
  // connection closes, then pool.end() fires while in-flight
  // classifyArticle calls are still mid-pipeline → "Cannot use a pool
  // after calling end on the pool" once per queued article.
  let httpClosed = false;
  let listenerDrained = false;
  let alreadyEnded = false;
  const closePoolWhenReady = async () => {
    if (alreadyEnded || !httpClosed || !listenerDrained) return;
    alreadyEnded = true;
    try {
      await pool.end();
      console.log('DB pool drained');
    } catch (err) {
      console.error('pool.end() failed:', err.message);
    }
    process.exit(0);
  };
  server.close(() => {
    console.log('HTTP server closed');
    httpClosed = true;
    closePoolWhenReady();
  });
  const { stopArticleListener } = require('./articleListener');
  stopArticleListener({ timeoutMs: 25_000 })
    .catch(err => console.warn('[articleListener] stop error:', err.message))
    .finally(() => {
      listenerDrained = true;
      closePoolWhenReady();
    });
  // Force exit after 30s if connections don't drain
  setTimeout(() => {
    console.error('Forced exit — connections did not drain in 30s');
    process.exit(1);
  }, 30_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
