-- ────────────────────────────────────────────────────────────────────────
-- Social post queue: draft-then-approve pipeline for posting threads to
-- social platforms (X, Reddit, LinkedIn, BlueSky, Instagram).
--
-- Filled by socialQueuePickerCron.js (runs ~06:30 + 16:30 UTC):
--   - selects 2-3 active threads using importance + diversity constraints
--   - composes platform-specific drafts via socialDraftComposer.js
--   - inserts rows with status='pending_approval'
--
-- Drained by manual approval in earth-editor's Social Queue tab:
--   - user opens the queue, reviews each draft per platform
--   - edits draft text inline if needed
--   - flips status to 'approved' OR 'skipped'
--
-- Posted by socialPublisherCron.js (v1.1, NOT auto-running on day 1):
--   - finds status='approved' rows, calls platform APIs
--   - records permalinks on success → status='posted'
--   - records failure_log on error → status remains 'approved' for retry
--
-- The constraint logic that prevents repetition is enforced in the
-- picker cron, not the schema — too domain-specific for a DB CHECK.
-- See socialQueuePickerCron.js for the dedup rules.
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.social_post_queue (
  id                BIGSERIAL PRIMARY KEY,
  thread_id         INTEGER NOT NULL REFERENCES public.story_threads(id) ON DELETE CASCADE,

  -- Composed drafts per platform — pure template fill, NO AI.
  -- Shape: {
  --   x:        { body: "..." },
  --   reddit:   { title: "...", body: "..." },
  --   linkedin: { body: "..." },
  --   bluesky:  { body: "..." },
  --   instagram:{ caption: "...", image_url: "..." }
  -- }
  -- Each platform's draft is independently editable by the user.
  drafts            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Per-platform publish enable (after approval). UI lets user toggle
  -- which platforms to publish to before clicking "Post".
  platforms_enabled JSONB NOT NULL DEFAULT '{"x":true,"reddit":true,"linkedin":true,"bluesky":true,"instagram":true}'::jsonb,

  status            TEXT NOT NULL DEFAULT 'pending_approval'
                    CHECK (status IN ('pending_approval','approved','posted','skipped','failed')),

  -- When the picker cron put this row in the queue. Drives the auto-
  -- expiry: if status hasn't moved past pending_approval within 36h,
  -- the row should auto-skip (so stale drafts don't post tomorrow's
  -- news with yesterday's framing).
  scheduled_for     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Why the picker chose this thread — e.g. "top by importance, mideast region slot, 47 articles, 3-region batch".
  -- Useful for debugging the picker and for the human reviewer to gauge thread quality at-a-glance.
  selection_reason  TEXT,

  approved_at       TIMESTAMPTZ,
  posted_at         TIMESTAMPTZ,

  -- Per-platform permalinks set by the publisher cron on success.
  -- Shape: { x: "https://x.com/...", reddit: "https://reddit.com/...", ... }
  permalinks        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Append-only error log if a publish attempt fails. Shape:
  -- [{ platform, error_message, attempted_at }]
  failure_log       JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Picker cron + reviewer UI both read by status + scheduled_for
CREATE INDEX IF NOT EXISTS social_post_queue_status_idx
  ON public.social_post_queue (status, scheduled_for DESC);

-- Picker uses this to check the 48h cooling rule per thread_id
CREATE INDEX IF NOT EXISTS social_post_queue_thread_recency_idx
  ON public.social_post_queue (thread_id, scheduled_for DESC);

-- Touch updated_at on every UPDATE
CREATE OR REPLACE FUNCTION public.social_post_queue_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS social_post_queue_updated_at_trig ON public.social_post_queue;
CREATE TRIGGER social_post_queue_updated_at_trig
  BEFORE UPDATE ON public.social_post_queue
  FOR EACH ROW EXECUTE FUNCTION public.social_post_queue_touch_updated_at();
