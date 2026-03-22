/**
 * backfillStoryThreads.js
 *
 * One-time backfill — processes all historical articles into story threads.
 * Runs in weekly time-window batches, oldest-to-newest.
 * Fully resumable — tracks progress in story_thread_builder_state table.
 * Uses claude-haiku for cost efficiency (~$15 for 1M articles).
 *
 * Usage:
 *   node backfillStoryThreads.js              — resume from last checkpoint
 *   node backfillStoryThreads.js --reset      — restart from beginning
 *   node backfillStoryThreads.js --from=2024-01-01 — start from specific date
 */

require("dotenv").config();
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WINDOW_DAYS    = 7;    // process one week of articles at a time
const CLAUDE_BATCH   = 15;   // articles per Claude call
const INTER_CALL_MS  = 800;  // delay between Claude calls (rate limit)
const INTER_WINDOW_MS = 200; // delay between weekly windows
const MIN_SHARED_KW  = 2;
const MIN_CLUSTER    = 2;
const SKIP_KEYWORDS  = new Set([
  "government","minister","president","official","said","year","people",
  "new","first","last","will","also","one","two","three","could","would",
  "after","before","over","under","says","day","week","month","country",
  "world","international","national","local","news","report","according"
]);

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const fromArg = args.find(a => a.startsWith("--from="))?.split("=")[1];

  console.log("\n🧵 Story Thread Backfill");
  console.log("   Model: claude-haiku-3-5 (cost-optimised)");
  if (reset) { await clearState(); console.log("   State reset."); }

  // Get date range of articles
  const { rows: range } = await pool.query(`
    SELECT
      MIN(published_at) AS oldest,
      MAX(published_at) AS newest
    FROM news_articles
    WHERE published_at < NOW()
      AND published_at > '2000-01-01'
  `);
  const dbOldest = new Date(range[0].oldest);
  const dbNewest = new Date(range[0].newest);

  // Determine start date — default floor is 2026-01-01
  const FLOOR_DATE = new Date("2026-01-01");
  let startDate;
  if (fromArg) {
    startDate = new Date(fromArg);
  } else {
    const checkpoint = await getState("last_window_end");
    startDate = checkpoint ? new Date(checkpoint) : FLOOR_DATE;
  }
  // Never go earlier than the floor
  if (startDate < FLOOR_DATE) startDate = FLOOR_DATE;

  console.log(`   DB range:  ${fmt(dbOldest)} → ${fmt(dbNewest)}`);
  console.log(`   Starting:  ${fmt(startDate)}`);
  console.log(`   Remaining: ~${Math.ceil((dbNewest - startDate) / (1000*60*60*24))} days\n`);

  let windowStart = new Date(startDate);
  let totalCreated = 0, totalUpdated = 0, windowCount = 0;

  while (windowStart < dbNewest) {
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS);
    const cappedEnd = windowEnd > dbNewest ? dbNewest : windowEnd;

    const articles = await getArticlesInWindow(windowStart, cappedEnd);
    windowCount++;

    if (articles.length) {
      process.stdout.write(`📅 ${fmt(windowStart)} → ${fmt(cappedEnd)}  [${articles.length} articles] ... `);
      const { created, updated } = await processWindow(articles);
      totalCreated += created;
      totalUpdated += updated;
      console.log(`${created} new threads, ${updated} updated`);
    } else {
      console.log(`📅 ${fmt(windowStart)} → ${fmt(cappedEnd)}  [empty]`);
    }

    await saveState("last_window_end", cappedEnd.toISOString());
    windowStart = windowEnd;
    await sleep(INTER_WINDOW_MS);
  }

  // Cool down + archive old threads
  await pool.query(`UPDATE story_threads SET status='cooling'  WHERE status='active'  AND last_updated_at < NOW()-INTERVAL '5 days'`);
  await pool.query(`UPDATE story_threads SET status='archived' WHERE status='cooling' AND last_updated_at < NOW()-INTERVAL '14 days'`);

  console.log(`\n✅ Backfill complete.`);
  console.log(`   Windows processed: ${windowCount}`);
  console.log(`   Threads created:   ${totalCreated}`);
  console.log(`   Threads updated:   ${totalUpdated}\n`);
  await pool.end();
}

// ─── Window Processing ────────────────────────────────────────────────────────

async function processWindow(articles) {
  const clusters   = sqlCluster(articles);
  const clustered  = new Set(clusters.flat().map(a => a.id));
  const singletons = articles.filter(a => !clustered.has(a.id));

  const allGroups  = [...clusters, ...chunkArray(singletons, 20)];
  let created = 0, updated = 0;

  // Load active threads once per window for context
  const existingThreads = await getActiveThreads();

  for (let i = 0; i < allGroups.length; i++) {
    const group = allGroups[i].slice(0, CLAUDE_BATCH);
    if (!group.length) continue;

    try {
      const defs = await evaluateWithClaude(group, existingThreads, "haiku");
      const { c, u } = await persistThreadDefs(defs);
      created += c;
      updated += u;

      // Add new threads to local context so later batches can extend them
      for (const def of defs) {
        if (!def.existing_thread_id && def.title) {
          existingThreads.push({
            id: null, // will be filled after persist — good enough for keyword context
            title: def.title,
            keywords: def.keywords || [],
            primary_category: def.primary_category
          });
        }
      }
    } catch (err) {
      console.error(`\n   ⚠ Batch error: ${err.message}`);
    }

    await sleep(INTER_CALL_MS);
  }

  return { created, updated };
}

// ─── SQL Pre-Clustering ───────────────────────────────────────────────────────

function sqlCluster(articles) {
  const kwIndex = new Map();
  for (const a of articles) {
    for (const kw of (a.keywords || [])) {
      const k = kw.toLowerCase().trim();
      if (k.length < 4 || SKIP_KEYWORDS.has(k)) continue;
      if (!kwIndex.has(k)) kwIndex.set(k, []);
      kwIndex.get(k).push(a);
    }
  }

  const pairScore = new Map();
  for (const [, arts] of kwIndex) {
    if (arts.length < 2 || arts.length > 80) continue;
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        const key = `${Math.min(arts[i].id, arts[j].id)}:${Math.max(arts[i].id, arts[j].id)}`;
        pairScore.set(key, (pairScore.get(key) || 0) + 1);
      }
    }
  }

  const parent = new Map(articles.map(a => [a.id, a.id]));
  const find = x => { if (parent.get(x) !== x) parent.set(x, find(parent.get(x))); return parent.get(x); };
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

// ─── Claude Evaluation ────────────────────────────────────────────────────────

async function evaluateWithClaude(articles, existingThreads, tier = "sonnet") {
  const model = tier === "haiku"
    ? "claude-haiku-4-5"
    : "claude-sonnet-4-5";

  const articleData = articles.map(a => ({
    id:       a.id,
    title:    a.title,
    summary:  (a.summary || a.translated_summary || "").slice(0, 200),
    keywords: (a.keywords || []).slice(0, 10),
    country:  a.country_name || null,
    source:   a.source_name  || null,
    date:     a.published_at
  }));

  const existingData = existingThreads.slice(0, 25).map(t => ({
    id:       t.id,
    title:    t.title,
    keywords: (t.keywords || []).slice(0, 8),
    category: t.primary_category
  }));

  const prompt = `You are a news editor building a story thread database. Group these articles into ongoing story threads.

EXISTING THREADS (extend these if articles match):
${JSON.stringify(existingData, null, 2)}

ARTICLES:
${JSON.stringify(articleData, null, 2)}

Rules:
- Group articles about the same developing story, even if they use different keywords
- Detect semantic connections (e.g. "inflation" + "Fed rate hike" + "CPI data" = one economic story)
- Prefer extending existing threads over creating duplicates
- Single-article threads are OK for significant standalone stories
- Importance: 1-10 (10=major global event)

Return ONLY valid JSON array:
[{
  "existing_thread_id": null,
  "title": "Short thread title",
  "description": "Two sentences about the ongoing story.",
  "article_ids": [1, 2, 3],
  "anchor_article_id": 1,
  "primary_category": "politics|economy|military|diplomacy|environment|technology|society|sports|culture",
  "geographic_scope": "global|regional|local",
  "importance": 5,
  "keywords": ["key", "words"]
}]`;

  const response = await client.messages.create({
    model,
    max_tokens: 8096,
    messages:   [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("No JSON in response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Persist ─────────────────────────────────────────────────────────────────

async function persistThreadDefs(defs) {
  let created = 0, updated = 0;

  for (const def of defs) {
    if (!def.article_ids?.length) continue;
    try {
      if (def.existing_thread_id) {
        await pool.query(`
          UPDATE story_threads
          SET last_updated_at = NOW(),
              importance      = GREATEST(importance, $1),
              article_count   = article_count + $2,
              keywords        = ARRAY(SELECT DISTINCT unnest(keywords || $3::text[]))
          WHERE id = $4
        `, [def.importance || 5, def.article_ids.length, def.keywords || [], def.existing_thread_id]);

        await insertArticles(def.existing_thread_id, def.article_ids, def.anchor_article_id, def.importance);
        updated++;
      } else {
        const { rows } = await pool.query(`
          INSERT INTO story_threads
            (title, description, primary_category, geographic_scope, importance, keywords, article_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
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

        await insertArticles(rows[0].id, def.article_ids, def.anchor_article_id, def.importance);
        created++;
      }
    } catch (err) {
      console.error(`\n   ⚠ persist error: ${err.message}`);
    }
  }

  return { c: created, u: updated };
}

async function insertArticles(threadId, articleIds, anchorId, importance) {
  const score = (importance || 5) / 10;
  for (const articleId of articleIds) {
    await pool.query(`
      INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [threadId, articleId, score, articleId === anchorId]);
  }
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────

async function getArticlesInWindow(start, end) {
  const { rows } = await pool.query(`
    SELECT
      a.id, a.title, a.summary, a.translated_summary,
      a.published_at, COALESCE(ns.name, ys.name) AS source_name,
      co.name AS country_name,
      ARRAY_AGG(ak.keyword ORDER BY ak.frequency DESC) FILTER (WHERE ak.keyword IS NOT NULL) AS keywords
    FROM news_articles a
    LEFT JOIN countries co ON co.id = a.country_id
    LEFT JOIN news_sources ns ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    LEFT JOIN article_keywords ak ON ak.article_id = a.id
    LEFT JOIN story_thread_articles sta ON sta.article_id = a.id
    WHERE a.published_at >= $1
      AND a.published_at <  $2
      AND sta.article_id IS NULL
      AND a.title IS NOT NULL
    GROUP BY a.id, a.title, a.summary, a.translated_summary,
             a.published_at, ns.name, ys.name, co.name
    HAVING COUNT(ak.keyword) > 0
    ORDER BY a.published_at ASC
    LIMIT 2000
  `, [start.toISOString(), end.toISOString()]);
  return rows;
}

async function getActiveThreads() {
  const { rows } = await pool.query(`
    SELECT id, title, keywords, primary_category, importance
    FROM story_threads
    WHERE status IN ('active', 'cooling')
    ORDER BY importance DESC, last_updated_at DESC
    LIMIT 50
  `);
  return rows;
}

async function getState(key) {
  const { rows } = await pool.query(
    `SELECT value FROM story_thread_builder_state WHERE key = $1`, [key]
  );
  return rows[0]?.value || null;
}

async function saveState(key, value) {
  await pool.query(`
    INSERT INTO story_thread_builder_state (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
  `, [key, value]);
}

async function clearState() {
  await pool.query(`DELETE FROM story_thread_builder_state WHERE key = 'last_window_end'`);
}

// ─── Utils ───────────────────────────────────────────────────────────────────

const sleep   = ms => new Promise(r => setTimeout(r, ms));
const fmt     = d  => new Date(d).toISOString().slice(0, 10);
const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
