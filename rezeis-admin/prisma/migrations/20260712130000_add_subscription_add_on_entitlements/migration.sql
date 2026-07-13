-- Durable subscription Add-on entitlements: additive schema primitives only.
-- Generated from the Prisma schema diff; the partial ACTIVE-term index below
-- is migration-owned because Prisma cannot express filtered indexes.
-- No backfill or runtime feature activation occurs in this migration.

-- CreateEnum
CREATE TYPE "SubscriptionTermStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "ResetEpochCloseSource" AS ENUM ('SCHEDULER', 'WEBHOOK_RECONCILIATION', 'TERM_END', 'OPERATOR');

-- CreateEnum
CREATE TYPE "AddOnLifetime" AS ENUM ('UNTIL_NEXT_RESET', 'UNTIL_SUBSCRIPTION_END');

-- CreateEnum
CREATE TYPE "AddOnEntitlementState" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'REVERSED', 'REMEDIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "AddOnEntitlementActorType" AS ENUM ('SYSTEM', 'ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "EffectiveProjectionState" AS ENUM ('SHADOW', 'PENDING', 'APPLIED', 'DRIFTED', 'REMEDIATION_REQUIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "DeviceReductionPlanState" AS ENUM ('PENDING', 'IN_PROGRESS', 'BLOCKED', 'APPLIED', 'SUPERSEDED', 'REMEDIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "EntitlementIncidentKind" AS ENUM ('PAID_FULFILLMENT_STALLED', 'PROJECTION_DRIFT', 'DEVICE_REDUCTION_BLOCKED', 'REFUND_OR_CHARGEBACK', 'INVALID_CAPTURED_TARGET', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "EntitlementIncidentSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EntitlementIncidentState" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterTable
ALTER TABLE "profile_sync_jobs" ADD COLUMN     "aggregate_key" TEXT,
ADD COLUMN     "cause" TEXT,
ADD COLUMN     "desired_revision" BIGINT,
ADD COLUMN     "recovery_data" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "superseded_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "add_ons" ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "lifetime" "AddOnLifetime" NOT NULL DEFAULT 'UNTIL_NEXT_RESET',
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "add_ons"
  ADD CONSTRAINT "add_ons_revision_check"
  CHECK ("revision" > 0);

-- CreateTable
CREATE TABLE "subscription_terms" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "plan_id" TEXT,
    "plan_revision" INTEGER,
    "plan_snapshot" JSONB NOT NULL DEFAULT '{}',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "status" "SubscriptionTermStatus" NOT NULL DEFAULT 'SCHEDULED',
    "base_traffic_limit_bytes" BIGINT,
    "base_device_limit" INTEGER,
    "traffic_reset_strategy" "TrafficLimitStrategy" NOT NULL DEFAULT 'NO_RESET',
    "reset_anchor_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_reset_epochs" (
    "id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "planned_ends_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "close_source" "ResetEpochCloseSource",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_reset_epochs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "add_on_entitlements" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "source_transaction_id" TEXT NOT NULL,
    "source_line_key" TEXT NOT NULL,
    "add_on_id" TEXT,
    "catalog_revision" INTEGER NOT NULL,
    "receipt_name" TEXT NOT NULL,
    "type" "AddOnType" NOT NULL,
    "value_per_unit" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "total_value" BIGINT NOT NULL,
    "lifetime" "AddOnLifetime" NOT NULL,
    "applicability_snapshot" JSONB NOT NULL DEFAULT '{}',
    "unit_amount" DECIMAL(20,8) NOT NULL,
    "total_amount" DECIMAL(20,8) NOT NULL,
    "currency" "Currency" NOT NULL,
    "purchased_at" TIMESTAMPTZ(3) NOT NULL,
    "scheduled_activation_at" TIMESTAMPTZ(3) NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "expiry_epoch_id" TEXT,
    "state" "AddOnEntitlementState" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "terminal_reason" TEXT,
    "terminal_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "add_on_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "add_on_entitlement_events" (
    "id" TEXT NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "from_state" "AddOnEntitlementState",
    "to_state" "AddOnEntitlementState" NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_type" "AddOnEntitlementActorType" NOT NULL,
    "actor_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "command_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "add_on_entitlement_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_effective_projections" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "baseline_term_id" TEXT NOT NULL,
    "desired_revision" BIGINT NOT NULL DEFAULT 0,
    "base_traffic_limit_bytes" BIGINT,
    "base_device_limit" INTEGER,
    "active_traffic_contribution_bytes" BIGINT NOT NULL DEFAULT 0,
    "active_device_contribution" INTEGER NOT NULL DEFAULT 0,
    "desired_traffic_limit_bytes" BIGINT,
    "desired_device_limit" INTEGER,
    "state" "EffectiveProjectionState" NOT NULL DEFAULT 'SHADOW',
    "last_applied_revision" BIGINT,
    "last_applied_at" TIMESTAMPTZ(3),
    "observed_traffic_limit_bytes" BIGINT,
    "observed_device_limit" INTEGER,
    "observed_at" TIMESTAMPTZ(3),
    "observed_contract_version" TEXT,
    "drift_class" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_effective_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_reduction_plans" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "projection_id" TEXT NOT NULL,
    "projection_revision" BIGINT NOT NULL,
    "desired_limit" INTEGER NOT NULL,
    "selected_devices" JSONB NOT NULL DEFAULT '[]',
    "state" "DeviceReductionPlanState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "postcondition_metadata" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "device_reduction_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_incidents" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "entitlement_id" TEXT,
    "kind" "EntitlementIncidentKind" NOT NULL,
    "severity" "EntitlementIncidentSeverity" NOT NULL DEFAULT 'WARNING',
    "state" "EntitlementIncidentState" NOT NULL DEFAULT 'OPEN',
    "support_ref" TEXT NOT NULL,
    "summary_code" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMPTZ(3),
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "entitlement_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_sync_jobs_aggregate_key_desired_revision_idx" ON "profile_sync_jobs"("aggregate_key", "desired_revision");

-- CreateIndex
CREATE INDEX "profile_sync_jobs_status_scheduled_at_idx" ON "profile_sync_jobs"("status", "scheduled_at");

-- PostgreSQL-only invariants not expressible in Prisma schema syntax.
ALTER TABLE "subscription_terms"
  ADD CONSTRAINT "subscription_terms_generation_check"
  CHECK ("generation" > 0 AND ("ends_at" IS NULL OR "ends_at" > "starts_at"));

ALTER TABLE "subscription_reset_epochs"
  ADD CONSTRAINT "subscription_reset_epochs_ordinal_check"
  CHECK ("ordinal" > 0);

ALTER TABLE "subscription_reset_epochs"
  ADD CONSTRAINT "subscription_reset_epochs_boundary_check"
  CHECK ("planned_ends_at" > "starts_at");

ALTER TABLE "add_on_entitlements"
  ADD CONSTRAINT "add_on_entitlements_commercial_values_check"
  CHECK (
    "catalog_revision" > 0
    AND "quantity" = 1
    AND "value_per_unit" > 0
    AND "total_value" > 0
    AND "unit_amount" >= 0
    AND "total_amount" >= 0
  );

ALTER TABLE "add_on_entitlements"
  ADD CONSTRAINT "add_on_entitlements_boundary_check"
  CHECK ("expires_at" IS NULL OR "expires_at" > "scheduled_activation_at");

ALTER TABLE "subscription_effective_projections"
  ADD CONSTRAINT "subscription_effective_projections_nonnegative_check"
  CHECK (
    "desired_revision" >= 0
    AND "active_traffic_contribution_bytes" >= 0
    AND "active_device_contribution" >= 0
    AND ("base_traffic_limit_bytes" IS NULL OR "base_traffic_limit_bytes" >= 0)
    AND ("base_device_limit" IS NULL OR "base_device_limit" >= 0)
    AND ("desired_traffic_limit_bytes" IS NULL OR "desired_traffic_limit_bytes" >= 0)
    AND ("desired_device_limit" IS NULL OR "desired_device_limit" >= 0)
  );

ALTER TABLE "device_reduction_plans"
  ADD CONSTRAINT "device_reduction_plans_nonnegative_check"
  CHECK ("desired_limit" >= 0 AND "projection_revision" >= 0 AND "attempts" >= 0);

-- PostgreSQL-only invariant not expressible in Prisma schema syntax.
-- At most one ACTIVE commercial term may exist per subscription.
CREATE UNIQUE INDEX "subscription_terms_one_active_idx"
  ON "subscription_terms" ("subscription_id")
  WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "subscription_terms_subscription_id_status_idx" ON "subscription_terms"("subscription_id", "status");

-- CreateIndex
CREATE INDEX "subscription_terms_status_starts_at_idx" ON "subscription_terms"("status", "starts_at");

-- CreateIndex
CREATE INDEX "subscription_terms_status_ends_at_idx" ON "subscription_terms"("status", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_terms_subscription_id_generation_key" ON "subscription_terms"("subscription_id", "generation");

CREATE UNIQUE INDEX "subscription_terms_id_subscription_id_key" ON "subscription_terms"("id", "subscription_id");

-- CreateIndex
CREATE INDEX "subscription_reset_epochs_closed_at_planned_ends_at_idx" ON "subscription_reset_epochs"("closed_at", "planned_ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_reset_epochs_term_id_ordinal_key" ON "subscription_reset_epochs"("term_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_reset_epochs_term_id_planned_ends_at_key" ON "subscription_reset_epochs"("term_id", "planned_ends_at");

CREATE UNIQUE INDEX "subscription_reset_epochs_id_term_id_key" ON "subscription_reset_epochs"("id", "term_id");

-- CreateIndex
CREATE INDEX "add_on_entitlements_subscription_id_state_idx" ON "add_on_entitlements"("subscription_id", "state");

-- CreateIndex
CREATE INDEX "add_on_entitlements_term_id_state_idx" ON "add_on_entitlements"("term_id", "state");

-- CreateIndex
CREATE INDEX "add_on_entitlements_state_expires_at_idx" ON "add_on_entitlements"("state", "expires_at");

-- CreateIndex
CREATE INDEX "add_on_entitlements_expiry_epoch_id_idx" ON "add_on_entitlements"("expiry_epoch_id");

-- CreateIndex
CREATE UNIQUE INDEX "add_on_entitlements_source_transaction_id_source_line_key_key" ON "add_on_entitlements"("source_transaction_id", "source_line_key");

-- CreateIndex
CREATE INDEX "add_on_entitlement_events_entitlement_id_created_at_idx" ON "add_on_entitlement_events"("entitlement_id", "created_at");

-- CreateIndex
CREATE INDEX "add_on_entitlement_events_correlation_id_idx" ON "add_on_entitlement_events"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "add_on_entitlement_events_entitlement_id_command_key_key" ON "add_on_entitlement_events"("entitlement_id", "command_key");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_effective_projections_subscription_id_key" ON "subscription_effective_projections"("subscription_id");

-- CreateIndex
CREATE INDEX "subscription_effective_projections_state_updated_at_idx" ON "subscription_effective_projections"("state", "updated_at");

-- CreateIndex
CREATE INDEX "subscription_effective_projections_baseline_term_id_idx" ON "subscription_effective_projections"("baseline_term_id");

-- CreateIndex
CREATE INDEX "device_reduction_plans_state_created_at_idx" ON "device_reduction_plans"("state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_reduction_plans_subscription_id_projection_revision_key" ON "device_reduction_plans"("subscription_id", "projection_revision");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_incidents_support_ref_key" ON "entitlement_incidents"("support_ref");

-- CreateIndex
CREATE INDEX "entitlement_incidents_state_severity_created_at_idx" ON "entitlement_incidents"("state", "severity", "created_at");

-- CreateIndex
CREATE INDEX "entitlement_incidents_subscription_id_state_idx" ON "entitlement_incidents"("subscription_id", "state");

-- CreateIndex
CREATE INDEX "entitlement_incidents_entitlement_id_idx" ON "entitlement_incidents"("entitlement_id");

-- AddForeignKey
ALTER TABLE "subscription_terms" ADD CONSTRAINT "subscription_terms_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_reset_epochs" ADD CONSTRAINT "subscription_reset_epochs_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "subscription_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_on_entitlements" ADD CONSTRAINT "add_on_entitlements_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_on_entitlements" ADD CONSTRAINT "add_on_entitlements_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "subscription_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "add_on_entitlements" ADD CONSTRAINT "add_on_entitlements_term_subscription_fkey" FOREIGN KEY ("term_id", "subscription_id") REFERENCES "subscription_terms"("id", "subscription_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_on_entitlements" ADD CONSTRAINT "add_on_entitlements_source_transaction_id_fkey" FOREIGN KEY ("source_transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_on_entitlements" ADD CONSTRAINT "add_on_entitlements_add_on_id_fkey" FOREIGN KEY ("add_on_id") REFERENCES "add_ons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_on_entitlements" ADD CONSTRAINT "add_on_entitlements_expiry_epoch_term_fkey" FOREIGN KEY ("expiry_epoch_id", "term_id") REFERENCES "subscription_reset_epochs"("id", "term_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "add_on_entitlement_events" ADD CONSTRAINT "add_on_entitlement_events_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "add_on_entitlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_effective_projections" ADD CONSTRAINT "subscription_effective_projections_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_effective_projections" ADD CONSTRAINT "subscription_effective_projections_baseline_term_id_fkey" FOREIGN KEY ("baseline_term_id") REFERENCES "subscription_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_reduction_plans" ADD CONSTRAINT "device_reduction_plans_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_reduction_plans" ADD CONSTRAINT "device_reduction_plans_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "subscription_effective_projections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_incidents" ADD CONSTRAINT "entitlement_incidents_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_incidents" ADD CONSTRAINT "entitlement_incidents_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "add_on_entitlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
