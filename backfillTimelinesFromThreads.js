// backfillTimelinesFromThreads.js
//
// One-shot audit that merges existing story_threads into broad umbrella
// story_timelines. This seeds the Timelines view with the long-running
// narratives we already have rich thread data for — Iran war, Russia/
// Ukraine, Venezuela/US pressure, Israel/Lebanon, etc. — instead of
// waiting for the scheduled storyTimelineBuilder to rediscover them
// from the 7-day article window.
//
// Flow:
//   1. Pull every active + cooling thread with importance ≥ 5, article_count ≥ 3
//   2. Batch them to Claude Haiku; ask for umbrella groupings with stable slugs
//   3. For each umbrella: upsert story_timelines row by scope, then copy all
//      member articles from story_thread_articles → story_timeline_articles
//      with parabolic_weight computed from age
//   4. Recompute timeline aggregates (article_count, distinct_source_count,
//      parabolic_weight_sum) from the junction table
//
// Safe to re-run: umbrella scope is the merge key, article inserts use
// ON CONFLICT DO NOTHING. Threads that don't fit any big umbrella are
// left untouched — no forced clustering.

const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-haiku-4-5";

// ── Config ─────────────────────────────────────────────────────
const BATCH_SIZE       = 35;            // threads per Claude call
const MIN_IMPORTANCE   = 5;
const MIN_ARTICLES     = 2;
const MIN_CLUSTER_SIZE = 1;             // allow single-thread umbrellas for
                                        // distinct ongoing narratives (e.g.
                                        // Venezuela/Maduro, Myanmar civil war)
const PARABOLIC_PEAK_H = 24;

// Parabolic weighting identical to storyTimelineBuilder so the seeded
// timelines mesh cleanly with the scheduled builder's subsequent runs.
function parabolicWeight(ageHours) {
  const h = Math.max(0, ageHours);
  const logistic = 1 / (1 + Math.exp(0.045 * (h - PARABOLIC_PEAK_H)));
  const gaussian = Math.exp(-Math.pow(h - PARABOLIC_PEAK_H, 2) / 1800);
  return Math.max(0.05, logistic * (1 + 0.4 * gaussian));
}

// ── Fetch source threads ───────────────────────────────────────
async function fetchCandidateThreads() {
  const { rows } = await pool.query(`
    SELECT
      t.id, t.title, t.description, t.keywords,
      t.primary_category, t.geographic_scope, t.importance,
      t.article_count, t.status,
      t.first_seen_at, t.last_updated_at
    FROM story_threads t
    WHERE t.status IN ('active','cooling')
      AND COALESCE(t.importance, 0) >= $1
      AND COALESCE(t.article_count, 0) >= $2
    ORDER BY
      CASE t.status WHEN 'active' THEN 0 ELSE 1 END,
      t.importance DESC NULLS LAST,
      t.article_count DESC
  `, [MIN_IMPORTANCE, MIN_ARTICLES]);
  return rows;
}

// ── Prompt Claude for umbrella groupings ───────────────────────
function buildPrompt(batch, knownUmbrellas = []) {
  const list = batch.map((t, i) => {
    const kws = Array.isArray(t.keywords) ? t.keywords.slice(0, 6).join(", ") : "";
    return `[${t.id}] ${t.title}
  cat: ${t.primary_category || "?"} | scope: ${t.geographic_scope || "?"} | arts: ${t.article_count} | imp: ${t.importance}
  kws: ${kws}
  desc: ${(t.description || "").slice(0, 200)}`;
  }).join("\n\n");

  const knownBlock = knownUmbrellas.length
    ? `
KNOWN UMBRELLAS (created in earlier batches — RE-USE these scope slugs exactly when a thread fits one):
${knownUmbrellas.map(u => `  • ${u.scope} — ${u.title}`).join("\n")}
`
    : "";

  return `You are auditing a corpus of news "story threads" and merging them into broad UMBRELLA TIMELINES — the long-running, durable narratives that span weeks or months.

A good umbrella is a macro-story that would remain legible as a coherent arc for weeks: "Iran–Israel war 2025", "Russia–Ukraine war", "Venezuela crisis and US pressure", "Israel–Lebanon conflict", "Gaza ceasefire aftermath", "Trump second-term foreign policy shift", "Sudan civil war". Umbrellas should be BROAD — it's correct to fold 15 threads about different Iran war developments (Hormuz, strikes, ceasefire talks, journalist prosecution, oil markets) into ONE umbrella.

STRICT RULES — THIS IS CRITICAL:
  1. Only emit an umbrella if it represents a DURABLE, multi-week story arc. Single-event news items, daily market moves, isolated crimes, one-off corporate announcements, local elections → DO NOT emit. Leave them out entirely.
  2. Prefer FEW, BIG umbrellas over many small ones. If in doubt, leave it out.
  3. If a thread fits an umbrella listed in KNOWN UMBRELLAS below, RE-USE that exact scope slug — do NOT invent a variation.
  4. Year-anchor only when the event started in a specific year (e.g. "iran_israel_war_2025"). Otherwise no dates in the slug.
${knownBlock}
For each umbrella return:
  - scope: stable lowercase slug, underscores, e.g. "iran_israel_war_2025", "russia_ukraine_war", "venezuela_us_pressure_2026", "myanmar_civil_war"
  - title: 4–9 word narrative headline
  - description: 1–2 sentence summary of the umbrella arc
  - primary_category: one of politics, conflict, economy, climate, tech, health, culture, sports, disaster, other
  - geographic_scope: one of global, regional, national, local
  - importance: 1–10 integer (10 for active wars / existential crises)
  - thread_ids: array of integers — every input thread that belongs to this umbrella

Respond with ONLY valid JSON of this exact shape, no prose, no markdown:
{"umbrellas":[{"scope":"...","title":"...","description":"...","primary_category":"...","geographic_scope":"...","importance":0,"thread_ids":[0,0]}]}

THREADS:
${list}`;
}

async function classifyBatch(batch, batchNum, totalBatches, knownUmbrellas = []) {
  process.stdout.write(`   Batch ${batchNum}/${totalBatches} (${batch.length} threads, ${knownUmbrellas.length} known) → Claude... `);
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: buildPrompt(batch, knownUmbrellas) }]
    });
    const text = resp.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");
    const parsed = JSON.parse(match[0]);
    const umbrellas = Array.isArray(parsed.umbrellas) ? parsed.umbrellas : [];
    process.stdout.write(`✓ ${umbrellas.length} umbrellas\n`);
    return umbrellas;
  } catch (err) {
    process.stdout.write(`✗ ERROR: ${err.message}\n`);
    return [];
  }
}

// ── Merge umbrellas coming from different batches ─────────────
// Different batches may produce overlapping umbrellas (e.g. "iran_israel_war_2025"
// twice with different thread subsets). Merge by scope slug, union thread_ids,
// and keep the richest metadata.
function mergeUmbrellas(all) {
  const map = new Map();
  for (const u of all) {
    if (!u || !u.scope || !Array.isArray(u.thread_ids) || u.thread_ids.length === 0) continue;
    const key = u.scope.trim().toLowerCase();
    const existing = map.get(key);
    if (existing) {
      const union = new Set([...existing.thread_ids, ...u.thread_ids]);
      existing.thread_ids = [...union];
      existing.importance = Math.max(existing.importance || 0, u.importance || 0);
      // Prefer the longer description
      if ((u.description || "").length > (existing.description || "").length) {
        existing.description = u.description;
      }
    } else {
      map.set(key, {
        scope: key,
        title: u.title || key,
        description: u.description || "",
        primary_category: u.primary_category || "other",
        geographic_scope: u.geographic_scope || "global",
        importance: u.importance || 5,
        thread_ids: [...new Set(u.thread_ids)]
      });
    }
  }
  return [...map.values()].filter(u => u.thread_ids.length >= MIN_CLUSTER_SIZE);
}

// ── Final semantic dedup pass ──────────────────────────────────
// Claude produces synonymous scope slugs across batches (e.g.
// "nepal_political_turmoil" + "nepal_political_crisis"). This pass
// sends the full umbrella list to Claude and asks it to output a
// canonical merge map: { "duplicate_slug": "canonical_slug" }.
async function semanticDedup(umbrellas) {
  if (umbrellas.length < 2) return umbrellas;
  process.stdout.write(`   [semantic-dedup] Sending ${umbrellas.length} umbrellas to Claude for merge analysis... `);

  const listing = umbrellas
    .map(u => `  ${u.scope} (${u.thread_ids.length} threads) — ${u.title}`)
    .join("\n");

  const prompt = `Here is a list of UMBRELLA TIMELINE scope slugs. Some are semantic duplicates (e.g. "nepal_political_turmoil" and "nepal_political_crisis" are the same story). Your job: produce a merge map that collapses duplicates into a single canonical slug.

Rules:
  - Only merge slugs that are genuinely the same macro-narrative. Do NOT merge distinct stories that happen to share a country or category.
  - For each merge group, pick the BEST canonical slug (clearest, most stable).
  - The canonical slug MUST be one of the input slugs (don't invent new ones).
  - Do NOT include non-merged slugs in the map.

Respond with ONLY JSON of this exact shape, no prose:
{"merges":[{"canonical":"iran_us_conflict_2026","duplicates":["iran_israel_war_2025","trump_iran_ceasefire_collapse"]}]}

UMBRELLAS:
${listing}`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    });
    const text = resp.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON");
    const parsed = JSON.parse(match[0]);
    const merges = Array.isArray(parsed.merges) ? parsed.merges : [];
    process.stdout.write(`✓ ${merges.length} merge groups\n`);

    // Build remap: duplicate → canonical
    const remap = new Map();
    for (const m of merges) {
      if (!m.canonical || !Array.isArray(m.duplicates)) continue;
      for (const d of m.duplicates) {
        if (d !== m.canonical) remap.set(d, m.canonical);
      }
    }
    if (remap.size === 0) return umbrellas;

    // Apply remap: merge thread_ids of each duplicate into its canonical
    const byScope = new Map(umbrellas.map(u => [u.scope, u]));
    for (const [dup, canonical] of remap.entries()) {
      const dupU  = byScope.get(dup);
      const canU  = byScope.get(canonical);
      if (!dupU || !canU) continue;
      const union = new Set([...canU.thread_ids, ...dupU.thread_ids]);
      canU.thread_ids = [...union];
      canU.importance = Math.max(canU.importance || 0, dupU.importance || 0);
      if ((dupU.description || "").length > (canU.description || "").length) {
        canU.description = dupU.description;
      }
      byScope.delete(dup);
      console.log(`     ↳ merged ${dup} → ${canonical}`);
    }
    return [...byScope.values()];
  } catch (err) {
    process.stdout.write(`✗ ${err.message} (keeping as-is)\n`);
    return umbrellas;
  }
}

// ── Persist one umbrella ───────────────────────────────────────
async function persistUmbrella(u) {
  // 1. Pull all article IDs + keywords from the umbrella's member threads
  const { rows: memberArticles } = await pool.query(`
    SELECT DISTINCT
      sta.article_id,
      a.published_at,
      a.source_id,
      a.youtube_source_id
    FROM story_thread_articles sta
    JOIN news_articles a ON a.id = sta.article_id
    WHERE sta.thread_id = ANY($1::int[])
      AND a.published_at IS NOT NULL
  `, [u.thread_ids]);

  if (memberArticles.length === 0) {
    return { scope: u.scope, action: "skip-no-articles", articles: 0 };
  }

  // Aggregate keywords from the constituent threads
  const { rows: kwRows } = await pool.query(`
    SELECT keywords FROM story_threads WHERE id = ANY($1::int[])
  `, [u.thread_ids]);
  const kwCounts = new Map();
  for (const r of kwRows) {
    if (!Array.isArray(r.keywords)) continue;
    for (const kw of r.keywords) {
      if (!kw) continue;
      const k = String(kw).trim();
      kwCounts.set(k, (kwCounts.get(k) || 0) + 1);
    }
  }
  const topKws = [...kwCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k]) => k);

  // 2. Upsert the timeline row by scope
  const { rows: tlRows } = await pool.query(`
    INSERT INTO story_timelines (
      scope, title, description, primary_category, geographic_scope,
      importance, keywords, status, lookback_days, parabolic_peak_hours,
      first_seen_at, last_updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 7, $8, NOW(), NOW())
    ON CONFLICT (scope) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      primary_category = EXCLUDED.primary_category,
      geographic_scope = EXCLUDED.geographic_scope,
      importance = GREATEST(story_timelines.importance, EXCLUDED.importance),
      keywords = EXCLUDED.keywords,
      status = 'active',
      last_updated_at = NOW()
    RETURNING id, (xmax = 0) AS created
  `, [
    u.scope, u.title, u.description, u.primary_category,
    u.geographic_scope, u.importance, topKws, PARABOLIC_PEAK_H
  ]);
  const timelineId = tlRows[0].id;
  const created    = tlRows[0].created;

  // 3. Insert all member articles with parabolic weights
  const now = Date.now();
  const values = [];
  const params = [];
  let p = 1;
  for (const a of memberArticles) {
    const ageH = Math.max(0, (now - new Date(a.published_at).getTime()) / 3600000);
    const w = parabolicWeight(ageH);
    values.push(`($${p++}, $${p++}, $${p++}, $${p++}, false)`);
    params.push(timelineId, a.article_id, w, w);
  }
  // Chunk inserts so we don't blow past the 65k-parameter Postgres limit
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK);
    const sliceParams = params.slice(i * 4, (i + CHUNK) * 4);
    // Re-number params for the slice
    let q = 1;
    const renumbered = slice.map(() => `($${q++}, $${q++}, $${q++}, $${q++}, false)`);
    const r = await pool.query(`
      INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor)
      VALUES ${renumbered.join(", ")}
      ON CONFLICT (timeline_id, article_id) DO NOTHING
    `, sliceParams);
    inserted += r.rowCount || 0;
  }

  // 4. Recompute aggregates from the junction
  await pool.query(`
    UPDATE story_timelines t SET
      article_count = sub.cnt,
      distinct_source_count = sub.dsc,
      parabolic_weight_sum = sub.wsum,
      last_updated_at = NOW()
    FROM (
      SELECT
        sta.timeline_id,
        COUNT(*)::int AS cnt,
        COUNT(DISTINCT COALESCE(a.source_id::text, 'yt:' || a.youtube_source_id::text))::int AS dsc,
        COALESCE(SUM(sta.parabolic_weight), 0)::float AS wsum
      FROM story_timeline_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      WHERE sta.timeline_id = $1
      GROUP BY sta.timeline_id
    ) sub
    WHERE t.id = sub.timeline_id
  `, [timelineId]);

  return {
    scope: u.scope,
    action: created ? "created" : "updated",
    timelineId,
    threads: u.thread_ids.length,
    articles: memberArticles.length,
    inserted
  };
}

// ── Country-level sweep ───────────────────────────────────────
// Some countries are fragile/unstable enough that we want a SINGLE
// country-wide timeline covering every conflict they're engaged in plus
// notable domestic turmoil, rather than fragmenting into many small
// scope-specific umbrellas. This sweep runs after the main Claude
// pass and force-merges all matching threads into one canonical row.
const COUNTRY_UMBRELLAS = [
  {
    scope: "sudan_crisis",
    title: "Sudan Civil War and National Crisis",
    description: "Ongoing Sudanese civil war, regional spillover, and domestic political, humanitarian, and economic crises.",
    primary_category: "conflict",
    geographic_scope: "national",
    importance: 9,
    match: ["sudan", "khartoum", "rsf", "darfur"]
  },
  {
    scope: "myanmar_crisis",
    title: "Myanmar Civil War and Junta Rule",
    description: "Myanmar's military junta, the ongoing civil war against resistance forces, cross-border incidents, and domestic humanitarian crises.",
    primary_category: "conflict",
    geographic_scope: "national",
    importance: 8,
    match: ["myanmar", "burma", "tatmadaw", "knu", "junta"]
  },
  {
    scope: "venezuela_crisis",
    title: "Venezuela Crisis and US Confrontation",
    description: "Venezuela's Maduro regime, confrontation with the US, sanctions, domestic political and economic turmoil, and diaspora impact.",
    primary_category: "politics",
    geographic_scope: "national",
    importance: 8,
    match: ["venezuela", "maduro", "caracas", "pdvsa"]
  }
];

async function runCountrySweep(t0) {
  console.log(`\n   [+${((Date.now()-t0)/1000).toFixed(1)}s] Country sweep (sudan, myanmar, venezuela)...`);

  // First, drop any main-pass timelines whose scope contains a country
  // keyword but is NOT the canonical country scope. This prevents the
  // previous "us_venezuela_political_crisis" and "myanmar_civil_war"
  // rows from coexisting alongside the new canonical country umbrellas.
  const allMatchWords = COUNTRY_UMBRELLAS.flatMap(cu => cu.match);
  const canonicalScopes = COUNTRY_UMBRELLAS.map(cu => cu.scope);
  const matchConds = allMatchWords.map((_, i) => `scope ILIKE $${i + 1}`).join(" OR ");
  const delRes = await pool.query(`
    DELETE FROM story_timelines
    WHERE (${matchConds})
      AND scope NOT IN (${canonicalScopes.map((_, i) => `$${allMatchWords.length + i + 1}`).join(",")})
    RETURNING scope
  `, [...allMatchWords.map(w => `%${w}%`), ...canonicalScopes]);
  if (delRes.rowCount > 0) {
    console.log(`     dropped ${delRes.rowCount} non-canonical country timelines: ${delRes.rows.map(r => r.scope).join(", ")}`);
  }

  for (const cu of COUNTRY_UMBRELLAS) {
    // Find every active/cooling thread that matches this country
    const patterns = cu.match.map(w => `%${w}%`);
    const { rows: threads } = await pool.query(`
      SELECT DISTINCT t.id, t.title, t.article_count
      FROM story_threads t
      WHERE t.status IN ('active','cooling')
        AND (
          ${patterns.map((_, i) => `LOWER(t.title) LIKE $${i + 1}`).join(" OR ")}
          OR EXISTS (
            SELECT 1 FROM unnest(t.keywords) AS kw
            WHERE ${cu.match.map((_, i) => `LOWER(kw) LIKE $${patterns.length + i + 1}`).join(" OR ")}
          )
        )
    `, [...patterns, ...patterns]);

    if (threads.length === 0) {
      console.log(`     ${cu.scope}: no matching threads, skipped`);
      continue;
    }
    const threadIds = threads.map(t => t.id);

    // Persist using the same umbrella persistence path
    const r = await persistUmbrella({
      scope: cu.scope,
      title: cu.title,
      description: cu.description,
      primary_category: cu.primary_category,
      geographic_scope: cu.geographic_scope,
      importance: cu.importance,
      thread_ids: threadIds
    });
    console.log(`     ${r.action.padEnd(8)} ${r.scope} — ${threads.length} threads, ${r.articles || 0} articles${r.timelineId ? ` → timeline #${r.timelineId}` : ""}`);
  }
}

// ── Main ───────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  console.log(`📚 Timeline Backfill Audit — ${new Date().toISOString()}`);
  console.log(`   min_importance=${MIN_IMPORTANCE} min_articles=${MIN_ARTICLES} batch=${BATCH_SIZE}\n`);

  const threads = await fetchCandidateThreads();
  console.log(`   [+${((Date.now()-t0)/1000).toFixed(1)}s] Candidate threads: ${threads.length}`);
  if (threads.length === 0) { console.log("No candidates. Done."); process.exit(0); }

  // Split into batches
  const batches = [];
  for (let i = 0; i < threads.length; i += BATCH_SIZE) batches.push(threads.slice(i, i + BATCH_SIZE));
  console.log(`   [+${((Date.now()-t0)/1000).toFixed(1)}s] Sending ${batches.length} batch(es) to Claude...\n`);

  const allUmbrellas = [];
  for (let i = 0; i < batches.length; i++) {
    // Pass the running known-umbrella set so Claude re-uses existing scope
    // slugs instead of inventing synonymous ones in later batches.
    const runningKnown = mergeUmbrellas(allUmbrellas).map(u => ({
      scope: u.scope, title: u.title
    }));
    const us = await classifyBatch(batches[i], i + 1, batches.length, runningKnown);
    allUmbrellas.push(...us);
  }

  let merged = mergeUmbrellas(allUmbrellas);
  console.log(`\n   [+${((Date.now()-t0)/1000).toFixed(1)}s] Pre-dedup umbrellas: ${merged.length}`);

  // Final semantic dedup pass: feed all umbrella slugs+titles to Claude and
  // ask it to collapse semantic duplicates (e.g. `nepal_political_turmoil` +
  // `nepal_political_crisis` → one canonical scope).
  merged = await semanticDedup(merged);
  console.log(`\n   [+${((Date.now()-t0)/1000).toFixed(1)}s] Merged umbrellas (cross-batch): ${merged.length}`);
  for (const u of merged) {
    console.log(`     • ${u.scope} (${u.thread_ids.length} threads) — ${u.title}`);
  }

  console.log(`\n   [+${((Date.now()-t0)/1000).toFixed(1)}s] Persisting...`);
  const results = [];
  for (const u of merged) {
    try {
      const r = await persistUmbrella(u);
      results.push(r);
      console.log(`     ${r.action.padEnd(8)} ${r.scope} — ${r.articles || 0} articles${r.timelineId ? ` → timeline #${r.timelineId}` : ""}`);
    } catch (err) {
      console.log(`     ✗ ${u.scope}: ${err.message}`);
    }
  }

  const created = results.filter(r => r.action === "created").length;
  const updated = results.filter(r => r.action === "updated").length;
  console.log(`\n   Main pass: ${created} created, ${updated} updated.`);

  // Country-level sweep: Sudan, Myanmar, Venezuela each get a single
  // national umbrella covering both external conflicts and domestic issues.
  await runCountrySweep(t0);

  console.log(`\n✅ Backfill done in ${((Date.now()-t0)/1000).toFixed(1)}s.`);
  await pool.end();
}

if (require.main === module) {
  run().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run };
