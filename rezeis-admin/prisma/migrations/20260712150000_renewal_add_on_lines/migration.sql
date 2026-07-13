-- Renewal add-on composition lines (subscription-add-on-entitlements, T-007).
-- Additive only: one nullable JSONB column on each renewal line. Existing rows
-- keep NULL (no add-ons); the whole feature stays dormant behind the
-- `renewalAddOns` rollout flag (OFF by default). Each stored line carries the
-- selected add-on's revision/type/value/lifetime/activation + priced amount +
-- a deterministic sourceLineKey, so fulfillment can create the matching
-- PENDING entitlement idempotently on the scheduled renewal term.

-- AlterTable
ALTER TABLE "transaction_items"
  ADD COLUMN "add_on_lines" JSONB;
