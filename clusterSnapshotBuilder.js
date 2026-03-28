/**
 * clusterSnapshotBuilder.js
 *
 * Builds a precomputed semantic snapshot for the Cluster page.
 *
 * V1 strategy:
 * - Use recent story_threads as the rendered node unit
 * - Enrich each thread with normalized keywords, languages, and countries
 * - Build an explainable similarity graph
 * - Use connected components as cluster groups
 * - Generate deterministic 3D positions via a simple force layout
 * - Persist the snapshot into cluster_runs / cluster_groups / cluster_nodes / cluster_edges
 *
 * Usage:
 *   node clusterSnapshotBuilder.js
 *   node clusterSnapshotBuilder.js --days=7 --limit=300
 *   node clusterSnapshotBuilder.js --preset=3d --days=3
 *   node clusterSnapshotBuilder.js --with-labels
 */

'use strict';

require('dotenv').config();

const pool = require('./db');
const { normalizeRecentKeywords } = require('./keywordNormalizer');

let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (_) {
  Anthropic = null;
}

const args = process.argv.slice(2);

const DAYS = intArg('--days', 7);
const LIMIT = intArg('--limit', 350);
const PRESET = stringArg('--preset', DAYS === 7 ? '7d' : `${DAYS}d`);
const ALGORITHM_VERSION = stringArg('--version', 'cluster-v1');
const WITH_LABELS = args.includes('--with-labels');
const MIN_EDGE_WEIGHT = floatArg('--min-edge', 0.26);
const MAX_KEYWORDS_PER_NODE = intArg('--keywords', 16);
const MAX_EDGES_PER_NODE = intArg('--edges-per-node', 12);
const MAX_LABEL_GROUPS = intArg('--label-groups', 24);
const TITLE_BUCKET_LIMIT = intArg('--title-buckets', 4);
const CANDIDATE_KEYWORD_BUCKET_LIMIT = intArg('--keyword-buckets', 8);
const SEMANTIC_TOKEN_LIMIT = intArg('--semantic-tokens', 14);

const SKIP_KEYWORDS = new Set([
  'government', 'minister', 'president', 'official', 'said', 'year', 'people',
  'new', 'first', 'last', 'will', 'also', 'one', 'two', 'three', 'could', 'would',
  'after', 'before', 'over', 'under', 'says', 'day', 'week', 'month', 'country',
  'world', 'international', 'national', 'local', 'news', 'report', 'according'
]);

const CATEGORY_LIST = new Set([
  'politics', 'economy', 'military', 'diplomacy', 'environment',
  'technology', 'society', 'sports', 'culture'
]);

const aiClient = WITH_LABELS && Anthropic && process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function run() {
  const startedAt = Date.now();
  let runId = null;

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - DAYS * 24 * 60 * 60 * 1000);

  console.log(`\n✨ Cluster Snapshot Builder — ${new Date().toISOString()}`);
  console.log(`   Preset: ${PRESET}`);
  console.log(`   Window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}`);
  console.log(`   Limit:  ${LIMIT}`);
  console.log(`   Labels: ${aiClient ? 'Claude enabled' : 'fallback only'}`);

  try {
    const runRow = await pool.query(`
      INSERT INTO cluster_runs
        (window_start, window_end, preset, status, algorithm_version)
      VALUES ($1, $2, $3, 'running', $4)
      RETURNING id
    `, [windowStart, windowEnd, PRESET, ALGORITHM_VERSION]);
    runId = runRow.rows[0].id;

    const baseThreads = await loadCandidateThreads(windowStart, windowEnd, LIMIT);
    console.log(`   Threads loaded: ${baseThreads.length}`);

    if (!baseThreads.length) {
      await markRunCompleted(runId, 0, 0);
      console.log('   No weekly threads found. Snapshot recorded as empty.\n');
      return;
    }

    const keywordTranslationStats = await normalizeRecentKeywords({
      pool,
      anthropicClient: Anthropic && process.env.ANTHROPIC_API_KEY
        ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
        : null,
      logger: console,
      scope: {
        threadIds: baseThreads.map((thread) => thread.id),
        windowStart,
        windowEnd
      }
    });
    if (keywordTranslationStats) {
      const provider = keywordTranslationStats.provider === 'deepl'
        ? 'DeepL'
        : keywordTranslationStats.provider === 'claude'
          ? 'Claude'
          : null;
      if (provider && keywordTranslationStats.updatedKeywords) {
        console.log(`   ${provider} keyword updates: ${keywordTranslationStats.updatedKeywords} keywords, ${keywordTranslationStats.updatedRows} rows, ${keywordTranslationStats.translatedChars} chars`);
      }
    }

    const enriched = await enrichThreads(baseThreads, windowStart, windowEnd);
    console.log(`   Enriched nodes: ${enriched.length}`);

    const edges = buildSimilarityEdges(enriched);
    console.log(`   Strong edges:   ${edges.length}`);

    const groups = buildGroups(enriched, edges);
    console.log(`   Cluster groups: ${groups.length}`);

    const layout = layoutNodes(enriched, edges, groups);
    applyLayout(enriched, groups, layout);

    await labelGroups(groups, enriched);
    await persistSnapshot(runId, enriched, edges, groups);
    await markRunCompleted(runId, enriched.length, groups.length);

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n✅ Snapshot complete in ${secs}s`);
    console.log(`   run_id=${runId} threads=${enriched.length} groups=${groups.length} edges=${edges.length}\n`);
  } catch (err) {
    if (runId) await markRunFailed(runId, err);
    console.error(`\n❌ Cluster snapshot failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function loadCandidateThreads(windowStart, windowEnd, limit) {
  const { rows } = await pool.query(`
    SELECT
      st.id,
      st.title,
      st.description,
      st.primary_category,
      st.importance,
      st.keywords,
      st.article_count AS lifetime_article_count,
      MIN(a.published_at) AS first_weekly_article_at,
      MAX(a.published_at) AS last_weekly_article_at,
      COUNT(DISTINCT a.id)::int AS weekly_article_count
    FROM story_threads st
    JOIN story_thread_articles sta ON sta.thread_id = st.id
    JOIN news_articles a ON a.id = sta.article_id
    WHERE a.published_at >= $1
      AND a.published_at < $2
      AND COALESCE(st.status, 'active') <> 'archived'
    GROUP BY
      st.id,
      st.title,
      st.description,
      st.primary_category,
      st.importance,
      st.keywords,
      st.article_count
    ORDER BY
      COALESCE(st.importance, 0) DESC,
      COUNT(DISTINCT a.id) DESC,
      MAX(a.published_at) DESC
    LIMIT $3
  `, [windowStart, windowEnd, limit]);

  return rows.map((row) => ({
    id: row.id,
    title: row.title || 'Untitled thread',
    description: row.description || '',
    primary_category: normalizeCategory(row.primary_category),
    importance: clampInt(row.importance, 1, 10, 5),
    thread_keywords: Array.isArray(row.keywords) ? row.keywords : [],
    article_count: Number(row.weekly_article_count) || 0,
    first_published_at: row.first_weekly_article_at,
    last_published_at: row.last_weekly_article_at
  }));
}

async function enrichThreads(baseThreads, windowStart, windowEnd) {
  const threadIds = baseThreads.map((t) => t.id);
  const threadMap = new Map(baseThreads.map((t) => [t.id, {
    ...t,
    story_identity_id: null,
    keywords: new Map(),
    languages: new Map(),
    countries: new Map(),
    article_ids: new Set(),
    title_tokens: titleTokenSet(t.title),
    summary_tokens: textTokenSet(`${t.title} ${t.description}`),
    semantic_tokens: buildSemanticTokenMap(t.title, t.description),
    feature_keywords: [],
    native_feature_keywords: [],
    keyword_vector: {},
    canonical_keyword_vector: {},
    semantic_vector: {},
    native_surface_vector: {},
    normalized_hits: 0,
    raw_hits: 0,
    language_count: 0,
    source_country_count: 0,
    density_score: 0,
    novelty_score: 0,
    position: { x: 0, y: 0, z: 0 },
    radius: 1
  }]));

  const [detailRows, identityRows] = await Promise.all([
    pool.query(`
      SELECT
        sta.thread_id,
        a.id AS article_id,
        a.published_at,
        co.iso_code AS country_iso,
        ak.source_language,
        ak.keyword,
        ak.normalized_keyword,
        LOWER(ak.keyword) AS raw_keyword,
        COALESCE(ak.frequency, 0) AS frequency
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries co ON co.id = a.country_id
      LEFT JOIN article_keywords ak ON ak.article_id = a.id
      WHERE sta.thread_id = ANY($1::int[])
        AND a.published_at >= $2
        AND a.published_at < $3
    `, [threadIds, windowStart, windowEnd]),
    pool.query(`
      SELECT DISTINCT ON (ssl.thread_id)
        ssl.thread_id,
        ssl.story_identity_id
      FROM segment_story_links ssl
      WHERE ssl.thread_id = ANY($1::int[])
      ORDER BY ssl.thread_id, ssl.linked_at DESC
    `, [threadIds])
  ]);

  for (const row of identityRows.rows) {
    const thread = threadMap.get(row.thread_id);
    if (thread) thread.story_identity_id = row.story_identity_id || null;
  }

  for (const row of detailRows.rows) {
    const thread = threadMap.get(row.thread_id);
    if (!thread) continue;

    if (row.article_id) thread.article_ids.add(row.article_id);

    const language = cleanCode(row.source_language);
    if (language) incrementMap(thread.languages, language, 1);

    const country = cleanCode(row.country_iso);
    if (country) incrementMap(thread.countries, country, 1);

    const normalizedKeyword = sanitizeKeyword(row.normalized_keyword);
    const rawKeyword = sanitizeKeyword(row.raw_keyword);
    const frequency = Number(row.frequency) || 1;

    if (normalizedKeyword) {
      incrementMap(thread.keywords, normalizedKeyword, frequency);
      thread.normalized_hits += frequency;
    } else if (rawKeyword) {
      // Keep untranslated raw keywords, but treat them as a weak signal so
      // English thread semantics remain dominant in multilingual clustering.
      incrementMap(thread.keywords, rawKeyword, frequency * rawKeywordWeight(rawKeyword));
      thread.raw_hits += frequency;
    }
  }

  const allKeywordDocs = new Map();
  for (const thread of threadMap.values()) {
    const seen = new Set(thread.keywords.keys());
    for (const keyword of seen) {
      allKeywordDocs.set(keyword, (allKeywordDocs.get(keyword) || 0) + 1);
    }
  }

  const totalThreads = Math.max(threadMap.size, 1);
  for (const thread of threadMap.values()) {
    for (const keyword of thread.thread_keywords || []) {
      const cleaned = sanitizeKeyword(keyword);
      if (cleaned) incrementMap(thread.keywords, cleaned, 1.1);
    }

    const rankedKeywords = [...thread.keywords.entries()]
      .map(([keyword, rawWeight]) => {
        const docs = allKeywordDocs.get(keyword) || 1;
        const idf = Math.log(1 + totalThreads / docs);
        return {
          keyword,
          weight: round4(rawWeight * idf),
          rawWeight
        };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_KEYWORDS_PER_NODE);

    const keywordVector = {};
    const canonicalKeywordVector = {};
    const semanticVector = {};
    const nativeSurfaceVector = {};
    for (const item of rankedKeywords) keywordVector[item.keyword] = item.weight;
    for (const item of rankedKeywords) {
      for (const variant of keywordVariants(item.keyword)) {
        canonicalKeywordVector[variant] = Math.max(canonicalKeywordVector[variant] || 0, item.weight);
      }
    }
    for (const [token, weight] of topEntries(thread.semantic_tokens, SEMANTIC_TOKEN_LIMIT)) {
      semanticVector[token] = round4(weight);
    }
    for (const [keyword, weight] of topEntries(thread.keywords, MAX_KEYWORDS_PER_NODE * 2)) {
      if (!looksEnglishDominant(keyword)) {
        for (const variant of keywordVariants(keyword)) {
          nativeSurfaceVector[variant] = Math.max(nativeSurfaceVector[variant] || 0, round4(weight));
        }
      }
    }

    const languageCount = thread.languages.size;
    const countryCount = thread.countries.size;
    const spread = Math.max(0, languageCount - 1) + Math.max(0, countryCount - 1);
    const articleCount = thread.article_ids.size || thread.article_count;

    thread.article_count = articleCount;
    thread.feature_keywords = rankedKeywords.map((k) => ({
      value: k.keyword,
      weight: k.weight
    }));
    thread.native_feature_keywords = topEntries(thread.keywords, MAX_KEYWORDS_PER_NODE)
      .map(([value, weight]) => ({ value, weight: round4(weight) }))
      .filter((item) => !looksEnglishDominant(item.value))
      .slice(0, 8);
    thread.keyword_vector = keywordVector;
    thread.canonical_keyword_vector = canonicalKeywordVector;
    thread.semantic_vector = semanticVector;
    thread.native_surface_vector = nativeSurfaceVector;
    thread.language_count = languageCount;
    thread.source_country_count = countryCount;
    thread.top_languages = topEntries(thread.languages, 5).map(([value, count]) => ({ value, count }));
    thread.top_countries = topEntries(thread.countries, 5).map(([value, count]) => ({ value, count }));
    thread.density_score = round4(Math.min(1, articleCount / 12));
    thread.novelty_score = round4(Math.min(1, spread / 8));
    thread.radius = round4(1 + Math.min(2.4, Math.sqrt(articleCount) * 0.28 + thread.importance * 0.06));
  }

  return [...threadMap.values()];
}

function buildSimilarityEdges(threads) {
  const pairHints = new Map();
  const keywordBuckets = new Map();
  const canonicalKeywordBuckets = new Map();
  const nativeSurfaceBuckets = new Map();
  const categoryBuckets = new Map();
  const titleBuckets = new Map();
  const identityBuckets = new Map();

  for (const thread of threads) {
    for (const keyword of thread.feature_keywords.slice(0, CANDIDATE_KEYWORD_BUCKET_LIMIT).map((k) => k.value)) {
      pushBucket(keywordBuckets, keyword, thread.id);
      for (const variant of keywordVariants(keyword)) {
        pushBucket(canonicalKeywordBuckets, variant, thread.id);
      }
    }
    for (const keyword of thread.native_feature_keywords.slice(0, 6).map((k) => k.value)) {
      for (const variant of keywordVariants(keyword)) {
        pushBucket(nativeSurfaceBuckets, `native:${variant}`, thread.id);
      }
    }

    if (thread.primary_category) {
      pushBucket(categoryBuckets, `cat:${thread.primary_category}`, thread.id);
    }

    for (const country of thread.top_countries.slice(0, 3).map((c) => c.value)) {
      pushBucket(categoryBuckets, `country:${country}`, thread.id);
    }

    if (thread.story_identity_id) {
      pushBucket(identityBuckets, `identity:${thread.story_identity_id}`, thread.id);
    }

    for (const token of [...thread.title_tokens].slice(0, TITLE_BUCKET_LIMIT)) {
      pushBucket(titleBuckets, `title:${token}`, thread.id);
    }
  }

  addPairsFromBuckets(pairHints, keywordBuckets, 90, 1.25);
  addPairsFromBuckets(pairHints, canonicalKeywordBuckets, 120, 1.5);
  addPairsFromBuckets(pairHints, nativeSurfaceBuckets, 90, 1.85);
  addPairsFromBuckets(pairHints, categoryBuckets, 140, 0.85);
  addPairsFromBuckets(pairHints, titleBuckets, 80, 1.15);
  addPairsFromBuckets(pairHints, identityBuckets, 60, 3);

  const threadById = new Map(threads.map((t) => [t.id, t]));
  const rawEdges = [];

  for (const [pairKey, hintScore] of pairHints.entries()) {
    const [aId, bId] = pairKey.split(':').map(Number);
    const a = threadById.get(aId);
    const b = threadById.get(bId);
    if (!a || !b) continue;

    const score = similarityScore(a, b, hintScore);
    if (score.weight < MIN_EDGE_WEIGHT) continue;
    rawEdges.push(score);
  }

  const byNode = new Map();
  for (const edge of rawEdges) {
    if (!byNode.has(edge.source_thread_id)) byNode.set(edge.source_thread_id, []);
    if (!byNode.has(edge.target_thread_id)) byNode.set(edge.target_thread_id, []);
    byNode.get(edge.source_thread_id).push(edge);
    byNode.get(edge.target_thread_id).push(edge);
  }

  const kept = new Map();
  for (const [threadId, list] of byNode.entries()) {
    list
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_EDGES_PER_NODE)
      .forEach((edge) => {
        kept.set(edgeKey(edge.source_thread_id, edge.target_thread_id), edge);
      });
  }

  return [...kept.values()].sort((a, b) => b.weight - a.weight);
}

function similarityScore(a, b, hintScore) {
  const keywordScore = weightedJaccard(a.keyword_vector, b.keyword_vector);
  const canonicalKeywordScore = weightedJaccard(a.canonical_keyword_vector, b.canonical_keyword_vector);
  const semanticScore = weightedJaccard(a.semantic_vector, b.semantic_vector);
  const nativeSurfaceScore = weightedJaccard(a.native_surface_vector, b.native_surface_vector);
  const categoryScore = a.primary_category && a.primary_category === b.primary_category ? 1 : 0;
  const geographyScore = setOverlap(
    new Set(a.top_countries.map((c) => c.value)),
    new Set(b.top_countries.map((c) => c.value))
  );
  const titleScore = setOverlap(a.title_tokens, b.title_tokens);
  const textScore = setOverlap(a.summary_tokens, b.summary_tokens);
  const languageScore = setOverlap(
    new Set(a.top_languages.map((l) => l.value)),
    new Set(b.top_languages.map((l) => l.value))
  );
  const identityScore = a.story_identity_id && b.story_identity_id && a.story_identity_id === b.story_identity_id ? 1 : 0;
  const strongestKeywordScore = Math.max(keywordScore, canonicalKeywordScore);
  const nonEnglishSignal = Math.max(nativeSurfaceScore, canonicalKeywordScore * nonEnglishCoverageFactor(a, b));

  const weight = round4(Math.max(0, Math.min(1,
    strongestKeywordScore * 0.28 +
    nonEnglishSignal * 0.22 +
    semanticScore * 0.12 +
    keywordScore * 0.08 +
    categoryScore * 0.12 +
    geographyScore * 0.09 +
    languageScore * 0.05 +
    Math.max(titleScore, textScore, identityScore) * 0.13 +
    connectionBonus(a, b, { semanticScore, nativeSurfaceScore, canonicalKeywordScore }) +
    Math.min(0.10, hintScore * 0.012)
  )));

  const reasons = [];
  const sharedKeywords = sharedWeightedKeywords(a.canonical_keyword_vector, b.canonical_keyword_vector, 4);
  for (const keyword of sharedKeywords) reasons.push(`shared_keyword:${keyword}`);
  const sharedSemanticTerms = sharedWeightedKeywords(a.semantic_vector, b.semantic_vector, 3);
  for (const term of sharedSemanticTerms) reasons.push(`semantic_term:${term}`);
  const sharedNativeTerms = sharedWeightedKeywords(a.native_surface_vector, b.native_surface_vector, 3);
  for (const term of sharedNativeTerms) reasons.push(`native_term:${term}`);
  if (categoryScore) reasons.push(`category:${a.primary_category}`);
  if (identityScore) reasons.push(`identity:${a.story_identity_id}`);
  const sharedCountries = sharedItems(
    a.top_countries.map((c) => c.value),
    b.top_countries.map((c) => c.value)
  ).slice(0, 2);
  for (const country of sharedCountries) reasons.push(`country:${country}`);
  const sharedTitleTerms = sharedItems([...a.title_tokens], [...b.title_tokens]).slice(0, 2);
  for (const term of sharedTitleTerms) reasons.push(`title_term:${term}`);
  const sharedTextTerms = sharedItems([...a.summary_tokens], [...b.summary_tokens]).slice(0, 2);
  for (const term of sharedTextTerms) reasons.push(`text_term:${term}`);

  return {
    source_thread_id: Math.min(a.id, b.id),
    target_thread_id: Math.max(a.id, b.id),
    weight,
    reasons
  };
}

function buildGroups(threads, edges) {
  const parent = new Map(threads.map((t) => [t.id, t.id]));
  const find = (x) => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  };
  const union = (a, b) => {
    parent.set(find(a), find(b));
  };

  for (const edge of edges) union(edge.source_thread_id, edge.target_thread_id);

  const groupMap = new Map();
  for (const thread of threads) {
    const root = find(thread.id);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root).push(thread);
  }

  const groups = [];
  const sorted = [...groupMap.values()]
    .sort((a, b) => totalImportance(b) - totalImportance(a));

  sorted.forEach((members, idx) => {
    const clusterId = `g${idx + 1}`;
    const categoryCounts = countValues(members.map((m) => m.primary_category).filter(Boolean));
    const primaryCategory = topCountKey(categoryCounts) || members[0]?.primary_category || 'society';
    const keywordCounts = aggregateKeywordCounts(members);
    const sharedProperties = topEntries(keywordCounts, 5).map(([keyword]) => keyword);

    for (const member of members) member.cluster_id = clusterId;

    groups.push({
      cluster_id: clusterId,
      label: fallbackClusterLabel(primaryCategory, sharedProperties, members),
      summary: fallbackClusterSummary(primaryCategory, sharedProperties, members),
      primary_category: primaryCategory,
      node_count: members.length,
      article_count: members.reduce((sum, m) => sum + m.article_count, 0),
      language_count: new Set(members.flatMap((m) => m.top_languages.map((l) => l.value))).size,
      source_country_count: new Set(members.flatMap((m) => m.top_countries.map((c) => c.value))).size,
      centroid: { x: 0, y: 0, z: 0 },
      spread: 0,
      shared_properties: sharedProperties,
      member_ids: members.map((m) => m.id)
    });
  });

  return groups;
}

function layoutNodes(threads, edges, groups) {
  const positions = new Map();
  const velocities = new Map();
  const adjacency = new Map();

  threads.forEach((thread, idx) => {
    const seed = deterministicSeed(thread.id);
    positions.set(thread.id, {
      x: Math.sin(seed) * 6 + (idx % 9),
      y: Math.cos(seed * 1.7) * 6,
      z: Math.sin(seed * 0.7) * 6 - (idx % 7)
    });
    velocities.set(thread.id, { x: 0, y: 0, z: 0 });
    adjacency.set(thread.id, []);
  });

  edges.forEach((edge) => {
    adjacency.get(edge.source_thread_id)?.push(edge);
    adjacency.get(edge.target_thread_id)?.push(edge);
  });

  const iterations = Math.min(120, 60 + threads.length / 3);
  const repulsion = threads.length > 220 ? 22 : 32;
  const spring = 0.018;
  const damping = 0.82;
  const desiredDistance = 4.6;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < threads.length; i++) {
      const a = threads[i];
      const pa = positions.get(a.id);
      const va = velocities.get(a.id);

      for (let j = i + 1; j < threads.length; j++) {
        const b = threads[j];
        const pb = positions.get(b.id);
        const vb = velocities.get(b.id);

        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dz = pa.z - pb.z;
        let distSq = dx * dx + dy * dy + dz * dz + 0.001;
        let force = repulsion / distSq;
        let invDist = 1 / Math.sqrt(distSq);

        dx *= invDist;
        dy *= invDist;
        dz *= invDist;

        va.x += dx * force;
        va.y += dy * force;
        va.z += dz * force;
        vb.x -= dx * force;
        vb.y -= dy * force;
        vb.z -= dz * force;
      }
    }

    for (const edge of edges) {
      const a = positions.get(edge.source_thread_id);
      const b = positions.get(edge.target_thread_id);
      const va = velocities.get(edge.source_thread_id);
      const vb = velocities.get(edge.target_thread_id);

      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dz = b.z - a.z;
      let dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
      let pull = (dist - desiredDistance) * spring * edge.weight;

      dx /= dist;
      dy /= dist;
      dz /= dist;

      va.x += dx * pull;
      va.y += dy * pull;
      va.z += dz * pull;
      vb.x -= dx * pull;
      vb.y -= dy * pull;
      vb.z -= dz * pull;
    }

    for (const thread of threads) {
      const pos = positions.get(thread.id);
      const vel = velocities.get(thread.id);
      vel.x *= damping;
      vel.y *= damping;
      vel.z *= damping;
      pos.x += vel.x;
      pos.y += vel.y;
      pos.z += vel.z;
    }
  }

  separateGroupCentroids(groups, threads, positions);
  normalizePositions(positions);
  return positions;
}

function applyLayout(threads, groups, positions) {
  const membersByGroup = new Map(groups.map((g) => [g.cluster_id, []]));

  for (const thread of threads) {
    const pos = positions.get(thread.id) || { x: 0, y: 0, z: 0 };
    thread.position = {
      x: round4(pos.x),
      y: round4(pos.y),
      z: round4(pos.z)
    };
    membersByGroup.get(thread.cluster_id)?.push(thread);
  }

  for (const group of groups) {
    const members = membersByGroup.get(group.cluster_id) || [];
    if (!members.length) continue;

    const centroid = members.reduce((acc, m) => {
      acc.x += m.position.x;
      acc.y += m.position.y;
      acc.z += m.position.z;
      return acc;
    }, { x: 0, y: 0, z: 0 });

    centroid.x /= members.length;
    centroid.y /= members.length;
    centroid.z /= members.length;

    let spread = 0;
    for (const member of members) {
      spread += distance3(member.position, centroid);
    }
    spread = members.length ? spread / members.length : 0;

    group.centroid = {
      x: round4(centroid.x),
      y: round4(centroid.y),
      z: round4(centroid.z)
    };
    group.spread = round4(spread);
  }
}

async function labelGroups(groups, threads) {
  if (!groups.length) return;

  if (!aiClient) {
    groups.forEach((group) => {
      group.label = fallbackClusterLabel(group.primary_category, group.shared_properties, memberThreads(group, threads));
      group.summary = fallbackClusterSummary(group.primary_category, group.shared_properties, memberThreads(group, threads));
    });
    return;
  }

  for (const group of groups.slice(0, MAX_LABEL_GROUPS)) {
    try {
      const members = memberThreads(group, threads)
        .sort((a, b) => b.importance - a.importance || b.article_count - a.article_count)
        .slice(0, 6)
        .map((thread) => ({
          title: thread.title,
          category: thread.primary_category,
          importance: thread.importance,
          article_count: thread.article_count,
          keywords: thread.feature_keywords.slice(0, 6).map((k) => k.value)
        }));

      const response = await aiClient.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 220,
        messages: [{
          role: 'user',
          content: `You are writing a plain-English headline for a world-news cluster.

Return ONLY valid JSON:
{
  "label": "news-style headline, max 8 words",
  "summary": "one sentence in plain English, max 24 words",
  "shared_properties": ["3 to 5 concise shared properties"]
}

Rules for "label":
- It must read like a clear news headline about the underlying story.
- Use plain English only.
- Do not use abstract taxonomy terms like "Focus", "Cluster", "Theme", or "Development".
- Do not transliterate or preserve unexplained foreign words unless they are the actual central subject of the story.
- Prefer the actual event, place, people, or issue the stories are about.

Cluster category: ${group.primary_category}
Current shared properties: ${JSON.stringify(group.shared_properties)}
Representative threads: ${JSON.stringify(members)}`
        }]
      });

      const text = response.content?.[0]?.text?.trim() || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const parsed = JSON.parse(match[0]);

      if (parsed.label && typeof parsed.label === 'string') {
        group.label = parsed.label.trim().slice(0, 80);
      }
      if (parsed.summary && typeof parsed.summary === 'string') {
        group.summary = parsed.summary.trim().slice(0, 240);
      }
      if (Array.isArray(parsed.shared_properties) && parsed.shared_properties.length) {
        group.shared_properties = parsed.shared_properties
          .map((v) => String(v).trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 5);
      }
    } catch (err) {
      console.warn(`[clusterSnapshotBuilder] Labeling failed for ${group.cluster_id}: ${err.message}`);
    }
  }
}

async function persistSnapshot(runId, threads, edges, groups) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const group of groups) {
      await client.query(`
        INSERT INTO cluster_groups (
          run_id, cluster_id, label, summary, primary_category,
          node_count, article_count, language_count, source_country_count,
          centroid_x, centroid_y, centroid_z, spread, shared_properties
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13, $14::jsonb
        )
      `, [
        runId,
        group.cluster_id,
        group.label,
        group.summary,
        group.primary_category,
        group.node_count,
        group.article_count,
        group.language_count,
        group.source_country_count,
        group.centroid.x,
        group.centroid.y,
        group.centroid.z,
        group.spread,
        JSON.stringify(group.shared_properties || [])
      ]);
    }

    for (const thread of threads) {
      await client.query(`
        INSERT INTO cluster_nodes (
          run_id, thread_id, story_identity_id, cluster_id,
          title, description, primary_category, importance,
          article_count, language_count, source_country_count,
          feature_keywords, top_countries, top_languages,
          x, y, z, radius, density_score, novelty_score
        )
        VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12::jsonb, $13::jsonb, $14::jsonb,
          $15, $16, $17, $18, $19, $20
        )
      `, [
        runId,
        thread.id,
        thread.story_identity_id,
        thread.cluster_id,
        thread.title,
        thread.description,
        thread.primary_category,
        thread.importance,
        thread.article_count,
        thread.language_count,
        thread.source_country_count,
        JSON.stringify(thread.feature_keywords),
        JSON.stringify(thread.top_countries),
        JSON.stringify(thread.top_languages),
        thread.position.x,
        thread.position.y,
        thread.position.z,
        thread.radius,
        thread.density_score,
        thread.novelty_score
      ]);
    }

    for (const edge of edges) {
      await client.query(`
        INSERT INTO cluster_edges (
          run_id, source_thread_id, target_thread_id, weight, reasons
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `, [
        runId,
        edge.source_thread_id,
        edge.target_thread_id,
        edge.weight,
        JSON.stringify(edge.reasons || [])
      ]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function markRunCompleted(runId, threadCount, groupCount) {
  await pool.query(`
    UPDATE cluster_runs
    SET status = 'completed',
        thread_count = $2,
        group_count = $3,
        completed_at = NOW(),
        error_message = NULL
    WHERE id = $1
  `, [runId, threadCount, groupCount]);
}

async function markRunFailed(runId, err) {
  try {
    await pool.query(`
      UPDATE cluster_runs
      SET status = 'failed',
          completed_at = NOW(),
          error_message = LEFT($2, 2000)
      WHERE id = $1
    `, [runId, String(err?.stack || err?.message || err)]);
  } catch (_) {
    // Ignore secondary failure while already failing.
  }
}

function fallbackClusterLabel(category, sharedProperties, members = []) {
  const representative = members
    .slice()
    .sort((a, b) => b.importance - a.importance || b.article_count - a.article_count)
    .map((member) => String(member.title || '').replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (representative) return representative.slice(0, 80);

  const leading = sharedProperties?.slice(0, 2) || [];
  if (leading.length >= 2) return `${titleCase(leading[0])} ${titleCase(leading[1])}`.slice(0, 80);
  if (leading.length === 1) return `${titleCase(leading[0])} Update`;
  return `${titleCase(category || 'story')} Story`.slice(0, 80);
}

function fallbackClusterSummary(category, sharedProperties, members) {
  const themes = (sharedProperties || []).slice(0, 3).join(', ');
  const memberCount = members?.length || 0;
  const cat = category || 'story';
  if (themes) return `${titleCase(cat)} coverage converges around ${themes} across ${memberCount} connected thread${memberCount === 1 ? '' : 's'}.`;
  return `${titleCase(cat)} coverage forms a connected weekly cluster across ${memberCount} thread${memberCount === 1 ? '' : 's'}.`;
}

function memberThreads(group, threads) {
  const ids = new Set(group.member_ids || []);
  return threads.filter((thread) => ids.has(thread.id));
}

function weightedJaccard(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.size) return 0;
  let minSum = 0;
  let maxSum = 0;
  for (const key of keys) {
    const av = a[key] || 0;
    const bv = b[key] || 0;
    minSum += Math.min(av, bv);
    maxSum += Math.max(av, bv);
  }
  return maxSum > 0 ? minSum / maxSum : 0;
}

function setOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function sharedWeightedKeywords(a, b, limit) {
  return [...Object.keys(a)]
    .filter((key) => b[key] !== undefined)
    .map((key) => [key, Math.min(a[key], b[key])])
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([key]) => key);
}

function sharedItems(a, b) {
  const right = new Set(b);
  return [...new Set(a)].filter((item) => right.has(item));
}

function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function countValues(items) {
  const out = new Map();
  for (const item of items) out.set(item, (out.get(item) || 0) + 1);
  return out;
}

function topCountKey(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function aggregateKeywordCounts(members) {
  const counts = new Map();
  for (const member of members) {
    const source = member.native_feature_keywords.length ? member.native_feature_keywords : member.feature_keywords;
    for (const keyword of source.slice(0, 6)) {
      incrementMap(counts, keyword.value, keyword.weight || 1);
    }
  }
  return counts;
}

function incrementMap(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}

function pushBucket(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function addPairsFromBuckets(pairHints, buckets, maxBucketSize, weightBoost = 1) {
  for (const ids of buckets.values()) {
    const unique = [...new Set(ids)];
    if (unique.length < 2 || unique.length > maxBucketSize) continue;
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = edgeKey(unique[i], unique[j]);
        pairHints.set(key, (pairHints.get(key) || 0) + weightBoost);
      }
    }
  }
}

function edgeKey(a, b) {
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}

function totalImportance(members) {
  return members.reduce((sum, member) => sum + (member.importance || 0) * (member.article_count || 1), 0);
}

function separateGroupCentroids(groups, threads, positions) {
  const membersByGroup = new Map(groups.map((group) => [group.cluster_id, []]));
  for (const thread of threads) membersByGroup.get(thread.cluster_id)?.push(thread.id);

  const centroids = new Map();
  for (const [clusterId, ids] of membersByGroup.entries()) {
    const c = { x: 0, y: 0, z: 0 };
    ids.forEach((id) => {
      const pos = positions.get(id);
      c.x += pos.x;
      c.y += pos.y;
      c.z += pos.z;
    });
    c.x /= ids.length || 1;
    c.y /= ids.length || 1;
    c.z /= ids.length || 1;
    centroids.set(clusterId, c);
  }

  const groupIds = [...membersByGroup.keys()];
  for (let iter = 0; iter < 20; iter++) {
    for (let i = 0; i < groupIds.length; i++) {
      for (let j = i + 1; j < groupIds.length; j++) {
        const aId = groupIds[i];
        const bId = groupIds[j];
        const a = centroids.get(aId);
        const b = centroids.get(bId);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dz = a.z - b.z;
        const distSq = dx * dx + dy * dy + dz * dz + 0.1;
        const minDist = 6.5;
        const dist = Math.sqrt(distSq);
        if (dist >= minDist) continue;

        const push = (minDist - dist) * 0.06;
        dx /= dist || 1;
        dy /= dist || 1;
        dz /= dist || 1;

        a.x += dx * push;
        a.y += dy * push;
        a.z += dz * push;
        b.x -= dx * push;
        b.y -= dy * push;
        b.z -= dz * push;
      }
    }
  }

  for (const [clusterId, ids] of membersByGroup.entries()) {
    const finalCentroid = centroids.get(clusterId);
    const current = { x: 0, y: 0, z: 0 };
    ids.forEach((id) => {
      const pos = positions.get(id);
      current.x += pos.x;
      current.y += pos.y;
      current.z += pos.z;
    });
    current.x /= ids.length || 1;
    current.y /= ids.length || 1;
    current.z /= ids.length || 1;

    const shift = {
      x: finalCentroid.x - current.x,
      y: finalCentroid.y - current.y,
      z: finalCentroid.z - current.z
    };

    ids.forEach((id) => {
      const pos = positions.get(id);
      pos.x += shift.x;
      pos.y += shift.y;
      pos.z += shift.z;
    });
  }
}

function normalizePositions(positions) {
  let maxAbs = 1;
  for (const pos of positions.values()) {
    maxAbs = Math.max(maxAbs, Math.abs(pos.x), Math.abs(pos.y), Math.abs(pos.z));
  }
  const scale = 18 / maxAbs;
  for (const pos of positions.values()) {
    pos.x *= scale;
    pos.y *= scale;
    pos.z *= scale;
  }
}

function distance3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function sanitizeKeyword(value) {
  const keyword = String(value || '').trim().toLowerCase();
  if (!keyword || keyword.length < 3) return null;
  if (/^[0-9]+$/.test(keyword)) return null;
  if (SKIP_KEYWORDS.has(keyword)) return null;
  return keyword;
}

function titleTokenSet(title) {
  return textTokenSet(title);
}

function textTokenSet(text) {
  return new Set(extractTextTokens(text));
}

function extractTextTokens(text) {
  const tokens = [];
  for (const part of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const cleaned = normalizeFolded(part);
    if (cleaned && cleaned.length >= 4 && !SKIP_KEYWORDS.has(cleaned)) tokens.push(cleaned);
  }
  return tokens;
}

function keywordVariants(keyword) {
  const variants = new Set();
  const raw = sanitizeKeyword(keyword);
  if (!raw) return variants;

  variants.add(raw);

  const folded = normalizeFolded(raw);
  if (folded && folded.length >= 3) variants.add(folded);

  for (const token of raw.split(/\s+/)) {
    const cleaned = sanitizeKeyword(token);
    if (cleaned) variants.add(cleaned);
    const foldedToken = normalizeFolded(token);
    if (foldedToken && foldedToken.length >= 3 && !SKIP_KEYWORDS.has(foldedToken)) variants.add(foldedToken);
  }

  return variants;
}

function buildSemanticTokenMap(title, description) {
  const out = new Map();
  const titleTerms = extractTextTokens(title).slice(0, 10);
  const descTerms = extractTextTokens(description).slice(0, 24);

  for (const token of titleTerms) incrementMap(out, token, 2.6);
  for (const token of descTerms) incrementMap(out, token, 1.4);

  return out;
}

function normalizeFolded(value) {
  const out = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return out || null;
}

function connectionBonus(a, b, scores = {}) {
  let bonus = 0;
  if (a.importance >= 8 && b.importance >= 8 && a.primary_category === b.primary_category) bonus += 0.03;
  if (a.article_count >= 12 && b.article_count >= 12 && setOverlap(a.summary_tokens, b.summary_tokens) >= 0.12) bonus += 0.025;
  if (setOverlap(new Set(a.top_countries.map((c) => c.value)), new Set(b.top_countries.map((c) => c.value))) >= 0.34) bonus += 0.02;
  if ((scores.semanticScore ?? weightedJaccard(a.semantic_vector, b.semantic_vector)) >= 0.22) bonus += 0.015;
  if ((scores.nativeSurfaceScore ?? weightedJaccard(a.native_surface_vector, b.native_surface_vector)) >= 0.18) bonus += 0.04;
  if ((scores.canonicalKeywordScore ?? weightedJaccard(a.canonical_keyword_vector, b.canonical_keyword_vector)) >= 0.25
      && nonEnglishCoverageFactor(a, b) >= 0.4) bonus += 0.03;
  return bonus;
}

function rawKeywordWeight(keyword) {
  if (!keyword) return 0;
  if (/^[\x00-\x7F]+$/.test(keyword)) return 0.65;
  const folded = normalizeFolded(keyword);
  if (folded && folded !== keyword && /^[\x00-\x7F]+$/.test(folded)) return 0.55;
  return 0.28;
}

function looksEnglishDominant(keyword) {
  if (!keyword) return false;
  if (/[^ -~]/.test(keyword)) return false;
  const folded = normalizeFolded(keyword);
  if (!folded) return false;
  const parts = folded.split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => /^[a-z0-9'-]+$/.test(part));
}

function nonEnglishCoverageFactor(a, b) {
  const aShare = a.raw_hits / Math.max(1, a.raw_hits + a.normalized_hits);
  const bShare = b.raw_hits / Math.max(1, b.raw_hits + b.normalized_hits);
  return (aShare + bShare) / 2;
}

function normalizeCategory(value) {
  const category = String(value || '').trim().toLowerCase();
  return CATEGORY_LIST.has(category) ? category : 'society';
}

function deterministicSeed(id) {
  return (Number(id) * 9301 + 49297) % 233280 / 233280 * Math.PI * 2;
}

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function cleanCode(value) {
  const out = String(value || '').trim().toUpperCase();
  return out || null;
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function clampInt(value, min, max, fallback) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function intArg(name, fallback) {
  const raw = args.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1];
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function floatArg(name, fallback) {
  const raw = args.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1];
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function stringArg(name, fallback) {
  const raw = args.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1];
  return raw ? String(raw).trim() : fallback;
}

run();
