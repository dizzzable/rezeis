-- =============================================================================
--  Phase 5 — Security Hardening:
--    1. 2FA (TOTP) fields on admin_users
--    2. admin_login_attempts (Login Guard / Fail2ban)
--    3. admin_ip_allowlist  (Admin Panel IP Whitelist)
--    4. api_tokens          (Schema↔migrations drift backfill — the model
--                            shipped earlier but the init migration was
--                            never updated. Wrap in IF NOT EXISTS so this
--                            stays idempotent on prod databases that have
--                            the table already.)
-- =============================================================================

-- ── 0. api_tokens (drift backfill) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id"            TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "token"         TEXT NOT NULL,
  "prefix"        TEXT NOT NULL,
  "created_by"    TEXT,
  "last_used_at"  TIMESTAMPTZ(3),
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_token_key"
  ON "api_tokens" ("token");
CREATE INDEX IF NOT EXISTS "api_tokens_name_idx"
  ON "api_tokens" ("name");
CREATE INDEX IF NOT EXISTS "api_tokens_created_at_idx"
  ON "api_tokens" ("created_at");

-- ── 1. AdminUser TOTP fields ─────────────────────────────────────────────────

ALTER TABLE "admin_users"
  ADD COLUMN "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "totp_secret_encrypted" TEXT,
  ADD COLUMN "totp_recovery_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "totp_enrolled_at" TIMESTAMPTZ(3);

-- ── 2. admin_login_attempts ──────────────────────────────────────────────────

CREATE TABLE "admin_login_attempts" (
  "id"               TEXT        NOT NULL,
  "login_normalized" TEXT        NOT NULL DEFAULT '',
  "ip_address"       TEXT        NOT NULL,
  "success"          BOOLEAN     NOT NULL DEFAULT false,
  "reason"           TEXT,
  "user_agent"       TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_login_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_login_attempts_login_normalized_created_at_idx"
  ON "admin_login_attempts" ("login_normalized", "created_at");
CREATE INDEX "admin_login_attempts_ip_address_created_at_idx"
  ON "admin_login_attempts" ("ip_address", "created_at");
CREATE INDEX "admin_login_attempts_success_created_at_idx"
  ON "admin_login_attempts" ("success", "created_at");

-- ── 3. admin_ip_allowlist ───────────────────────────────────────────────────

CREATE TABLE "admin_ip_allowlist" (
  "id"            TEXT        NOT NULL,
  "address"       TEXT        NOT NULL,
  "label"         TEXT        NOT NULL DEFAULT '',
  "is_active"     BOOLEAN     NOT NULL DEFAULT true,
  "created_by_id" TEXT,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "admin_ip_allowlist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_ip_allowlist_address_key"
  ON "admin_ip_allowlist" ("address");
CREATE INDEX "admin_ip_allowlist_is_active_idx"
  ON "admin_ip_allowlist" ("is_active");
CREATE INDEX "admin_ip_allowlist_created_at_idx"
  ON "admin_ip_allowlist" ("created_at");
