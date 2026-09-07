-- Who moved the device limit, so the anti-fraud grace can tell the two apart.
--
-- ── The behaviour this changes ────────────────────────────────────────────
--
-- `sharing-detectors.ts` excuses a device overage that the OLD limit would not
-- have called one, inside a 14-day window. It refuses to do that when the old
-- limit was `0`, and the refusal is right for the reason written there: `0` is
-- the column default, the "never synced" value AND "unlimited", all at once,
-- and `RemnawaveImporterService.syncSubscription` rewrites the column on every
-- import pass — so one `0 → N` sweep would stamp the whole customer base
-- "previously unlimited" and hand every over-limit user 14 days of silence at
-- the exact moment a limit first started to mean something.
--
-- But the whole argument for refusing is that a SHARER buys the immunity: the
-- customer chooses the downgrade. When an operator sets an individual limit by
-- hand in the admin panel, the customer chose nothing, there is nobody to buy
-- immunity, and the provenance is not in doubt — it is the operator's own
-- hand. The trigger could not tell those apart, because a trigger sees only a
-- row, and both arrive as the same `UPDATE`.
--
-- ── How the provenance travels ────────────────────────────────────────────
--
-- Through a transaction-local setting rather than a column the writer fills in:
--
--     SELECT set_config('rezeis.device_limit_source', 'OPERATOR', true);
--
-- `true` makes it local to the transaction, so it cannot outlive the statement
-- that meant it, cannot be left set on a pooled connection, and cannot be
-- inherited by the next writer on that connection. A column would have had to
-- be cleared by the trigger, and "clear it unless this statement set it" is not
-- expressible without comparing OLD to NEW — which says nothing when an
-- operator sets the limit twice in a row to the same value.
--
-- Everything that does NOT set it — the importer, plan changes, renewals,
-- payments — records `NULL`, which is exactly the behaviour that exists today.
-- So the sweep this guards against still stamps `previously unlimited` with no
-- provenance, and is still judged.
--
-- Nullable column, no default: a catalogue-only change, no table rewrite.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "device_limit_reduction_by" TEXT;

CREATE OR REPLACE FUNCTION "stamp_subscription_device_limit_reduction"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."device_limit" > 0
     AND (OLD."device_limit" <= 0 OR NEW."device_limit" < OLD."device_limit")
  THEN
    NEW."device_limit_reduced_at" := now();
    -- `GREATEST(OLD."device_limit", 0)` — an unlimited (or nonsensical negative)
    -- old limit is stored as the canonical unlimited `0`, never as NULL, so
    -- "previously unlimited" stays distinguishable from "never recorded".
    NEW."device_limit_before_reduction" := GREATEST(OLD."device_limit", 0);
    -- Written in the SAME assignment block as the pair above, so provenance can
    -- never describe a different reduction than the one it arrived with. An
    -- unset setting yields NULL (`missing_ok := true`), and an empty string is
    -- normalised to NULL so a caller that clears it cannot record "".
    NEW."device_limit_reduction_by" :=
      NULLIF(current_setting('rezeis.device_limit_source', true), '');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Unchanged: `UPDATE OF "device_limit"` keeps the far more frequent writes that
-- touch only `status`, `expires_at` or `config_url` out of the function.
-- `DROP ... IF EXISTS` first because `prisma migrate deploy` replays.
DROP TRIGGER IF EXISTS "subscriptions_stamp_device_limit_reduction" ON "subscriptions";
CREATE TRIGGER "subscriptions_stamp_device_limit_reduction"
  BEFORE UPDATE OF "device_limit" ON "subscriptions"
  FOR EACH ROW
  EXECUTE FUNCTION "stamp_subscription_device_limit_reduction"();
