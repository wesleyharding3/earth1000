/**
 * dedupThreadsWithClaude.js
 *
 * Semantic duplicate pass over story_threads. The structural dedup in
 * storyThreadBuilder.js (title jaccard / containment / nation overlap)
 * catches paraphrased rewrites where tokens align. It misses cases where
 * same-story threads use different vocabulary — e.g. "Trump Claims Hormuz
 * Control" vs "Maritime Escalation Intensifies as Iran Breaks US Blockade"
 * (both the Iran-US Hormuz conflict, but title tokens barely overlap).
 *
 * This pass:
 *   1. Pulls every active/cooling thread (>= N articles).
 *   2. Clusters threads by shared primary_category + shared primary_nation
 *      (loose — any nation overlap counts).
 *   3. Sends each cluster to Claude with titles + descriptions + keywords
 *      and asks which threads cover the SAME breaking story and should merge.
 *   4. Applies merges by reusing storyThreadBuilder.dedupSimilarThreads'
 *      merge logic (article reassignment, keyword union, loser → dormant).
 *
 * By default dry-run. Pass --apply to execute merges.
 *
 * Usage:
 *   node dedupThreadsWithClaude.js                    # dry-run
 *   node dedupThreadsWithClaude.js --apply            # execute merges
 *   node dedupThreadsWithClaude.js --max-clusters=40  # cost cap
 *   node dedupThreadsWithClaude.js --min-cluster=2    # skip single-thread clusters
 */

// override:true — see auditThreadArticles.js for the reason.
require("dotenv").config({ override: true });
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");

// Inline (intentionally — avoids a circular require with storyThreadBuilder
// once it imports THIS module for in-cron dedup). Mirrors the canonical
// implementation's behavior: case-fix, UK→GB, drop malformed entries.
function sanitizeIsos(input) {
  if (!Array.isArray(input)) return [];
  const out = [], seen = new Set();
  for (const raw of input) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!/^[A-Za-z]{2}$/.test(s)) continue;
    let code = s.toUpperCase();
    if (code === 'UK') code = 'GB';
    if (seen.has(code)) continue;
    seen.add(code); out.push(code);
  }
  return out;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY        = !!ARGV.get('apply');
const MODEL        = ARGV.get('model') || 'claude-haiku-4-5';
const MAX_CLUSTERS = parseInt(ARGV.get('max-clusters') || '40', 10);
const MIN_CLUSTER  = parseInt(ARGV.get('min-cluster') || '2', 10);
const MIN_ARTICLES = parseInt(ARGV.get('min-articles') || '2', 10);
// --only=ID1,ID2 limits --apply to merges whose LOSER id is in this set.
// Lets you dry-run, review Claude's proposed merges, then cherry-pick the
// good ones by listing loser ids. Without --only, --apply executes all
// proposed merges.
const ONLY = ARGV.get('only')
  ? new Set(String(ARGV.get('only')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean))
  : null;
// --exclude=ID1,ID2 does the inverse — blocks specific loser ids from
// being merged. Useful when you want "everything Claude proposed except
// these three obviously wrong ones."
const EXCLUDE = ARGV.get('exclude')
  ? new Set(String(ARGV.get('exclude')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean))
  : null;

async function main() {
  const t0 = Date.now();
  const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`\n🪢 Claude Thread Dedup — ${new Date().toISOString()}`);
  console.log(`   mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN'} | model: ${MODEL} | max_clusters=${MAX_CLUSTERS}\n`);

  const { rows: threads } = await pool.query(`
    SELECT id, title, description, keywords, primary_category,
           primary_nations, secondary_nations, importance,
           article_count, last_updated_at
      FROM story_threads
     WHERE status IN ('active','cooling')
       AND article_count >= $1
     ORDER BY primary_category, importance DESC, article_count DESC
  `, [MIN_ARTICLES]);
  console.log(`   [${el()}] Loaded ${threads.length} threads`);

  // Cluster by primary_category × any overlapping primary_nation. Two
  // threads land in the same cluster if they share a category AND at least
  // one primary nation. Very loose — Claude decides what's actually a
  // duplicate within each cluster.
  const clusters = buildClusters(threads);
  const ranked = clusters
    .filter(c => c.length >= MIN_CLUSTER)
    .sort((a, b) => b.length - a.length);
  console.log(`   [${el()}] Built ${ranked.length} candidate clusters (>= ${MIN_CLUSTER} threads each)`);

  let mergeGroups = 0;
  let mergedRows  = 0;
  let claudeCalls = 0;

  for (let i = 0; i < ranked.length && claudeCalls < MAX_CLUSTERS; i++) {
    const cluster = ranked[i];
    claudeCalls++;
    const cat = cluster[0].primary_category || 'uncategorized';
    const nations = new Set(cluster.flatMap(t =>
      sanitizeIsos([...(t.primary_nations || []), ...(t.secondary_nations || [])])));
    process.stdout.write(`   [${el()}] Cluster ${i + 1}/${ranked.length} cat=${cat} nations=[${[...nations].slice(0, 6).join(',')}] threads=${cluster.length} → Claude... `);

    let groups;
    try {
      groups = await askClaude(cluster);
    } catch (err) {
      console.log(`✗ ${err.message}`);
      continue;
    }
    if (!groups.length) { console.log(`— no merges`); continue; }
    console.log(`${groups.length} merge group(s)`);

    for (const g of groups) {
      const winnerId = g.winner_id;
      const loserIds = (g.loser_ids || []).filter(id => id !== winnerId);
      if (!loserIds.length) continue;
      const winner = cluster.find(t => t.id === winnerId);
      if (!winner) continue;
      mergeGroups++;

      for (const loserId of loserIds) {
        const loser = cluster.find(t => t.id === loserId);
        if (!loser) continue;
        // ONLY / EXCLUDE cherry-pick filtering when applying.
        const skipped = APPLY && (
          (ONLY && !ONLY.has(loserId)) ||
          (EXCLUDE && EXCLUDE.has(loserId))
        );
        const prefix = skipped ? '⏭ skipped' : '✂';
        console.log(`      ${prefix}  ${loserId} "${(loser.title || '').slice(0,60)}" → ${winnerId} "${(winner.title || '').slice(0,60)}"`);
        if (APPLY && !skipped) {
          await mergeThread(winner, loser);
          mergedRows++;
        }
      }
    }
  }

  console.log(`\n${APPLY ? '✅ Applied' : '✅ Dry run'} — ${claudeCalls} Claude calls, ${mergeGroups} merge groups proposed${APPLY ? `, ${mergedRows} threads merged into winners` : ''}.`);
  await pool.end();
}

// ─── Clustering ─────────────────────────────────────────────────────────────
function buildClusters(threads) {
  // Union-find by (category, shared primary nation)
  const parent = new Map(threads.map(t => [t.id, t.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const byCat = new Map();
  for (const t of threads) {
    const cat = t.primary_category || '(none)';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(t);
  }
  for (const [, list] of byCat) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const aIsos = new Set(sanitizeIsos(a.primary_nations || []));
      if (!aIsos.size) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const bIsos = sanitizeIsos(b.primary_nations || []);
        if (bIsos.some(iso => aIsos.has(iso))) union(a.id, b.id);
      }
    }
  }
  const groups = new Map();
  for (const t of threads) {
    const r = find(t.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()];
}

// ─── Claude prompt ──────────────────────────────────────────────────────────
async function askClaude(cluster) {
  const threadLines = cluster.map(t =>
    `#${t.id} "${t.title || ''}"
  nations=[${sanitizeIsos([...(t.primary_nations || []), ...(t.secondary_nations || [])]).slice(0, 5).join(',')}]
  keywords=[${(t.keywords || []).slice(0, 10).join(', ')}]
  description="${(t.description || '').slice(0, 220).replace(/\s+/g, ' ')}"`
  ).join('\n\n');

  const prompt = `You are deduplicating breaking-news story threads. Each thread represents one ongoing story. Below are threads in the same category that share at least one country; some are likely paraphrased duplicates of the same breaking event.

Return ONLY valid JSON:
{
  "merge_groups": [
    {
      "winner_id": <thread id to keep (highest-coverage canonical version)>,
      "loser_ids": [<ids to merge into winner>],
      "rationale": "one-line reason (<25 words)"
    }
  ]
}

Rules (STRICT — err heavily toward NOT merging):
- ONLY group threads that cover THE SAME specific breaking event — same actors, same action, same moment in time. Titles should read like paraphrases of the same headline when written a week apart.
- HARD BLOCKS on merging (never merge these, regardless of category/nation overlap):
    * Two DIFFERENT countries (e.g. Cuba vs Venezuela, even both "Latin America energy crisis"). NOT duplicates.
    * Two DIFFERENT named officials / politicians / actors (e.g. Swalwell resignation vs DeRemer resignation). NOT duplicates.
    * OPPOSITE directions of a conflict (e.g. "Ukraine drone strikes on Russian oil" vs "Russian airstrikes on Ukrainian cities"). NOT duplicates — these are different sides.
    * Different incidents even in the same place (e.g. two separate school shootings, two separate prison raids, two separate budget passes).
    * One thread is an umbrella / macro summary (e.g. "Global economic fallout from X war") and the other is a specific-event thread. NOT duplicates.
    * Related but distinct facets (e.g. EU energy policy response vs. US sanctions relaxation — same broader context, but different decisions/actors). NOT duplicates.
- A mega-story like the entire US-Iran war legitimately has many separate threads covering distinct events (naval blockade, ceasefire talks, executions, protests, market impact). Keep them separate — merging all into one "Iran War" thread loses information.
- A SAFE merge requires:
    * Both titles describe the same action by the same primary actor on the same date/week
    * OR both are explicit paraphrases (e.g. "Denmark Train Collision Injures 17" and "Denmark Train Collision Leaves Five Critical")
    * Nation overlap alone is NOT sufficient.
- Winner selection: prefer the thread with a more specific, named-event title over a generic one. If titles are equally specific, the higher article_count wins.
- If no real duplicates, return { "merge_groups": [] }.
- WHEN IN DOUBT, DO NOT MERGE. The cost of a false merge (two different stories collapsed, articles misattributed) is much higher than the cost of leaving two paraphrased threads intact.

THREADS (${cluster.length}):
${threadLines}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (response?.content || []).map(p => typeof p?.text === 'string' ? p.text : '').join('').trim();
  const parsed = extractJson(text);
  const groups = Array.isArray(parsed?.merge_groups) ? parsed.merge_groups : [];
  return groups
    .map(g => ({
      winner_id: parseInt(g.winner_id, 10),
      loser_ids: Array.isArray(g.loser_ids) ? g.loser_ids.map(x => parseInt(x, 10)).filter(Boolean) : [],
      rationale: String(g.rationale || '').slice(0, 160),
    }))
    .filter(g => Number.isFinite(g.winner_id) && g.loser_ids.length);
}

// ─── Merge (mirrors storyThreadBuilder.dedupSimilarThreads semantics) ───────
async function mergeThread(winner, loser) {
  // Move loser's articles onto winner (skip dupes)
  await pool.query(`
    INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
    SELECT $1, sta.article_id, sta.relevance_score, FALSE
      FROM story_thread_articles sta
     WHERE sta.thread_id = $2
     ON CONFLICT DO NOTHING
  `, [winner.id, loser.id]);

  // Recount winner, union keywords + nations
  const winnerKws = new Set((winner.keywords || []).map(k => String(k || '').trim().toLowerCase()).filter(Boolean));
  (loser.keywords || []).forEach(k => winnerKws.add(String(k || '').trim().toLowerCase()));
  const mergedKeywords = [...winnerKws];
  const mergedPrimary = [...new Set([...(winner.primary_nations || []), ...(loser.primary_nations || [])])];
  const mergedSecondary = [...new Set([...(winner.secondary_nations || []), ...(loser.secondary_nations || [])])];

  await pool.query(`
    UPDATE story_threads
       SET article_count   = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1),
           keywords        = $2::text[],
           primary_nations = $3::text[],
           secondary_nations = $4::text[],
           importance      = GREATEST(importance, $5),
           last_updated_at = NOW()
     WHERE id = $1
  `, [winner.id, mergedKeywords, mergedPrimary, mergedSecondary, Number(loser.importance) || 0]);

  // Drop loser's join rows, mark dormant
  await pool.query(`DELETE FROM story_thread_articles WHERE thread_id = $1`, [loser.id]);
  await pool.query(`
    UPDATE story_threads
       SET status = 'dormant', article_count = 0, last_updated_at = NOW()
     WHERE id = $1
  `, [loser.id]);
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) {}
  }
  return null;
}

// ─── Exported entry point for in-cron invocation ────────────────────────────
// storyThreadBuilder.js calls this at the end of its run, scoped to the
// thread IDs it just created/updated. Scoping keeps Claude cost at a
// handful of clusters per run (~$0.05-$0.10) instead of the full 19-cluster
// semantic pass (which costs ~$0.40/run and is better run manually every
// few hours).
//
// Options:
//   touchedIds : Set<number> | Array<number> — ids created/updated this run
//   maxClusters: number — hard cap on Claude calls (default 5)
//   apply      : boolean  — actually merge (default true in cron)
//   log        : console-like object for progress logs (default console)
async function runScopedDedup({ touchedIds, maxClusters = 5, apply = true, log = console } = {}) {
  const idSet = touchedIds instanceof Set ? touchedIds : new Set([...(touchedIds || [])].map(Number));
  if (!idSet.size) return { proposed: 0, merged: 0, claudeCalls: 0 };

  const { rows: threads } = await pool.query(`
    SELECT id, title, description, keywords, primary_category,
           primary_nations, secondary_nations, importance,
           article_count, last_updated_at
      FROM story_threads
     WHERE status IN ('active','cooling')
       AND article_count >= 2
  `);
  if (!threads.length) return { proposed: 0, merged: 0, claudeCalls: 0 };

  const all = buildClusters(threads);
  // Keep only clusters that contain at least one touched thread, have
  // at least 2 threads total, and sort by size DESC so the biggest
  // potential-dup clusters get the budget.
  const scoped = all
    .filter(c => c.length >= 2 && c.some(t => idSet.has(Number(t.id))))
    .sort((a, b) => b.length - a.length)
    .slice(0, maxClusters);

  let proposed = 0;
  let merged   = 0;
  let claudeCalls = 0;

  for (const cluster of scoped) {
    claudeCalls++;
    const cat = cluster[0].primary_category || '?';
    log.log(`   [claude-dedup] cluster cat=${cat} threads=${cluster.length} (touched: ${cluster.filter(t => idSet.has(Number(t.id))).length})`);
    let groups;
    try { groups = await askClaude(cluster); }
    catch (err) { log.warn(`   [claude-dedup] error: ${err.message}`); continue; }

    for (const g of groups) {
      const winner = cluster.find(t => t.id === g.winner_id);
      if (!winner) continue;
      const loserIds = (g.loser_ids || []).filter(id => id !== g.winner_id);
      for (const loserId of loserIds) {
        const loser = cluster.find(t => t.id === loserId);
        if (!loser) continue;
        proposed++;
        log.log(`   [claude-dedup] ${apply ? '✂' : '[dry]'}  ${loserId} "${(loser.title || '').slice(0,60)}" → ${winner.id} "${(winner.title || '').slice(0,60)}"`);
        if (apply) {
          try { await mergeThread(winner, loser); merged++; }
          catch (err) { log.warn(`   [claude-dedup] merge failed: ${err.message}`); }
        }
      }
    }
  }

  return { proposed, merged, claudeCalls };
}

module.exports = { runScopedDedup };

// Only auto-run the CLI main() when invoked directly via
// `node dedupThreadsWithClaude.js`, never when required as a module.
if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
