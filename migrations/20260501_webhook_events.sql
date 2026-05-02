-- ─────────────────────────────────────────────────────────────────────
-- webhook_events — audit + idempotency log for payment provider webhooks
--
-- Why this exists:
--
--   Without a per-event dedupe table, every payment-provider webhook
--   handler would have to encode its own idempotency contract against
--   the subscriptions table. That's brittle: a SUBSCRIBED → DID_RENEW
--   sequence redelivered out of order can't be detected from the row's
--   final state alone, and refund-then-payment ordering bugs surface
--   only when a user complains.
--
--   This table stores the provider's own event id (notificationUUID
--   for Apple, event.id for PayPal + RevenueCat) and uses a UNIQUE
--   constraint on (provider, event_id) so duplicate deliveries become
--   a single failed INSERT — the handler can short-circuit and return
--   200 immediately. The full payload is kept as JSONB so a botched
--   write can be replayed by hand without losing the source data.
--
-- Columns:
--   • provider:     'apple' | 'paypal' | 'revenuecat'. Lowercase.
--   • event_id:     provider's unique event identifier. UUID-like for
--                   Apple, opaque string for PayPal/RC.
--   • event_type:   provider's event type name (DID_RENEW,
--                   BILLING.SUBSCRIPTION.ACTIVATED, RENEWAL, …) — kept
--                   for log filtering.
--   • user_id:      our internal user id when known. May be null at
--                   ingest time (Apple webhook arrives before we've
--                   linked the originalTransactionId to a user).
--   • payload:      the verified, decoded JSONB body. We store the
--                   POST-VERIFICATION decoded form, not the raw signed
--                   blob — verification has already happened, the
--                   payload is what mattered.
--   • received_at:  when our handler first saw this event id.
--   • processed_at: when the side effects (subscription upsert,
--                   cancel, etc.) committed. NULL while in-flight or
--                   on processing error → the row is replayable.
--   • processing_error: last error message if processing failed.
--                   Inspectable for manual replay decisions.
--
-- Indexes:
--   • idx_webhook_events_unprocessed: partial index on rows with
--     processed_at IS NULL — drives the future replay-stuck-rows cron.
--   • idx_webhook_events_provider_received: chronological browse by
--     provider for log review.
--   • idx_webhook_events_user: lookups when a support ticket comes
--     in ("show me every payment event for user X").
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_events (
  id                BIGSERIAL    PRIMARY KEY,
  provider          TEXT         NOT NULL,
  event_id          TEXT         NOT NULL,
  event_type        TEXT,
  user_id           UUID,
  payload           JSONB        NOT NULL,
  received_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ,
  processing_error  TEXT,
  CONSTRAINT webhook_events_provider_event_unique UNIQUE (provider, event_id),
  CONSTRAINT webhook_events_provider_check
    CHECK (provider IN ('apple', 'paypal', 'revenuecat'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_received
  ON webhook_events (provider, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_events_unprocessed
  ON webhook_events (provider, received_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_events_user
  ON webhook_events (user_id)
  WHERE user_id IS NOT NULL;
