-- The full replacement index was built concurrently by the preceding
-- migration, and the conflicting canonical index was removed concurrently by
-- the intermediate one. Rename the staging index with metadata-only DDL.
--
-- The guard makes a retry after a lost success response idempotent: once the
-- staging index has already been renamed, the block only validates the final
-- canonical state.

DO $reconcile_subscription_expiry_index$
DECLARE
  canonical_is_expected BOOLEAN;
BEGIN
  IF to_regclass('public.subscriptions_status_expires_at_rebuild_idx') IS NOT NULL THEN
    ALTER INDEX "public"."subscriptions_status_expires_at_rebuild_idx"
      RENAME TO "subscriptions_status_expires_at_idx";
  END IF;

  SELECT COUNT(*) = 1
  INTO canonical_is_expected
  FROM pg_index AS indexes
  JOIN pg_class AS index_class ON index_class.oid = indexes.indexrelid
  JOIN pg_class AS table_class ON table_class.oid = indexes.indrelid
  JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
  JOIN pg_am AS access_method ON access_method.oid = index_class.relam
  JOIN pg_attribute AS status_attribute
    ON status_attribute.attrelid = table_class.oid
    AND status_attribute.attname = 'status'
  JOIN pg_attribute AS expiry_attribute
    ON expiry_attribute.attrelid = table_class.oid
    AND expiry_attribute.attname = 'expires_at'
  WHERE table_namespace.nspname = 'public'
    AND table_class.relname = 'subscriptions'
    AND index_class.relname = 'subscriptions_status_expires_at_idx'
    AND access_method.amname = 'btree'
    AND indexes.indisvalid
    AND indexes.indisready
    AND indexes.indpred IS NULL
    AND indexes.indexprs IS NULL
    AND indexes.indnkeyatts = 2
    AND indexes.indnatts = 2
    AND indexes.indkey[0] = status_attribute.attnum
    AND indexes.indkey[1] = expiry_attribute.attnum;

  IF canonical_is_expected IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'subscriptions_status_expires_at_idx must be valid and non-partial after reconciliation';
  END IF;
END
$reconcile_subscription_expiry_index$;
