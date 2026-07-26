-- One ATTRIBUTED conversion per user, not one row per user.
--
-- A refund flips the conversion to REVERTED but the row stayed, and the plain
-- unique on user_id kept the slot: the customer's next real purchase could never
-- be recorded, so the placement lost that revenue permanently and its
-- registration-to-purchase rate was understated for good.
DROP INDEX IF EXISTS "ad_conversions_user_id_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ad_conversions_user_id_attributed_key"
    ON "ad_conversions"("user_id")
 WHERE "status" = 'ATTRIBUTED';

-- Lookups by user are still needed (revert, metrics) and no longer covered by
-- the dropped unique constraint.
CREATE INDEX IF NOT EXISTS "ad_conversions_user_id_idx" ON "ad_conversions"("user_id");
