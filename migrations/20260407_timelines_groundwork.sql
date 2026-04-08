-- ─── Timelines Groundwork ─────────────────────────────────────────────────────
-- Lays the foundation for the future Timelines feature: a knowledge graph of
-- entities, typed relationships, and historical events that lets us connect
-- present-day stories to events going back decades.
--
-- This migration is intentionally inert for end users — no UI surfaces this
-- yet. Its purpose is to start ENRICHING new articles in the right shape so
-- that when Timelines ships, we already have months of structured data.
--
-- Design rules (do not break these without discussion):
--   1. Every entity has a canonical_id (Wikidata QID preferred). Aliases live
--      in a separate column so name variants don't fragment the graph.
--   2. Every relationship edge MUST cite at least one source. No unsourced
--      edges. This is the anti-hallucination rule.
--   3. Historical events ARE entities (entity_type = 'event') so they can
--      participate in relationships uniformly. Date fields live on the event
--      side via entity_event_metadata.
--   4. Relationships are time-bounded (start_date / end_date). NULL = unknown
--      or ongoing. This is what makes timelines temporal.
--   5. Confidence floor for any extractor write is 0.4. Below that, Claude is
--      effectively guessing. Filter happens in extractor code, not the DB.

-- Required for fuzzy entity-name matching during extraction.
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ─── Entities ────────────────────────────────────────────────────────────────
-- Canonical nodes in the knowledge graph. Persons, orgs, places, ideologies,
-- and events all live here, distinguished by entity_type.

CREATE TABLE IF NOT EXISTS entities (
  id              SERIAL PRIMARY KEY,
  canonical_name  TEXT        NOT NULL,
  entity_type     TEXT        NOT NULL CHECK (entity_type IN (
                    'person', 'organization', 'location', 'ideology',
                    'event', 'work', 'other'
                  )),
  wikidata_qid    TEXT        UNIQUE,        -- e.g. 'Q9438' for Mosaddegh
  aliases         TEXT[]      NOT NULL DEFAULT '{}',
  description     TEXT,                      -- one-line disambiguator
  country_code    TEXT,                      -- ISO-3166 where meaningful
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entities_type        ON entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_qid         ON entities (wikidata_qid) WHERE wikidata_qid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entities_aliases_gin ON entities USING GIN (aliases);
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm   ON entities USING GIN (canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_active      ON entities (is_active) WHERE is_active = TRUE;


-- ─── Event metadata ──────────────────────────────────────────────────────────
-- Date / location fields that only apply to entity_type='event'. Kept in a
-- side table so the entities table stays narrow and other entity types don't
-- carry NULLs. 1:1 with entities for events.

CREATE TABLE IF NOT EXISTS entity_event_metadata (
  entity_id       INT         PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  start_date      DATE,
  end_date        DATE,
  date_precision  TEXT        NOT NULL DEFAULT 'day' CHECK (date_precision IN (
                    'day', 'month', 'year', 'decade', 'century'
                  )),
  location_text   TEXT,
  latitude        NUMERIC(9,6),
  longitude       NUMERIC(9,6),
  summary         TEXT
);

CREATE INDEX IF NOT EXISTS idx_eem_start_date ON entity_event_metadata (start_date);
CREATE INDEX IF NOT EXISTS idx_eem_end_date   ON entity_event_metadata (end_date);


-- ─── Article ↔ Entity mentions ───────────────────────────────────────────────
-- An article "mentions" an entity with a role and a confidence. Crucially,
-- 'referenced_historical' is a distinct role: an article published today
-- talks ABOUT a 1953 event without being about 2024. This is what unlocks
-- cross-century connections in Timelines.

CREATE TABLE IF NOT EXISTS article_entity_mentions (
  id              BIGSERIAL PRIMARY KEY,
  article_id      INTEGER     NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  entity_id       INT         NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN (
                    'subject',                -- article is primarily about this
                    'actor',                  -- active participant in present story
                    'location',               -- where the story happens
                    'referenced',             -- mentioned in passing
                    'referenced_historical',  -- past entity invoked for context
                    'source'                  -- entity is the source/speaker
                  )),
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 0.75,
  extracted_by    TEXT        NOT NULL DEFAULT 'claude',  -- 'claude' | 'wikidata' | 'manual'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (article_id, entity_id, role)
);

CREATE INDEX IF NOT EXISTS idx_aem_article  ON article_entity_mentions (article_id);
CREATE INDEX IF NOT EXISTS idx_aem_entity   ON article_entity_mentions (entity_id);
CREATE INDEX IF NOT EXISTS idx_aem_role     ON article_entity_mentions (role);
-- The historical-reference index is the one Timelines will hit hardest:
CREATE INDEX IF NOT EXISTS idx_aem_historical
  ON article_entity_mentions (entity_id)
  WHERE role = 'referenced_historical';


-- ─── Article-referenced dates ────────────────────────────────────────────────
-- Independent of entity mentions: when an article's text invokes a date or
-- date range that is NOT its publication date. Lightweight, free-text
-- extraction. Used to find articles that "reach back" to a given era.

CREATE TABLE IF NOT EXISTS article_referenced_dates (
  id              BIGSERIAL PRIMARY KEY,
  article_id      INTEGER     NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  referenced_date DATE        NOT NULL,
  date_precision  TEXT        NOT NULL DEFAULT 'day' CHECK (date_precision IN (
                    'day', 'month', 'year', 'decade', 'century'
                  )),
  context_snippet TEXT,                      -- the sentence that contained it
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 0.75,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ard_article ON article_referenced_dates (article_id);
CREATE INDEX IF NOT EXISTS idx_ard_date    ON article_referenced_dates (referenced_date);


-- ─── Entity relationships (the knowledge graph edges) ────────────────────────
-- Typed, directional, time-bounded, and SOURCED. Every row must have at
-- least one source citation in source_refs. The CHECK enforces non-empty.
--
-- relationship_type taxonomy is intentionally small at launch. Add types
-- through migrations only — never let extractors invent new ones inline.
--
-- Editorial layer: every relationship lands as 'unreviewed' and only
-- promotes to 'approved' through a human review queue. Timelines queries
-- should default to status='approved' for end-user views, but allow
-- 'unreviewed' for editorial dashboards.

CREATE TABLE IF NOT EXISTS entity_relationships (
  id                SERIAL PRIMARY KEY,
  from_entity_id    INT         NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id      INT         NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type TEXT        NOT NULL CHECK (relationship_type IN (
                      -- causal
                      'caused', 'enabled', 'prevented', 'retaliated_against',
                      -- organizational
                      'founded', 'member_of', 'succeeded', 'split_from',
                      'allied_with', 'opposed',
                      -- material
                      'funded', 'armed', 'trained', 'supplied',
                      -- spatial / temporal
                      'occurred_at', 'occurred_during',
                      -- narrative
                      'referenced_by', 'framed_as'
                    )),
  start_date        DATE,
  end_date          DATE,
  date_precision    TEXT        NOT NULL DEFAULT 'year' CHECK (date_precision IN (
                      'day', 'month', 'year', 'decade', 'century'
                    )),
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  source_refs       JSONB       NOT NULL,    -- [{type:'article', id:123}, {type:'wikidata', qid:'Q...'}]
  notes             TEXT,
  extracted_by      TEXT        NOT NULL DEFAULT 'claude',
  review_status     TEXT        NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN (
                      'unreviewed', 'approved', 'rejected', 'needs_evidence'
                    )),
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(source_refs) = 'array' AND jsonb_array_length(source_refs) > 0),
  CHECK (from_entity_id <> to_entity_id),
  UNIQUE (from_entity_id, to_entity_id, relationship_type, start_date)
);

CREATE INDEX IF NOT EXISTS idx_er_from      ON entity_relationships (from_entity_id);
CREATE INDEX IF NOT EXISTS idx_er_to        ON entity_relationships (to_entity_id);
CREATE INDEX IF NOT EXISTS idx_er_type      ON entity_relationships (relationship_type);
CREATE INDEX IF NOT EXISTS idx_er_start     ON entity_relationships (start_date);
CREATE INDEX IF NOT EXISTS idx_er_sources   ON entity_relationships USING GIN (source_refs);
-- Editorial queue: fast lookup of pending review work
CREATE INDEX IF NOT EXISTS idx_er_review_pending
  ON entity_relationships (created_at DESC)
  WHERE review_status = 'unreviewed';
CREATE INDEX IF NOT EXISTS idx_er_review_status
  ON entity_relationships (review_status);


-- ─── Extraction queue / progress tracking ────────────────────────────────────
-- So we can roll out entity extraction over the existing article corpus
-- incrementally without re-processing what's already done. One row per
-- article. The partial index on status makes "give me the next batch of
-- pending articles" a sub-millisecond query even at millions of rows.

CREATE TABLE IF NOT EXISTS article_entity_extraction_state (
  article_id      INTEGER     PRIMARY KEY REFERENCES news_articles(id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'processing', 'done', 'failed', 'skipped'
                  )),
  entities_found  INT         NOT NULL DEFAULT 0,
  dates_found     INT         NOT NULL DEFAULT 0,
  error_message   TEXT,
  processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_aees_status
  ON article_entity_extraction_state (status)
  WHERE status IN ('pending', 'failed');
