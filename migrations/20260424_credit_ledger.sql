-- credit_ledger + user_credit_balance — token/credit system for AI features.
--
-- Shift away from per-feature hard caps (1/day keyword context, 5/day article
-- analysis, …) toward a unified credit balance. Users get a weekly allotment
-- of credits based on their tier; each AI call deducts credits scaled to its
-- actual Claude cost (see CREDIT_COSTS in creditLedger.js). Overage can be
-- covered by add-on credit packs that roll over indefinitely.
--
-- Why this shape:
--   • Weekly-refreshed "base" credits (non-rollover) — predictable budget,
--     aligns with how Claude priced-per-week feels to users.
--   • Rolling "add-on" credits (infinite lifetime) — lets heavy users buy
--     more without losing what they didn't use.
--   • Append-only `credit_ledger` — every spend, refill, purchase is an
--     audited row. Balance is derived + stored denormalised on the per-user
--     row for read speed.

-- Per-user balance. One row per user, materialised from the ledger for
-- fast gate checks on every AI call.
CREATE TABLE IF NOT EXISTS user_credit_balance (
  user_id              uuid PRIMARY KEY,
  -- Base credits: granted by tier, reset each week. `base_week_start` is
  -- the Monday of the week currently accounted. If NOW() crosses into a
  -- new week we refresh base_credits_used to 0 + bump base_week_start
  -- (done atomically in creditLedger.consumeCredits).
  base_credits_used    int   NOT NULL DEFAULT 0,
  base_week_start      date  NOT NULL DEFAULT (date_trunc('week', NOW() AT TIME ZONE 'UTC'))::date,
  -- Add-on balance: purchased packs, carries over indefinitely. Never
  -- reset by the weekly rollover.
  addon_credits        int   NOT NULL DEFAULT 0,
  -- Lifetime audit counters.
  total_consumed       bigint NOT NULL DEFAULT 0,
  total_purchased      bigint NOT NULL DEFAULT 0,
  last_consumed_at     timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT NOW()
);

-- Append-only log. One row per ledger event:
--   reason = 'consume.<feature>' (negative delta), e.g. 'consume.article_analysis'
--   reason = 'refill.weekly'      (positive, recorded on first consume of new week)
--   reason = 'purchase.<pack>'    (positive, from payment webhook)
--   reason = 'adjustment'         (positive or negative, manual support)
CREATE TABLE IF NOT EXISTS credit_ledger (
  id             bigserial PRIMARY KEY,
  user_id        uuid NOT NULL,
  delta          int  NOT NULL,
  reason         text NOT NULL,
  reference_id   text,
  balance_after  int,
  created_at     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created
  ON credit_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_reason
  ON credit_ledger (reason);
