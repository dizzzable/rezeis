-- Phase 3 — Persistent fraud signals.
--
-- Replaces the previous stateless `AntiFraudService.generateReport()`
-- flow with a row-per-finding model so the admin UI can show history,
-- track resolution, dedupe duplicate alerts and chain automation actions
-- (notify / block_user / freeze_subscription).

-- CreateEnum
CREATE TYPE "FraudSignalSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "FraudSignalStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "fraud_signals" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL DEFAULT '',
    "severity" "FraudSignalSeverity" NOT NULL,
    "status" "FraudSignalStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "confidence" INTEGER NOT NULL DEFAULT 100,
    "affected_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "last_action" TEXT NOT NULL DEFAULT 'none',
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" TEXT,
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fraud_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fraud_signals_code_fingerprint_key" ON "fraud_signals"("code", "fingerprint");

-- CreateIndex
CREATE INDEX "fraud_signals_status_idx" ON "fraud_signals"("status");

-- CreateIndex
CREATE INDEX "fraud_signals_severity_idx" ON "fraud_signals"("severity");

-- CreateIndex
CREATE INDEX "fraud_signals_code_idx" ON "fraud_signals"("code");

-- CreateIndex
CREATE INDEX "fraud_signals_detected_at_idx" ON "fraud_signals"("detected_at");
