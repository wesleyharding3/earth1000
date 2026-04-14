-- Manual ranking overrides + preference learning for threads and timelines
--
-- ranking_overrides: stores explicit position pins from the editor
-- ranking_feedback: logs every manual adjustment so a model can learn patterns
-- ranking_model_weights: persisted learned weights for ranking features

-- ── Explicit rank overrides ──────────────────────────────────────────────────
-- When an admin manually repositions a thread or timeline, the override
-- persists until cleared. Overrides are absolute positions (1 = top).
CREATE TABLE IF NOT EXISTS ranking_overrides (
  id          SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('thread', 'timeline')),
  entity_id   INTEGER NOT NULL,
  pinned_rank INTEGER,           -- absolute position (1 = top), NULL = unpinned
  boost       REAL DEFAULT 0,    -- additive boost to importance (+/- fractional)
  pinned_by   TEXT,              -- admin identifier
  pinned_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (entity_type, entity_id)
);

-- ── Feedback log (training data for preference learning) ─────────────────────
-- Every manual adjustment is logged with the entity's features at the time
-- of the change. This provides labeled (old_rank → new_rank) pairs that a
-- simple model can learn from.
CREATE TABLE IF NOT EXISTS ranking_feedback (
  id            SERIAL PRIMARY KEY,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('thread', 'timeline')),
  entity_id     INTEGER NOT NULL,
  old_rank      INTEGER,
  new_rank      INTEGER,
  old_importance REAL,
  new_importance REAL,
  -- Feature snapshot at time of feedback
  article_count     INTEGER,
  source_count      INTEGER,
  breaking_signal   REAL,
  category          TEXT,
  status            TEXT,
  age_hours         REAL,     -- hours since last_updated_at
  -- Context
  feedback_by   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ranking_feedback_entity
  ON ranking_feedback (entity_type, entity_id, created_at DESC);

-- ── Learned model weights ────────────────────────────────────────────────────
-- Stores feature weights learned from feedback. The model is a simple linear
-- scoring function: score = sum(weight_i * feature_i). Retrained periodically.
CREATE TABLE IF NOT EXISTS ranking_model_weights (
  id            SERIAL PRIMARY KEY,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('thread', 'timeline')),
  feature_name  TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  sample_count  INTEGER DEFAULT 0,  -- how many feedback samples informed this
  UNIQUE (entity_type, feature_name)
);

-- Seed initial weights (prior beliefs, overridden by learning)
INSERT INTO ranking_model_weights (entity_type, feature_name, weight) VALUES
  ('thread', 'importance',       1.0),
  ('thread', 'article_count',    0.02),
  ('thread', 'source_count',     0.1),
  ('thread', 'breaking_signal',  0.3),
  ('thread', 'recency_hours',   -0.01),
  ('thread', 'is_conflict',      0.5),
  ('thread', 'is_politics',      0.3),
  ('thread', 'is_economy',       0.2),
  ('timeline', 'importance',     1.0),
  ('timeline', 'article_count',  0.01),
  ('timeline', 'source_count',   0.08),
  ('timeline', 'recency_hours', -0.005),
  ('timeline', 'is_conflict',    0.5),
  ('timeline', 'is_politics',    0.3),
  ('timeline', 'is_economy',     0.2)
ON CONFLICT DO NOTHING;
