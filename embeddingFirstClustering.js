// embeddingFirstClustering.js
//
// V2 article-clustering algorithm. Replaces the SQL-keyword first pass
// + keyword normalization with a pure pgvector-driven similarity graph.
// Output is a list of clusters that get sent to Claude for naming /
// categorizing only — not for deciding "is this one story?", which the
// embedding similarity already answered with high confidence.
//
// Pipeline:
//   1. Pull all unthreaded embedded articles in the lookback window.
//   2. For each article, ask pgvector for its top-K nearest neighbors
//      WITHIN the same window above pair-similarity threshold.
//   3. Union-find over the resulting edge list → connected components.
//   4. Frankenstein guard: reject clusters of 3+ where the pair-wise
//      AVERAGE similarity drops below avgThreshold (catches transitive
//      chains where a-b=0.71 and b-c=0.71 but a-c=0.30).
//   5. Return clusters of size ≥ minSize.
//
// Performance: with an HNSW index on news_articles.embedding, each
// k-NN query is O(log n). For 12k articles × 50 neighbors each ≈
// ~600k index lookups in a few seconds. Tractable.
//
// USAGE (programmatic — consumed by storyThreadBuilder):
//   const { clusters, singletons } = await embeddingFirstCluster(pool, {
//     lookbackHours: 24,
//     pairThreshold: 0.70,
//     avgThreshold:  0.70,
//     minClusterSize: 2,
//     timeGateHours: 24,  // candidate neighbors must be within ±N hours
//   });
//
// USAGE (dry-run preview from the CLI):
//   node embeddingFirstClustering.js [--hours=24] [--pair=0.70]

'use strict';

const DEFAULTS = {
  lookbackHours:  parseInt(process.env.EFC_LOOKBACK_HOURS  || '24',   10),
  pairThreshold:  parseFloat(process.env.EFC_PAIR_THRESHOLD || '0.70'),
  avgThreshold:   parseFloat(process.env.EFC_AVG_THRESHOLD  || '0.70'),
  minClusterSize: parseInt(process.env.EFC_MIN_SIZE        || '2',    10),
  topKPerArticle: parseInt(process.env.EFC_TOP_K           || '50',   10),
  timeGateHours:  parseInt(process.env.EFC_TIME_GATE_H     || '36',   10),
};

async function embeddingFirstCluster(pool, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = Date.now();

  // ── Pull candidate articles ─────────────────────────────────────
  // Unthreaded + embedded, in the lookback window. Order by id DESC
  // (proxy for recency) so consistent ties.
  const { rows: articles } = await pool.query(`
    SELECT a.id,
           COALESCE(a.translated_title, a.title)     AS title,
           COALESCE(a.translated_summary, a.summary) AS summary,
           a.source_id,
           a.country_id,
           a.published_at,
           EXTRACT(EPOCH FROM a.published_at)::bigint AS published_ts
      FROM news_articles a
     WHERE a.published_at > NOW() - ($1::int * INTERVAL '1 hour')
       AND a.embedding IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM story_thread_articles WHERE article_id = a.id)
     ORDER BY a.id DESC
  `, [o.lookbackHours]);
  if (!articles.length) return { clusters: [], singletons: [], stats: { ...summary(o), candidates: 0 } };

  const tFetch = Date.now() - t0;
  const candidates = articles.length;

  // ── Build edges via pgvector k-NN ───────────────────────────────
  // For each article, ask pgvector for its top-K cosine-nearest
  // neighbors among the SAME candidate set, above pairThreshold. We
  // gate to ±timeGateHours of the source article's publish time so a
  // generic-language article from last week doesn't spuriously bind to
  // a fresh story.
  //
  // The `1 - (a <=> b)` formulation is the conventional way to recover
  // cosine SIMILARITY from pgvector's cosine DISTANCE operator.
  const candidateIds = articles.map(a => a.id);
  const timeGateSec = o.timeGateHours * 3600;
  const edges = []; // [{a, b, sim}]
  let edgesPulled = 0;
  for (let i = 0; i < articles.length; i++) {
    const seed = articles[i];
    const { rows: neighbors } = await pool.query(`
      SELECT n.id, 1 - (n.embedding <=> a.embedding) AS sim
        FROM news_articles a
        JOIN news_articles n
          ON n.id = ANY($2::int[])
         AND n.id <> $1
         AND ABS(EXTRACT(EPOCH FROM (n.published_at - a.published_at))) <= $3
       WHERE a.id = $1
       ORDER BY n.embedding <=> a.embedding ASC
       LIMIT $4
    `, [seed.id, candidateIds, timeGateSec, o.topKPerArticle]);
    for (const n of neighbors) {
      const sim = Number(n.sim);
      if (sim < o.pairThreshold) break; // sorted ascending by distance → stop on first miss
      if (seed.id < n.id) {
        edges.push({ a: seed.id, b: n.id, sim });
      }
      edgesPulled++;
    }
  }
  const tEdges = Date.now() - t0 - tFetch;

  // ── Union-find over edges ───────────────────────────────────────
  const idToIdx = new Map();
  articles.forEach((a, i) => idToIdx.set(a.id, i));
  const parent = articles.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const r1 = find(a), r2 = find(b); if (r1 !== r2) parent[r1] = r2; };
  for (const e of edges) union(idToIdx.get(e.a), idToIdx.get(e.b));

  // ── Collect groups ──────────────────────────────────────────────
  const groups = new Map();
  for (let i = 0; i < articles.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  // ── Frankenstein guard (avg sim for 3+) ─────────────────────────
  // Pull EVERY pair's similarity within a candidate cluster, average
  // it, reject clusters whose average falls below avgThreshold.
  //
  // The all-pairs sim lookup is the expensive part — we already have
  // SOME edges from the k-NN pass, but not all internal pairs. For
  // clusters of 3+ we re-query pgvector for the remaining pairs (only
  // if the cluster passes the size gate).
  const result = { clusters: [], singletons: [], stats: null };
  let prunedFrankenstein = 0;
  for (const cluster of groups.values()) {
    if (cluster.length < o.minClusterSize) {
      if (cluster.length === 1) result.singletons.push(articles[cluster[0]]);
      continue;
    }
    if (cluster.length === 2) {
      const sim = edges.find(e =>
        (idToIdx.get(e.a) === cluster[0] && idToIdx.get(e.b) === cluster[1]) ||
        (idToIdx.get(e.a) === cluster[1] && idToIdx.get(e.b) === cluster[0])
      )?.sim ?? 0;
      result.clusters.push({
        articles: cluster.map(i => articles[i]),
        size: 2,
        avgSim: sim,
        minSim: sim,
      });
      continue;
    }
    // ≥ 3: compute average pair similarity via a single SQL query
    const ids = cluster.map(i => articles[i].id);
    const { rows: pairs } = await pool.query(`
      WITH ids AS (SELECT unnest($1::int[]) AS id)
      SELECT i1.id AS a, i2.id AS b,
             1 - (n1.embedding <=> n2.embedding) AS sim
        FROM ids i1
        JOIN ids i2 ON i1.id < i2.id
        JOIN news_articles n1 ON n1.id = i1.id
        JOIN news_articles n2 ON n2.id = i2.id
    `, [ids]);
    // sims can hold tens of thousands of pair-similarities for large
    // clusters; `Math.min(...sims)` overflows the JS call stack via
    // Function.prototype.apply's argument limit. Use a manual loop.
    const sims = pairs.map(p => Number(p.sim));
    let sum = 0, min = Infinity;
    for (const s of sims) { sum += s; if (s < min) min = s; }
    const avg = sims.length ? sum / sims.length : 0;
    if (!sims.length) min = 0;
    if (avg < o.avgThreshold) {
      prunedFrankenstein++;
      // The Frankenstein cluster's members fall back to singletons.
      for (const i of cluster) result.singletons.push(articles[i]);
      continue;
    }
    result.clusters.push({
      articles: cluster.map(i => articles[i]),
      size: cluster.length,
      avgSim: avg,
      minSim: min,
    });
  }

  result.stats = {
    ...summary(o),
    candidates,
    edgesPulled,
    rawClusters: groups.size,
    keptClusters: result.clusters.length,
    prunedFrankenstein,
    singletons: result.singletons.length,
    timingMs: { fetch: tFetch, edges: tEdges, total: Date.now() - t0 },
  };
  return result;
}

function summary(o) {
  return {
    lookbackHours:  o.lookbackHours,
    pairThreshold:  o.pairThreshold,
    avgThreshold:   o.avgThreshold,
    minClusterSize: o.minClusterSize,
    topKPerArticle: o.topKPerArticle,
    timeGateHours:  o.timeGateHours,
  };
}

module.exports = { embeddingFirstCluster, DEFAULTS };

// ── CLI dry-run preview ────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const pool = require('./db');
  // parse --foo=bar style overrides
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  const opts = {};
  if (args.hours)  opts.lookbackHours = parseInt(args.hours, 10);
  if (args.pair)   opts.pairThreshold = parseFloat(args.pair);
  if (args.avg)    opts.avgThreshold  = parseFloat(args.avg);
  if (args.min)    opts.minClusterSize = parseInt(args.min, 10);
  if (args.k)      opts.topKPerArticle = parseInt(args.k, 10);
  if (args.gate)   opts.timeGateHours = parseInt(args.gate, 10);
  (async () => {
    console.log('=== embeddingFirstCluster dry-run ===');
    console.log('opts:', { ...DEFAULTS, ...opts });
    console.log('');
    const r = await embeddingFirstCluster(pool, opts);
    console.log('Stats:', JSON.stringify(r.stats, null, 2));
    console.log('');
    console.log(`Found ${r.clusters.length} cluster(s), ${r.singletons.length} singleton(s)`);
    console.log('');
    // Sort by size desc, show top 20
    r.clusters.sort((a, b) => b.size - a.size);
    for (let c = 0; c < Math.min(r.clusters.length, 20); c++) {
      const k = r.clusters[c];
      console.log(`\nCluster ${c+1} — size ${k.size}, avg ${k.avgSim.toFixed(3)}, min ${k.minSim.toFixed(3)}`);
      for (const a of k.articles) {
        console.log(`  [${a.id}] ${(a.title || '').slice(0, 90)}`);
      }
    }
    if (r.clusters.length > 20) console.log(`\n... and ${r.clusters.length - 20} more clusters`);
    // Size histogram
    const sizes = {};
    for (const k of r.clusters) sizes[k.size] = (sizes[k.size] || 0) + 1;
    console.log('\nCluster size histogram:');
    for (const sz of Object.keys(sizes).sort((a, b) => a - b)) {
      console.log(`  size=${sz}: ${sizes[sz]} cluster(s)`);
    }
    await pool.end();
  })().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
}
