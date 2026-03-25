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

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOOKBACK_HOURS  = parseInt(process.argv.find(a => a.startsWith("--hours="))?.split("=")[1] || "48");
const ARTICLE_LIMIT   = 3000;  // max articles to pull per run
const CLAUDE_BATCH    = 30;    // articles per Claude call
const MIN_CLUSTER     = 2;     // min articles to form a cluster
const MIN_SHARED_KW   = 2;     // min shared keywords to link two articles
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
  console.log(`   Lookback: ${LOOKBACK_HOURS}h | Article limit: ${ARTICLE_LIMIT}`);

  console.log(`   [${elapsed()}] Normalizing new non-English keywords...`);
  await normalizeNewKeywords(LOOKBACK_HOURS);
  console.log(`   [${elapsed()}] Keyword normalization done`);

  console.log(`   [${elapsed()}] Querying unthreaded articles...`);
  const articles = await getUnthreadedArticles(LOOKBACK_HOURS, ARTICLE_LIMIT);
  console.log(`   [${elapsed()}] Found ${articles.length} unthreaded articles`);
  if (!articles.length) { console.log("   Nothing to thread. Done."); await pool.end(); return; }

  console.log(`   [${elapsed()}] Running SQL keyword clustering...`);
  const clusters   = sqlCluster(articles);
  const assigned   = new Set(clusters.flat().map(a => a.id));
  const singletons = articles.filter(a => !assigned.has(a.id));
  console.log(`   [${elapsed()}] Clusters: ${clusters.length} | Singletons: ${singletons.length}`);

  console.log(`   [${elapsed()}] Loading existing active threads...`);
  const existingThreads = await getActiveThreads();
  console.log(`   [${elapsed()}] Active threads in DB: ${existingThreads.length}`);

  let created = 0, updated = 0;
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
      const defs = await evaluateWithClaude(batch, existingThreads);
      const { c, u } = await persistThreadDefs(defs, validIdSet);
      created += c; updated += u;
      console.log(`✓ ${defs.length} threads (${c} new, ${u} updated)`);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
    }

    await sleep(1500);
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
      const k = kw.toLowerCase().trim();
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
    summary:      (a.summary || a.translated_summary || "").slice(0, 250),
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
    model:      "claude-sonnet-4-5",
    max_tokens: 4096,
    messages:   [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON array in Claude response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── Persist ─────────────────────────────────────────────────────────────────

async function persistThreadDefs(defs, validIdSet) {
  let created = 0, updated = 0;

  for (const def of defs) {
    if (!def.article_ids?.length) continue;

    try {
      if (def.existing_thread_id) {
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
        `, [def.importance, def.article_ids.length, def.keywords || [], def.existing_thread_id]);

        await insertArticles(def.existing_thread_id, def.article_ids, def.anchor_article_id, def.importance, validIdSet);
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
        created++;
      }
    } catch (err) {
      console.error(`   ⚠ Failed to persist thread "${def.title}": ${err.message}`);
    }
  }

  return { c: created, u: updated };
}

async function insertArticles(threadId, articleIds, anchorId, importance, validIdSet) {
  const score = (importance || 5) / 10;
  for (const articleId of articleIds) {
    if (validIdSet && !validIdSet.has(Number(articleId))) continue;
    await pool.query(`
      INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [threadId, articleId, score, articleId === anchorId]);
  }
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

// ─── Keyword Normalization (inline, new keywords only) ────────────────────────
// Uses Claude Haiku in batches of 60 — no DeepL dependency.
// Haiku handles all non-Latin scripts (Arabic, Cyrillic, CJK, Devanagari, etc.)
// and resolves proper nouns to standard English forms (Пекин → beijing).

function isNonLatin(text) {
  return /[\u0600-\u06FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF\u0900-\u097F\u0E00-\u0E7F\u0370-\u03FF]/.test(text);
}

const NORMALIZE_BATCH = 60;

async function normalizeNewKeywords(hours) {
  const { rows } = await pool.query(`
    SELECT DISTINCT ak.keyword
    FROM article_keywords ak
    JOIN news_articles a ON a.id = ak.article_id
    WHERE a.published_at > NOW() - INTERVAL '${hours} hours'
      AND ak.normalized_keyword IS NULL
      AND ak.keyword IS NOT NULL
  `);

  const toNormalize = rows.map(r => r.keyword).filter(isNonLatin);
  if (!toNormalize.length) return;

  let done = 0;

  for (let i = 0; i < toNormalize.length; i += NORMALIZE_BATCH) {
    const batch = toNormalize.slice(i, i + NORMALIZE_BATCH);
    try {
      const msg = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: `Translate these news keywords/phrases to standard English equivalents for keyword indexing.
Return ONLY a valid JSON object: each key is the original keyword, each value is the lowercase English equivalent string, or null if untranslatable/too ambiguous.
Use standard English proper nouns (e.g. "Пекин"→"beijing", "北京"→"beijing", "موسكو"→"moscow", "한국"→"south korea").
Single characters or meaningless fragments → null.

Keywords: ${JSON.stringify(batch)}

JSON only:`
        }]
      });

      let map;
      try { map = JSON.parse(msg.content[0].text.trim()); }
      catch { continue; }

      const entries = Object.entries(map).filter(([, v]) => v && typeof v === "string");
      if (!entries.length) continue;

      // Bulk insert into keyword_translations
      const tVals   = entries.map((_, j) => `($${j*2+1},$${j*2+2})`).join(",");
      const tParams = entries.flatMap(([orig, norm]) => [orig, norm.toLowerCase().trim()]);
      await pool.query(
        `INSERT INTO keyword_translations (original_keyword, normalized_keyword)
         VALUES ${tVals} ON CONFLICT (original_keyword) DO NOTHING`,
        tParams
      );

      // Bulk update article_keywords
      for (const [orig, norm] of entries) {
        await pool.query(
          `UPDATE article_keywords SET normalized_keyword = $1
           WHERE keyword = $2 AND normalized_keyword IS NULL`,
          [norm.toLowerCase().trim(), orig]
        );
        done++;
      }
    } catch (err) {
      console.warn(`  ⚠️  Keyword normalization batch failed: ${err.message}`);
    }
  }

  if (done) process.stdout.write(`(${done} keywords normalized via Claude Haiku) `);
}

// ─── DB Queries ───────────────────────────────────────────────────────────────

async function getUnthreadedArticles(hours, limit) {
  // Step 1: get article IDs quickly using indexed columns only
  const { rows: baseRows } = await pool.query(`
    SELECT
      a.id, a.title, a.summary, a.translated_summary,
      a.published_at,
      COALESCE(ns.name, ys.name) AS source_name,
      co.name AS country_name,
      ci.name AS city_name
    FROM news_articles a
    LEFT JOIN countries co      ON co.id = a.country_id
    LEFT JOIN cities    ci      ON ci.id = a.city_id
    LEFT JOIN news_sources ns   ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    WHERE a.published_at > NOW() - INTERVAL '${hours} hours'
      AND a.published_at < NOW()
      AND a.title IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
      )
    ORDER BY a.score DESC NULLS LAST, a.published_at DESC
    LIMIT $1
  `, [limit]);

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
    SELECT id, title, keywords, primary_category, importance
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

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
