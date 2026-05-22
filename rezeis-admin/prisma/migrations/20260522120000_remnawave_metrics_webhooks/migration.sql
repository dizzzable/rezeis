-- Remnawave Metrics & Webhooks
-- Time-series samples for online trends and per-node traffic history.

CREATE TABLE "remnawave_metric_samples" (
    "id" TEXT NOT NULL,
    "online_now" INTEGER NOT NULL,
    "total_users" INTEGER NOT NULL,
    "nodes_online" INTEGER NOT NULL,
    "total_bytes_lifetime" BIGINT NOT NULL,
    "nodes_snapshot" JSONB NOT NULL DEFAULT '[]',
    "cpu_cores" INTEGER NOT NULL DEFAULT 0,
    "memory_used" BIGINT NOT NULL DEFAULT 0,
    "memory_total" BIGINT NOT NULL DEFAULT 0,
    "uptime" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remnawave_metric_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "remnawave_metric_samples_created_at_idx" ON "remnawave_metric_samples"("created_at");

-- Webhook events received from the Remnawave panel.

CREATE TABLE "remnawave_webhook_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "is_processed" BOOLEAN NOT NULL DEFAULT false,
    "source_ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remnawave_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "remnawave_webhook_events_event_type_idx" ON "remnawave_webhook_events"("event_type");
CREATE INDEX "remnawave_webhook_events_is_processed_idx" ON "remnawave_webhook_events"("is_processed");
CREATE INDEX "remnawave_webhook_events_created_at_idx" ON "remnawave_webhook_events"("created_at");
