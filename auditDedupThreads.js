/**
 * auditDedupThreads.js
 *
 * One-time backfill: dedup ALL active story threads (no recency window).
 * Catches the historical pile of near-duplicate threads (Trump/Iran/Hormuz/
 * Mexico/etc) that accumulated before the inline dedup pass existed.
 *
 * Usage:
 *   node auditDedupThreads.js               # dry-run (default, no writes)
 *   node auditDedupThreads.js --apply       # actually merge
 *   node auditDedupThreads.js --apply --min-title=0.6 --min-kw=0.7
 *   node auditDedupThreads.js --include-cooling
 *
 * Merge rule: two threads are duplicates when
 *     (titleSim ≥ MIN_TITLE  OR  kwSim ≥ MIN_KW)
 *     AND same primary_category
 *
 * Winner = highest importance → most articles → most recent.
 * Losers are marked DORMANT (never deleted) so historical arcs survive.
 */

require("dotenv").config();
const pool = require("./db");

const APPLY           = process.argv.includes("--apply");
const INCLUDE_COOLING = process.argv.includes("--include-cooling");
const MIN_TITLE       = parseFloat(process.argv.find(a => a.startsWith("--min-title="))?.split("=")[1] || "0.60");
const MIN_KW          = parseFloat(process.argv.find(a => a.startsWith("--min-kw="))?.split("=")[1]    || "0.70");

const TITLE_STOPWORDS = new Set([
  "the","a","an","of","in","on","at","to","for","and","or","but","with","from",
  "by","as","is","are","was","were","be","been","being","it","its","this","that",
  "these","those","over","under","after","before","new","says","say","said",
  "amid","into","out","up","down","off","vs","versus"
]);

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

function tokenizeTitle(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter(t => t.length >= 3 && !TITLE_STOPWORDS.has(t))
  );
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersect = 0;
  for (const x of setA) if (setB.has(x)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union ? intersect / union : 0;
}

function mergeKeywords(existing, incoming) {
  const merged = new Map();
  for (const k of [...(existing || []), ...(incoming || [])]) {
    const n = normalizeKeyword(k);
    if (!n || merged.has(n)) continue;
    merged.set(n, String(k || "").trim());
  }
  return [...merged.values()];
}

async function main() {
  const t0 = Date.now();
  console.log(`\n🔎 Story Thread Backfill Dedup — ${new Date().toISOString()}`);
  console.log(`   Mode:           ${APPLY ? "APPLY (writes)" : "DRY RUN"}`);
  console.log(`   Title Jaccard:  ≥ ${MIN_TITLE}`);
  console.log(`   Keyword Jaccard:≥ ${MIN_KW}`);
  console.log(`   Scope:          ${INCLUDE_COOLING ? "active + cooling" : "active only"}\n`);

  const statusFilter = INCLUDE_COOLING
    ? `status IN ('active', 'cooling')`
    : `status = 'active'`;

  const { rows: threads } = await pool.query(`
    SELECT id, title, keywords, primary_category, importance, article_count, last_updated_at, status
    FROM story_threads
    WHERE ${statusFilter}
    ORDER BY importance DESC, article_count DESC, last_updated_at DESC
  `);

  console.log(`📦 Loaded ${threads.length} threads to evaluate`);
  if (threads.length < 2) { await pool.end(); return; }

  // Pre-compute token/keyword sets
  const enriched = threads.map(t => ({
    ...t,
    _titleTokens: tokenizeTitle(t.title),
    _kwSet: new Set((t.keywords || []).map(normalizeKeyword).filter(Boolean))
  }));

  // Union-Find: transitively cluster similar threads
  const parent = new Map(enriched.map(t => [t.id, t.id]));
  const find = (x) => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Pair scan — O(n²) but fine for a few thousand threads
  console.log(`🧮 Scanning ${(enriched.length * (enriched.length - 1) / 2).toLocaleString()} pairs...`);
  let pairsMatched = 0;
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i], b = enriched[j];
      if (a.primary_category && b.primary_category && a.primary_category !== b.primary_category) continue;

      const titleSim = jaccard(a._titleTokens, b._titleTokens);
      const kwSim    = jaccard(a._kwSet, b._kwSet);
      if (titleSim >= MIN_TITLE || kwSim >= MIN_KW) {
        union(a.id, b.id);
        pairsMatched++;
      }
    }
  }
  console.log(`   ${pairsMatched} similar pair(s) found`);

  // Group by root
  const groups = new Map();
  for (const t of enriched) {
    const r = find(t.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }

  const dupGroups = [...groups.values()].filter(g => g.length >= 2);
  console.log(`\n🧬 ${dupGroups.length} duplicate group(s) detected\n`);

  // Sort groups by size (largest = most painful duplicates) for nice output
  dupGroups.sort((a, b) => b.length - a.length);

  let totalLosers = 0;
  let mergedCount = 0;

  for (const group of dupGroups) {
    // Winner: highest importance → most articles → most recent
    group.sort((a, b) => {
      const imp = (Number(b.importance) || 0) - (Number(a.importance) || 0);
      if (imp) return imp;
      const ac = (Number(b.article_count) || 0) - (Number(a.article_count) || 0);
      if (ac) return ac;
      return new Date(b.last_updated_at).getTime() - new Date(a.last_updated_at).getTime();
    });
    const winner = group[0];
    const losers = group.slice(1);
    totalLosers += losers.length;

    console.log(`─── Group (${group.length} threads, category: ${winner.primary_category || "—"}) ───`);
    console.log(`  ★ WINNER  [${winner.id}] imp=${winner.importance} arts=${winner.article_count}  "${winner.title}"`);
    for (const l of losers) {
      console.log(`     loser  [${l.id}] imp=${l.importance} arts=${l.article_count}  "${l.title}"`);
    }

    if (!APPLY) {
      console.log("");
      continue;
    }

    // APPLY: merge each loser into winner
    for (const loser of losers) {
      try {
        const mergedKw = mergeKeywords(winner.keywords || [], loser.keywords || []);

        await pool.query(`
          INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
          SELECT $1, sta.article_id, sta.relevance_score, FALSE
          FROM story_thread_articles sta
          WHERE sta.thread_id = $2
          ON CONFLICT DO NOTHING
        `, [winner.id, loser.id]);

        await pool.query(`
          UPDATE story_threads
          SET article_count   = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1),
              keywords        = $2::text[],
              importance      = GREATEST(importance, $3),
              last_updated_at = NOW()
          WHERE id = $1
        `, [winner.id, mergedKw, Number(loser.importance) || 0]);

        await pool.query(`DELETE FROM story_thread_articles WHERE thread_id = $1`, [loser.id]);
        await pool.query(`
          UPDATE story_threads
          SET status = 'dormant',
              article_count = 0,
              last_updated_at = NOW()
          WHERE id = $1
        `, [loser.id]);

        winner.keywords = mergedKw;
        winner.importance = Math.max(Number(winner.importance) || 0, Number(loser.importance) || 0);
        mergedCount++;
      } catch (err) {
        console.error(`     ⚠ failed to merge ${loser.id} → ${winner.id}: ${err.message}`);
      }
    }
    console.log("");
  }

  console.log(`\n${APPLY ? "✅" : "🔍"} Summary`);
  console.log(`   Threads scanned:    ${threads.length}`);
  console.log(`   Duplicate groups:   ${dupGroups.length}`);
  console.log(`   Threads to merge:   ${totalLosers}`);
  if (APPLY) console.log(`   Threads merged:     ${mergedCount}`);
  console.log(`   Elapsed:            ${((Date.now()-t0)/1000).toFixed(1)}s`);

  if (!APPLY && totalLosers > 0) {
    console.log(`\n💡 Re-run with --apply to commit these merges.`);
  }

  await pool.end();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
