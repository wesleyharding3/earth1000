-- ─── subscriptions FK cascade + orphan cleanup ────────────────────────────
--
-- Lives in Supabase (auth.users + subscriptions are both Supabase Postgres,
-- not Render). Apply via Supabase Dashboard → SQL Editor.
--
-- Why:
--   The original `subscriptions.user_id → auth.users.id` foreign key was
--   created without ON DELETE CASCADE. Supabase's admin.deleteUser() does
--   succeed against that FK (it bypasses the constraint internally) but
--   the subscription row is left orphaned — its user_id points at a
--   user that no longer exists. RevenueCat's webhook then keeps trying
--   to upsert the same row and hits a foreign-key violation each time,
--   spraying 500s into the API logs until RevenueCat backs off.
--
--   This migration cleans up any current orphans and rebuilds the FK
--   with CASCADE so future account deletions automatically take their
--   subscription row with them.

-- Step 1 — delete any existing orphan rows.
DELETE FROM public.subscriptions
WHERE user_id NOT IN (SELECT id FROM auth.users);

-- Step 2 — drop the existing FK and re-add it with ON DELETE CASCADE.
-- Postgres doesn't let you ALTER a constraint's action in place, so it's
-- always drop + recreate. Constraint name matches Supabase's auto-naming
-- convention; if your project renamed it, adjust DROP CONSTRAINT here.
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_user_id_fkey;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
