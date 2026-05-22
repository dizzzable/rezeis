-- OAuth2 Providers & Passkeys
-- Multi-provider authentication infrastructure for the admin panel.

-- Provider type enum
CREATE TYPE "AuthProviderType" AS ENUM ('TELEGRAM', 'GITHUB', 'YANDEX', 'KEYCLOAK', 'POCKETID', 'GENERIC_OAUTH2');

-- Provider configuration table
CREATE TABLE "auth_provider_configs" (
    "id" TEXT NOT NULL,
    "type" "AuthProviderType" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "display_name" TEXT NOT NULL,
    "client_id" TEXT,
    "client_secret_enc" TEXT,
    "frontend_domain" TEXT,
    "backend_domain" TEXT,
    "authorization_url" TEXT,
    "token_url" TEXT,
    "realm" TEXT,
    "provider_domain" TEXT,
    "use_pkce" BOOLEAN NOT NULL DEFAULT false,
    "allowed_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_telegram_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_provider_configs_type_key" ON "auth_provider_configs"("type");
CREATE INDEX "auth_provider_configs_is_enabled_idx" ON "auth_provider_configs"("is_enabled");

-- OAuth linked identities
CREATE TABLE "admin_oauth_links" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "provider_type" "AuthProviderType" NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "provider_email" TEXT,
    "provider_name" TEXT,
    "profile_data" JSONB NOT NULL DEFAULT '{}',
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "admin_oauth_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_oauth_links_provider_type_provider_user_id_key"
    ON "admin_oauth_links"("provider_type", "provider_user_id");
CREATE INDEX "admin_oauth_links_admin_user_id_idx" ON "admin_oauth_links"("admin_user_id");
CREATE INDEX "admin_oauth_links_provider_type_idx" ON "admin_oauth_links"("provider_type");

-- WebAuthn/Passkey credentials
CREATE TABLE "admin_passkeys" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "aaguid" TEXT,
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "admin_passkeys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_passkeys_credential_id_key" ON "admin_passkeys"("credential_id");
CREATE INDEX "admin_passkeys_admin_user_id_idx" ON "admin_passkeys"("admin_user_id");

-- Seed default provider configs (all disabled)
INSERT INTO "auth_provider_configs" ("id", "type", "display_name", "is_enabled") VALUES
    ('prov_telegram', 'TELEGRAM', 'Telegram', false),
    ('prov_github', 'GITHUB', 'GitHub', false),
    ('prov_yandex', 'YANDEX', 'Yandex', false),
    ('prov_keycloak', 'KEYCLOAK', 'Keycloak', false),
    ('prov_pocketid', 'POCKETID', 'PocketID', false),
    ('prov_generic', 'GENERIC_OAUTH2', 'OAuth2', false);
