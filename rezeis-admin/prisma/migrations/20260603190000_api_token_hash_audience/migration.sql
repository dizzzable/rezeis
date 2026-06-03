-- Store API token fingerprints instead of raw bearer JWTs and attach an
-- explicit audience for new tokens. Existing token rows are migrated in place
-- so already-issued Reiwa/internal integrations keep working until rotation.

ALTER TABLE "api_tokens"
  ADD COLUMN IF NOT EXISTS "token_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "audience" TEXT NOT NULL DEFAULT 'rezeis-internal-api',
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ(3);

UPDATE "api_tokens"
SET "token_hash" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token_hash" IS NULL
  AND "token" IS NOT NULL;

UPDATE "api_tokens"
SET "expires_at" = now() + interval '180 days'
WHERE "expires_at" IS NULL;

ALTER TABLE "api_tokens"
  ALTER COLUMN "token_hash" SET NOT NULL,
  ALTER COLUMN "expires_at" SET NOT NULL;

DROP INDEX IF EXISTS "api_tokens_token_key";

CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_token_hash_key"
  ON "api_tokens" ("token_hash");

ALTER TABLE "api_tokens"
  DROP COLUMN IF EXISTS "token";
