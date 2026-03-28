-- Cluster page snapshot cache
-- Stores precomputed weekly semantic cluster runs so the frontend can load
-- a stable 3D dataset without doing live clustering on page request.

CREATE TABLE IF NOT EXISTS cluster_runs (
  id                SERIAL PRIMARY KEY,
  window_start      TIMESTAMPTZ NOT NULL,
  window_end        TIMESTAMPTZ NOT NULL,
  preset            TEXT        NOT NULL DEFAULT '7d',
  status            TEXT        NOT NULL DEFAULT 'running'
                                 CHECK (status IN ('running', 'completed', 'failed')),
  algorithm_version TEXT        NOT NULL,
  thread_count      INT         NOT NULL DEFAULT 0,
  group_count       INT         NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  error_message     TEXT,
  CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS idx_cluster_runs_lookup
  ON cluster_runs (preset, status, completed_at DESC, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cluster_runs_window
  ON cluster_runs (window_start DESC, window_end DESC);


CREATE TABLE IF NOT EXISTS cluster_groups (
  id                   SERIAL PRIMARY KEY,
  run_id               INT              NOT NULL REFERENCES cluster_runs(id) ON DELETE CASCADE,
  cluster_id           TEXT             NOT NULL,
  label                TEXT             NOT NULL,
  summary              TEXT,
  primary_category     TEXT,
  node_count           INT              NOT NULL DEFAULT 0,
  article_count        INT              NOT NULL DEFAULT 0,
  language_count       INT              NOT NULL DEFAULT 0,
  source_country_count INT              NOT NULL DEFAULT 0,
  centroid_x           DOUBLE PRECISION NOT NULL,
  centroid_y           DOUBLE PRECISION NOT NULL,
  centroid_z           DOUBLE PRECISION NOT NULL,
  spread               DOUBLE PRECISION NOT NULL DEFAULT 0,
  shared_properties    JSONB            NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_groups_run_size
  ON cluster_groups (run_id, node_count DESC, article_count DESC);


CREATE TABLE IF NOT EXISTS cluster_nodes (
  id                   SERIAL PRIMARY KEY,
  run_id               INT              NOT NULL REFERENCES cluster_runs(id) ON DELETE CASCADE,
  thread_id            INT              NOT NULL REFERENCES story_threads(id) ON DELETE CASCADE,
  story_identity_id    INT                  REFERENCES story_identities(id) ON DELETE SET NULL,
  cluster_id           TEXT             NOT NULL,
  title                TEXT             NOT NULL,
  description          TEXT,
  primary_category     TEXT,
  importance           INT,
  article_count        INT              NOT NULL DEFAULT 0,
  language_count       INT              NOT NULL DEFAULT 0,
  source_country_count INT              NOT NULL DEFAULT 0,
  feature_keywords     JSONB            NOT NULL DEFAULT '[]'::jsonb,
  top_countries        JSONB            NOT NULL DEFAULT '[]'::jsonb,
  top_languages        JSONB            NOT NULL DEFAULT '[]'::jsonb,
  x                    DOUBLE PRECISION NOT NULL,
  y                    DOUBLE PRECISION NOT NULL,
  z                    DOUBLE PRECISION NOT NULL,
  radius               DOUBLE PRECISION NOT NULL DEFAULT 1,
  density_score        DOUBLE PRECISION NOT NULL DEFAULT 0,
  novelty_score        DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, thread_id),
  FOREIGN KEY (run_id, cluster_id)
    REFERENCES cluster_groups(run_id, cluster_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cluster_nodes_run_cluster
  ON cluster_nodes (run_id, cluster_id);

CREATE INDEX IF NOT EXISTS idx_cluster_nodes_run_importance
  ON cluster_nodes (run_id, importance DESC, article_count DESC);


CREATE TABLE IF NOT EXISTS cluster_edges (
  id                SERIAL PRIMARY KEY,
  run_id            INT              NOT NULL REFERENCES cluster_runs(id) ON DELETE CASCADE,
  source_thread_id  INT              NOT NULL REFERENCES story_threads(id) ON DELETE CASCADE,
  target_thread_id  INT              NOT NULL REFERENCES story_threads(id) ON DELETE CASCADE,
  weight            DOUBLE PRECISION NOT NULL,
  reasons           JSONB            NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, source_thread_id, target_thread_id),
  CHECK (source_thread_id <> target_thread_id),
  CHECK (weight >= 0 AND weight <= 1)
);

CREATE INDEX IF NOT EXISTS idx_cluster_edges_run_weight
  ON cluster_edges (run_id, weight DESC);

CREATE INDEX IF NOT EXISTS idx_cluster_edges_run_source
  ON cluster_edges (run_id, source_thread_id);

CREATE INDEX IF NOT EXISTS idx_cluster_edges_run_target
  ON cluster_edges (run_id, target_thread_id);
