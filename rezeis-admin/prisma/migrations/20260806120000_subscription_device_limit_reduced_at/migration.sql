-- When a subscription's device limit last became MORE restrictive, and what it
-- was immediately before that.
--
-- WHY THESE COLUMNS EXIST.
-- `SharingDetectors.detectHwidOverage` compares the panel's REGISTERED HWID
-- count against the panel's `hwidDeviceLimit` and files a HIGH-severity
-- `SUBSCRIPTION_SHARING_HWID` signal at confidence 80. Nothing on the
-- limit-change path deletes the now-surplus HWID rows — the only component that
-- deletes them is `DeviceReductionExecutionService`, reachable only from an
-- add-on *entitlement* expiry and dormant unless `ADDON_DEVICE_CLEANUP_AUTO` is
-- on, which it is not in any deployment. So a customer moving from a 5-device
-- plan to a 2-device plan keeps five registered devices against a limit of two
-- and gets named, at HIGH, for downgrading their own subscription.
--
-- Nothing in the schema could answer "is this overage explained by a reduction
-- we made?": `subscriptions.updated_at` moves on any column,
-- `profile_sync_jobs.payload` carries provenance but never the old or new value,
-- the admin subscription editor writes no `admin_audit_log` row at all, and
-- `subscription_effective_projections` is empty on every deployment (it requires
-- exactly one ACTIVE `subscription_terms` row, which only the flag-gated ledger
-- path or the manual cutover CLI ever creates).
--
-- WHY BOTH COLUMNS, NOT JUST THE TIMESTAMP.
-- A reduction explains exactly one thing, and it is BOUNDED: the devices the
-- customer already held under the OLD limit, which they cannot un-register
-- instantly and were never at fault for. Excusing any overage merely because a
-- reduction happened is exploitable — a genuine sharer downgrades their own plan
-- and buys `HWID_DOWNGRADE_GRACE_DAYS` of immunity while continuing to register
-- devices past a bypassed limit. Downgrading costs them nothing, because the
-- panel limit was never what constrained them.
--
-- Do NOT reason from "Remnawave refuses a registration at or over the limit"
-- (`USER_HWID_DEVICE_LIMIT_REACHED`). There are tools and services that bypass
-- the panel's HWID device limit, and that bypass is the entire reason this
-- detector exists — if the limit could not be circumvented, `devices > limit`
-- would be unreachable and there would be nothing to detect. Any argument of the
-- form "the panel won't let them" is reasoning from the absence of the thing we
-- are hunting.
--
-- So the honest test is not "was there a reduction?" but "would this same panel
-- state have been an overage BEFORE the reduction?", which needs the old limit:
--
--   5 devices, limit 5 → 2   the detector would not have named them a minute
--                            before we moved the line. Excused, in full.
--   9 devices, limit 5 → 2   four of those appeared after the change, or were
--                            never legitimate. The reduction explains five of
--                            the nine and says nothing about the rest. Still
--                            named — see `detectHwidOverage` for how the
--                            partly-explained case is reported.
--
-- WHY A TRIGGER AND NOT APPLICATION CODE.
-- Fifteen call sites across payments, the admin subscription editor, bulk plan
-- assignment, five importers, the Remnawave webhook mirror, promo rewards and
-- the entitlement boundary write `subscriptions.device_limit`. A stamp added to
-- some of them is a suppression that silently does not apply to the rest, and
-- every future writer would have to remember. The trigger is reached by every
-- write by construction, including ones that do not exist yet, and it compares
-- the actual row transition rather than whichever earlier read a call site
-- happened to have in hand. Both columns are written in ONE assignment block, so
-- they cannot disagree about the same event.
--
-- "MORE RESTRICTIVE" follows the product's `device_limit <= 0 ⇒ unlimited`
-- convention (see `add-on-entitlements/domain/cutover-baseline.ts`), so
-- unlimited → 5 IS a reduction and 5 → unlimited is not. The detector ignores
-- users at an unlimited limit, so a stamp is only ever useful for a finite one.
--
-- A raise does NOT clear the stamp, deliberately: after 5 → 2 → 3 the customer's
-- five registered devices are still explained by the original downgrade, and
-- clearing would re-accuse them. The suppression is time-bounded in the detector
-- instead (`HWID_DOWNGRADE_GRACE_DAYS`), so a stale stamp expires on its own.
--
-- ENCODING of `device_limit_before_reduction`. `0` means "previously unlimited",
-- reached via `GREATEST(..., 0)` so a stray negative cannot read as a finite
-- ceiling; a previously unlimited customer was entitled to any number of
-- devices, so nothing about their count is unexplained. NULL means "no reduction
-- has ever been recorded for this row", and it always travels with a NULL
-- timestamp — the two columns are written together or not at all, so a stamped
-- row without a ceiling is not a state this schema can reach.
--
-- Adding nullable columns with no default is a catalogue-only change in
-- PostgreSQL — no table rewrite, no `CONCURRENTLY`, safe on a large
-- `subscriptions` table.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "device_limit_reduced_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "device_limit_before_reduction" INTEGER;

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
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `UPDATE OF "device_limit"` so the function is not entered by the far more
-- frequent writes that touch only `status`, `expires_at` or `config_url`.
-- `DROP ... IF EXISTS` first because `prisma migrate deploy` replays, and a bare
-- CREATE TRIGGER over an existing trigger is a hard error.
DROP TRIGGER IF EXISTS "subscriptions_stamp_device_limit_reduction" ON "subscriptions";
CREATE TRIGGER "subscriptions_stamp_device_limit_reduction"
  BEFORE UPDATE OF "device_limit" ON "subscriptions"
  FOR EACH ROW
  EXECUTE FUNCTION "stamp_subscription_device_limit_reduction"();
