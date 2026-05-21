-- =============================================================================
--  Phase 6 — Webhook Subscriptions + Delivery History
-- =============================================================================

-- ── Enum ─────────────────────────────────────────────────────────────────────

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'RETRYING');

-- ── webhook_subscriptions ────────────────────────────────────────────────────

CREATE TABLE "webhook_subscriptions" (
  "id"                   TEXT        NOT NULL,
  "name"                 TEXT        NOT NULL,
  "url"                  TEXT        NOT NULL,
  "secret"               TEXT        NOT NULL,
  "event_types"          TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  "description"          TEXT,
  "is_active"            BOOLEAN     NOT NULL DEFAULT true,
  "created_by_id"        TEXT,
  "last_delivered_at"    TIMESTAMPTZ(3),
  "consecutive_failures" INTEGER     NOT NULL DEFAULT 0,
  "total_deliveries"     INTEGER     NOT NULL DEFAULT 0,
  "total_failures"       INTEGER     NOT NULL DEFAULT 0,
  "auto_disabled_at"     TIMESTAMPTZ(3),
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_subscriptions_is_active_idx"
  ON "webhook_subscriptions" ("is_active");
CREATE INDEX "webhook_subscriptions_created_at_idx"
  ON "webhook_subscriptions" ("created_at");

-- ── webhook_deliveries ───────────────────────────────────────────────────────

CREATE TABLE "webhook_deliveries" (
  "id"              TEXT                    NOT NULL,
  "subscription_id" TEXT                    NOT NULL,
  "event_type"      TEXT                    NOT NULL,
  "payload"         JSONB                   NOT NULL,
  "status"          "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempt"         INTEGER                 NOT NULL DEFAULT 0,
  "http_status"     INTEGER,
  "response_body"   TEXT,
  "error_message"   TEXT,
  "duration_ms"     INTEGER,
  "next_retry_at"   TIMESTAMPTZ(3),
  "started_at"      TIMESTAMPTZ(3),
  "finished_at"     TIMESTAMPTZ(3),
  "created_at"      TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_deliveries_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "webhook_deliveries_subscription_id_created_at_idx"
  ON "webhook_deliveries" ("subscription_id", "created_at");
CREATE INDEX "webhook_deliveries_status_created_at_idx"
  ON "webhook_deliveries" ("status", "created_at");
CREATE INDEX "webhook_deliveries_event_type_idx"
  ON "webhook_deliveries" ("event_type");
