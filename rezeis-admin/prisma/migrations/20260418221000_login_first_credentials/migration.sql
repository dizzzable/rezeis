BEGIN;

ALTER TABLE "AdminUser"
ADD COLUMN IF NOT EXISTS "login" TEXT,
ADD COLUMN IF NOT EXISTS "loginNormalized" TEXT;

ALTER TABLE "AdminUser"
ALTER COLUMN "email" DROP NOT NULL;

WITH "admin_user_source" AS (
  SELECT
    "id",
    REPLACE("id", '-', '') AS "id_fragment",
    COALESCE(
      NULLIF(BTRIM("login"), ''),
      NULLIF(SPLIT_PART(BTRIM("email"), '@', 1), ''),
      NULLIF(BTRIM("email"), ''),
      CONCAT('admin-', SUBSTRING(REPLACE("id", '-', '') FROM 1 FOR 16))
    ) AS "raw_login_source"
  FROM "AdminUser"
),
"admin_user_sanitized" AS (
  SELECT
    "id",
    "id_fragment",
    REGEXP_REPLACE(
      REGEXP_REPLACE(LOWER("raw_login_source"), '[^a-z0-9._-]+', '-', 'g'),
      '(^[._-]+|[._-]+$)',
      '',
      'g'
    ) AS "sanitized_login"
  FROM "admin_user_source"
),
"admin_user_base" AS (
  SELECT
    "id",
    "id_fragment",
    CASE
      WHEN CHAR_LENGTH("sanitized_login") >= 3 THEN LEFT("sanitized_login", 64)
      WHEN CHAR_LENGTH("sanitized_login") > 0 THEN LEFT(CONCAT("sanitized_login", '-', SUBSTRING("id_fragment" FROM 1 FOR 16)), 64)
      ELSE LEFT(CONCAT('admin-', SUBSTRING("id_fragment" FROM 1 FOR 16)), 64)
    END AS "base_login"
  FROM "admin_user_sanitized"
),
"admin_user_prepared" AS (
  SELECT
    "id",
    "base_login",
    "id_fragment",
    COUNT(*) OVER (PARTITION BY "base_login") AS "duplicate_count"
  FROM "admin_user_base"
),
"admin_user_resolved" AS (
  SELECT
    "id",
    CASE
      WHEN "duplicate_count" = 1 THEN "base_login"
      ELSE CONCAT(LEFT("base_login", 47), '-', SUBSTRING("id_fragment" FROM 1 FOR 16))
    END AS "final_login"
  FROM "admin_user_prepared"
)
UPDATE "AdminUser" AS "admin_user"
SET
  "login" = "admin_user_resolved"."final_login",
  "loginNormalized" = "admin_user_resolved"."final_login"
FROM "admin_user_resolved"
WHERE "admin_user"."id" = "admin_user_resolved"."id";

ALTER TABLE "AdminUser"
ALTER COLUMN "login" SET NOT NULL,
ALTER COLUMN "loginNormalized" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "AdminUser_loginNormalized_key" ON "AdminUser"("loginNormalized");

ALTER TABLE "WebAccount"
ADD COLUMN IF NOT EXISTS "login" TEXT,
ADD COLUMN IF NOT EXISTS "loginNormalized" TEXT;

ALTER TABLE "WebAccount"
ALTER COLUMN "login" DROP NOT NULL,
ALTER COLUMN "loginNormalized" DROP NOT NULL;

WITH "web_account_source" AS (
  SELECT
    "id",
    REPLACE("id", '-', '') AS "id_fragment",
    COALESCE(NULLIF(BTRIM("login"), ''), NULLIF(BTRIM("loginNormalized"), '')) AS "raw_login_source"
  FROM "WebAccount"
),
"web_account_sanitized" AS (
  SELECT
    "id",
    CASE
      WHEN "raw_login_source" IS NULL THEN NULL
      ELSE REGEXP_REPLACE(
        REGEXP_REPLACE(LOWER("raw_login_source"), '[^a-z0-9._-]+', '-', 'g'),
        '(^[._-]+|[._-]+$)',
        '',
        'g'
      )
    END AS "sanitized_login",
    "id_fragment"
  FROM "web_account_source"
),
"web_account_base" AS (
  SELECT
    "id",
    "id_fragment",
    CASE
      WHEN "sanitized_login" IS NULL THEN NULL
      WHEN CHAR_LENGTH("sanitized_login") >= 3 THEN LEFT("sanitized_login", 64)
      WHEN CHAR_LENGTH("sanitized_login") > 0 THEN LEFT(CONCAT("sanitized_login", '-', SUBSTRING("id_fragment" FROM 1 FOR 16)), 64)
      ELSE LEFT(CONCAT('user-', SUBSTRING("id_fragment" FROM 1 FOR 16)), 64)
    END AS "base_login"
  FROM "web_account_sanitized"
),
"web_account_prepared" AS (
  SELECT
    "id",
    "base_login",
    "id_fragment",
    CASE
      WHEN "base_login" IS NULL THEN 0
      ELSE COUNT(*) OVER (PARTITION BY "base_login")
    END AS "duplicate_count"
  FROM "web_account_base"
),
"web_account_resolved" AS (
  SELECT
    "id",
    CASE
      WHEN "base_login" IS NULL THEN NULL
      WHEN "duplicate_count" = 1 THEN "base_login"
      ELSE CONCAT(LEFT("base_login", 47), '-', SUBSTRING("id_fragment" FROM 1 FOR 16))
    END AS "final_login"
  FROM "web_account_prepared"
)
UPDATE "WebAccount" AS "web_account"
SET
  "login" = "web_account_resolved"."final_login",
  "loginNormalized" = "web_account_resolved"."final_login"
FROM "web_account_resolved"
WHERE "web_account"."id" = "web_account_resolved"."id";

CREATE UNIQUE INDEX IF NOT EXISTS "WebAccount_loginNormalized_key" ON "WebAccount"("loginNormalized");

COMMIT;
