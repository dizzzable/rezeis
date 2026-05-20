-- Phase 4 — Automations: rule engine + execution log.
--
-- Two tables drive the IFTTT-style automation feature:
--   automation_rules       — operator-edited rule definitions.
--   automation_executions  — append-only history with per-action results.

-- CreateEnum
CREATE TYPE "AutomationTriggerKind" AS ENUM ('REALTIME', 'CRON', 'MANUAL');

-- CreateEnum
CREATE TYPE "AutomationExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger_kind" "AutomationTriggerKind" NOT NULL,
    "trigger_spec" TEXT NOT NULL DEFAULT '',
    "conditions" JSONB,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" TEXT,
    "last_run_at" TIMESTAMPTZ(3),
    "last_run_status" "AutomationExecutionStatus",
    "last_run_message" TEXT,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_executions" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "status" "AutomationExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" TEXT NOT NULL,
    "trigger_payload" JSONB NOT NULL DEFAULT '{}',
    "action_results" JSONB NOT NULL DEFAULT '[]',
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_rules_is_enabled_idx" ON "automation_rules"("is_enabled");

-- CreateIndex
CREATE INDEX "automation_rules_trigger_kind_idx" ON "automation_rules"("trigger_kind");

-- CreateIndex
CREATE INDEX "automation_executions_rule_id_idx" ON "automation_executions"("rule_id");

-- CreateIndex
CREATE INDEX "automation_executions_status_idx" ON "automation_executions"("status");

-- CreateIndex
CREATE INDEX "automation_executions_created_at_idx" ON "automation_executions"("created_at");

-- AddForeignKey
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
