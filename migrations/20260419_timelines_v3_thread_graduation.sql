-- 20260419_timelines_v3_thread_graduation.sql
--
-- Restructures timelines around the threads→timelines promotion model.
-- Previously storyTimelineBuilder.js clustered raw articles directly
-- (Phases 1–3), duplicating the work the thread builder had just done
-- two hours earlier. Timelines are now the graduated form of threads
-- that have crossed a "sustained coverage" gate.
--
-- New entities:
--
--   story_threads.timeline_id       FK: the thread's graduation target
--                                   (NULL until promoted). Threads keep
--                                   existing as 48h breaking-state cards
--                                   AFTER graduation — the line records
--                                   the series of events, the thread
--                                   captures the present.
--
--   story_timelines.last_reawakened_at
--                                   Non-null when a dormant timeline got
--                                   reactivated by a newly-promoted
--                                   thread with high entity overlap.
--                                   Surfaces in analytics / UI to mark
--                                   "this story came back to life".
--
--   story_timeline_events           Day-level event structure within a
--                                   timeline — the "series of events"
--                                   the product needs to render
--                                   timelines as narratives rather than
--                                   article-bags. One row per day that
--                                   produced ≥1 event; an event has an
--                                   anchor article (its title becomes
--                                   the event title verbatim) and a
--                                   Claude-written description.

-- ── story_threads: add graduation target link ────────────────────────────────
ALTER TABLE story_threads
  ADD COLUMN IF NOT EXISTS timeline_id integer
    REFERENCES story_timelines(id) ON DELETE SET NULL;

-- Most queries will walk thread → timeline; index supports the join.
CREATE INDEX IF NOT EXISTS idx_story_threads_timeline_id
  ON story_threads (timeline_id)
  WHERE timeline_id IS NOT NULL;

COMMENT ON COLUMN story_threads.timeline_id IS
  'Target timeline this thread graduated into. NULL until storyTimelineBuilder''s promotion pass links it. Threads stay alive after graduation — they capture the 48h breaking state; the timeline captures the long-running series. Set by the builder, re-linkable by admin edit.';

-- ── story_timelines: add reawakening timestamp ──────────────────────────────
ALTER TABLE story_timelines
  ADD COLUMN IF NOT EXISTS last_reawakened_at timestamptz;

COMMENT ON COLUMN story_timelines.last_reawakened_at IS
  'Non-null when this timeline went from dormant back to active because a newly-promoted thread had very high entity/primary_nations overlap (e.g. ceasefire broke, war resumed). Distinct from last_updated_at so the UI can surface "this story is back".';

-- ── story_timeline_events: day-level event rows ─────────────────────────────
CREATE TABLE IF NOT EXISTS story_timeline_events (
  id                  bigserial PRIMARY KEY,
  timeline_id         integer  NOT NULL REFERENCES story_timelines(id) ON DELETE CASCADE,
  event_date          date     NOT NULL,
  anchor_article_id   integer  REFERENCES news_articles(id) ON DELETE SET NULL,
  -- event_title is the anchor article's (translated) title captured at
  -- extraction time. Deliberately NOT a live join — the anchor may be
  -- re-translated, pruned, or re-titled later and we want the event to
  -- stay stable.
  event_title         text     NOT NULL,
  event_description   text,
  article_ids         integer[] NOT NULL DEFAULT '{}',
  source_count        integer  NOT NULL DEFAULT 0,
  importance          real,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- One event per (timeline, date, anchor) — repeated runs on the same
  -- day-cluster upsert rather than duplicate. Changing the anchor (e.g.
  -- a later, higher-weight article arrives) creates a new event row,
  -- which the extractor will reconcile on its next pass via the
  -- dedup-by-date pass in the builder.
  UNIQUE (timeline_id, event_date, anchor_article_id)
);

-- Chronological reads: "give me this timeline's events newest first"
CREATE INDEX IF NOT EXISTS idx_story_timeline_events_timeline_date
  ON story_timeline_events (timeline_id, event_date DESC);

-- For per-article reverse lookups (e.g. "is this article part of any
-- event?"), support GIN on article_ids.
CREATE INDEX IF NOT EXISTS idx_story_timeline_events_article_ids
  ON story_timeline_events USING GIN (article_ids);

COMMENT ON TABLE story_timeline_events IS
  'Day-level event structure within a timeline. Produced by storyTimelineBuilder''s event-extraction phase (Claude Haiku reads the timeline''s articles grouped by date, extracts 1–3 events per day, each with an anchor article + one-line description). Consumed by briefingGenerator to produce chronological voiceover narrative rather than flat article bags.';

COMMENT ON COLUMN story_timeline_events.anchor_article_id IS
  'The most representative article reporting this event. Its (translated) title becomes event_title. Nullable because ON DELETE SET NULL — if the anchor gets pruned we keep the event row rather than losing the historical entry.';

COMMENT ON COLUMN story_timeline_events.article_ids IS
  'Every article attached to this event. Anchor is included. GIN-indexed for reverse lookups.';
