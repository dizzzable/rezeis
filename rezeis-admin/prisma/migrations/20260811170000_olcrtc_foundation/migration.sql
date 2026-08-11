-- OLCRTC foundation: desired-state metadata only. Runtime agent provisioning is
-- intentionally introduced in a later slice.

CREATE TYPE "OlcProvider" AS ENUM ('TELEMOST', 'WBSTREAM', 'JITSI');
CREATE TYPE "OlcTransport" AS ENUM ('VP8CHANNEL', 'DATACHANNEL', 'SEICHANNEL', 'VIDEOCHANNEL');
CREATE TYPE "OlcRoomStatus" AS ENUM ('CREATING', 'READY', 'IN_USE', 'EXPIRED', 'INVALID', 'DELETING', 'DELETED');
CREATE TYPE "OlcGatewayStatus" AS ENUM ('ACTIVE', 'DRAINING', 'DISABLED', 'UNHEALTHY');
CREATE TYPE "OlcSessionStatus" AS ENUM ('PROVISIONING', 'PENDING_AGENT', 'STARTING', 'ACTIVE', 'IDLE', 'STOPPING', 'STOPPED', 'FAILED', 'EXPIRED');

CREATE TABLE "olc_provider_accounts" (
  "id" TEXT NOT NULL,
  "provider" "OlcProvider" NOT NULL,
  "name" TEXT NOT NULL,
  "credentials_enc" TEXT,
  "credential_hint" TEXT,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "last_validated_at" TIMESTAMPTZ(3),
  "last_validation_error" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "olc_provider_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "olc_profiles" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" "OlcProvider" NOT NULL,
  "transport" "OlcTransport" NOT NULL,
  "provider_account_id" TEXT,
  "room_template" TEXT,
  "transport_options" JSONB NOT NULL DEFAULT '{}',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "olc_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "olc_gateways" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "management_url" TEXT NOT NULL,
  "status" "OlcGatewayStatus" NOT NULL DEFAULT 'DISABLED',
  "capacity" INTEGER NOT NULL DEFAULT 0,
  "active_sessions" INTEGER NOT NULL DEFAULT 0,
  "version" TEXT,
  "last_seen_at" TIMESTAMPTZ(3),
  "health" JSONB NOT NULL DEFAULT '{}',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "olc_gateways_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "olc_sessions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "profile_id" TEXT NOT NULL,
  "gateway_id" TEXT,
  "status" "OlcSessionStatus" NOT NULL DEFAULT 'PROVISIONING',
  "provider" "OlcProvider" NOT NULL,
  "transport" "OlcTransport" NOT NULL,
  "crypto_key_enc" TEXT NOT NULL,
  "crypto_key_fingerprint" TEXT NOT NULL,
  "subscription_uri" TEXT,
  "agent_session_id" TEXT,
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3),
  "last_seen_at" TIMESTAMPTZ(3),
  "stopped_at" TIMESTAMPTZ(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "olc_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "olc_rooms" (
  "id" TEXT NOT NULL,
  "provider" "OlcProvider" NOT NULL,
  "external_room_id" TEXT NOT NULL,
  "external_url" TEXT,
  "status" "OlcRoomStatus" NOT NULL DEFAULT 'CREATING',
  "provider_account_id" TEXT,
  "profile_id" TEXT,
  "lease_session_id" TEXT,
  "created_for_user_id" TEXT,
  "expires_at" TIMESTAMPTZ(3),
  "last_verified_at" TIMESTAMPTZ(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "olc_rooms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "olc_traffic_ledger" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "rx_bytes" BIGINT NOT NULL DEFAULT 0,
  "tx_bytes" BIGINT NOT NULL DEFAULT 0,
  "source" TEXT NOT NULL,
  "observed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotency_key" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "olc_traffic_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "olc_gateways_name_key" ON "olc_gateways"("name");
CREATE UNIQUE INDEX "olc_rooms_lease_session_id_key" ON "olc_rooms"("lease_session_id");
CREATE UNIQUE INDEX "olc_traffic_ledger_idempotency_key_key" ON "olc_traffic_ledger"("idempotency_key");

CREATE INDEX "olc_provider_accounts_provider_is_enabled_idx" ON "olc_provider_accounts"("provider", "is_enabled");
CREATE INDEX "olc_profiles_is_enabled_priority_idx" ON "olc_profiles"("is_enabled", "priority");
CREATE INDEX "olc_profiles_provider_transport_idx" ON "olc_profiles"("provider", "transport");
CREATE INDEX "olc_gateways_status_idx" ON "olc_gateways"("status");
CREATE INDEX "olc_gateways_last_seen_at_idx" ON "olc_gateways"("last_seen_at");
CREATE INDEX "olc_rooms_provider_status_idx" ON "olc_rooms"("provider", "status");
CREATE INDEX "olc_rooms_status_expires_at_idx" ON "olc_rooms"("status", "expires_at");
CREATE INDEX "olc_rooms_profile_id_status_idx" ON "olc_rooms"("profile_id", "status");
CREATE INDEX "olc_sessions_user_id_status_idx" ON "olc_sessions"("user_id", "status");
CREATE INDEX "olc_sessions_subscription_id_status_idx" ON "olc_sessions"("subscription_id", "status");
CREATE INDEX "olc_sessions_gateway_id_status_idx" ON "olc_sessions"("gateway_id", "status");
CREATE INDEX "olc_sessions_status_expires_at_idx" ON "olc_sessions"("status", "expires_at");
CREATE INDEX "olc_traffic_ledger_session_id_observed_at_idx" ON "olc_traffic_ledger"("session_id", "observed_at");

ALTER TABLE "olc_profiles" ADD CONSTRAINT "olc_profiles_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "olc_provider_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "olc_sessions" ADD CONSTRAINT "olc_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "olc_sessions" ADD CONSTRAINT "olc_sessions_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "olc_sessions" ADD CONSTRAINT "olc_sessions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "olc_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "olc_sessions" ADD CONSTRAINT "olc_sessions_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "olc_gateways"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "olc_rooms" ADD CONSTRAINT "olc_rooms_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "olc_provider_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "olc_rooms" ADD CONSTRAINT "olc_rooms_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "olc_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "olc_rooms" ADD CONSTRAINT "olc_rooms_lease_session_id_fkey" FOREIGN KEY ("lease_session_id") REFERENCES "olc_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "olc_traffic_ledger" ADD CONSTRAINT "olc_traffic_ledger_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "olc_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
