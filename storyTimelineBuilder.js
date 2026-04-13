/**
 * storyTimelineBuilder.js
 *
 * Builds the broad "Timelines" lane.
 *
 * Timelines vs Threads:
 *   • Threads  — 48h tight meta-story, built by storyThreadBuilder.js
 *   • Timelines — 30-day broad umbrella arcs ("NATO", "Iran Israel War",
 *                 "US-China Trade War"), built by this file. Runs every
 *                 12 hours. Ties together threads (active, cooling, and
 *                 dormant) plus old and new articles under overarching
 *                 geopolitical narratives.
 *
 * Core mechanics:
 *   1. 30-day lookback (720h), parabolic / logistic weighting that peaks
 *      around ~24h old and decays toward both edges. This biases grouping
 *      toward articles from the last day while still letting older
 *      references anchor a timeline as historical context.
 *
 *   2. Article pool gated by `fetch_tier IN (2,3,4) OR base_priority >= 0.55`.
 *      Opens up to ~top 25% of articles instead of top decile. Tier 1
 *      wires-only sources now also contribute via the lowered floor.
 *
 *   3. Thread-informed pipeline: active threads (importance ≥ 5) are queried
 *      and their articles are injected into the pool. This guarantees that
 *      any breaking story already tracked by the thread builder will be
 *      considered for umbrella grouping — even if it wouldn't pass the
 *      article-level gate on its own.
 *
 *   4. Broad grouping: MIN_SHARED_KW = 1 (vs 2 for threads) PLUS an
 *      entity-overlap boost AND a country+category co-location boost.
 *      Two articles from the same country in the same category get a
 *      linking bonus even without keyword overlap.
 *
 *   5. Historical anchors: when referenced dates exist for articles in
 *      a timeline via `article_referenced_dates`, the top N are written
 *      to `story_timelines.historical_anchors` JSONB so the timeline
 *      panel can render them as pinned historical markers.
 *
 * Usage:
 *   node storyTimelineBuilder.js             — process last 720 hours (30d)
 *   node storyTimelineBuilder.js --hours=240 — custom lookback window
 */

require("dotenv").config();
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOOKBACK_HOURS       = parseInt(process.argv.find(a => a.startsWith("--hours="))?.split("=")[1] || "720");
const PARABOLIC_PEAK_HOURS = 24;        // the age we weight heaviest
const CLAUDE_BATCH         = 36;        // more articles per Claude call for better context
const MIN_CLUSTER          = 2;
const MIN_SHARED_KW        = 1;         // broader than threads (2)
const MIN_SHARED_KW_FALLBACK = 2;       // for generic keyword pairs
const MAX_PER_SOURCE       = 18;        // wider per-source allowance for 30d window
const TOTAL_ARTICLE_LIMIT  = 1500;      // larger pool for monthly lookback
const BASE_PRIORITY_FLOOR  = 0.55;      // ~top 25% (was 0.7 = top decile)
const ENTITY_LINK_BOOST    = true;
const COUNTRY_CAT_BOOST    = true;      // NEW: boost pairs sharing country+category

const SKIP_KEYWORDS = new Set([
  "government","minister","president","official","said","year","people",
  "new","first","last","will","also","one","two","three","could","would",
  "after","before","over","under","says","day","week","month","country",
  "world","international","national","local","news","report","according"
]);

// ─── Parabolic / logistic weighting ──────────────────────────────────────────
// Goal: heavy mass near 24h, long-tailed out to 720h (30d), with a modest
// gaussian bump at the peak so the curve isn't a flat logistic. Older articles
// retain meaningful weight (floor 0.10) so 30-day-old articles still contribute
// to umbrella grouping — they're context, not noise.
function parabolicWeight(ageHours) {
  const h = Math.max(0, ageHours);
  // Gentler decay (0.012 vs 0.045) so the tail extends across the full month
  const logistic = 1 / (1 + Math.exp(0.012 * (h - PARABOLIC_PEAK_HOURS)));
  const gaussian = Math.exp(-Math.pow(h - PARABOLIC_PEAK_HOURS, 2) / 1800);
  const base = Math.max(0.10, logistic * (1 + 0.4 * gaussian));
  return Number(base.toFixed(5));
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🗓  Story Timeline Builder — ${new Date().toISOString()}`);
  console.log(`   Lookback: ${LOOKBACK_HOURS}h | Peak: ${PARABOLIC_PEAK_HOURS}h | Gate: tier 2-4 OR bp>=${BASE_PRIORITY_FLOOR}`);

  console.log(`   [${elapsed()}] Querying gated article pool...`);
  const articles = await getTimelineArticlePool(LOOKBACK_HOURS);
  console.log(`   [${elapsed()}] Pool: ${articles.length} articles`);

  // ── Thread-informed injection ──────────────────────────────────────────────
  // Pull articles from active/cooling threads that may not have passed the
  // article-level gate. This ensures breaking stories tracked by the thread
  // builder always contribute to umbrella timelines.
  console.log(`   [${elapsed()}] Injecting thread-sourced articles...`);
  const threadArticles = await getThreadArticles();
  const existingIds = new Set(articles.map(a => a.id));
  let injected = 0;
  for (const ta of threadArticles) {
    if (!existingIds.has(ta.id)) {
      articles.push(ta);
      existingIds.add(ta.id);
      injected++;
    }
  }
  console.log(`   [${elapsed()}] Injected ${injected} thread-sourced articles (${threadArticles.length} total from threads)`);

  if (!articles.length) { console.log("   Nothing to timeline. Done."); await pool.end(); return; }

  console.log(`   [${elapsed()}] Loading entity mentions for pool...`);
  const entityMap = await loadEntityMentionsForArticles(articles.map(a => a.id));
  const entityBoostCount = [...entityMap.values()].filter(v => v.length).length;
  console.log(`   [${elapsed()}] Articles with entity mentions: ${entityBoostCount}`);

  console.log(`   [${elapsed()}] Clustering (kw + entity + country/cat + parabolic weight)...`);
  const clusters = clusterBroad(articles, entityMap);
  const assigned = new Set(clusters.flat().map(a => a.id));
  const singletons = articles.filter(a => !assigned.has(a.id));
  console.log(`   [${elapsed()}] Clusters: ${clusters.length} | Singletons: ${singletons.length}`);

  console.log(`   [${elapsed()}] Loading existing timelines (active + cooling + dormant)...`);
  const existingTimelines = await getActiveTimelines();
  const existingMap = new Map(existingTimelines.map(t => [Number(t.id), { ...t }]));
  console.log(`   [${elapsed()}] Loaded timelines: ${existingTimelines.length}`);

  // ── Thread gap audit: find active threads with no matching timeline ────────
  console.log(`   [${elapsed()}] Auditing threads for timeline coverage gaps...`);
  const gapThreads = await findThreadsWithoutTimelines(existingTimelines);
  console.log(`   [${elapsed()}] Threads without timelines: ${gapThreads.length}`);

  let created = 0, updated = 0;
  const allGroups = [...clusters, ...chunkArray(singletons, 20)];

  // If there are gap threads, add them as priority batches at the front
  if (gapThreads.length) {
    const gapBatches = chunkArray(gapThreads, CLAUDE_BATCH);
    for (const batch of gapBatches) {
      allGroups.unshift(batch);
    }
  }

  const totalBatches = Math.ceil(allGroups.length / 3);
  console.log(`   [${elapsed()}] Sending ${totalBatches} batch(es) to Claude...\n`);

  for (let i = 0; i < allGroups.length; i += 3) {
    const batchNum = Math.floor(i/3) + 1;
    const batch = allGroups.slice(i, i + 3).flat().slice(0, CLAUDE_BATCH);
    if (!batch.length) continue;

    process.stdout.write(`   [${elapsed()}] Batch ${batchNum}/${totalBatches} (${batch.length} articles) → Claude... `);
    try {
      const validIdSet = new Set(batch.map(a => Number(a.id)));
      const defs = await evaluateWithClaude(batch, [...existingMap.values()]);
      const { c, u } = await persistTimelineDefs(defs, validIdSet, existingMap);
      created += c; updated += u;
      console.log(`✓ ${defs.length} timelines (${c} new, ${u} updated)`);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
    }
    await sleep(1500);
  }

  console.log(`\n   [${elapsed()}] Broadening overly specific timeline titles...`);
  await broadenTimelineTitles();

  console.log(`\n   [${elapsed()}] Attaching historical anchors...`);
  await attachHistoricalAnchors();

  console.log(`\n   [${elapsed()}] Cooling down inactive timelines...`);
  await coolDownTimelines();

  console.log(`\n✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s — ${created} created, ${updated} updated.\n`);
  await pool.end();
}

// ─── Article pool ────────────────────────────────────────────────────────────
async function getTimelineArticlePool(hours) {
  const { rows } = await pool.query(`
    WITH ranked AS (
      SELECT
        a.id, a.title, a.summary, a.translated_summary,
        a.published_at, a.base_priority,
        COALESCE(ns.name, ys.name) AS source_name,
        COALESCE(ns.id::text, 'y'||ys.id::text) AS source_key,
        COALESCE(ns.fetch_tier, 1) AS fetch_tier,
        co.name AS country_name,
        ci.name AS city_name,
        a.primary_category,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(a.source_id::text, a.youtube_source_id::text, 'unknown')
          ORDER BY a.published_at DESC
        ) AS source_rank
      FROM news_articles a
      LEFT JOIN countries     co ON co.id = a.country_id
      LEFT JOIN cities        ci ON ci.id = a.city_id
      LEFT JOIN news_sources  ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE a.published_at > NOW() - INTERVAL '${hours} hours'
        AND a.published_at < NOW()
        AND a.title IS NOT NULL
        AND (
          COALESCE(ns.fetch_tier, 1) IN (2, 3, 4)
          OR COALESCE(a.base_priority, 0) >= ${BASE_PRIORITY_FLOOR}
        )
    )
    SELECT id, title, summary, translated_summary, published_at, base_priority,
           source_name, source_key, fetch_tier, country_name, city_name, primary_category
    FROM ranked
    WHERE source_rank <= ${MAX_PER_SOURCE}
    ORDER BY base_priority DESC NULLS LAST, published_at DESC
    LIMIT ${TOTAL_ARTICLE_LIMIT}
  `);
  if (!rows.length) return [];

  const ids = rows.map(r => r.id);
  const { rows: kwRows } = await pool.query(`
    SELECT article_id, ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
    FROM article_keywords
    WHERE article_id = ANY($1::int[])
    GROUP BY article_id
  `, [ids]);
  const kwMap = new Map(kwRows.map(r => [r.article_id, r.keywords]));

  // Don't drop articles with no keywords — they can still be linked via
  // entity overlap or country+category co-location
  return rows.map(a => {
    const ageHours = (Date.now() - new Date(a.published_at).getTime()) / 3600000;
    return {
      ...a,
      keywords: kwMap.get(a.id) || [],
      age_hours: ageHours,
      parabolic_weight: parabolicWeight(ageHours)
    };
  });
}

// ─── Thread-sourced articles ─────────────────────────────────────────────────
// Pull articles belonging to active/cooling threads with importance ≥ 5.
// These represent the strongest breaking-story signal and guarantee that
// ongoing conflicts (Iran war, Ukraine, etc.) feed into timelines even if
// individual articles have low base_priority.
async function getThreadArticles() {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT
        a.id, a.title, a.summary, a.translated_summary,
        a.published_at, a.base_priority,
        COALESCE(ns.name, ys.name) AS source_name,
        COALESCE(ns.id::text, 'y'||ys.id::text) AS source_key,
        COALESCE(ns.fetch_tier, 1) AS fetch_tier,
        co.name AS country_name,
        ci.name AS city_name,
        a.primary_category,
        st.importance AS thread_importance
      FROM story_threads st
      JOIN story_thread_articles sta ON sta.thread_id = st.id
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries     co ON co.id = a.country_id
      LEFT JOIN cities        ci ON ci.id = a.city_id
      LEFT JOIN news_sources  ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE st.status IN ('active', 'cooling')
        AND st.importance >= 5
        AND a.published_at > NOW() - INTERVAL '${LOOKBACK_HOURS} hours'
        AND a.title IS NOT NULL
      ORDER BY st.importance DESC, a.published_at DESC
      LIMIT 600
    `);
    if (!rows.length) return [];

    const ids = rows.map(r => r.id);
    const { rows: kwRows } = await pool.query(`
      SELECT article_id, ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
      FROM article_keywords
      WHERE article_id = ANY($1::int[])
      GROUP BY article_id
    `, [ids]);
    const kwMap = new Map(kwRows.map(r => [r.article_id, r.keywords]));

    return rows.map(a => {
      const ageHours = (Date.now() - new Date(a.published_at).getTime()) / 3600000;
      return {
        ...a,
        keywords: kwMap.get(a.id) || [],
        age_hours: ageHours,
        parabolic_weight: parabolicWeight(ageHours),
        _from_thread: true
      };
    });
  } catch (e) {
    console.warn(`   ⚠ Thread article injection skipped: ${e.message}`);
    return [];
  }
}

// ─── Thread gap audit ────────────────────────────────────────────────────────
// Find active threads (importance ≥ 6) whose keywords/title don't match any
// existing timeline. Return their articles as a synthetic cluster so Claude
// can create the missing timeline.
async function findThreadsWithoutTimelines(existingTimelines) {
  try {
    const { rows: threads } = await pool.query(`
      SELECT st.id, st.title, st.keywords, st.importance, st.primary_category
      FROM story_threads st
      WHERE st.status IN ('active', 'cooling')
        AND st.importance >= 6
      ORDER BY st.importance DESC
      LIMIT 50
    `);
    if (!threads.length) return [];

    // Build a lookup of existing timeline scopes + keywords for matching
    const tlKeywords = new Set();
    const tlScopes = new Set();
    for (const tl of existingTimelines) {
      if (tl.scope) tlScopes.add(tl.scope.toLowerCase());
      for (const kw of (tl.keywords || [])) {
        tlKeywords.add(normalizeKeyword(kw));
      }
    }

    // A thread is "uncovered" if fewer than 2 of its keywords appear in any timeline
    const uncoveredThreadIds = [];
    for (const t of threads) {
      const threadKws = (t.keywords || []).map(k => normalizeKeyword(k));
      const overlap = threadKws.filter(k => tlKeywords.has(k)).length;
      if (overlap < 2) {
        uncoveredThreadIds.push(t.id);
      }
    }
    if (!uncoveredThreadIds.length) return [];

    // Pull articles from uncovered threads
    const { rows: articles } = await pool.query(`
      SELECT DISTINCT
        a.id, a.title, a.summary, a.translated_summary,
        a.published_at, a.base_priority,
        COALESCE(ns.name, ys.name) AS source_name,
        co.name AS country_name,
        ci.name AS city_name,
        a.primary_category
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries     co ON co.id = a.country_id
      LEFT JOIN cities        ci ON ci.id = a.city_id
      LEFT JOIN news_sources  ns ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE sta.thread_id = ANY($1::int[])
        AND a.title IS NOT NULL
      ORDER BY a.published_at DESC
      LIMIT 80
    `, [uncoveredThreadIds]);

    if (!articles.length) return [];

    const ids = articles.map(r => r.id);
    const { rows: kwRows } = await pool.query(`
      SELECT article_id, ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
      FROM article_keywords
      WHERE article_id = ANY($1::int[])
      GROUP BY article_id
    `, [ids]);
    const kwMap = new Map(kwRows.map(r => [r.article_id, r.keywords]));

    return articles.map(a => {
      const ageHours = (Date.now() - new Date(a.published_at).getTime()) / 3600000;
      return {
        ...a,
        keywords: kwMap.get(a.id) || [],
        age_hours: ageHours,
        parabolic_weight: parabolicWeight(ageHours),
        _gap_thread: true
      };
    });
  } catch (e) {
    console.warn(`   ⚠ Thread gap audit skipped: ${e.message}`);
    return [];
  }
}

async function loadEntityMentionsForArticles(articleIds) {
  const out = new Map(articleIds.map(id => [id, []]));
  if (!articleIds.length) return out;
  try {
    const { rows } = await pool.query(`
      SELECT article_id, entity_id
      FROM article_entity_mentions
      WHERE article_id = ANY($1::int[])
        AND role IN ('subject', 'actor', 'location')
    `, [articleIds]);
    for (const r of rows) {
      if (!out.has(r.article_id)) out.set(r.article_id, []);
      out.get(r.article_id).push(r.entity_id);
    }
  } catch (e) {
    // Graceful fallback if entity tables aren't populated
    console.warn(`   ⚠ Entity mention lookup skipped: ${e.message}`);
  }
  return out;
}

// ─── Broad clustering ────────────────────────────────────────────────────────
function clusterBroad(articles, entityMap) {
  // 1. Keyword index — allow 3-char keywords for important short terms (war, oil, etc.)
  const kwIndex = new Map();
  for (const a of articles) {
    for (const kw of (a.keywords || [])) {
      const k = normalizeKeyword(kw);
      if (k.length < 3 || SKIP_KEYWORDS.has(k)) continue;
      if (!kwIndex.has(k)) kwIndex.set(k, []);
      kwIndex.get(k).push(a);
    }
  }

  // 2. Pair scoring — keyword overlap + entity overlap boost + country/cat boost
  const pairScore = new Map();
  const addPair = (idA, idB, weight) => {
    const key = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
    pairScore.set(key, (pairScore.get(key) || 0) + weight);
  };

  for (const [, arts] of kwIndex) {
    if (arts.length < 2 || arts.length > 120) continue;
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        addPair(arts[i].id, arts[j].id, 1);
      }
    }
  }

  // Entity index
  if (ENTITY_LINK_BOOST) {
    const entIndex = new Map();
    for (const a of articles) {
      const ents = entityMap.get(a.id) || [];
      for (const eid of ents) {
        if (!entIndex.has(eid)) entIndex.set(eid, []);
        entIndex.get(eid).push(a);
      }
    }
    for (const [, arts] of entIndex) {
      if (arts.length < 2 || arts.length > 80) continue;
      for (let i = 0; i < arts.length; i++) {
        for (let j = i + 1; j < arts.length; j++) {
          addPair(arts[i].id, arts[j].id, 1.5);  // entity overlap worth more than a single kw
        }
      }
    }
  }

  // Country + category co-location boost: articles from the same country
  // in the same hard-news category get a linking bonus. This catches stories
  // about the same conflict/crisis that use different keywords (e.g. "nuclear"
  // vs "strait of hormuz" for Iran).
  if (COUNTRY_CAT_BOOST) {
    const HARD_CATS = new Set(['politics', 'military', 'diplomacy', 'conflict']);
    const ccIndex = new Map(); // "country::category" → [articles]
    for (const a of articles) {
      if (!a.country_name) continue;
      const cat = (a.primary_category || '').toLowerCase();
      if (!HARD_CATS.has(cat)) continue;
      const key = `${a.country_name.toLowerCase()}::${cat}`;
      if (!ccIndex.has(key)) ccIndex.set(key, []);
      ccIndex.get(key).push(a);
    }
    for (const [, arts] of ccIndex) {
      if (arts.length < 2 || arts.length > 80) continue;
      for (let i = 0; i < arts.length; i++) {
        for (let j = i + 1; j < arts.length; j++) {
          addPair(arts[i].id, arts[j].id, 0.8); // weaker than entity but still meaningful
        }
      }
    }
  }

  // 3. Union-Find — lower threshold than threads so grouping is broader
  const parent = new Map(articles.map(a => [a.id, a.id]));
  const find = (x) => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  };
  const union = (x, y) => parent.set(find(x), find(y));

  for (const [pair, score] of pairScore) {
    if (score >= MIN_SHARED_KW) {
      const [a, b] = pair.split(":").map(Number);
      union(a, b);
    }
  }

  const clusters = new Map();
  for (const a of articles) {
    const root = find(a.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(a);
  }
  return Array.from(clusters.values()).filter(c => c.length >= MIN_CLUSTER);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Claude evaluation ───────────────────────────────────────────────────────
async function evaluateWithClaude(articles, existingTimelines) {
  const articleData = articles.map(a => ({
    id:           a.id,
    title:        a.title,
    summary:      (a.translated_summary || a.summary || "").slice(0, 250),
    keywords:     (a.keywords || []).slice(0, 12),
    country:      a.country_name || null,
    city:         a.city_name || null,
    source:       a.source_name || null,
    tier:         a.fetch_tier,
    age_h:        Math.round(a.age_hours),
    weight:       a.parabolic_weight,
    category:     a.primary_category || null,
    published_at: a.published_at
  }));

  // Send ALL existing timelines (up to 300) so Claude can match dormant ones too
  const existingData = existingTimelines.slice(0, 300).map(t => ({
    id:     t.id,
    title:  t.title,
    scope:  t.scope,
    status: t.status,
    kw:     (t.keywords || []).slice(0, 8),
    cat:    t.primary_category,
    art_ct: t.article_count
  }));

  const prompt = `You are the editor of a GLOBAL TIMELINE — the UMBRELLA ARCS view of world geopolitics. Your job is the OPPOSITE of a breaking-news ticker: your job is to group all stories touching the same ongoing arc into ONE broad timeline, even when keywords diverge and sub-stories look distinct. This is a 30-DAY lookback — you are building MONTH-SCALE narratives, not daily news cycles.

═══ WHAT A TIMELINE IS ═══
A timeline is a BROAD UMBRELLA ARC — a multi-week/multi-month geopolitical narrative that absorbs ALL sub-stories, events, developments, and angles under one roof. Think of how a newspaper's "Iran" desk covers everything Iran-related under one banner.

The NAME should be as BROAD as possible — name the arc, not the event:
  • "NATO" not "NATO Summit Response to Baltic Deployment"
  • "Iran Israel War" not "Iran-Israel Strikes Escalation in March"
  • "US-China Trade War" not "US-China Tariff Dispute Over Semiconductors"
  • "Ukraine Russia War" not "Ukraine-Russia War: Bakhmut Offensive"

Examples of GOOD timeline titles (SHORT, BROAD, UMBRELLA-LEVEL):
  • "NATO"
  • "Iran Israel War"
  • "Ukraine Russia War"
  • "Gaza War"
  • "Venezuela Crisis"
  • "US-China Trade War"
  • "Sahel Insurgency"
  • "Sudan Civil War"
  • "North Korea"
  • "EU Migration Crisis"

═══ GROUP BROADLY ═══
If an article touches an existing timeline's arc EVEN TANGENTIALLY, attach it to that timeline via existing_timeline_id. Do NOT split an arc into micro-threads. A single "Iran" timeline should absorb:
  • Iran nuclear program stories
  • Strait of Hormuz shipping stories
  • Iran-Israel strikes
  • US-Iran diplomatic maneuvers
  • Iran proxy (Houthi / Hezbollah) activity tied to Iran leadership
  • Regional condemnations / alignments about Iran

A single "Venezuela" timeline should absorb:
  • Maduro government moves
  • Opposition / Guaidó activity
  • US sanctions / oil pressure
  • Migration crisis flowing out of Venezuela
  • Regional diplomatic response

The one exception: if a sub-story has clearly escaped its parent arc and become its own multi-country crisis (e.g. the Houthi Red Sea shipping campaign arguably becomes its own arc). In that case you can create a sibling timeline and link scope.

═══ CRITICAL: PREFER ATTACHING TO EXISTING TIMELINES ═══
Before creating ANY new timeline, scan the full existing timelines list carefully. Many of these are dormant or cooling — REACTIVATE them by attaching articles via existing_timeline_id. It is MUCH better to reactivate a dormant timeline than to create a duplicate.

Check by: scope slug, title, keywords, AND topic/country overlap. If an article is about Iran and there's an existing "Iran Israel War" timeline (even if dormant), attach to it.

═══ SCOPE SLUG ═══
Every timeline has a "scope" — a stable slug that names the umbrella. Keep scopes BROAD and stable: "nato", "iran_israel", "ukraine_russia", "gaza", "venezuela", "us_china", "sahel", "sudan", "north_korea", "eu_migration". Reuse scopes across runs so timelines persist. Invent a new scope only when an arc is genuinely new. NEVER make scopes event-specific.

═══ PARABOLIC WEIGHTING (CONTEXT FOR YOU) ═══
The age_h and weight fields show how strongly the system thinks each article should anchor a timeline. Articles near 24h old are weighted heaviest; older articles are mostly anchors / historical context. Use weight as a hint for which article to mark as the anchor_article_id — pick one with high weight that best represents the arc, NOT necessarily the oldest one.

═══ HARD REJECT ═══
Do NOT spawn timelines for:
  • Sports, entertainment, lifestyle, celebrity, recreational
  • Local crime, weather, traffic, routine administrative announcements
  • Commercial product launches, factory openings, earnings releases
  • Research breakthroughs unrelated to state policy
  • Single-country "summary" buckets ("Brazil Political Developments")
  • Chamber-of-commerce / local party / regional cabinet stories
  • "Policy discussions" / "sectoral overviews" without a concrete arc

EXISTING TIMELINES (${existingData.length} total — attach to these whenever possible, even dormant/cooling ones):
${JSON.stringify(existingData, null, 2)}

ARTICLES TO ANALYZE:
${JSON.stringify(articleData, null, 2)}

Return ONLY a valid JSON array, no explanation. Empty array [] is acceptable.
[
  {
    "existing_timeline_id": null,
    "title": "broad umbrella arc title (max 10 words)",
    "description": "Two sentences describing this ongoing arc and why it matters.",
    "scope": "stable_slug_for_arc",
    "article_ids": [ids that belong],
    "anchor_article_id": id,
    "primary_category": "politics|economy|military|diplomacy|environment|technology",
    "geographic_scope": "global|regional|local",
    "importance": 7,
    "keywords": ["5-10 core keywords"]
  }
]`;

  const response = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 4500,
    messages:   [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON array in Claude response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── Persist ─────────────────────────────────────────────────────────────────
async function persistTimelineDefs(defs, validIdSet, existingMap) {
  let created = 0, updated = 0;

  const ALLOWED_CATS = new Set(['politics','economy','military','diplomacy','environment','technology','conflict']);

  for (const def of defs) {
    if (!def.article_ids?.length) continue;
    if (!def.existing_timeline_id) {
      const cat = String(def.primary_category || '').toLowerCase();
      if (cat && !ALLOWED_CATS.has(cat)) {
        console.log(`   🚫 Rejected timeline "${def.title}" (category=${cat})`);
        continue;
      }
    }

    try {
      const filteredIds = def.article_ids
        .map(id => Number(id))
        .filter(id => validIdSet.has(id));
      if (!filteredIds.length) continue;

      if (def.existing_timeline_id) {
        const timelineId = Number(def.existing_timeline_id);
        await pool.query(`
          UPDATE story_timelines
          SET last_updated_at = NOW(),
              status          = 'active',
              importance      = GREATEST(importance, $1),
              article_count   = article_count + $2,
              keywords        = (SELECT ARRAY(SELECT DISTINCT unnest(keywords || $3::text[])))
          WHERE id = $4
        `, [def.importance || 5, filteredIds.length, def.keywords || [], timelineId]);
        await insertTimelineArticles(timelineId, filteredIds, def.anchor_article_id, def.importance);
        updated++;
      } else {
        const { rows } = await pool.query(`
          INSERT INTO story_timelines
            (title, description, scope, primary_category, geographic_scope,
             importance, keywords, article_count, lookback_days, parabolic_peak_hours)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `, [
          def.title,
          def.description || '',
          (def.scope || '').toLowerCase().replace(/\s+/g, '_').slice(0, 80) || null,
          def.primary_category || 'politics',
          def.geographic_scope || 'global',
          def.importance || 5,
          def.keywords || [],
          filteredIds.length,
          Math.ceil(LOOKBACK_HOURS / 24),
          PARABOLIC_PEAK_HOURS
        ]);
        const timelineId = rows[0].id;
        await insertTimelineArticles(timelineId, filteredIds, def.anchor_article_id, def.importance);
        existingMap.set(Number(timelineId), {
          id: Number(timelineId),
          title: def.title,
          scope: def.scope,
          keywords: def.keywords || [],
          primary_category: def.primary_category || 'politics'
        });
        created++;
      }
    } catch (err) {
      console.error(`   ⚠ Failed to persist timeline "${def.title}": ${err.message}`);
    }
  }

  return { c: created, u: updated };
}

async function insertTimelineArticles(timelineId, articleIds, anchorId, importance) {
  if (!articleIds.length) return;
  const { rows } = await pool.query(`
    SELECT id, published_at FROM news_articles WHERE id = ANY($1::int[])
  `, [articleIds]);

  const ptMap = new Map(rows.map(r => [Number(r.id), r.published_at]));
  const base = Math.max(0.1, Math.min(1, (Number(importance) || 5) / 10));

  for (const articleId of articleIds) {
    const id = Number(articleId);
    const pt = ptMap.get(id);
    let weight = 0.05;
    if (pt) {
      const ageHours = Math.max(0, (Date.now() - new Date(pt).getTime()) / 3600000);
      weight = parabolicWeight(ageHours);
    }
    const relevance = Number((base * weight).toFixed(4));
    await pool.query(`
      INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `, [timelineId, id, weight, relevance, id === Number(anchorId)]);
  }

  // Refresh aggregate columns
  await pool.query(`
    UPDATE story_timelines t
    SET parabolic_weight_sum = COALESCE((
          SELECT SUM(parabolic_weight)::real FROM story_timeline_articles WHERE timeline_id = t.id
        ), 0),
        distinct_source_count = COALESCE((
          SELECT COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id))::int
          FROM story_timeline_articles sta
          JOIN news_articles a ON a.id = sta.article_id
          WHERE sta.timeline_id = t.id
        ), 0)
    WHERE t.id = $1
  `, [timelineId]);
}

// ─── Historical anchors ──────────────────────────────────────────────────────
async function attachHistoricalAnchors() {
  // Per active timeline, pull up to 8 referenced historical dates from the
  // entity groundwork tables and pin them as a JSONB array on the timeline.
  // Gracefully no-ops if article_referenced_dates is empty.
  try {
    const { rows } = await pool.query(`
      WITH active AS (
        SELECT id FROM story_timelines WHERE status = 'active'
      ),
      anchors AS (
        SELECT
          a.id AS timeline_id,
          jsonb_agg(jsonb_build_object(
            'date', ard.referenced_date,
            'precision', ard.date_precision,
            'context', LEFT(ard.context_snippet, 180)
          ) ORDER BY ard.referenced_date DESC) FILTER (WHERE ard.id IS NOT NULL) AS anchors
        FROM active a
        JOIN story_timeline_articles sta ON sta.timeline_id = a.id
        JOIN article_referenced_dates ard ON ard.article_id = sta.article_id
        GROUP BY a.id
      )
      UPDATE story_timelines t
      SET historical_anchors = COALESCE(anc.anchors, '[]'::jsonb)
      FROM anchors anc
      WHERE t.id = anc.timeline_id
    `);
    console.log(`   Historical anchors updated on ${rows.length || 0} timelines`);
  } catch (e) {
    console.warn(`   ⚠ Anchor attach skipped: ${e.message}`);
  }
}

async function broadenTimelineTitles() {
  // Audit existing timelines — rename overly specific titles to broad
  // umbrella-level names. Sends batches of titles to Claude for renaming.
  try {
    const { rows } = await pool.query(`
      SELECT id, title, scope, keywords, primary_category
      FROM story_timelines
      WHERE status IN ('active', 'cooling')
        AND LENGTH(title) > 35
      ORDER BY importance DESC
      LIMIT 100
    `);
    if (!rows.length) { console.log(`   No titles need broadening.`); return; }

    const batches = chunkArray(rows, 40);
    let renamed = 0;
    for (const batch of batches) {
      const resp = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        messages: [{ role: "user", content: `You are renaming geopolitical timeline titles to be as BROAD and SHORT as possible. These are umbrella arcs, NOT specific events.

Rules:
- Maximum 5 words, ideally 2-3
- Name the ARC not the event: "NATO" not "NATO Response to Baltic Threat"
- Name the conflict not the battle: "Ukraine Russia War" not "Ukraine-Russia Bakhmut Offensive"
- If already broad enough (≤5 words, names the arc), keep it unchanged
- Return the SAME id with the new title

TIMELINES TO RENAME:
${JSON.stringify(batch.map(t => ({ id: t.id, title: t.title, scope: t.scope })), null, 2)}

Return ONLY a JSON array: [{"id": 123, "title": "New Broad Title"}]
Omit entries that don't need renaming.` }]
      });
      const text = resp.content[0].text.trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;
      const renames = JSON.parse(jsonMatch[0]);
      for (const r of renames) {
        if (!r.id || !r.title) continue;
        await pool.query(`UPDATE story_timelines SET title = $1 WHERE id = $2`, [r.title, r.id]);
        renamed++;
      }
      await sleep(1000);
    }
    console.log(`   Broadened ${renamed} timeline title(s).`);
  } catch (e) {
    console.warn(`   ⚠ Title broadening skipped: ${e.message}`);
  }
}

async function coolDownTimelines() {
  // With 30-day lookback, timelines live much longer — they're broad
  // geopolitical arcs that can span months. 45d → cooling, 90d → dormant.
  const a = await pool.query(`
    UPDATE story_timelines SET status = 'cooling'
    WHERE status = 'active' AND last_updated_at < NOW() - INTERVAL '45 days'
  `);
  const c = await pool.query(`
    UPDATE story_timelines SET status = 'dormant'
    WHERE status = 'cooling' AND last_updated_at < NOW() - INTERVAL '90 days'
  `);
  console.log(`   active→cooling: ${a.rowCount} | cooling→dormant: ${c.rowCount}`);
}

async function getActiveTimelines() {
  // Include active, cooling, AND dormant timelines so the builder can
  // reactivate dormant arcs when new articles touch them.
  // Expanded limit from 300→500 to ensure dormant timelines aren't excluded.
  const { rows } = await pool.query(`
    SELECT id, title, description, scope, keywords, primary_category, geographic_scope,
           importance, article_count, status
    FROM story_timelines
    WHERE last_updated_at > NOW() - INTERVAL '120 days'
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'cooling' THEN 1 ELSE 2 END,
      importance DESC, last_updated_at DESC
    LIMIT 500
  `);
  return rows;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeKeyword(keyword) {
  return String(keyword || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/["""'`]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

if (require.main === module) {
  run().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

module.exports = { run, parabolicWeight };
