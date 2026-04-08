/**
 * mergeFragmentedThreads.js
 *
 * One-shot cleanup: find semantically related threads and merge them into
 * unified narratives. Solves fragmentation where the same geopolitical story
 * is split across multiple threads (e.g., "Armenia Court Detention" +
 * "Armenia-Azerbaijan Transit Corridor" + "Armenia Tensions" → one thread).
 *
 * Approach:
 *   1. Load all active/cooling threads
 *   2. Compute title token similarity + keyword overlap
 *   3. Use union-find to cluster related threads
 *   4. For each cluster with 2+ threads, use Claude to generate a unified title
 *   5. Merge articles, keywords, and metadata into the "winner" thread
 *   6. Mark losers as dormant with article_count = 0
 *
 * Usage:
 *   node mergeFragmentedThreads.js                # dry-run (default)
 *   node mergeFragmentedThreads.js --apply        # actually merge
 *   node mergeFragmentedThreads.js --apply --min-cluster=3  # only merge 3+ threads
 *   node mergeFragmentedThreads.js --show=100     # show first 100 merge proposals
 */

require("dotenv").config();
const pool = require("./db");
const { Anthropic } = require("@anthropic-ai/sdk");

const client = new Anthropic();

const APPLY = process.argv.includes("--apply");
const MIN_CLUSTER = parseInt(process.argv.find(a => a.startsWith("--min-cluster="))?.split("=")[1] || "2", 10);
const SHOW_LIMIT = parseInt(process.argv.find(a => a.startsWith("--show="))?.split("=")[1] || "50", 10);

// ─── Utilities ────────────────────────────────────────────────────────────

const TITLE_STOPWORDS = new Set([
  "the","a","an","of","in","on","at","to","for","and","or","but","with","from",
  "by","as","is","are","was","were","be","been","being","it","its","this","that",
  "these","those","over","under","after","before","new","says","say","said",
  "amid","into","out","up","down","off","vs","versus","during","against",
]);

function tokenizeTitle(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, " ")
      .split(/\s+/)
      .filter(t => t.length >= 3 && !TITLE_STOPWORDS.has(t))
  );
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  if (!setA.size || !setB.size) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x))).size;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

function keywordOverlap(kwA, kwB) {
  if (!kwA?.length || !kwB?.length) return 0;
  const setA = new Set(kwA.map(k => String(k || "").toLowerCase().trim()).filter(Boolean));
  const setB = new Set(kwB.map(k => String(k || "").toLowerCase().trim()).filter(Boolean));
  return jaccardSimilarity(setA, setB);
}

// ─── Union-Find for clustering ────────────────────────────────────────────

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = Array(n).fill(0);
  }
  find(x) {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }
  union(x, y) {
    const px = this.find(x), py = this.find(y);
    if (px === py) return;
    if (this.rank[px] < this.rank[py]) [px, py] = [py, px];
    this.parent[py] = px;
    if (this.rank[px] === this.rank[py]) this.rank[px]++;
  }
}

// ─── Claude title merger ──────────────────────────────────────────────────

async function generateMergedTitle(cluster) {
  const titles = cluster.map(t => t.title);
  const keywords = cluster.flatMap(t => t.keywords || []).slice(0, 20);
  const countries = cluster
    .map(t => t.title.match(/\b([A-Z][a-z]+)\b/g) || [])
    .flat()
    .filter(Boolean);

  const prompt = `You are reframing multiple fragmented news threads into ONE unified geopolitical narrative.

Current fragmented titles:
${titles.map((t, i) => `  ${i + 1}. "${t}"`).join("\n")}

Shared keywords: ${[...new Set(keywords)].slice(0, 10).join(", ")}

Geographic focus: ${[...new Set(countries)].slice(0, 5).join(", ")}

Task: Write a SINGLE story-centric thread title (max 10 words) that unifies these fragments into one narrative. The title should:
  • Name specific actors/places/events (not abstract topics)
  • Use an action verb or specific event noun if possible
  • Show how the fragments connect into one geopolitical story
  • Be compelling and informative

Return ONLY the title, no explanation.`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }]
  });

  return response.content[0].text.trim();
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("═════════════════════════════════════════════");
  console.log("🔗 merge fragmented threads");
  console.log(`   mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`   min-cluster: ${MIN_CLUSTER}`);
  console.log("═════════════════════════════════════════════\n");

  // Load all active/cooling threads with their keywords
  const { rows: threads } = await pool.query(`
    SELECT id, title, keywords, primary_category, importance, article_count, status, last_updated_at
    FROM story_threads
    WHERE status IN ('active', 'cooling')
    ORDER BY importance DESC, article_count DESC
  `);
  console.log(`📦 Loaded ${threads.length} active/cooling threads\n`);

  // Enrich with tokenized titles
  const enriched = threads.map(t => ({
    ...t,
    _titleTokens: tokenizeTitle(t.title),
    _kwSet: new Set((t.keywords || []).map(k => String(k || "").toLowerCase().trim()).filter(Boolean))
  }));

  // Build similarity graph: threads are "related" if similarity >= 0.5
  const SIMILARITY_THRESHOLD = 0.5;
  const uf = new UnionFind(enriched.length);

  console.log("🧮 Computing similarity graph...");
  let pairsMatched = 0;
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i], b = enriched[j];

      // Only cluster threads in same category
      if (a.primary_category && b.primary_category && a.primary_category !== b.primary_category) {
        continue;
      }

      // Title token Jaccard
      const titleSim = jaccardSimilarity(a._titleTokens, b._titleTokens);
      // Keyword overlap
      const kwSim = keywordOverlap(Array.from(a._kwSet), Array.from(b._kwSet));
      // Either metric triggers a link
      if (titleSim >= SIMILARITY_THRESHOLD || kwSim >= 0.4) {
        uf.union(i, j);
        pairsMatched++;
      }
    }
  }
  console.log(`   ${pairsMatched} related pair(s) found\n`);

  // Group by root
  const clusters = new Map();
  for (let i = 0; i < enriched.length; i++) {
    const root = uf.find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(enriched[i]);
  }

  // Filter to clusters with 2+ threads
  const mergeableClusters = [...clusters.values()]
    .filter(c => c.length >= MIN_CLUSTER)
    .sort((a, b) => b.length - a.length);

  console.log(`🧬 ${mergeableClusters.length} cluster(s) to merge\n`);

  if (mergeableClusters.length === 0) {
    console.log("✅ no mergeable clusters found.");
    await pool.end();
    return;
  }

  // Generate merge proposals for each cluster
  const proposals = [];
  for (let i = 0; i < mergeableClusters.length; i++) {
    const cluster = mergeableClusters[i];
    console.log(`⏳ Generating title for cluster ${i + 1}/${mergeableClusters.length} (${cluster.length} threads)...`);

    try {
      const mergedTitle = await generateMergedTitle(cluster);
      proposals.push({
        cluster,
        mergedTitle,
        winner: cluster[0], // highest importance / most articles (they're sorted)
        losers: cluster.slice(1)
      });
    } catch (err) {
      console.error(`   ⚠ failed to generate title: ${err.message}`);
    }
  }

  console.log(`\n── merge proposals (first ${SHOW_LIMIT}) ──\n`);
  for (const { cluster, mergedTitle, winner, losers } of proposals.slice(0, SHOW_LIMIT)) {
    console.log(`🔗 Cluster (${cluster.length} threads) → winner: [${winner.id}]`);
    console.log(`   current: "${winner.title}"`);
    for (const loser of losers) {
      console.log(`   merge:   [${loser.id}] "${loser.title}"`);
    }
    console.log(`   ✨ unified: "${mergedTitle}"`);
    console.log("");
  }

  if (proposals.length > SHOW_LIMIT) {
    console.log(`… and ${proposals.length - SHOW_LIMIT} more clusters\n`);
  }

  if (!APPLY) {
    console.log("🔍 dry-run complete. Re-run with --apply to merge.");
    await pool.end();
    return;
  }

  // APPLY: merge articles and metadata
  console.log("⚙️ applying merges...\n");
  let merged = 0, failed = 0;

  for (const { cluster, mergedTitle, winner, losers } of proposals) {
    try {
      // Collect all articles from losers
      const loserIds = losers.map(l => l.id);

      // Move articles from losers to winner
      await pool.query(`
        UPDATE story_thread_articles
        SET thread_id = $1
        WHERE thread_id = ANY($2::int[])
      `, [winner.id, loserIds]);

      // Merge keywords: union of all keywords from cluster
      const mergedKeywords = Array.from(
        new Set(cluster.flatMap(t => t.keywords || []).map(k => String(k || "").toLowerCase().trim()).filter(Boolean))
      );

      // Update winner thread with new title, merged keywords, updated article count
      const newArticleCount = cluster.reduce((sum, t) => sum + (t.article_count || 0), 0);
      await pool.query(`
        UPDATE story_threads
        SET title = $1,
            keywords = $2::text[],
            article_count = $3,
            last_updated_at = NOW()
        WHERE id = $4
      `, [mergedTitle, mergedKeywords, newArticleCount, winner.id]);

      // Mark losers as dormant with article_count = 0
      for (const loser of losers) {
        await pool.query(`
          UPDATE story_threads
          SET status = 'dormant',
              article_count = 0,
              last_updated_at = NOW()
          WHERE id = $1
        `, [loser.id]);
      }

      merged++;
    } catch (err) {
      failed++;
      console.error(`   ⚠ failed to merge cluster: ${err.message}`);
    }
  }

  console.log("");
  console.log("✅ merged: " + merged);
  if (failed) console.log("⚠ failed: " + failed);

  console.log("");
  console.log("═════════════════════════════════════════════");
  console.log("done.");
  console.log("═════════════════════════════════════════════\n");

  await pool.end();
}

main().catch(err => {
  console.error("fatal:", err);
  process.exit(1);
});
