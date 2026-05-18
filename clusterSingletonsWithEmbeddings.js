#!/usr/bin/env node
'use strict';

/**
 * clusterSingletonsWithEmbeddings.js
 *
 * Read-only analysis tool. Replays the singleton-clustering decision
 * Claude used to make in storyThreadBuilder.js's singleton batches —
 * but using embeddings + cosine similarity instead. Prints proposed
 * clusters so you can eyeball whether the quality is good enough to
 * wire into production.
 *
 * What it does:
 *
 *   1. Pull recent unthreaded articles (singletons by definition — they
 *      haven't been attached to any thread).
 *   2. For each pair (a, b), compute embedding cosine similarity.
 *   3. Edge passes if:
 *        cosine_similarity >= SIMILARITY_THRESHOLD   (default 0.60)
 *      AND
 *        |published(a) - published(b)| <= RECENCY_WINDOW_DAYS   (default 14)
 *      AND
 *        a and b share at least one named entity   (from article_deep_context;
 *        skipped if either article has no entity data — entity-data sparsity
 *        is itself a signal but we don't want to drop coverage entirely)
 *   4. Union-find on passing edges → clusters of ≥ MIN_CLUSTER_SIZE.
 *   5. For each cluster, print:
 *        - cluster size, time span, country mix
 *        - article titles
 *        - intra-cluster pairwise similarity range (min/avg/max)
 *
 * Output is grouped: largest/strongest clusters first. After eyeballing
 * a few you can decide whether the proposed clusters look like real
 * stories.
 *
 * Knobs:
 *   SIMILARITY_THRESHOLD     default 0.60   (lower = more permissive)
 *   RECENCY_WINDOW_DAYS      default 14
 *   MIN_CLUSTER_SIZE         default 2      (singletons becoming pairs is fine)
 *   LOOKBACK_HOURS           default 24
 *   MAX_CANDIDATES           default 500    (cap total articles to score)
 *   REQUIRE_ENTITY_OVERLAP   default 1      ('0' to disable the entity guard)
 *
 * Examples:
 *   node clusterSingletonsWithEmbeddings.js
 *   SIMILARITY_THRESHOLD=0.55 node clusterSingletonsWithEmbeddings.js
 *   LOOKBACK_HOURS=48 MAX_CANDIDATES=1000 node clusterSingletonsWithEmbeddings.js
 */

require('dotenv').config();
const pool = require('./db');
const { cosine } = require('./embedder');

const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.60');
const RECENCY_WINDOW_DAYS  = parseInt(process.env.RECENCY_WINDOW_DAYS    || '14', 10);
const MIN_CLUSTER_SIZE     = parseInt(process.env.MIN_CLUSTER_SIZE       || '2', 10);
const LOOKBACK_HOURS       = parseInt(process.env.LOOKBACK_HOURS         || '24', 10);
const MAX_CANDIDATES       = parseInt(process.env.MAX_CANDIDATES         || '500', 10);
const REQUIRE_ENTITY       = (process.env.REQUIRE_ENTITY_OVERLAP || '1') === '1';

function unionFind(n) {
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent[a] = b; };
  return { find, union };
}

async function run() {
  const t0 = Date.now();
  console.log(`\nclusterSingletonsWithEmbeddings — ${new Date().toISOString()}`);
  console.log(`  similarity_threshold = ${SIMILARITY_THRESHOLD}`);
  console.log(`  recency_window_days  = ${RECENCY_WINDOW_DAYS}`);
  console.log(`  min_cluster_size     = ${MIN_CLUSTER_SIZE}`);
  console.log(`  lookback_hours       = ${LOOKBACK_HOURS}`);
  console.log(`  max_candidates       = ${MAX_CANDIDATES}`);
  console.log(`  require_entity       = ${REQUIRE_ENTITY}\n`);

  // 1. Pull unthreaded articles with embeddings, recent window.
  //    "Unthreaded" = no row in story_thread_articles. These are the
  //    articles Claude used to chew through in singleton batches.
  console.log(`  Loading candidate singletons…`);
  // iso_code lives on countries (joined via news_articles.country_id),
  // not directly on news_articles.
  const { rows: arts } = await pool.query(`
    SELECT a.id,
           COALESCE(a.translated_title, a.title) AS title,
           a.published_at,
           co.iso_code,
           a.embedding
      FROM news_articles a
      LEFT JOIN countries co ON co.id = a.country_id
     WHERE a.embedding IS NOT NULL
       AND a.published_at > NOW() - ($1::int * INTERVAL '1 hour')
       AND NOT EXISTS (
         SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
       )
     ORDER BY a.published_at DESC
     LIMIT $2
  `, [LOOKBACK_HOURS, MAX_CANDIDATES]);

  console.log(`  Loaded ${arts.length} singleton article(s) with embeddings.`);
  if (arts.length < 2) {
    console.log(`  Not enough candidates to cluster.\n`);
    await pool.end();
    return;
  }

  // 2. Load each article's entities for the entity-overlap guard.
  const ids = arts.map(a => a.id);
  let entitiesByArticle = new Map();
  if (REQUIRE_ENTITY) {
    const { rows: ctxRows } = await pool.query(`
      SELECT article_id, entities
        FROM article_deep_context
       WHERE article_id = ANY($1::int[])
    `, [ids]);
    for (const r of ctxRows) {
      let parsed = null;
      try {
        parsed = typeof r.entities === 'string' ? JSON.parse(r.entities) : r.entities;
      } catch (_) {}
      const list = Array.isArray(parsed) ? parsed : (parsed?.entities || []);
      const set = new Set();
      for (const e of list) {
        if (!e?.text) continue;
        set.add(String(e.text).toLowerCase().trim());
      }
      entitiesByArticle.set(Number(r.article_id), set);
    }
    const withEntities = arts.filter(a => entitiesByArticle.get(a.id)?.size > 0).length;
    console.log(`  ${withEntities}/${arts.length} articles have entity data.\n`);
  }

  // 3. pgvector returns embeddings as a *string* like '[0.123,-0.456,...]'.
  //    Parse those into Float32Array for in-process cosine.
  const vectors = arts.map(a => {
    const str = a.embedding;
    if (Array.isArray(str)) return Float32Array.from(str);
    if (typeof str !== 'string') return null;
    const inner = str.replace(/^\[/, '').replace(/\]$/, '');
    const parts = inner.split(',');
    return Float32Array.from(parts, parseFloat);
  });
  const valid = vectors.every(v => v && v.length > 0);
  if (!valid) {
    console.error('  Some embeddings failed to parse — aborting.');
    await pool.end();
    return;
  }

  // 4. All-pairs cosine. O(n²) — fine for n<=500.
  //    Edge passes if cosine>=threshold AND recency window AND entity overlap.
  const RECENCY_MS = RECENCY_WINDOW_DAYS * 86400 * 1000;
  const uf = unionFind(arts.length);
  const edges = [];
  for (let i = 0; i < arts.length; i++) {
    for (let j = i + 1; j < arts.length; j++) {
      const sim = cosine(vectors[i], vectors[j]);
      if (sim < SIMILARITY_THRESHOLD) continue;
      // Recency window — singletons published 30 days apart aren't the
      // same breaking story even if vector-similar.
      const ti = new Date(arts[i].published_at).getTime();
      const tj = new Date(arts[j].published_at).getTime();
      if (Math.abs(ti - tj) > RECENCY_MS) continue;
      // Entity-overlap guard.
      if (REQUIRE_ENTITY) {
        const ei = entitiesByArticle.get(arts[i].id) || new Set();
        const ej = entitiesByArticle.get(arts[j].id) || new Set();
        if (ei.size > 0 && ej.size > 0) {
          let shared = 0;
          const [small, big] = ei.size <= ej.size ? [ei, ej] : [ej, ei];
          for (const e of small) if (big.has(e)) { shared++; break; }
          if (shared === 0) continue;
        }
        // If either side has no entity data, fall through — we don't want
        // to drop every multilingual / non-enriched article from clustering.
      }
      uf.union(i, j);
      edges.push({ i, j, sim });
    }
  }

  // 5. Collect clusters.
  const clusters = new Map();
  for (let i = 0; i < arts.length; i++) {
    const root = uf.find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  // Frankenstein guard. Naive union-find chains: pair (a,b)=0.7 and
  // (b,c)=0.7 unionize {a,b,c} even when (a,c) is 0.05 — exactly the
  // problem the SQL Jaccard MIN_SHARED_KW=3 floor caught with the
  // bumped-up threshold. For embeddings we re-enforce it as a
  // post-pass: a cluster is kept only if its AVERAGE pairwise
  // similarity is also above threshold. Outliers that chained in via
  // a single strong-edge link get rejected. This isn't quite as
  // strict as "all pairs must pass" (which would over-filter) but
  // catches the worst transitive false-merges.
  const CLUSTER_AVG_THRESHOLD = SIMILARITY_THRESHOLD;
  const clusterList = [];
  for (const cluster of clusters.values()) {
    if (cluster.length < MIN_CLUSTER_SIZE) continue;
    if (cluster.length === 2) {
      clusterList.push(cluster);
      continue;
    }
    // Compute average pairwise sim for clusters of 3+. Bail if too low.
    let sum = 0, count = 0;
    for (let a = 0; a < cluster.length; a++) {
      for (let b = a + 1; b < cluster.length; b++) {
        sum += cosine(vectors[cluster[a]], vectors[cluster[b]]);
        count++;
      }
    }
    const avgSim = count ? sum / count : 0;
    if (avgSim >= CLUSTER_AVG_THRESHOLD) clusterList.push(cluster);
  }
  clusterList.sort((a, b) => b.length - a.length);

  console.log(`━━━ Found ${clusterList.length} cluster(s) (≥${MIN_CLUSTER_SIZE} articles each) ━━━\n`);
  console.log(`  total singletons clustered: ${clusterList.reduce((s, c) => s + c.length, 0)}`);
  console.log(`  total singletons left as singletons: ${arts.length - clusterList.reduce((s, c) => s + c.length, 0)}\n`);

  // 6. Print each cluster with stats + sample titles.
  for (let ci = 0; ci < clusterList.length; ci++) {
    const idxs = clusterList[ci];
    const members = idxs.map(i => arts[i]);
    // Compute intra-cluster similarity stats.
    const intraEdges = [];
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        intraEdges.push(cosine(vectors[idxs[a]], vectors[idxs[b]]));
      }
    }
    intraEdges.sort();
    const minSim = intraEdges[0] || 1;
    const maxSim = intraEdges[intraEdges.length - 1] || 1;
    const avgSim = intraEdges.length
      ? intraEdges.reduce((s, v) => s + v, 0) / intraEdges.length
      : 1;
    // Time span + country mix.
    const times = members.map(m => new Date(m.published_at).getTime());
    const spanH = (Math.max(...times) - Math.min(...times)) / 3600 / 1000;
    const countries = new Set(members.map(m => m.iso_code).filter(Boolean));

    console.log(`──── Cluster #${ci + 1}  size=${idxs.length}  span=${spanH.toFixed(1)}h  countries=[${[...countries].join(',') || '?'}]`);
    console.log(`     sim: min=${minSim.toFixed(2)} avg=${avgSim.toFixed(2)} max=${maxSim.toFixed(2)}`);
    for (const m of members.slice(0, 10)) {
      console.log(`     # ${String(m.id).padStart(8)}  ${m.iso_code || '??'}  ${new Date(m.published_at).toISOString().slice(0,16)}  "${(m.title || '').slice(0, 100)}"`);
    }
    if (members.length > 10) console.log(`     ...and ${members.length - 10} more`);
    console.log('');
  }

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

run().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
