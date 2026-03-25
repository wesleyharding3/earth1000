-- ─── Story Continuity Tracking ───────────────────────────────────────────────
-- Persistent story identities that survive across daily briefings.
-- Uses keyword TEXT[] (GIN index) for Jaccard-similarity matching —
-- no pgvector extension required.

CREATE TABLE IF NOT EXISTS story_identities (
  id              SERIAL PRIMARY KEY,
  canonical_title TEXT        NOT NULL,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mention_count   INT         NOT NULL DEFAULT 1,
  keywords        TEXT[]      NOT NULL DEFAULT '{}',
  tags            TEXT[]      NOT NULL DEFAULT '{}',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE
);

-- Fast lookup: active identities seen recently
CREATE INDEX IF NOT EXISTS idx_si_active_last_seen
  ON story_identities (last_seen_at DESC)
  WHERE is_active = TRUE;

-- GIN index for fast keyword-array overlap queries (k = ANY(...))
CREATE INDEX IF NOT EXISTS idx_si_keywords_gin
  ON story_identities USING GIN (keywords);


-- Links a briefing segment to its persistent story identity.
-- day_number = how many distinct briefing dates have covered this identity
-- (1 = first appearance, 2 = second day, etc.)
CREATE TABLE IF NOT EXISTS segment_story_links (
  id                  SERIAL      PRIMARY KEY,
  briefing_episode_id INT         NOT NULL REFERENCES briefing_episodes(id) ON DELETE CASCADE,
  segment_index       INT         NOT NULL,
  thread_id           INT         REFERENCES story_threads(id),
  story_identity_id   INT         NOT NULL REFERENCES story_identities(id),
  day_number          INT         NOT NULL DEFAULT 1,
  similarity_score    NUMERIC(5,4)         DEFAULT 0,
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (briefing_episode_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_ssl_identity_time
  ON segment_story_links (story_identity_id, linked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ssl_episode
  ON segment_story_links (briefing_episode_id);
CREATE INDEX IF NOT EXISTS idx_ssl_thread
  ON segment_story_links (thread_id);


-- Framing snapshots: captures how different world regions headline
-- the same story on a given day, enabling divergence analysis over time.
CREATE TABLE IF NOT EXISTS story_framing_snapshots (
  id                SERIAL      PRIMARY KEY,
  story_identity_id INT         NOT NULL REFERENCES story_identities(id) ON DELETE CASCADE,
  captured_at       DATE        NOT NULL,
  region            TEXT        NOT NULL,
  headline_sample   TEXT,
  source_count      INT         NOT NULL DEFAULT 0,
  UNIQUE (story_identity_id, captured_at, region)
);

CREATE INDEX IF NOT EXISTS idx_sfs_identity_date
  ON story_framing_snapshots (story_identity_id, captured_at DESC);


-- ─── Keyword Intelligence Cache ───────────────────────────────────────────────
-- Pre-computed trending/rising results written by keywordCron.js.
-- Endpoints serve directly from this table — sub-millisecond vs. live DB scan.

CREATE TABLE IF NOT EXISTS keyword_intelligence_cache (
  id          SERIAL      PRIMARY KEY,
  mode        TEXT        NOT NULL CHECK (mode IN ('trending', 'rising')),
  filter_key  TEXT        NOT NULL DEFAULT 'global',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  results     JSONB       NOT NULL
);

-- Covering index for single-row lookup by mode + filter, newest first
CREATE INDEX IF NOT EXISTS idx_kic_lookup
  ON keyword_intelligence_cache (mode, filter_key, computed_at DESC);
