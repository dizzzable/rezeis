-- AlterEnum: add Valutix payment gateway (same platform engine as RIOPAY).
-- Idempotent so a re-run (or a partially-applied deploy) never fails.
ALTER TYPE "PaymentGatewayType" ADD VALUE IF NOT EXISTS 'VALUTIX';
