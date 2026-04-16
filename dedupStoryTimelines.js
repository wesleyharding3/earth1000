/**
 * dedupStoryTimelines.js
 *
 * One-shot (or periodic) merger for overlapping umbrella timelines.
 *
 * WHY THIS EXISTS
 * ────────────────
 * storyTimelineBuilder.js creates NEW timelines whenever its batch-level
 * clustering decides a group of articles doesn't obviously belong to an
 * existing timeline it was shown. Because the builder only sees ~120
 * existing timelines at a time and batches articles in groups of 28,
 * the same umbrella arc can spawn multiple sibling timelines across
 * runs — e.g. "Trump threatens NATO allies" and "Trump Reshapes NATO
 * With Pay-to-Play Model" living side by side, or two separate
 * "Ukraine-Russia War" timelines with nearly identical article pools.
 *
 * This script runs ACROSS ALL active timelines, asks Claude to find
 * duplicate / sibling-arc groups, then merges every loser into the
 * winner by:
 *   1. reassigning story_timeline_articles (ON CONFLICT DO NOTHING)
 *   2. unioning keywords
 *   3. taking the winner's title/scope/description (optionally
 *      rewritten by Claude to a better umbrella label)
 *   4. recomputing aggregate columns
 *   5. deleting the losing timeline rows
 *
 * Dedup is narrower than a rewrite — it only merges timelines that
 * share an umbrella arc. It will NOT merge "Iran-Israel war" into
 * "Iran leadership succession" even though both are Iran stories,
 * because those are distinct arcs and readers benefit from that split.
 *
 * Usage:
 *   node dedupStoryTimelines.js                 — dry-run, prints plan
 *   node dedupStoryTimelines.js --commit        — actually merge
 *   node dedupStoryTimelines.js --max=200       — cap active pool
 */

require("dotenv").config();
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const COMMIT    = process.argv.includes("--commit");
const MAX_POOL  = parseInt(process.argv.find(a => a.startsWith("--max="))?.split("=")[1] || "300", 10);
const BATCH     = 80; // timelines per Claude pass

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🧹 Story Timeline Dedup — ${new Date().toISOString()}`);
  console.log(`   Mode: ${COMMIT ? "COMMIT" : "DRY-RUN"} | Max pool: ${MAX_POOL}`);

  const timelines = await loadActiveTimelines(MAX_POOL);
  console.log(`   [${elapsed()}] Loaded ${timelines.length} active timelines`);
  if (timelines.length < 2) { console.log("   Nothing to dedup."); await pool.end(); return; }

  // Split into Claude-sized batches but keep the full set visible to each
  // batch so cross-batch duplicates still get caught. Strategy:
  //   • Batch 1: timelines sorted by importance desc, first BATCH entries.
  //   • Batch 2: remaining timelines PLUS the top 30 from Batch 1 as context
  //     anchors, so Claude can still merge a low-importance sibling into
  //     a high-importance umbrella it already saw.
  const batches = buildBatches(timelines, BATCH);
  console.log(`   [${elapsed()}] ${batches.length} Claude batch(es)`);

  const mergeOps = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    process.stdout.write(`   [${elapsed()}] Batch ${bi+1}/${batches.length} (${batch.length} timelines) → Claude... `);
    try {
      const plan = await askClaudeForMergePlan(batch);
      for (const group of plan) {
        if (!group || !group.keep_id || !Array.isArray(group.merge_ids) || !group.merge_ids.length) continue;
        mergeOps.push(group);
      }
      console.log(`✓ ${plan.length} merge group(s)`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
    await sleep(800);
  }

  // Reconcile: if the same losing timeline appears in multiple groups, keep
  // only the first occurrence so we don't double-move articles.
  const seenLoser = new Set();
  const finalOps = [];
  for (const op of mergeOps) {
    const filteredLosers = op.merge_ids
      .map(Number)
      .filter(id => id !== Number(op.keep_id) && !seenLoser.has(id));
    if (!filteredLosers.length) continue;
    for (const l of filteredLosers) seenLoser.add(l);
    finalOps.push({ ...op, merge_ids: filteredLosers });
  }

  console.log(`\n   [${elapsed()}] ${finalOps.length} final merge operation(s):`);
  const titleById = new Map(timelines.map(t => [Number(t.id), t.title]));
  for (const op of finalOps) {
    const keepTitle = titleById.get(Number(op.keep_id)) || "?";
    console.log(`\n   ✓ KEEP  [${op.keep_id}] ${keepTitle}`);
    if (op.new_title && op.new_title !== keepTitle) {
      console.log(`     └─ rename → "${op.new_title}"`);
    }
    for (const loser of op.merge_ids) {
      const lt = titleById.get(Number(loser)) || "?";
      console.log(`     ⮕ merge [${loser}] ${lt}`);
    }
    if (op.reason) console.log(`     reason: ${op.reason}`);
  }

  if (!finalOps.length) {
    console.log(`\n   ✅ No merges proposed. Done in ${((Date.now()-t0)/1000).toFixed(1)}s.\n`);
    await pool.end();
    return;
  }

  if (!COMMIT) {
    console.log(`\n   (dry-run — pass --commit to apply these merges)\n`);
    await pool.end();
    return;
  }

  console.log(`\n   [${elapsed()}] Applying merges...`);
  let mergedRows = 0, deletedTimelines = 0;
  for (const op of finalOps) {
    try {
      const stats = await applyMerge(op);
      mergedRows       += stats.movedArticles;
      deletedTimelines += stats.deletedTimelines;
    } catch (e) {
      console.error(`   ⚠ Merge into [${op.keep_id}] failed: ${e.message}`);
    }
  }

  console.log(`\n   ✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s — ${deletedTimelines} timeline(s) merged, ${mergedRows} article link(s) reassigned.\n`);
  await pool.end();
}

// ─── Load timelines ──────────────────────────────────────────────────────────
async function loadActiveTimelines(limit) {
  const { rows } = await pool.query(`
    SELECT id, title, description, scope, primary_category, geographic_scope,
           importance, keywords, article_count, last_updated_at
    FROM story_timelines
    WHERE status = 'active'
    ORDER BY importance DESC NULLS LAST, article_count DESC NULLS LAST, last_updated_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

function buildBatches(timelines, size) {
  if (timelines.length <= size) return [timelines];
  const batches = [];
  const anchors = timelines.slice(0, Math.min(30, Math.floor(size / 3)));
  const rest = timelines.slice(anchors.length);
  for (let i = 0; i < rest.length; i += size - anchors.length) {
    const chunk = rest.slice(i, i + (size - anchors.length));
    batches.push([...anchors, ...chunk]);
  }
  return batches;
}

// ─── Claude ──────────────────────────────────────────────────────────────────
async function askClaudeForMergePlan(timelines) {
  const data = timelines.map(t => ({
    id:          t.id,
    title:       t.title,
    scope:       t.scope,
    category:    t.primary_category,
    importance:  t.importance,
    arts:        t.article_count,
    keywords:    (t.keywords || []).slice(0, 8),
    description: (t.description || "").slice(0, 300)
  }));

  const prompt = `You are the timeline editor for a GEOPOLITICS platform. Below is a list of ACTIVE umbrella timelines. Many are duplicates or near-duplicates of each other — the same arc was spawned twice with slightly different titles/scopes. Your job is to find those duplicate clusters and tell me which to merge together.

═══ WHAT COUNTS AS A DUPLICATE ═══
Two timelines should be merged if they cover the SAME UMBRELLA ARC:
  • Same war or conflict theater (e.g. two "Ukraine-Russia war" timelines)
  • Same political crisis in the same country (e.g. two "Trump NATO restructuring" timelines)
  • Same diplomatic process between the same parties — TREAT SYNONYMS AS IDENTICAL:
    "Negotiations" = "Talks" = "Dialogue" = "Discussions"
    "Ceasefire" = "Truce" = "Armistice"
    "Escalation" = "Intensification" = "Buildup"
    "Crisis" = "Turmoil" = "Upheaval" = "Unrest"
    "Transition" = "Succession" = "Changeover"
    "Realignment" = "Reset" = "Recalibration"
  • Same named scandal, investigation, or protest movement
  • Example: "Israel-Lebanon Ceasefire Negotiations" = "Israel-Lebanon Ceasefire Talks" = "Israel-Lebanon Direct Negotiations" → ALL THE SAME ARC
  • Example: "Iran Leadership Transition Crisis" = "Iran Leadership Succession Crisis" → SAME ARC
  • Example: "Hungary's Democratic Realignment" = "Hungary's Democratic Reset" → SAME ARC

Also flag for removal any GENERIC TOPIC BUCKET that isn't a real geopolitical arc:
  • "Global Energy Transition", "Renewable Energy", "Cost of Living Crisis", "Cybersecurity Standards" → these are categories, not story arcs
  • Propose merging them into the nearest real arc, or if none, add them to merge_ids with keep_id of the most relevant real arc

Sibling arcs that are GENUINELY DISTINCT should NOT be merged:
  • "Iran-Israel war" ≠ "Iran leadership succession" (war vs. domestic succession)
  • "Ukraine-Russia war" ≠ "Hungarian intel leak to Russia" (different theaters)
  • "Gaza genocide" ≠ "Israel-Lebanon conflict" (distinct fronts, even if linked)
  • Different countries' elections or protests — each is its own arc

═══ WHICH TIMELINE TO KEEP ═══
When merging, pick the KEEP candidate using this priority:
  1. Highest article_count (strongest base of coverage)
  2. Higher importance
  3. Broader, more umbrella-style title (e.g. "Trump NATO restructuring" beats "Trump threatens NATO allies over Iran")
  4. Cleaner scope slug
You may rewrite the KEEP title/scope/description if the existing one is too narrow for the merged arc — return them in the response.

═══ OUTPUT ═══
Return ONLY a JSON array of merge groups. Empty array [] is acceptable. Each group:
{
  "keep_id": <id to keep>,
  "merge_ids": [<ids whose articles should be moved into keep_id and then deleted>],
  "new_title": "optional broader umbrella title, or null to keep existing",
  "new_scope": "optional cleaner scope slug, or null",
  "new_description": "optional two-sentence umbrella description, or null",
  "reason": "short justification"
}

A timeline id MUST appear in at most one group total (either keep or merge). Do not propose merges across fundamentally different arcs. Be aggressive about clear duplicates but conservative about marginal cases.

TIMELINES:
${JSON.stringify(data, null, 2)}`;

  const response = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 8192,
    messages:   [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`No JSON array in response: ${text.slice(0, 160)}`);
  return JSON.parse(m[0]);
}

// ─── Apply merge ─────────────────────────────────────────────────────────────
async function applyMerge(op) {
  const keepId = Number(op.keep_id);
  const losers = op.merge_ids.map(Number).filter(id => id !== keepId);
  if (!losers.length) return { movedArticles: 0, deletedTimelines: 0 };

  const dbClient = await pool.connect();
  let movedArticles = 0;
  try {
    await dbClient.query("BEGIN");

    // Move article links from losers → keep (ON CONFLICT DO NOTHING to
    // avoid PK collisions when an article is already linked to keep).
    const { rows: moveCount } = await dbClient.query(`
      WITH moved AS (
        INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor, added_at)
        SELECT $1, article_id, parabolic_weight, relevance_score, is_anchor, added_at
        FROM story_timeline_articles
        WHERE timeline_id = ANY($2::int[])
        ON CONFLICT DO NOTHING
        RETURNING article_id
      )
      SELECT COUNT(*)::int AS n FROM moved
    `, [keepId, losers]);
    movedArticles = moveCount[0].n;

    // Union keywords
    await dbClient.query(`
      UPDATE story_timelines kt
      SET keywords = ARRAY(
        SELECT DISTINCT unnest(
          COALESCE(kt.keywords, ARRAY[]::text[]) ||
          COALESCE((
            SELECT ARRAY_AGG(kw)
            FROM (
              SELECT unnest(keywords) AS kw FROM story_timelines WHERE id = ANY($2::int[])
            ) s
          ), ARRAY[]::text[])
        )
      ),
      importance = GREATEST(
        kt.importance,
        COALESCE((SELECT MAX(importance) FROM story_timelines WHERE id = ANY($2::int[])), 0)
      ),
      last_updated_at = GREATEST(
        kt.last_updated_at,
        COALESCE((SELECT MAX(last_updated_at) FROM story_timelines WHERE id = ANY($2::int[])), kt.last_updated_at)
      )
      WHERE kt.id = $1
    `, [keepId, losers]);

    // Optional rewrite of title/scope/description on the keep row
    if (op.new_title || op.new_scope || op.new_description) {
      await dbClient.query(`
        UPDATE story_timelines
        SET title       = COALESCE(NULLIF($2, ''), title),
            scope       = COALESCE(NULLIF($3, ''), scope),
            description = COALESCE(NULLIF($4, ''), description)
        WHERE id = $1
      `, [
        keepId,
        (op.new_title || "").trim().slice(0, 180),
        (op.new_scope || "").toLowerCase().trim().replace(/\s+/g, "_").slice(0, 80),
        (op.new_description || "").trim().slice(0, 600)
      ]);
    }

    // Delete loser timelines (CASCADE drops any story_timeline_articles rows
    // that weren't already moved because of PK conflicts — those rows have
    // duplicate (timeline_id,article_id) pairs on the keep side already).
    await dbClient.query(`DELETE FROM story_timelines WHERE id = ANY($1::int[])`, [losers]);

    // Recompute keep's aggregates from the final article set
    await dbClient.query(`
      UPDATE story_timelines t
      SET article_count = COALESCE((
            SELECT COUNT(*)::int FROM story_timeline_articles WHERE timeline_id = t.id
          ), 0),
          parabolic_weight_sum = COALESCE((
            SELECT SUM(parabolic_weight)::real FROM story_timeline_articles WHERE timeline_id = t.id
          ), 0),
          distinct_source_count = COALESCE((
            SELECT COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id))::int
            FROM story_timeline_articles sta
            JOIN news_articles a ON a.id = sta.article_id
            WHERE sta.timeline_id = t.id
          ), 0)
      WHERE t.id = $1
    `, [keepId]);

    await dbClient.query("COMMIT");
    console.log(`     → merged ${losers.length} timeline(s) into [${keepId}], ${movedArticles} article link(s) moved`);
    return { movedArticles, deletedTimelines: losers.length };
  } catch (e) {
    await dbClient.query("ROLLBACK");
    throw e;
  } finally {
    dbClient.release();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (require.main === module) {
  run().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

module.exports = { run };
