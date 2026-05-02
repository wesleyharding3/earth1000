-- ─── subscriptions.user_id UNIQUE constraint ─────────────────────────────
--
-- Lives in Supabase (subscriptions is a Supabase Postgres table, not Render).
-- Apply via Supabase Dashboard → SQL Editor.
--
-- Why:
--   payments.js upsertSubscription() previously did SELECT-then-INSERT/UPDATE
--   without a transaction. Two concurrent webhook deliveries for the same
--   user (e.g. RevenueCat + reconciliation cron firing within the same
--   second) could both observe "no existing row" and both INSERT, leaving
--   the user with two subscription rows in violation of the one-row-per-user
--   model the rest of the code assumes. Switching to a single Supabase
--   .upsert(..., { onConflict: 'user_id' }) makes the operation atomic —
--   but Postgres needs a UNIQUE constraint on user_id for ON CONFLICT to
--   resolve. This migration adds it.
--
-- Pre-flight: dedupe any existing duplicates first. If you have multiple
-- rows per user_id, keep the most recently updated one (mirrors the
-- pickBestActiveSubscription logic — newest updated_at wins). Without this
-- step the unique-index creation will fail with "could not create unique
-- index ... has duplicate values".

-- Step 1 — collapse duplicates: keep the row with the highest updated_at
-- per user, drop the rest. Uses a CTE to identify keepers by id.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id
           ORDER BY updated_at DESC NULLS LAST, id DESC
         ) AS rn
    FROM public.subscriptions
)
DELETE FROM public.subscriptions s
 USING ranked r
 WHERE s.id = r.id
   AND r.rn > 1;

-- Step 2 — add the UNIQUE constraint. ON CONFLICT (user_id) needs this to
-- resolve. Using a constraint (not just a unique index) so PostgREST/
-- Supabase upsert recognizes it by the column name.
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);
