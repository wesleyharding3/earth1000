/**
 * storyTimelineBuilder.js  — v2 (deterministic-first architecture)
 *
 * Builds the "Lines" lane — broad multi-month umbrella arcs that track
 * the world's major ongoing conflicts, crises, and geopolitical narratives.
 *
 * Lines vs Threads:
 *   • Threads  — 48h tight breaking meta-story (storyThreadBuilder.js)
 *   • Lines    — month/year-scale umbrella arcs ("Russia Ukraine War",
 *                "Gaza War", "Mexican Cartel Violence"). This file.
 *
 * ═══ Architecture (v2) ═══
 *   Phase 1 — DETERMINISTIC ATTACH
 *     For every new article, score it against every existing timeline using
 *     keyword overlap, entity overlap, and country+category match.
 *     If score exceeds threshold, attach it directly — no LLM needed.
 *     This is the 90% case and eliminates the Haiku matching failure.
 *
 *   Phase 2 — CLUSTER UNMATCHED
 *     Articles that didn't match any existing timeline get clustered via
 *     union-find (keyword + entity + country/category scoring).
 *
 *   Phase 3 — CLAUDE CREATES ONLY
 *     Send unmatched clusters to Claude to create genuinely NEW timelines.
 *     Claude no longer matches to existing — that's handled deterministically.
 *
 *   Phase 4 — THREAD-INFORMED SEEDING
 *     Active threads (importance ≥ 6) that have no matching timeline get
 *     force-seeded as new timelines (Claude names them).
 *
 *   Phase 5 — COOLDOWN & CLEANUP
 *     Transition inactive timelines, merge duplicates, refresh counts.
 *
 * Usage:
 *   node storyTimelineBuilder.js             — full run
 *   node storyTimelineBuilder.js --hours=240 — custom lookback
 */

require("dotenv").config();
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOOKBACK_HOURS       = parseInt(process.argv.find(a => a.startsWith("--hours="))?.split("=")[1] || "720");
const PARABOLIC_PEAK_HOURS = 24;
const CLAUDE_BATCH         = 40;
const MIN_CLUSTER          = 5;          // need at least 5 articles for a new timeline (raised from 3)
const MAX_PER_SOURCE       = 20;
const TOTAL_ARTICLE_LIMIT  = 2000;
const BASE_PRIORITY_FLOOR  = 0.45;       // wider net — top ~35%
const ATTACH_THRESHOLD     = 2.5;        // min score to attach article to existing timeline
const STRONG_ATTACH        = 5.0;        // score above this = definite match, skip lower-scored timelines

// ── Generic topic-bucket filter ─────────────────────────────────────────────
// Catch any abstract "Global X" / "Renewable Y" topic-category titles that
// Claude sometimes creates despite the prompt. These aren't geopolitical arcs.
const GENERIC_TOPIC_PATTERNS = [
  /^global\s+\w+\s+(crisis|policy|security|transition|reform|system|investment|slowdown|negotiation)/i,
  /^regional\s+\w+\s+(development|cooperation|infrastructure)/i,
  /^\w+\s+energy\s+(transition|infrastructure|expansion|security)/i,
  /^(extreme|natural|climate)\s+\w+\s+(response|disaster|impact)/i,
  /^(cyber|digital|quantum)\s+\w+\s+(standard|breach|development|transition|infrastructure)/i,
  /^(african|indo-pacific|sub-saharan)\s+\w+\s+(infrastructure|governance|reform|stress)/i,
  /^(ai|artificial intelligence)\s+(in|for|and)\s+/i,
  /^global\s+(organized|protest|labor|data|semiconductor|food|health|monetary|economic|hydrogen|energy)/i,
  /^(renewable|green|clean)\s+energy/i,
  /^(cultural|heritage)\s+\w+\s+(protection|preservation)/i,
  /^cost\s+of\s+living/i,
  /^(faith|religion)\s*[-–]?\s*based/i,
  /^space\s+exploration$/i,
  /^(media|press)\s+(freedom|regulation)/i,
  // ── Additional bucket patterns (catches "AI in Newsrooms", "Cybersecurity Data Breaches", etc.) ──
  /^cybersecurity\s+(data\s+)?breaches?$/i,
  /^\w+\s+airport\s+disruptions?$/i,
  /^\w+\s+politics$/i,                     // "Nepal Politics", "Canadian Politics"
  /^\w+\s+(in\s+)?(newsrooms?|education|healthcare|classrooms?)/i,
  /^\w+\s+data\s+breaches?/i,
  // Abstract [Topic] and [Topic] patterns — "AI in Newsrooms and Education"
  /^[\w\s]+\band\b\s+(education|development|reform|infrastructure|governance|society|innovation)$/i,
  // Bare country + abstract noun — "Nepal Politics", "Canadian Liberal Majority Government"
  /^(canadian|american|british|french|german|japanese|chinese|indian|brazilian|mexican|australian|african|european|asian)\s+(liberal|conservative|labor|labour)?\s*(majority\s+)?(government|politics|policy|reform|economy)$/i,
];
const COUNTRY_SIGNAL_RE = /\b(gaza|palestine|ukraine|russia|iran|israel|china|taiwan|north korea|dprk|venezuela|syria|yemen|myanmar|burma|sudan|ethiopia|libya|haiti|cuba|hungary|turkey|india|pakistan|lebanon|iraq|afghanistan|somalia|congo|drc|niger|mali|burkina|chad|nigeria|brazil|mexico|colombia|peru|chile|argentina|egypt|saudi|qatar|uae|bahrain|jordan|georgia|armenia|azerbaijan|moldova|belarus|poland|romania|serbia|kosovo|bosnia|philippines|indonesia|thailand|vietnam|japan|korea|kenya|tanzania|mozambique|zimbabwe|south africa|morocco|algeria|tunisia)\b/i;

function isGenericTopicBucket(title) {
  const lower = title.toLowerCase().trim();
  for (const pat of GENERIC_TOPIC_PATTERNS) {
    if (pat.test(lower)) {
      // Rescue if it mentions a specific country
      if (COUNTRY_SIGNAL_RE.test(lower)) return false;
      return true;
    }
  }
  return false;
}

const SKIP_KEYWORDS = new Set([
  "government","minister","president","official","said","year","people",
  "new","first","last","will","also","one","two","three","could","would",
  "after","before","over","under","says","day","week","month","country",
  "world","international","national","local","news","report","according",
  "state","united","states","make","made","time","city","part","group"
]);

// ── Parabolic weighting (same as v1) ────────────────────────────────────────
function parabolicWeight(ageHours) {
  const h = Math.max(0, ageHours);
  const logistic = 1 / (1 + Math.exp(0.012 * (h - PARABOLIC_PEAK_HOURS)));
  const gaussian = Math.exp(-Math.pow(h - PARABOLIC_PEAK_HOURS, 2) / 1800);
  const base = Math.max(0.10, logistic * (1 + 0.4 * gaussian));
  return Number(base.toFixed(5));
}

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

const sleep = ms => new Promise(r => setTimeout(r, ms));
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🗓  Story Timeline Builder v2 — ${new Date().toISOString()}`);
  console.log(`   Lookback: ${LOOKBACK_HOURS}h | Attach threshold: ${ATTACH_THRESHOLD} | Article limit: ${TOTAL_ARTICLE_LIMIT}`);

  // ── Load existing timelines ──────────────────────────────────────────────
  console.log(`   [${elapsed()}] Loading existing timelines...`);
  const existingTimelines = await getActiveTimelines();
  console.log(`   [${elapsed()}] ${existingTimelines.length} existing timelines`);

  // Build keyword index for each timeline (for fast matching)
  for (const tl of existingTimelines) {
    tl._kwSet = new Set((tl.keywords || []).map(k => normalizeKeyword(k)).filter(k => k.length >= 3 && !SKIP_KEYWORDS.has(k)));
    tl._titleWords = new Set(
      (tl.title || '').toLowerCase().split(/[\s\-_,]+/).filter(w => w.length >= 3 && !SKIP_KEYWORDS.has(w))
    );
    tl._scopeWords = new Set(
      (tl.scope || '').split(/[_\-]+/).filter(w => w.length >= 3 && !SKIP_KEYWORDS.has(w))
    );
  }

  // ── Load article pool (articles NOT yet in any timeline) ─────────────────
  console.log(`   [${elapsed()}] Querying article pool...`);
  const articles = await getArticlePool(LOOKBACK_HOURS);
  console.log(`   [${elapsed()}] Pool: ${articles.length} articles`);

  if (!articles.length) { console.log("   Nothing to process. Done."); await pool.end(); return; }

  // ── Load entity mentions ────────────────────────────────────────────────
  console.log(`   [${elapsed()}] Loading entity mentions...`);
  const entityMap = await loadEntityMentions(articles.map(a => a.id));

  // Also load entity mentions for existing timeline articles (sample)
  const tlEntityMap = await loadTimelineEntityProfiles(existingTimelines.map(t => t.id));

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 1: DETERMINISTIC ATTACH
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n   ═══ PHASE 1: Deterministic Attach ═══`);

  let attachCount = 0;
  const unmatched = [];

  for (const article of articles) {
    const artKws = new Set(
      (article.keywords || []).map(k => normalizeKeyword(k)).filter(k => k.length >= 3 && !SKIP_KEYWORDS.has(k))
    );
    const artEntities = new Set((entityMap.get(article.id) || []).map(Number));
    const artCountry = (article.country_name || '').toLowerCase();
    const artCategory = (article.primary_category || '').toLowerCase();
    const artTitleWords = new Set(
      (article.title || '').toLowerCase().split(/[\s\-_,.:;'"]+/).filter(w => w.length >= 3 && !SKIP_KEYWORDS.has(w))
    );

    let bestScore = 0;
    let bestTimeline = null;

    for (const tl of existingTimelines) {
      let score = 0;

      // Keyword overlap: each shared keyword = 1.5 points
      let kwOverlap = 0;
      for (const kw of artKws) {
        if (tl._kwSet.has(kw)) kwOverlap++;
      }
      score += kwOverlap * 1.5;

      // Title word match: article title words matching timeline title/scope = 2 points each
      for (const w of artTitleWords) {
        if (tl._titleWords.has(w) || tl._scopeWords.has(w)) score += 2.0;
      }

      // Entity overlap: shared entities = 1.8 points each (capped at 5)
      const tlEnts = tlEntityMap.get(Number(tl.id)) || new Set();
      let entOverlap = 0;
      for (const eid of artEntities) {
        if (tlEnts.has(eid)) entOverlap++;
      }
      score += Math.min(entOverlap, 5) * 1.8;

      // Country + category match: same country AND same hard-news category = 1.5 bonus
      const HARD_CATS = new Set(['politics', 'military', 'diplomacy', 'conflict', 'economy']);
      const tlCountries = (tl._countries || []).map(c => c.toLowerCase());
      if (artCountry && tlCountries.includes(artCountry) && HARD_CATS.has(artCategory)) {
        const tlCat = (tl.primary_category || '').toLowerCase();
        if (tlCat === artCategory || HARD_CATS.has(tlCat)) {
          score += 1.5;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestTimeline = tl;
        if (score >= STRONG_ATTACH) break; // definitely this timeline, no need to check more
      }
    }

    if (bestScore >= ATTACH_THRESHOLD && bestTimeline) {
      // Attach article to this timeline
      if (!bestTimeline._pendingArticles) bestTimeline._pendingArticles = [];
      bestTimeline._pendingArticles.push(article);
      attachCount++;
    } else {
      unmatched.push(article);
    }
  }

  console.log(`   [${elapsed()}] Deterministically attached: ${attachCount} articles`);
  console.log(`   [${elapsed()}] Unmatched: ${unmatched.length} articles`);

  // Persist deterministic attachments in bulk
  let updatedTimelines = 0;
  for (const tl of existingTimelines) {
    if (!tl._pendingArticles?.length) continue;
    await bulkInsertTimelineArticles(Number(tl.id), tl._pendingArticles);
    await pool.query(`
      UPDATE story_timelines
      SET last_updated_at = NOW(),
          status          = 'active',
          article_count   = article_count + $1
      WHERE id = $2
    `, [tl._pendingArticles.length, tl.id]);
    updatedTimelines++;
  }
  console.log(`   [${elapsed()}] Updated ${updatedTimelines} existing timelines`);

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 2: CLUSTER UNMATCHED
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n   ═══ PHASE 2: Cluster Unmatched ═══`);

  const clusters = clusterBroad(unmatched, entityMap);
  console.log(`   [${elapsed()}] Clusters from unmatched: ${clusters.length} (articles in clusters: ${clusters.reduce((s,c) => s+c.length, 0)})`);

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 3: CLAUDE CREATES NEW TIMELINES
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n   ═══ PHASE 3: Claude Creates New Timelines ═══`);

  let created = 0;
  const existingScopeSet = new Set(existingTimelines.map(t => (t.scope || '').toLowerCase()));
  const existingTitleSet = new Set(existingTimelines.map(t => (t.title || '').toLowerCase()));

  // Only send clusters big enough to warrant a new timeline
  const viableClusters = clusters.filter(c => c.length >= MIN_CLUSTER);
  const allBatches = [];

  for (const cluster of viableClusters) {
    if (cluster.length <= CLAUDE_BATCH) {
      allBatches.push(cluster);
    } else {
      // Split large clusters into manageable batches
      for (const chunk of chunkArray(cluster, CLAUDE_BATCH)) {
        allBatches.push(chunk);
      }
    }
  }

  console.log(`   [${elapsed()}] Sending ${allBatches.length} batch(es) to Claude for new timeline creation...`);

  for (let i = 0; i < allBatches.length; i++) {
    const batch = allBatches[i];
    process.stdout.write(`   [${elapsed()}] Batch ${i+1}/${allBatches.length} (${batch.length} articles) → Claude... `);
    try {
      const defs = await claudeCreateTimelines(batch, existingTimelines);
      for (const def of defs) {
        if (!def.article_ids?.length || def.article_ids.length < MIN_CLUSTER) continue;

        // Skip if scope already exists
        const scope = (def.scope || '').toLowerCase().replace(/\s+/g, '_').slice(0, 80);
        if (scope && existingScopeSet.has(scope)) {
          console.log(`\n   ⚠ Skipped duplicate scope "${scope}"`);
          continue;
        }

        const cat = String(def.primary_category || '').toLowerCase();
        const ALLOWED_CATS = new Set(['politics','economy','military','diplomacy','environment','technology','conflict','security']);
        if (cat && !ALLOWED_CATS.has(cat)) {
          console.log(`\n   🚫 Rejected "${def.title}" (category=${cat})`);
          continue;
        }

        // Reject generic topic buckets that slipped past the prompt
        if (isGenericTopicBucket(def.title)) {
          console.log(`\n   🚫 Rejected generic bucket "${def.title}"`);
          continue;
        }

        // Entity/geography gate: title must contain a country signal or proper noun
        if (!COUNTRY_SIGNAL_RE.test(def.title) && !hasProperNoun(def.title)) {
          console.log(`\n   🚫 Rejected (no entity anchor): "${def.title}"`);
          continue;
        }

        const validIds = def.article_ids.map(Number).filter(id => batch.some(a => a.id === id));
        if (validIds.length < MIN_CLUSTER) continue;

        try {
          const { rows } = await pool.query(`
            INSERT INTO story_timelines
              (title, description, scope, primary_category, geographic_scope,
               importance, keywords, article_count, lookback_days, parabolic_peak_hours)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
          `, [
            def.title,
            def.description || '',
            scope || null,
            def.primary_category || 'politics',
            def.geographic_scope || 'global',
            def.importance || 6,
            def.keywords || [],
            validIds.length,
            Math.ceil(LOOKBACK_HOURS / 24),
            PARABOLIC_PEAK_HOURS
          ]);

          const timelineId = rows[0].id;
          const batchArticles = batch.filter(a => validIds.includes(a.id));
          await bulkInsertTimelineArticles(timelineId, batchArticles, def.anchor_article_id);
          existingScopeSet.add(scope);
          created++;
        } catch (err) {
          if (err.code === '23505') {
            console.log(`\n   ⚠ Duplicate key for "${def.title}" — skipped`);
          } else {
            console.error(`\n   ⚠ Failed to create "${def.title}": ${err.message}`);
          }
        }
      }
      console.log(`✓ created ${defs.length} timeline defs`);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
    }
    await sleep(1500);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 4: THREAD-INFORMED SEEDING
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n   ═══ PHASE 4: Thread-Informed Seeding ═══`);

  // Reload existing timelines (includes newly created ones)
  const updatedExisting = await getActiveTimelines();
  const updatedScopeSet = new Set(updatedExisting.map(t => (t.scope || '').toLowerCase()));

  const seeded = await seedFromThreads(updatedExisting, updatedScopeSet);
  console.log(`   [${elapsed()}] Seeded ${seeded} new timelines from uncovered threads`);

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 5: CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n   ═══ PHASE 5: Cleanup ═══`);

  await refreshAllCounts();
  await coolDownTimelines();
  await detectAndMergeDuplicates();

  console.log(`\n✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s — ${attachCount} attached, ${created} created, ${seeded} seeded.\n`);
  await pool.end();
}

// ═════════════════════════════════════════════════════════════════════════════
//  ARTICLE POOL — articles NOT yet in any timeline
// ═════════════════════════════════════════════════════════════════════════════
async function getArticlePool(hours) {
  // Disable statement timeout for these heavy queries
  await pool.query('SET statement_timeout = 0');

  // Pre-fetch the set of article IDs already in timelines (fast hash join)
  const { rows: existingRows } = await pool.query(
    'SELECT DISTINCT article_id FROM story_timeline_articles'
  );
  const inTimeline = new Set(existingRows.map(r => r.article_id));

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
           source_name, source_key, fetch_tier, country_name, city_name
    FROM ranked
    WHERE source_rank <= ${MAX_PER_SOURCE}
    ORDER BY base_priority DESC NULLS LAST, published_at DESC
    LIMIT ${TOTAL_ARTICLE_LIMIT * 2}
  `);

  // Filter out articles already in timelines (in JS — avoids slow NOT IN subquery)
  const filtered = rows.filter(r => !inTimeline.has(r.id)).slice(0, TOTAL_ARTICLE_LIMIT);
  if (!filtered.length) return [];

  // Batch-fetch categories from thread associations
  const allIds = filtered.map(r => r.id);
  const { rows: catRows } = await pool.query(`
    SELECT DISTINCT ON (sta.article_id)
      sta.article_id, st.primary_category
    FROM story_thread_articles sta
    JOIN story_threads st ON st.id = sta.thread_id
    WHERE sta.article_id = ANY($1::int[])
    ORDER BY sta.article_id, st.importance DESC
  `, [allIds]);
  const catMap = new Map(catRows.map(r => [r.article_id, r.primary_category]));
  for (const r of filtered) {
    r.primary_category = catMap.get(r.id) || null;
  }

  // Also inject articles from active/cooling threads not yet in timelines
  const { rows: threadRows } = await pool.query(`
    SELECT DISTINCT ON (a.id)
      a.id, a.title, a.summary, a.translated_summary,
      a.published_at, a.base_priority,
      COALESCE(ns.name, ys.name) AS source_name,
      COALESCE(ns.id::text, 'y'||ys.id::text) AS source_key,
      COALESCE(ns.fetch_tier, 1) AS fetch_tier,
      co.name AS country_name,
      ci.name AS city_name,
      st.primary_category
    FROM story_threads st
    JOIN story_thread_articles sta ON sta.thread_id = st.id
    JOIN news_articles a ON a.id = sta.article_id
    LEFT JOIN countries     co ON co.id = a.country_id
    LEFT JOIN cities        ci ON ci.id = a.city_id
    LEFT JOIN news_sources  ns ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    WHERE st.status IN ('active', 'cooling')
      AND st.importance >= 4
      AND a.published_at > NOW() - INTERVAL '${hours} hours'
      AND a.title IS NOT NULL
    ORDER BY a.id, st.importance DESC, a.published_at DESC
    LIMIT 800
  `);

  // Merge, dedup — also filter thread rows through inTimeline set
  const allRows = [...filtered];
  const existingIds = new Set(filtered.map(r => r.id));
  for (const tr of threadRows) {
    if (!existingIds.has(tr.id) && !inTimeline.has(tr.id)) {
      allRows.push(tr);
      existingIds.add(tr.id);
    }
  }

  // Load keywords for all articles
  const ids = allRows.map(r => r.id);
  const { rows: kwRows } = await pool.query(`
    SELECT article_id, ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
    FROM article_keywords
    WHERE article_id = ANY($1::int[])
    GROUP BY article_id
  `, [ids]);
  const kwMap = new Map(kwRows.map(r => [r.article_id, r.keywords]));

  return allRows.map(a => {
    const ageHours = (Date.now() - new Date(a.published_at).getTime()) / 3600000;
    return {
      ...a,
      keywords: kwMap.get(a.id) || [],
      age_hours: ageHours,
      parabolic_weight: parabolicWeight(ageHours)
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENTITY LOADING
// ═════════════════════════════════════════════════════════════════════════════
async function loadEntityMentions(articleIds) {
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
    console.warn(`   ⚠ Entity mention lookup skipped: ${e.message}`);
  }
  return out;
}

// Build entity profiles for existing timelines — sample top entities from
// each timeline's most recent articles
async function loadTimelineEntityProfiles(timelineIds) {
  const out = new Map();
  if (!timelineIds.length) return out;
  try {
    const { rows } = await pool.query(`
      SELECT sta.timeline_id, aem.entity_id, COUNT(*) AS mentions
      FROM story_timeline_articles sta
      JOIN article_entity_mentions aem ON aem.article_id = sta.article_id
      WHERE sta.timeline_id = ANY($1::int[])
        AND aem.role IN ('subject', 'actor', 'location')
      GROUP BY sta.timeline_id, aem.entity_id
      HAVING COUNT(*) >= 2
      ORDER BY sta.timeline_id, mentions DESC
    `, [timelineIds]);
    for (const r of rows) {
      const tid = Number(r.timeline_id);
      if (!out.has(tid)) out.set(tid, new Set());
      out.get(tid).add(Number(r.entity_id));
    }
  } catch (e) {
    console.warn(`   ⚠ Timeline entity profile skipped: ${e.message}`);
  }

  // Also load country info for each timeline
  try {
    const { rows } = await pool.query(`
      SELECT sta.timeline_id, co.name AS country_name, COUNT(*) AS cnt
      FROM story_timeline_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      JOIN countries co ON co.id = a.country_id
      WHERE sta.timeline_id = ANY($1::int[])
      GROUP BY sta.timeline_id, co.name
      HAVING COUNT(*) >= 2
      ORDER BY sta.timeline_id, cnt DESC
    `, [timelineIds]);

    // Store on the timeline objects (we'll read it in Phase 1)
    const countryMap = new Map();
    for (const r of rows) {
      const tid = Number(r.timeline_id);
      if (!countryMap.has(tid)) countryMap.set(tid, []);
      countryMap.get(tid).push(r.country_name);
    }
    // Attach to timeline objects — we need to pass this through
    // Store on global object for now
    global.__tlCountryMap = countryMap;
  } catch (e) {
    console.warn(`   ⚠ Timeline country profile skipped: ${e.message}`);
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CLUSTERING (for unmatched articles only)
// ═════════════════════════════════════════════════════════════════════════════
function clusterBroad(articles, entityMap) {
  if (!articles.length) return [];

  const kwIndex = new Map();
  for (const a of articles) {
    for (const kw of (a.keywords || [])) {
      const k = normalizeKeyword(kw);
      if (k.length < 3 || SKIP_KEYWORDS.has(k)) continue;
      if (!kwIndex.has(k)) kwIndex.set(k, []);
      kwIndex.get(k).push(a);
    }
  }

  const pairScore = new Map();
  const addPair = (idA, idB, weight) => {
    const key = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
    pairScore.set(key, (pairScore.get(key) || 0) + weight);
  };

  for (const [, arts] of kwIndex) {
    if (arts.length < 2 || arts.length > 150) continue;
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        addPair(arts[i].id, arts[j].id, 1);
      }
    }
  }

  // Entity overlap
  const entIndex = new Map();
  for (const a of articles) {
    const ents = entityMap.get(a.id) || [];
    for (const eid of ents) {
      if (!entIndex.has(eid)) entIndex.set(eid, []);
      entIndex.get(eid).push(a);
    }
  }
  for (const [, arts] of entIndex) {
    if (arts.length < 2 || arts.length > 100) continue;
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        addPair(arts[i].id, arts[j].id, 1.5);
      }
    }
  }

  // Country + category co-location
  const HARD_CATS = new Set(['politics', 'military', 'diplomacy', 'conflict']);
  const ccIndex = new Map();
  for (const a of articles) {
    if (!a.country_name) continue;
    const cat = (a.primary_category || '').toLowerCase();
    if (!HARD_CATS.has(cat)) continue;
    const key = `${a.country_name.toLowerCase()}::${cat}`;
    if (!ccIndex.has(key)) ccIndex.set(key, []);
    ccIndex.get(key).push(a);
  }
  for (const [, arts] of ccIndex) {
    if (arts.length < 2 || arts.length > 100) continue;
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        addPair(arts[i].id, arts[j].id, 0.8);
      }
    }
  }

  // Union-Find
  const parent = new Map(articles.map(a => [a.id, a.id]));
  const find = (x) => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  };
  const union = (x, y) => parent.set(find(x), find(y));

  for (const [pair, score] of pairScore) {
    if (score >= 1.5) { // slightly higher threshold for new timeline creation
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

// ═════════════════════════════════════════════════════════════════════════════
//  CLAUDE — CREATE-ONLY (no matching to existing)
// ═════════════════════════════════════════════════════════════════════════════
async function claudeCreateTimelines(articles, existingTimelines) {
  const articleData = articles.map(a => ({
    id:       a.id,
    title:    a.title,
    summary:  (a.translated_summary || a.summary || "").slice(0, 200),
    keywords: (a.keywords || []).slice(0, 10),
    country:  a.country_name || null,
    category: a.primary_category || null,
    age_h:    Math.round(a.age_hours),
  }));

  // Show existing timelines so Claude doesn't create duplicates
  const existingInfo = existingTimelines.slice(0, 200).map(t => ({
    title: t.title,
    scope: t.scope,
  }));

  const prompt = `You are creating NEW broad geopolitical timeline arcs for a GEOPOLITICS app. These are UMBRELLA-LEVEL multi-month narratives tracking SPECIFIC ongoing crises, conflicts, and power shifts — NOT abstract global topic categories.

Your job: group these unmatched articles into genuinely NEW timeline arcs that don't already exist.

═══ EXISTING TIMELINES (DO NOT DUPLICATE) ═══
${JSON.stringify(existingInfo, null, 1)}

═══ RULES ═══
• Title: 2-5 words MAX. Name the ARC: "Gaza Genocide", "NATO Expansion", "Sahel Insurgency"
• Scope: stable snake_case slug: "gaza_genocide", "nato_expansion", "sahel_insurgency"
• Only create if 3+ articles clearly belong to the same SPECIFIC arc
• importance: 5-10 (10 = genocide/major war, 9 = major conflict, 5 = regional political shift)

═══ MANDATORY REJECTIONS ═══
REJECT all of the following — they are NOT valid geopolitical arcs:
• Sports, entertainment, local crime, product launches, lifestyle
• Abstract global categories: "Global Energy Transition", "Renewable Energy", "Climate Crisis", "Cost of Living", "Cybersecurity Standards", "Digital Infrastructure", "AI Regulation", "Global Health", "Food Security", "Labor Negotiations"
• Generic topic buckets that lack a SPECIFIC country, actor, or event: "Cultural Heritage Protection", "Extreme Weather Response", "Global Economic Slowdown"
• Any title starting with "Global" followed by an abstract noun (policy, transition, security, reform, etc.)

═══ WHAT MAKES A VALID ARC ═══
A valid arc has a SPECIFIC geopolitical signal:
  ✅ "Hungary Election Crisis" — specific country, specific event
  ✅ "US-Iran Blockade" — specific actors, specific action
  ✅ "Gaza Genocide" — specific location, specific crisis
  ✅ "DRC-Rwanda Proxy War" — specific countries, specific conflict
  ❌ "Global Energy Security" — no specific actor or event
  ❌ "Renewable Energy Transition" — abstract category, not a story arc
  ❌ "Natural Disasters & Climate Impacts" — vague topic bucket

If articles don't form a SPECIFIC geopolitical arc, return empty array [].

═══ UNMATCHED ARTICLES ═══
${JSON.stringify(articleData, null, 1)}

Return ONLY valid JSON array, no explanation:
[{"title":"...", "description":"Two sentences.", "scope":"snake_slug", "article_ids":[ids], "anchor_article_id":id, "primary_category":"politics|economy|military|diplomacy|environment|technology|conflict|security", "geographic_scope":"global|regional", "importance":7, "keywords":["5-10 keywords"]}]`;

  const response = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 4000,
    messages:   [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON array in response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ═════════════════════════════════════════════════════════════════════════════
//  THREAD-INFORMED SEEDING — PRIMARY source of new timelines
//
//  A thread graduates to a timeline ONLY when it proves sustained coverage:
//    • article coverage span ≥ 7 days (measured from actual article dates,
//      not thread created_at — so a thread with articles on day 1 and day 30
//      but nothing in between still counts, but one with articles only on a
//      single day does not)
//    • article_count ≥ 5
//    • distinct_source_count ≥ 3 (multi-source coverage)
//    • has at least one primary_nation (entity/geography anchor)
//    • ANY status qualifies (active, cooling, OR dormant) — a thread that
//      tracked the Ukraine-Russia war for months and went dormant should
//      still become a timeline
//
//  Title comes directly from the thread — no Claude umbrella invention.
//  Before creating, we check article overlap against existing timelines
//  and merge if ≥ 30% overlap.
// ═════════════════════════════════════════════════════════════════════════════
async function seedFromThreads(existingTimelines, existingScopeSet) {
  try {
    // ── Gate: threads with ≥ 7 days of article coverage span ──
    // We join story_thread_articles → news_articles to compute the actual
    // date range of articles in each thread. A thread qualifies if
    // MAX(published_at) - MIN(published_at) ≥ 7 days.
    // ALL statuses included: active threads still developing, cooling ones
    // winding down, and dormant ones that tracked a long-running story.
    const { rows: threads } = await pool.query(`
      SELECT st.id, st.title, st.description, st.keywords, st.importance,
             st.primary_category, st.article_count, st.distinct_source_count,
             st.primary_nations, st.created_at, st.status,
             span.first_article, span.last_article, span.span_days
      FROM story_threads st
      JOIN (
        SELECT sta.thread_id,
               MIN(a.published_at) AS first_article,
               MAX(a.published_at) AS last_article,
               EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400.0 AS span_days
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        GROUP BY sta.thread_id
        HAVING EXTRACT(EPOCH FROM (MAX(a.published_at) - MIN(a.published_at))) / 86400.0 >= 7
      ) span ON span.thread_id = st.id
      WHERE st.article_count >= 5
        AND st.distinct_source_count >= 3
      ORDER BY st.importance DESC, span.span_days DESC, st.article_count DESC
      LIMIT 120
    `);
    if (!threads.length) return 0;
    console.log(`   [seedFromThreads] ${threads.length} threads pass 7-day gate`);

    // ── Reject generic topic buckets ──
    const qualified = threads.filter(t => {
      if (isGenericTopicBucket(t.title)) {
        console.log(`   🚫 Rejected generic: "${t.title}"`);
        return false;
      }
      // Must have a proper noun / country signal in title
      if (!COUNTRY_SIGNAL_RE.test(t.title) && !hasProperNoun(t.title)) {
        console.log(`   🚫 Rejected (no entity anchor): "${t.title}"`);
        return false;
      }
      return true;
    });
    if (!qualified.length) return 0;
    console.log(`   [seedFromThreads] ${qualified.length} threads pass entity/quality gate`);

    // ── Title-cluster dedup: prevent 10 Iran variants from all graduating ──
    // Sort best-first, then absorb any subsequent thread whose title signal
    // words have containment similarity ≥ 0.50 with an already-kept thread.
    // Containment = shared / size_of_smaller_set (more aggressive than Jaccard).
    {
      const sorted = [...qualified].sort((a, b) =>
        (b.importance - a.importance) || (b.span_days - a.span_days) || (b.article_count - a.article_count));

      const sigs = sorted.map(t => ({
        thread: t,
        sig: new Set(
          (t.title || '').toLowerCase()
            .split(/[\s\-_,.:;'"&+/]+/)
            .filter(w => w.length >= 4 && !SKIP_KEYWORDS.has(w))
        )
      }));

      const absorbed = new Set();
      const kept = [];
      for (let i = 0; i < sigs.length; i++) {
        if (absorbed.has(i)) continue;
        kept.push(sorted[i]);
        for (let j = i + 1; j < sigs.length; j++) {
          if (absorbed.has(j)) continue;
          const sigA = sigs[i].sig;
          const sigB = sigs[j].sig;
          if (!sigA.size || !sigB.size) continue;
          let shared = 0;
          for (const w of sigA) { if (sigB.has(w)) shared++; }
          const containment = shared / Math.min(sigA.size, sigB.size);
          if (containment >= 0.50) {
            console.log(`   ⟳ Title-cluster: "${sorted[j].title}" absorbed by "${sorted[i].title}" (${(containment*100).toFixed(0)}%)`);
            absorbed.add(j);
          }
        }
      }
      qualified.length = 0;
      kept.forEach(t => qualified.push(t));
      console.log(`   [seedFromThreads] After title-cluster dedup: ${qualified.length} threads`);
    }

    // ── Load article IDs for each qualifying thread ──
    const threadIds = qualified.map(t => t.id);
    const { rows: threadArticleRows } = await pool.query(`
      SELECT sta.thread_id, ARRAY_AGG(sta.article_id) AS article_ids
      FROM story_thread_articles sta
      WHERE sta.thread_id = ANY($1::int[])
      GROUP BY sta.thread_id
    `, [threadIds]);
    const threadArticleMap = new Map(threadArticleRows.map(r => [r.thread_id, new Set(r.article_ids)]));

    // ── Load article IDs for existing timelines (for overlap check) ──
    const tlIds = existingTimelines.map(t => Number(t.id));
    const tlArticleMap = new Map();
    if (tlIds.length) {
      const { rows: tlArtRows } = await pool.query(`
        SELECT timeline_id, ARRAY_AGG(article_id) AS article_ids
        FROM story_timeline_articles
        WHERE timeline_id = ANY($1::int[])
        GROUP BY timeline_id
      `, [tlIds]);
      for (const r of tlArtRows) {
        tlArticleMap.set(Number(r.timeline_id), new Set(r.article_ids));
      }
    }

    let seeded = 0;
    for (const thread of qualified) {
      const threadArts = threadArticleMap.get(thread.id);
      if (!threadArts || threadArts.size < 5) continue;

      // ── Article-overlap check against existing timelines ──
      let bestOverlap = 0;
      let bestTl = null;
      for (const tl of existingTimelines) {
        const tlArts = tlArticleMap.get(Number(tl.id));
        if (!tlArts || !tlArts.size) continue;
        let shared = 0;
        for (const aid of threadArts) { if (tlArts.has(aid)) shared++; }
        const overlapRatio = shared / Math.min(threadArts.size, tlArts.size);
        if (overlapRatio > bestOverlap) {
          bestOverlap = overlapRatio;
          bestTl = tl;
        }
      }

      if (bestOverlap >= 0.20 && bestTl) {
        // ── Merge into existing timeline ──
        console.log(`   ⤵ Thread "${thread.title}" → merge into "${bestTl.title}" (${(bestOverlap*100).toFixed(0)}% overlap)`);
        // Add thread's articles to the existing timeline
        const artIds = [...threadArts];
        for (const artId of artIds) {
          await pool.query(`
            INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor)
            VALUES ($1, $2, 0.5, 0.5, false)
            ON CONFLICT DO NOTHING
          `, [bestTl.id, artId]);
        }
        await pool.query(`UPDATE story_timelines SET last_updated_at = NOW(), status = 'active' WHERE id = $1`, [bestTl.id]);
        continue;
      }

      // ── Check scope/title duplicate ──
      const scope = (thread.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80);
      if (existingScopeSet.has(scope)) {
        console.log(`   ⚠ Scope collision: "${scope}" — skipped`);
        continue;
      }

      // ── Also check title-word overlap with existing timelines ──
      const threadTitleWords = new Set(
        (thread.title || '').toLowerCase().split(/[\s\-_,.:;'"]+/).filter(w => w.length >= 3 && !SKIP_KEYWORDS.has(w))
      );
      let titleDupe = false;
      for (const tl of existingTimelines) {
        const tlWords = new Set(
          (tl.title || '').toLowerCase().split(/[\s\-_,.:;'"]+/).filter(w => w.length >= 3 && !SKIP_KEYWORDS.has(w))
        );
        if (!tlWords.size || !threadTitleWords.size) continue;
        let shared = 0;
        for (const w of threadTitleWords) { if (tlWords.has(w)) shared++; }
        const jaccard = shared / (new Set([...threadTitleWords, ...tlWords])).size;
        if (jaccard >= 0.30) {
          console.log(`   ⚠ Title overlap with "${tl.title}" (jaccard ${jaccard.toFixed(2)}) — skipped`);
          titleDupe = true;
          break;
        }
      }
      if (titleDupe) continue;

      // ── Create new timeline from thread ──
      try {
        const { rows } = await pool.query(`
          INSERT INTO story_timelines
            (title, description, scope, primary_category, geographic_scope,
             importance, keywords, primary_nations, article_count,
             lookback_days, parabolic_peak_hours)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id
        `, [
          thread.title,
          thread.description || '',
          scope,
          thread.primary_category || 'politics',
          'regional',
          thread.importance || 6,
          thread.keywords || [],
          thread.primary_nations || [],
          threadArts.size,
          Math.ceil(LOOKBACK_HOURS / 24),
          PARABOLIC_PEAK_HOURS
        ]);

        const timelineId = rows[0].id;
        const artIds = [...threadArts];
        for (const artId of artIds) {
          await pool.query(`
            INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor)
            VALUES ($1, $2, 0.5, 0.5, false)
            ON CONFLICT DO NOTHING
          `, [timelineId, artId]);
        }

        existingScopeSet.add(scope);
        // Also add to existingTimelines so subsequent threads can overlap-check
        existingTimelines.push({
          id: timelineId, title: thread.title, scope, keywords: thread.keywords || [],
          primary_category: thread.primary_category, _countries: thread.primary_nations || [],
          importance: thread.importance, article_count: threadArts.size, status: 'active'
        });
        tlArticleMap.set(timelineId, threadArts);
        seeded++;
        console.log(`   ✓ Graduated: "${thread.title}" (${threadArts.size} articles, ${thread.distinct_source_count} sources, ${Math.round(thread.span_days)}d coverage span, status=${thread.status || 'unknown'})`);
      } catch (err) {
        if (err.code !== '23505') {
          console.error(`   ⚠ Seed failed "${thread.title}": ${err.message}`);
        }
      }
    }

    return seeded;
  } catch (e) {
    console.warn(`   ⚠ Thread seeding skipped: ${e.message}`);
    return 0;
  }
}

// Simple proper-noun check: title contains at least one capitalized word
// that isn't at the start and isn't a common English word.
function hasProperNoun(title) {
  if (!title) return false;
  const words = title.split(/\s+/).slice(1); // skip first word (always capitalized)
  const COMMON = new Set(['the','and','for','with','from','into','over','after','before','during','against','between','under','about','through']);
  return words.some(w => /^[A-Z]/.test(w) && !COMMON.has(w.toLowerCase()));
}

// ═════════════════════════════════════════════════════════════════════════════
//  BULK INSERT ARTICLES INTO TIMELINE
// ═════════════════════════════════════════════════════════════════════════════
async function bulkInsertTimelineArticles(timelineId, articles, anchorId) {
  if (!articles.length) return;
  const values = [];
  const params = [];
  let idx = 1;

  for (const a of articles) {
    const weight = a.parabolic_weight || 0.5;
    const importance = a.base_priority || 0.5;
    const relevance = Number((importance * weight).toFixed(4));
    const isAnchor = a.id === Number(anchorId);
    values.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4})`);
    params.push(timelineId, a.id, weight, relevance, isAnchor);
    idx += 5;
  }

  await pool.query(`
    INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor)
    VALUES ${values.join(', ')}
    ON CONFLICT DO NOTHING
  `, params);
}

// ═════════════════════════════════════════════════════════════════════════════
//  REFRESH COUNTS, COOLDOWN, MERGE
// ═════════════════════════════════════════════════════════════════════════════
async function refreshAllCounts() {
  try {
    await pool.query(`
      UPDATE story_timelines t
      SET article_count       = sub.cnt,
          distinct_source_count = sub.src_cnt,
          parabolic_weight_sum = sub.pw_sum
      FROM (
        SELECT sta.timeline_id,
               COUNT(*)::int AS cnt,
               COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id))::int AS src_cnt,
               COALESCE(SUM(sta.parabolic_weight)::real, 0) AS pw_sum
        FROM story_timeline_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        GROUP BY sta.timeline_id
      ) sub
      WHERE t.id = sub.timeline_id
    `);
    console.log(`   Refreshed article counts for all timelines`);
  } catch (e) {
    console.warn(`   ⚠ Count refresh failed: ${e.message}`);
  }
}

async function coolDownTimelines() {
  // Timelines that haven't had new articles in 30 days → cooling
  // Cooling for 60+ more days → dormant
  const a = await pool.query(`
    UPDATE story_timelines SET status = 'cooling'
    WHERE status = 'active' AND last_updated_at < NOW() - INTERVAL '30 days'
  `);
  const c = await pool.query(`
    UPDATE story_timelines SET status = 'dormant'
    WHERE status = 'cooling' AND last_updated_at < NOW() - INTERVAL '90 days'
  `);
  console.log(`   active→cooling: ${a.rowCount} | cooling→dormant: ${c.rowCount}`);
}

async function detectAndMergeDuplicates() {
  let merged = 0;

  // ── Pass 0: Title-similarity dedup ───────────────────────────────────────
  // Two active timelines with title-signal containment ≥ 0.50 are the same
  // story. Catches "US-Iran Military Escalation" vs "Iran-US Escalation Crisis"
  // even when they share < 30% article overlap (different articles, same arc).
  try {
    const { rows: allTls } = await pool.query(`
      SELECT id, title, importance, article_count
      FROM story_timelines
      WHERE status IN ('active', 'cooling')
      ORDER BY importance DESC, article_count DESC
    `);

    const sigs = allTls.map(t => ({
      tl: t,
      sig: new Set(
        (t.title || '').toLowerCase()
          .split(/[\s\-_,.:;'"&+/]+/)
          .filter(w => w.length >= 4 && !SKIP_KEYWORDS.has(w))
      )
    }));

    const titleAbsorbed = new Set();
    let titleMerged = 0;
    for (let i = 0; i < sigs.length; i++) {
      if (titleAbsorbed.has(sigs[i].tl.id)) continue;
      for (let j = i + 1; j < sigs.length; j++) {
        if (titleAbsorbed.has(sigs[j].tl.id)) continue;
        const sigA = sigs[i].sig;
        const sigB = sigs[j].sig;
        if (!sigA.size || !sigB.size) continue;
        let shared = 0;
        for (const w of sigA) { if (sigB.has(w)) shared++; }
        const containment = shared / Math.min(sigA.size, sigB.size);
        if (containment >= 0.50) {
          const keepTl = sigs[i].tl;
          const loseTl = sigs[j].tl;
          console.log(`   ⤵ Title merge (${(containment*100).toFixed(0)}%): "${loseTl.title}" → "${keepTl.title}"`);
          await mergeTimelineInto(keepTl.id, loseTl.id);
          titleAbsorbed.add(loseTl.id);
          titleMerged++;
        }
      }
    }
    if (titleMerged) console.log(`   Merged ${titleMerged} title-similarity duplicate(s)`);
  } catch (e) {
    console.warn(`   ⚠ Title-similarity dedup skipped: ${e.message}`);
  }

  // ── Pass 1: Exact scope-slug duplicates ──────────────────────────────────
  try {
    const { rows } = await pool.query(`
      SELECT scope, ARRAY_AGG(id ORDER BY article_count DESC) AS ids,
             COUNT(*) AS cnt
      FROM story_timelines
      WHERE scope IS NOT NULL AND scope != ''
      GROUP BY scope
      HAVING COUNT(*) > 1
    `);

    for (const row of rows) {
      const [keepId, ...dupeIds] = row.ids;
      for (const dupeId of dupeIds) {
        await mergeTimelineInto(keepId, dupeId);
        merged++;
      }
    }
    if (merged) console.log(`   Merged ${merged} scope-slug duplicate(s)`);
  } catch (e) {
    console.warn(`   ⚠ Scope-slug dedup skipped: ${e.message}`);
  }

  // ── Pass 2: Article-overlap dedup ────────────────────────────────────────
  // Any two active timelines sharing ≥ 30% of their articles are the same
  // story. Keep the one with higher importance (tiebreak: more articles).
  try {
    const { rows: activeTls } = await pool.query(`
      SELECT id, title, importance, article_count
      FROM story_timelines
      WHERE status IN ('active', 'cooling')
      ORDER BY importance DESC, article_count DESC
    `);
    if (activeTls.length < 2) return;

    // Load article sets for each timeline
    const { rows: artRows } = await pool.query(`
      SELECT timeline_id, ARRAY_AGG(article_id) AS aids
      FROM story_timeline_articles
      WHERE timeline_id = ANY($1::int[])
      GROUP BY timeline_id
    `, [activeTls.map(t => t.id)]);
    const artSets = new Map(artRows.map(r => [Number(r.timeline_id), new Set(r.aids)]));

    const absorbed = new Set(); // timelines already merged away
    let overlapMerged = 0;

    for (let i = 0; i < activeTls.length; i++) {
      const a = activeTls[i];
      if (absorbed.has(a.id)) continue;
      const setA = artSets.get(a.id);
      if (!setA || !setA.size) continue;

      for (let j = i + 1; j < activeTls.length; j++) {
        const b = activeTls[j];
        if (absorbed.has(b.id)) continue;
        const setB = artSets.get(b.id);
        if (!setB || !setB.size) continue;

        let shared = 0;
        for (const aid of setA) { if (setB.has(aid)) shared++; }
        const overlapRatio = shared / Math.min(setA.size, setB.size);

        if (overlapRatio >= 0.20) {
          // Keep the one with higher importance; tiebreak by article count
          const keepHigher = (a.importance > b.importance) ||
            (a.importance === b.importance && a.article_count >= b.article_count);
          const [keepId, loserId] = keepHigher ? [a.id, b.id] : [b.id, a.id];
          const keepTitle = keepHigher ? a.title : b.title;
          const loserTitle = keepHigher ? b.title : a.title;

          console.log(`   ⤵ Overlap merge (${(overlapRatio*100).toFixed(0)}%): "${loserTitle}" → "${keepTitle}"`);
          await mergeTimelineInto(keepId, loserId);
          absorbed.add(loserId);
          // Update the surviving set
          if (setB) for (const aid of setB) setA.add(aid);
          overlapMerged++;
        }
      }
    }
    if (overlapMerged) console.log(`   Merged ${overlapMerged} article-overlap duplicate(s)`);
  } catch (e) {
    console.warn(`   ⚠ Article-overlap dedup skipped: ${e.message}`);
  }
}

// Shared merge helper: move articles from loser into keeper, union keywords, delete loser
async function mergeTimelineInto(keepId, loserId) {
  // Move articles from loser to keeper
  await pool.query(`
    INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor)
    SELECT $1, article_id, parabolic_weight, relevance_score, is_anchor
    FROM story_timeline_articles
    WHERE timeline_id = $2
    ON CONFLICT DO NOTHING
  `, [keepId, loserId]);

  // Delete loser's article links
  await pool.query(`DELETE FROM story_timeline_articles WHERE timeline_id = $1`, [loserId]);

  // Merge keywords
  await pool.query(`
    UPDATE story_timelines
    SET keywords = (SELECT ARRAY(SELECT DISTINCT unnest(keywords || (SELECT keywords FROM story_timelines WHERE id = $2))))
    WHERE id = $1
  `, [keepId, loserId]);

  // Delete loser timeline
  await pool.query(`DELETE FROM story_timelines WHERE id = $1`, [loserId]);
}

async function getActiveTimelines() {
  const { rows } = await pool.query(`
    SELECT id, title, description, scope, keywords, primary_category, geographic_scope,
           importance, article_count, status
    FROM story_timelines
    WHERE last_updated_at > NOW() - INTERVAL '180 days'
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'cooling' THEN 1 ELSE 2 END,
      importance DESC, last_updated_at DESC
    LIMIT 500
  `);

  // Attach country info
  const countryMap = global.__tlCountryMap || new Map();
  for (const tl of rows) {
    tl._countries = countryMap.get(Number(tl.id)) || [];
  }

  return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
if (require.main === module) {
  run().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

module.exports = { run, parabolicWeight };
