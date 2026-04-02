/**
 * storyThreadBuilder.js
 *
 * Nightly job — processes recent articles (last 48h) into story threads.
 * Uses SQL keyword co-occurrence for pre-clustering, then Claude Sonnet
 * to evaluate clusters, detect cross-cluster connections, and name threads.
 *
 * Usage:
 *   node storyThreadBuilder.js            — process last 48 hours
 *   node storyThreadBuilder.js --hours=72 — custom lookback window
 */

require("dotenv").config();
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");
const { normalizeRecentKeywords } = require("./keywordNormalizer");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOOKBACK_HOURS  = parseInt(process.argv.find(a => a.startsWith("--hours="))?.split("=")[1] || "48");
const CLAUDE_BATCH    = 30;    // articles per Claude call
const MIN_CLUSTER     = 2;     // min articles to form a cluster
const MIN_SHARED_KW   = 2;     // min shared keywords to link two articles
const FRESH_PRIORITY_HOURS = 6;
const FRESH_PRIORITY_LIMIT = 100;
const TOTAL_ARTICLE_LIMIT  = 300;
const REFRESH_MIN_ARTICLES = 5;
const REFRESH_MIN_NEW_KWS  = 3;
const RECENCY_HALF_LIFE_HOURS = 36;
const SKIP_KEYWORDS   = new Set([ // too generic to cluster on
  "government","minister","president","official","said","year","people",
  "new","first","last","will","also","one","two","three","could","would",
  "after","before","over","under","says","says","day","week","month","country",
  "world","international","national","local","news","report","according"
]);

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🧵 Story Thread Builder — ${new Date().toISOString()}`);
  console.log(`   Lookback: ${LOOKBACK_HOURS}h | Article limit: none`);

  console.log(`   [${elapsed()}] Normalizing recent multilingual keywords...`);
  const normalization = await normalizeRecentKeywords({
    pool,
    anthropicClient: client,
    logger: console,
    scope: { hours: LOOKBACK_HOURS }
  }).catch(err => {
    console.warn(`   ⚠ Keyword normalization skipped: ${err.message}`);
    return null;
  });
  if (normalization) {
    console.log(`   [${elapsed()}] Keyword normalization provider=${normalization.provider} updated_keywords=${normalization.updatedKeywords} updated_rows=${normalization.updatedRows}`);
  }

  console.log(`   [${elapsed()}] Querying unthreaded articles...`);
  const articles = await getUnthreadedArticles(LOOKBACK_HOURS);
  console.log(`   [${elapsed()}] Found ${articles.length} unthreaded articles`);
  if (!articles.length) { console.log("   Nothing to thread. Done."); await pool.end(); return; }

  console.log(`   [${elapsed()}] Running SQL keyword clustering...`);
  const clusters   = sqlCluster(articles);
  const assigned   = new Set(clusters.flat().map(a => a.id));
  const singletons = articles.filter(a => !assigned.has(a.id));
  console.log(`   [${elapsed()}] Clusters: ${clusters.length} | Singletons: ${singletons.length}`);

  console.log(`   [${elapsed()}] Loading existing active threads...`);
  const existingThreads = await getActiveThreads();
  const existingThreadMap = new Map(existingThreads.map(t => [Number(t.id), { ...t }]));
  console.log(`   [${elapsed()}] Active threads in DB: ${existingThreads.length}`);

  let created = 0, updated = 0;
  const refreshThreadIds = new Set();
  const allGroups = [...clusters, ...chunkSingletons(singletons, 20)];
  const totalBatches = Math.ceil(allGroups.length / 3);
  console.log(`   [${elapsed()}] Sending ${totalBatches} batch(es) to Claude...\n`);

  for (let i = 0; i < allGroups.length; i += 3) {
    const batchNum = Math.floor(i/3) + 1;
    const batch = allGroups.slice(i, i + 3).flat().slice(0, CLAUDE_BATCH);
    if (!batch.length) continue;

    process.stdout.write(`   [${elapsed()}] Batch ${batchNum}/${totalBatches} (${batch.length} articles) → Claude... `);
    try {
      const validIdSet = new Set(batch.map(a => Number(a.id)));
      const defs = await evaluateWithClaude(batch, [...existingThreadMap.values()]);
      const { c, u, refreshIds } = await persistThreadDefs(defs, validIdSet, existingThreadMap);
      created += c; updated += u;
      refreshIds.forEach(id => refreshThreadIds.add(Number(id)));
      console.log(`✓ ${defs.length} threads (${c} new, ${u} updated)`);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
    }

    await sleep(1500);
  }

  if (refreshThreadIds.size) {
    console.log(`\n   [${elapsed()}] Refreshing ${refreshThreadIds.size} evolving thread context(s)...`);
    const refreshed = await refreshStaleThreadContexts([...refreshThreadIds]);
    console.log(`   [${elapsed()}] Refreshed ${refreshed} evolving thread context(s)`);
  }

  console.log(`\n   [${elapsed()}] Cooling down inactive threads...`);
  await coolDownInactiveThreads();

  console.log(`\n✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s — ${created} threads created, ${updated} updated.\n`);
  await pool.end();
}

// ─── SQL Pre-Clustering ───────────────────────────────────────────────────────

function sqlCluster(articles) {
  // Build inverted keyword index
  const kwIndex = new Map();
  for (const a of articles) {
    for (const kw of (a.keywords || [])) {
      const k = normalizeKeyword(kw);
      if (k.length < 4 || SKIP_KEYWORDS.has(k)) continue;
      if (!kwIndex.has(k)) kwIndex.set(k, []);
      kwIndex.get(k).push(a);
    }
  }

  // Score pairs by shared keyword count
  const pairScore = new Map();
  for (const [, arts] of kwIndex) {
    if (arts.length < 2 || arts.length > 80) continue; // skip hapax or too-common
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        const key = `${Math.min(arts[i].id, arts[j].id)}:${Math.max(arts[i].id, arts[j].id)}`;
        pairScore.set(key, (pairScore.get(key) || 0) + 1);
      }
    }
  }

  // Union-Find grouping
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

  // Group by cluster root
  const clusters = new Map();
  for (const a of articles) {
    const root = find(a.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(a);
  }

  return Array.from(clusters.values()).filter(c => c.length >= MIN_CLUSTER);
}

function chunkSingletons(singletons, size) {
  const chunks = [];
  for (let i = 0; i < singletons.length; i += size) {
    chunks.push(singletons.slice(i, i + size));
  }
  return chunks;
}

// ─── Claude Evaluation ────────────────────────────────────────────────────────

async function evaluateWithClaude(articles, existingThreads) {
  const articleData = articles.map(a => ({
    id:           a.id,
    title:        a.title,
    summary:      (a.translated_summary || a.summary || "").slice(0, 250),
    keywords:     (a.keywords || []).slice(0, 12),
    country:      a.country_name || null,
    city:         a.city_name || null,
    source:       a.source_name || null,
    published_at: a.published_at
  }));

  const existingData = existingThreads.slice(0, 30).map(t => ({
    id:       t.id,
    title:    t.title,
    keywords: t.keywords,
    category: t.primary_category
  }));

  const prompt = `You are a senior news editor. Analyze these articles and identify distinct ongoing news story threads.

EXISTING ACTIVE THREADS (check if any articles extend these):
${JSON.stringify(existingData, null, 2)}

ARTICLES TO ANALYZE:
${JSON.stringify(articleData, null, 2)}

Instructions:
- Group articles that are genuinely about the same ongoing story — even if they use different keywords
- A "story thread" is a developing narrative that spans multiple articles/sources over time
- Single articles can start a new thread if they represent a significant standalone story
- Check existing threads first — prefer extending them over creating duplicates
- Detect semantic connections SQL keyword matching would miss (e.g. "tariffs" + "trade war" + "WTO dispute" = same story)
- Importance 1-10: 10 = major global event, 1 = minor local interest

Return ONLY a valid JSON array, no explanation:
[
  {
    "existing_thread_id": null,
    "title": "concise thread title (max 8 words)",
    "description": "Two sentences describing the ongoing story and its significance.",
    "article_ids": [array of article ids that belong to this thread],
    "anchor_article_id": id of the most representative article,
    "primary_category": "politics|economy|military|diplomacy|environment|technology|society|sports|culture",
    "geographic_scope": "global|regional|local",
    "importance": 7,
    "keywords": ["array", "of", "5-10", "core", "keywords"]
  }
]`;

  const response = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 2048,
    messages:   [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON array in Claude response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── Persist ─────────────────────────────────────────────────────────────────

async function persistThreadDefs(defs, validIdSet, existingThreadMap = new Map()) {
  let created = 0, updated = 0;
  const refreshIds = new Set();

  for (const def of defs) {
    if (!def.article_ids?.length) continue;

    try {
      if (def.existing_thread_id) {
        const threadId = Number(def.existing_thread_id);
        const current = existingThreadMap.get(threadId);
        if (shouldRefreshThreadContext(current, def.keywords || [])) {
          refreshIds.add(threadId);
        }

        // Update existing thread
        await pool.query(`
          UPDATE story_threads
          SET last_updated_at = NOW(),
              importance      = GREATEST(importance, $1),
              article_count   = article_count + $2,
              keywords        = (
                SELECT ARRAY(SELECT DISTINCT unnest(keywords || $3::text[]))
              )
          WHERE id = $4
        `, [def.importance, def.article_ids.length, def.keywords || [], threadId]);

        await insertArticles(threadId, def.article_ids, def.anchor_article_id, def.importance, validIdSet);
        if (current) {
          existingThreadMap.set(threadId, {
            ...current,
            importance: Math.max(Number(current.importance) || 0, Number(def.importance) || 0),
            article_count: (Number(current.article_count) || 0) + def.article_ids.length,
            keywords: mergeKeywords(current.keywords || [], def.keywords || []),
            last_updated_at: new Date().toISOString()
          });
        }
        updated++;
      } else {
        // Create new thread
        const { rows } = await pool.query(`
          INSERT INTO story_threads
            (title, description, primary_category, geographic_scope, importance, keywords, article_count)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `, [
          def.title,
          def.description,
          def.primary_category || "politics",
          def.geographic_scope || "global",
          def.importance       || 5,
          def.keywords         || [],
          def.article_ids.length
        ]);

        const threadId = rows[0].id;
        await insertArticles(threadId, def.article_ids, def.anchor_article_id, def.importance, validIdSet);
        existingThreadMap.set(Number(threadId), {
          id: Number(threadId),
          title: def.title,
          description: def.description,
          primary_category: def.primary_category || "politics",
          geographic_scope: def.geographic_scope || "global",
          importance: def.importance || 5,
          keywords: def.keywords || [],
          article_count: def.article_ids.length
        });
        created++;
      }
    } catch (err) {
      console.error(`   ⚠ Failed to persist thread "${def.title}": ${err.message}`);
    }
  }

  return { c: created, u: updated, refreshIds: [...refreshIds] };
}

async function insertArticles(threadId, articleIds, anchorId, importance, validIdSet) {
  const filteredIds = articleIds
    .map(id => Number(id))
    .filter(id => !validIdSet || validIdSet.has(id));
  if (!filteredIds.length) return;

  const { rows } = await pool.query(`
    SELECT id, published_at
    FROM news_articles
    WHERE id = ANY($1::int[])
  `, [filteredIds]);

  const publishedAtMap = new Map(rows.map(r => [Number(r.id), r.published_at]));
  for (const articleId of articleIds) {
    const numericId = Number(articleId);
    if (validIdSet && !validIdSet.has(numericId)) continue;
    const publishedAt = publishedAtMap.get(numericId);
    const score = computeArticleRelevanceScore(importance, publishedAt);
    await pool.query(`
      INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [threadId, numericId, score, numericId === Number(anchorId)]);
  }
}

async function refreshStaleThreadContexts(threadIds) {
  let refreshed = 0;

  for (const threadId of threadIds) {
    try {
      const context = await getThreadRefreshContext(threadId);
      if (!context || context.articles.length < 2) continue;

      const next = await reevaluateThreadContext(context);
      if (!next) continue;

      await pool.query(`
        UPDATE story_threads
        SET title            = $1,
            description      = $2,
            primary_category = $3,
            geographic_scope = $4,
            importance       = GREATEST(importance, $5),
            keywords         = $6,
            last_updated_at  = NOW()
        WHERE id = $7
      `, [
        next.title || context.title,
        next.description || context.description,
        next.primary_category || context.primary_category || "politics",
        next.geographic_scope || context.geographic_scope || "global",
        next.importance || context.importance || 5,
        next.keywords?.length ? next.keywords : (context.keywords || []),
        threadId
      ]);

      refreshed++;
    } catch (err) {
      console.error(`   ⚠ Failed to refresh thread ${threadId}: ${err.message}`);
    }
  }

  return refreshed;
}

async function getThreadRefreshContext(threadId) {
  const { rows: threadRows } = await pool.query(`
    SELECT id, title, description, primary_category, geographic_scope, importance, keywords, article_count
    FROM story_threads
    WHERE id = $1
    LIMIT 1
  `, [threadId]);
  if (!threadRows.length) return null;

  const { rows: articleRows } = await pool.query(`
    SELECT
      a.id,
      a.title,
      a.summary,
      a.translated_summary,
      a.published_at,
      COALESCE(ns.name, ys.name) AS source_name,
      co.name AS country_name,
      ci.name AS city_name
    FROM story_thread_articles sta
    JOIN news_articles a ON a.id = sta.article_id
    LEFT JOIN news_sources ns    ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    LEFT JOIN countries co       ON co.id = a.country_id
    LEFT JOIN cities ci          ON ci.id = a.city_id
    WHERE sta.thread_id = $1
    ORDER BY a.published_at DESC
    LIMIT 6
  `, [threadId]);

  return { ...threadRows[0], articles: articleRows };
}

async function reevaluateThreadContext(thread) {
  const prompt = `You are refreshing the framing of an ongoing news story thread.

CURRENT THREAD:
${JSON.stringify({
  id: thread.id,
  title: thread.title,
  description: thread.description,
  primary_category: thread.primary_category,
  geographic_scope: thread.geographic_scope,
  importance: thread.importance,
  keywords: thread.keywords,
  article_count: thread.article_count
}, null, 2)}

MOST RECENT ARTICLES:
${JSON.stringify(thread.articles.map(a => ({
  id: a.id,
  title: a.title,
  summary: (a.translated_summary || a.summary || "").slice(0, 250),
  published_at: a.published_at,
  source: a.source_name || null,
  country: a.country_name || null,
  city: a.city_name || null
})), null, 2)}

Instructions:
- Keep this as the same ongoing thread, but refresh the framing to match the most recent developments
- Put more emphasis on the newest reporting than older context
- Return updated title, description, category, scope, importance, and 5-10 current keywords
- Use a concise title (max 8 words)

Return ONLY valid JSON:
{
  "title": "updated thread title",
  "description": "Two sentences describing the current state of the story and why it matters now.",
  "primary_category": "politics|economy|military|diplomacy|environment|technology|society|sports|culture",
  "geographic_scope": "global|regional|local",
  "importance": 7,
  "keywords": ["array", "of", "5-10", "current", "keywords"]
}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON object in Claude refresh response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── Maintenance ─────────────────────────────────────────────────────────────

async function coolDownInactiveThreads() {
  // Threads with no new articles in 5 days → cooling
  await pool.query(`
    UPDATE story_threads
    SET status = 'cooling'
    WHERE status = 'active'
      AND last_updated_at < NOW() - INTERVAL '5 days'
  `);
  // Threads cooling for 14 days → archived
  await pool.query(`
    UPDATE story_threads
    SET status = 'archived'
    WHERE status = 'cooling'
      AND last_updated_at < NOW() - INTERVAL '14 days'
  `);
}

// ─── DB Queries ───────────────────────────────────────────────────────────────

async function getUnthreadedArticles(hours) {
  // Step 1: keep the 48h window, but bias selection toward the freshest articles.
  // We still cap at 5 per source, then reserve the first tranche for the last 6h
  // before filling the rest from the older remainder of the 48h window.
  const { rows: baseRows } = await pool.query(`
    WITH ranked AS (
      SELECT
        a.id, a.title, a.summary, a.translated_summary,
        a.published_at,
        COALESCE(ns.name, ys.name) AS source_name,
        co.name AS country_name,
        ci.name AS city_name,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(a.source_id::text, a.youtube_source_id::text, 'unknown')
          ORDER BY a.published_at DESC
        ) AS source_rank
      FROM news_articles a
      LEFT JOIN countries co       ON co.id = a.country_id
      LEFT JOIN cities    ci       ON ci.id = a.city_id
      LEFT JOIN news_sources ns    ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE a.published_at > NOW() - INTERVAL '${hours} hours'
        AND a.published_at < NOW()
        AND a.title IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
        )
    ),
    fresh AS (
      SELECT id, title, summary, translated_summary, published_at, source_name, country_name, city_name
      FROM ranked
      WHERE source_rank <= 5
        AND published_at > NOW() - INTERVAL '${Math.min(hours, FRESH_PRIORITY_HOURS)} hours'
      ORDER BY published_at DESC, RANDOM()
      LIMIT ${FRESH_PRIORITY_LIMIT}
    ),
    backlog AS (
      SELECT id, title, summary, translated_summary, published_at, source_name, country_name, city_name
      FROM ranked
      WHERE source_rank <= 5
        AND published_at <= NOW() - INTERVAL '${Math.min(hours, FRESH_PRIORITY_HOURS)} hours'
      ORDER BY published_at DESC, RANDOM()
      LIMIT ${TOTAL_ARTICLE_LIMIT - FRESH_PRIORITY_LIMIT}
    )
    SELECT *
    FROM (
      SELECT * FROM fresh
      UNION ALL
      SELECT * FROM backlog
    ) sampled
    ORDER BY published_at DESC, RANDOM()
    LIMIT ${TOTAL_ARTICLE_LIMIT}
  `);

  if (!baseRows.length) return [];

  // Step 2: fetch keywords for just those article IDs
  const ids = baseRows.map(r => r.id);
  const { rows: kwRows } = await pool.query(`
    SELECT article_id, ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
    FROM article_keywords
    WHERE article_id = ANY($1::int[])
    GROUP BY article_id
  `, [ids]);

  const kwMap = new Map(kwRows.map(r => [r.article_id, r.keywords]));

  return baseRows
    .map(a => ({ ...a, keywords: kwMap.get(a.id) || [] }))
    .filter(a => a.keywords.length > 0);
}

async function getActiveThreads() {
  const { rows } = await pool.query(`
    SELECT id, title, description, keywords, primary_category, geographic_scope, importance, article_count
    FROM story_threads
    WHERE status = 'active'
      AND last_updated_at > NOW() - INTERVAL '30 days'
    ORDER BY importance DESC, last_updated_at DESC
    LIMIT 60
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
    .replace(/[“”"'`]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeKeywords(existingKeywords, incomingKeywords) {
  const merged = new Map();
  for (const keyword of [...(existingKeywords || []), ...(incomingKeywords || [])]) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized || merged.has(normalized)) continue;
    merged.set(normalized, String(keyword || "").trim());
  }
  return [...merged.values()];
}

function shouldRefreshThreadContext(thread, incomingKeywords) {
  if (!thread || (Number(thread.article_count) || 0) < REFRESH_MIN_ARTICLES) return false;

  const existing = new Set((thread.keywords || []).map(normalizeKeyword).filter(Boolean));
  const incomingNovelCount = new Set(
    (incomingKeywords || [])
      .map(normalizeKeyword)
      .filter(Boolean)
      .filter(keyword => !existing.has(keyword))
  ).size;

  return incomingNovelCount >= REFRESH_MIN_NEW_KWS;
}

function computeArticleRelevanceScore(importance, publishedAt) {
  const base = Math.max(0.1, Math.min(1, (Number(importance) || 5) / 10));
  if (!publishedAt) return Number(base.toFixed(4));

  const ageMs = Math.max(0, Date.now() - new Date(publishedAt).getTime());
  const ageHours = ageMs / (1000 * 60 * 60);
  const recencyFactor = Math.exp(-ageHours / RECENCY_HALF_LIFE_HOURS);
  return Number((base * recencyFactor).toFixed(4));
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
