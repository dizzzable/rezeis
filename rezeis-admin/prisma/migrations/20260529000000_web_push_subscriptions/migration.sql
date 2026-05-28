-- WebPushSubscription model — browser web-push registrations.
--
-- One row per (user, endpoint) tuple. The same user can register
-- multiple subscriptions (laptop + phone PWA) and each one delivers
-- independently. Endpoints are unique across the table because a
-- single push-service URL identifies a single destination.

CREATE TABLE "web_push_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh_key" TEXT NOT NULL,
    "auth_key" TEXT NOT NULL,
    "user_agent" TEXT,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "web_push_subscriptions_endpoint_key"
    ON "web_push_subscriptions" ("endpoint");

CREATE INDEX "web_push_subscriptions_user_id_idx"
    ON "web_push_subscriptions" ("user_id");

ALTER TABLE "web_push_subscriptions"
    ADD CONSTRAINT "web_push_subscriptions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
