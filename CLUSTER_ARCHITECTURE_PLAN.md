# Cluster Page Architecture Plan

## Goal

Add a fourth page, `cluster`, that presents the last 7 days of stories as a 3D semantic space. Stories should gather into visible clusters based on shared properties, with language normalized so coverage of the same story from different countries can appear together.

This page should reuse the current story and keyword pipeline wherever possible:

- `storyThreadBuilder.js` already compresses raw articles into story threads.
- `normalizeKeywords.js` already translates many non-English keywords into English.
- `storyTracker.js` already provides persistent story identity logic.
- `index.html` already contains the multi-page shell and 3D rendering patterns.

The main design principle is: **cluster on top of existing story objects, not raw articles**.

## Product Intent

The `cluster` page should answer:

- What major story groupings defined the last week?
- Which stories are globally shared versus regionally isolated?
- Which clusters are multilingual and cross-border?
- Why are these stories grouped together?

The page is not just a prettier feed. It is a semantic map.

## Recommended Unit Of Visualization

### V1 node type: `story_threads`

Use `story_threads` as the rendered node in V1.

Why:

- They already represent compressed groups of articles.
- They are time-bounded and map well to a weekly view.
- They already contain title, description, category, importance, and keywords.
- They are cheaper and less risky to use than article-level clustering.

### Later upgrade: `story_identities`

Once continuity quality is proven, we can optionally upgrade some clustering logic to use `story_identities` for multi-day continuity across weeks.

For the first version, `story_identities` should be treated as an enrichment source, not the primary rendered object.

## Existing Reusable Inputs

### Article-level

- `news_articles`
- `article_keywords`
- `article_keywords.normalized_keyword`
- translated title and summary fields already used elsewhere

### Thread-level

- `story_threads`
- `story_thread_articles`

### Continuity-level

- `story_identities`
- `segment_story_links`

## Core Architecture

The system should be split into four layers:

1. Source layer
- Raw articles and extracted keywords.

2. Story compression layer
- Existing `story_threads` remain the first-pass semantic grouping.

3. Weekly cluster snapshot layer
- A new batch job computes a weekly clustering snapshot for a fixed time window.

4. Rendering/API layer
- The `cluster` page reads the latest completed snapshot and renders it directly.

This avoids doing expensive clustering live on every page load.

## Snapshot Strategy

The `cluster` page should read from a precomputed snapshot, not live pairwise queries.

Benefits:

- Stable user experience for the same time window
- Faster page loads
- Easier debugging and tuning
- Ability to version the algorithm over time
- Safer use of Claude as a final refinement step rather than an online dependency

## Time Window

Default window:

- `window_end = now`
- `window_start = now - interval '7 days'`

Supported presets later:

- 24 hours
- 3 days
- 7 days

V1 should optimize first for `7 days`.

## New Data Model

### 1. `cluster_runs`

Tracks each clustering snapshot run.

Suggested columns:

- `id SERIAL PRIMARY KEY`
- `window_start TIMESTAMPTZ NOT NULL`
- `window_end TIMESTAMPTZ NOT NULL`
- `preset TEXT NOT NULL DEFAULT '7d'`
- `status TEXT NOT NULL CHECK (status IN ('running','completed','failed'))`
- `algorithm_version TEXT NOT NULL`
- `thread_count INT NOT NULL DEFAULT 0`
- `group_count INT NOT NULL DEFAULT 0`
- `started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `completed_at TIMESTAMPTZ`
- `error_message TEXT`

Indexes:

- `(preset, status, completed_at DESC)`
- `(window_start, window_end)`

### 2. `cluster_nodes`

One rendered node per story thread in the snapshot.

Suggested columns:

- `id SERIAL PRIMARY KEY`
- `run_id INT NOT NULL REFERENCES cluster_runs(id) ON DELETE CASCADE`
- `thread_id INT NOT NULL REFERENCES story_threads(id) ON DELETE CASCADE`
- `story_identity_id INT REFERENCES story_identities(id)`
- `cluster_id TEXT NOT NULL`
- `title TEXT NOT NULL`
- `description TEXT`
- `primary_category TEXT`
- `importance INT`
- `article_count INT NOT NULL DEFAULT 0`
- `language_count INT NOT NULL DEFAULT 0`
- `source_country_count INT NOT NULL DEFAULT 0`
- `feature_keywords JSONB NOT NULL DEFAULT '[]'::jsonb`
- `top_countries JSONB NOT NULL DEFAULT '[]'::jsonb`
- `top_languages JSONB NOT NULL DEFAULT '[]'::jsonb`
- `x DOUBLE PRECISION NOT NULL`
- `y DOUBLE PRECISION NOT NULL`
- `z DOUBLE PRECISION NOT NULL`
- `radius DOUBLE PRECISION NOT NULL DEFAULT 1`
- `density_score DOUBLE PRECISION NOT NULL DEFAULT 0`
- `novelty_score DOUBLE PRECISION NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Constraints and indexes:

- `UNIQUE (run_id, thread_id)`
- index on `(run_id, cluster_id)`
- index on `(run_id, importance DESC)`

### 3. `cluster_groups`

One row per cluster cloud or topic neighborhood.

Suggested columns:

- `id SERIAL PRIMARY KEY`
- `run_id INT NOT NULL REFERENCES cluster_runs(id) ON DELETE CASCADE`
- `cluster_id TEXT NOT NULL`
- `label TEXT NOT NULL`
- `summary TEXT`
- `primary_category TEXT`
- `node_count INT NOT NULL DEFAULT 0`
- `article_count INT NOT NULL DEFAULT 0`
- `language_count INT NOT NULL DEFAULT 0`
- `source_country_count INT NOT NULL DEFAULT 0`
- `centroid_x DOUBLE PRECISION NOT NULL`
- `centroid_y DOUBLE PRECISION NOT NULL`
- `centroid_z DOUBLE PRECISION NOT NULL`
- `spread DOUBLE PRECISION NOT NULL DEFAULT 0`
- `shared_properties JSONB NOT NULL DEFAULT '[]'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Constraints and indexes:

- `UNIQUE (run_id, cluster_id)`
- index on `(run_id, node_count DESC)`

### 4. `cluster_edges`

Stores sparse similarity edges for hover and local neighborhood exploration.

Suggested columns:

- `id SERIAL PRIMARY KEY`
- `run_id INT NOT NULL REFERENCES cluster_runs(id) ON DELETE CASCADE`
- `source_thread_id INT NOT NULL REFERENCES story_threads(id) ON DELETE CASCADE`
- `target_thread_id INT NOT NULL REFERENCES story_threads(id) ON DELETE CASCADE`
- `weight DOUBLE PRECISION NOT NULL`
- `reasons JSONB NOT NULL DEFAULT '[]'::jsonb`

Constraints and indexes:

- `UNIQUE (run_id, source_thread_id, target_thread_id)`
- index on `(run_id, weight DESC)`

### 5. Optional `cluster_articles`

Only add this if the frontend needs direct article drill-down without another join.

Suggested columns:

- `run_id`
- `thread_id`
- `article_id`
- `membership_score`

This can likely wait until V2.

## Feature Construction

Each weekly node should be created from a single `story_thread`, enriched from linked articles.

### Base thread features

- `story_threads.title`
- `story_threads.description`
- `story_threads.primary_category`
- `story_threads.importance`
- `story_threads.keywords`
- `story_threads.article_count`

### Enrichment from joined articles

- language distribution from `article_keywords.source_language`
- source-country distribution from `news_articles` and `news_sources`
- article recency spread
- translated title and summary fallback

### Node feature object

Each thread should produce an internal feature object like:

```json
{
  "thread_id": 123,
  "story_identity_id": 42,
  "keywords": [
    { "value": "tariffs", "weight": 0.93 },
    { "value": "trade war", "weight": 0.88 },
    { "value": "wto", "weight": 0.61 }
  ],
  "category": "economy",
  "importance": 8,
  "languages": ["en", "zh", "ar"],
  "source_countries": ["US", "CN", "AE"],
  "article_count": 14,
  "published_span_hours": 41
}
```

## Similarity Model

V1 should use an explainable weighted similarity score, not opaque embeddings.

### Recommended score

- `0.55` keyword similarity
- `0.20` category similarity
- `0.15` geography overlap
- `0.10` title/summary semantic fallback

### 1. Keyword similarity

Use weighted overlap on normalized keywords:

- prefer `normalized_keyword`
- fallback to raw keyword only when no normalized value exists
- discount generic words already filtered in threading logic
- optionally apply TF-IDF style downweighting for globally common terms

Good candidates:

- weighted Jaccard
- cosine similarity on keyword-weight vectors

### 2. Category similarity

Simple boost if `primary_category` matches.

This keeps clusters more interpretable and prevents unrelated global stories from collapsing into one cloud just because they share vague keywords.

### 3. Geography overlap

Use shared or nearby source-country/about-country signals to distinguish:

- a globally distributed topic
- a regionally concentrated topic
- two unrelated stories using similar policy or conflict vocabulary

### 4. Title or summary fallback

Do not use article-level LLM comparison at scale.

Instead:

- compare normalized thread title text
- compare translated summaries if present
- reserve Claude for only borderline merge or labeling cases

## Clustering Algorithm

### V1 approach: graph-based clustering

1. Build one feature vector per weekly thread.
2. Compute pairwise similarity only among plausible candidates.
3. Keep edges above a threshold.
4. Run graph clustering.
5. Generate 3D positions from force-directed layout.

### Candidate pruning before pairwise scoring

Do not compare every thread to every other thread.

Only compare threads that share at least one of:

- top normalized keyword
- primary category
- country overlap
- story identity link

This keeps compute manageable.

### Grouping options

Preferred V1 option:

- connected components on a thresholded graph

Better V1.5 option:

- Louvain or Leiden-style community detection

Simplest start:

- threshold graph at `similarity >= X`
- connected components become cluster groups
- split oversized groups with a stricter secondary threshold

## 3D Layout Strategy

The layout should be deterministic for a given run.

### Node placement

- Run a force layout on the sparse similarity graph.
- Strong edges pull nodes closer.
- Weakly connected nodes drift outward.
- Large groups get more physical space.

### Cluster placement

After node layout:

- compute group centroids
- normalize positions into a bounded 3D cube or sphere
- reserve visual margin between large clouds

### Rendering semantics

- node size = article count or importance
- node color = primary category
- glow intensity = importance
- cloud radius = group spread
- thin local edges shown only on hover or focus

## Claude Usage Strategy

Claude should refine the output, not drive the entire clustering process.

### Good uses

- cluster label generation
- one-paragraph cluster summary
- shared-properties list generation
- tie-break verification for borderline merges

### Avoid

- article-to-article pairwise comparison at scale
- full re-clustering using LLM-only logic
- online dependency during page load

### Example refinement pass

For each final cluster group, send Claude:

- top 5 thread titles
- top keywords
- category distribution
- country/language spread

Ask for:

- short label
- short summary
- 3 to 5 shared properties

This is cheap and aligned with the existing Claude investment.

## Batch Pipeline

Add a new job, for example `clusterSnapshotBuilder.js`.

### Pipeline stages

1. Create `cluster_runs` row with `status='running'`.
2. Load candidate threads from the last 7 days.
3. Enrich each thread with keyword, language, country, and identity data.
4. Compute pairwise similarity for pruned candidate pairs.
5. Build graph and detect groups.
6. Compute 3D layout coordinates.
7. Optionally ask Claude to label each final group.
8. Write `cluster_groups`, `cluster_nodes`, and `cluster_edges`.
9. Mark run `completed`.

### Scheduling

Recommended cadence:

- every 6 hours for the default 7-day preset

This keeps the page fresh without rebuilding continuously.

## API Contract

### 1. `GET /api/clusters/weekly`

Primary endpoint for page load.

Query params:

- `preset=7d`
- optional `runId`
- optional filters later: `category`, `minImportance`, `country`, `language`

Example response:

```json
{
  "run": {
    "id": 17,
    "preset": "7d",
    "window_start": "2026-03-20T00:00:00.000Z",
    "window_end": "2026-03-27T00:00:00.000Z",
    "algorithm_version": "cluster-v1"
  },
  "groups": [
    {
      "cluster_id": "economy-3",
      "label": "Trade Pressure Spiral",
      "summary": "Tariff, export, and retaliation stories converged across several markets.",
      "primary_category": "economy",
      "node_count": 12,
      "article_count": 97,
      "language_count": 8,
      "source_country_count": 14,
      "centroid": { "x": 12.2, "y": -4.1, "z": 7.8 },
      "spread": 5.6,
      "shared_properties": ["tariffs", "export controls", "retaliation"]
    }
  ],
  "nodes": [
    {
      "thread_id": 123,
      "story_identity_id": 42,
      "cluster_id": "economy-3",
      "title": "China and US tariff escalation",
      "primary_category": "economy",
      "importance": 8,
      "article_count": 14,
      "language_count": 5,
      "source_country_count": 7,
      "feature_keywords": ["tariffs", "trade war", "wto"],
      "position": { "x": 11.3, "y": -3.8, "z": 9.1 },
      "radius": 1.8,
      "density_score": 0.77,
      "novelty_score": 0.33
    }
  ],
  "edges": [
    {
      "source_thread_id": 123,
      "target_thread_id": 219,
      "weight": 0.71,
      "reasons": ["shared_keyword:tariffs", "category:economy"]
    }
  ]
}
```

### 2. `GET /api/clusters/thread/:threadId`

Returns drill-down details for one node.

Suggested payload:

- thread metadata
- top articles
- keyword distribution
- languages
- source-country distribution
- neighboring threads in same cluster

### 3. `GET /api/clusters/group/:clusterId`

Returns drill-down details for a cluster cloud.

Suggested payload:

- group metadata
- member nodes
- aggregate properties
- representative articles or anchor threads

## Frontend Integration

The current app shell in `index.html` uses a fixed page track and nav dots. The `cluster` page should become page index `3`, expanding the app from 3 pages to 4:

- `0 = stats`
- `1 = globe`
- `2 = feed`
- `3 = cluster`

### Frontend state

Create a dedicated cluster page state object, for example:

```js
window.__clusterState = {
  run: null,
  groups: [],
  nodes: [],
  edges: [],
  selectedClusterId: null,
  selectedThreadId: null,
  hoveredThreadId: null,
  filters: {
    category: "all",
    minImportance: 0,
    languageMode: "all"
  }
};
```

### Rendering

Preferred V1 rendering:

- independent Three.js scene for cluster page
- soft volumetric cloud per group
- glowing point sprite or sphere per node
- labels only on hover or selection
- edge lines rendered only for selected or hovered neighborhoods

### Interactions

V1 interactions:

- orbit camera
- hover node for tooltip
- click node to open thread panel
- click cluster cloud to isolate group
- filter by category and importance
- toggle between 24h, 3d, 7d later

## Page UX Requirements

The page should communicate both structure and explanation.

Each hover or selection state should answer:

- what is this node?
- why is it here?
- what cluster does it belong to?
- how global is it?

Suggested node tooltip fields:

- thread title
- cluster label
- article count
- languages
- source countries
- top 3 shared properties

## Explainability Rules

Every cluster relationship should be explainable from stored data.

At minimum, keep machine-readable reasons for strong edges:

- shared normalized keyword
- same category
- source-country overlap
- identity continuity link

This is important both for product trust and for debugging tuning issues.

## Performance Targets

V1 target bounds:

- 150 to 500 nodes per 7-day run
- sparse edge graph only
- payload under roughly 1.5 MB compressed
- page load from snapshot API, not live clustering

If the candidate set is too large:

- keep only top weekly threads by importance and article count
- collapse low-signal singletons
- omit low-weight edges from API response

## Recommended Implementation Order

### Phase 1: schema and snapshot builder

- add migration for cluster tables
- implement weekly snapshot builder job
- write latest-snapshot read query

### Phase 2: API

- add `/api/clusters/weekly`
- add thread and cluster detail endpoints

### Phase 3: page shell

- add fourth page and nav dot
- add basic loading and empty states

### Phase 4: 3D visualization

- render nodes and groups
- add hover and selection
- add right-side or bottom detail panel

### Phase 5: Claude refinement

- label clusters
- generate shared properties
- improve summaries

### Phase 6: tuning

- adjust thresholds
- tune graph density
- evaluate thread versus identity grouping

## Open Decisions

These are the only major decisions still worth confirming before implementation:

1. Should V1 render every weekly thread or only the top N threads by importance and article volume?
2. Should the detail click open the existing article panel style or a cluster-specific panel?
3. Should category color be fixed across the app so `feed`, `globe`, and `cluster` share one semantic palette?

## Recommendation

Proceed with this implementation stance:

- render `story_threads` in V1
- build precomputed 7-day snapshots
- use normalized keywords as the primary multilingual bridge
- use graph-based clustering with explainable similarity
- use Claude only for cluster labeling and final refinement

That gets us a high-quality first version without adding embedding infrastructure or duplicating the existing story pipeline.
