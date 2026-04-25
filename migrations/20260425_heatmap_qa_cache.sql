-- Heatmap Q&A cache — backs POST /api/heatmap/ask.
--
-- Flow on the server:
--   1. Normalize the user's question (lowercase, collapse whitespace),
--      hash it with sha256, look up by (question_hash, mode).
--   2. Hit  → return the cached `values` and `legend`. No Claude call.
--   3. Miss → call Claude with the set_country_values tool, validate
--      ISOs against `countries`, store, return.
--
-- The same table holds BOTH Claude-generated answers and hand-curated
-- "common questions" you pre-populate. Hand-curated rows just have
-- `source = 'curated'` and never expire. The `is_pinned` flag lets
-- pre-seeded rows survive normal TTL eviction passes.
--
-- `mode` matches the frontend renderer enum:
--   'percent' — values are 0–100, color scale heat
--   'rank'    — values are integers (1 = top), inverted color scale
--   'binary'  — values are 0 or 1, single shade for 1
--
-- `refusal` is set when Claude declines (e.g. biased framing). The
-- frontend reads it to display a graceful empty-state instead of a
-- blank globe.

CREATE TABLE IF NOT EXISTS heatmap_qa_cache (
  id              bigserial PRIMARY KEY,
  question_hash   text NOT NULL,
  question_text   text NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('percent','rank','binary')),
  legend          text,             -- short label shown in the legend chip
  unit            text,             -- e.g. '%' / 'rank' / null
  source_note     text,             -- attribution / "AI estimate", year of data, etc.
  values          jsonb NOT NULL,   -- [{ "iso": "ID", "value": 87.2 }, ...]
  refusal         text,             -- non-null when Claude declined the question
  source          text NOT NULL DEFAULT 'claude' CHECK (source IN ('claude','curated')),
  is_pinned       boolean NOT NULL DEFAULT false,
  hit_count       int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  last_hit_at     timestamptz,
  -- Different `mode` values for the same question are legitimately
  -- different rows (e.g. "majority Muslim?" as percent vs binary).
  UNIQUE (question_hash, mode)
);

CREATE INDEX IF NOT EXISTS idx_hqc_pinned       ON heatmap_qa_cache (is_pinned) WHERE is_pinned;
CREATE INDEX IF NOT EXISTS idx_hqc_last_hit_at  ON heatmap_qa_cache (last_hit_at NULLS FIRST);

COMMENT ON TABLE heatmap_qa_cache IS
  'Cache + curated answers for POST /api/heatmap/ask. Pinned rows are pre-seeded and survive eviction.';
