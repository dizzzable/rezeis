import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AutomationExecutionStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AutomationActionRegistry } from './actions/action-registry';
import { AutomationJobData } from './automation-queue.service';
import { AUTOMATION_PAYLOAD_TRUNCATE_BYTES } from './automations.constants';
import {
  AutomationActionContext,
  AutomationActionDefinition,
  AutomationActionResult,
} from './interfaces/automation-action.interface';
import {
  evaluateCondition,
  LogicExpression,
} from './utils/expression-evaluator';

interface ExecuteRuleResult {
  readonly executionId: string;
  readonly status: AutomationExecutionStatus;
  readonly actionResults: readonly AutomationActionResult[];
  readonly errorMessage: string | null;
}

/**
 * Runs a single rule against its trigger payload. Wrapped by a BullMQ
 * processor and also reused by `POST /admin/automations/rules/:id/run`
 * for manual / dry-run invocations.
 *
 * Lifecycle
 *   1. Resolve the rule. Missing / disabled → record `SKIPPED`.
 *   2. Evaluate `conditions` against the payload. False → record `SKIPPED`.
 *   3. Execute every action sequentially. Failures don't abort the chain.
 *   4. Persist the resulting execution row + update rule's `lastRun*` cache.
 */
@Injectable()
export class AutomationExecutorService {
  private readonly logger = new Logger(AutomationExecutorService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly actionRegistry: AutomationActionRegistry,
  ) {}

  public async executeJob(job: AutomationJobData): Promise<ExecuteRuleResult> {
    const startedAt = new Date();
    const rule = await this.prismaService.automationRule.findUnique({
      where: { id: job.ruleId },
    });

    if (!rule) {
      // The rule was deleted between enqueue and processor pickup.
      // Materialise a SKIPPED execution row so operators can see the
      // mismatch in the history view.
      return this.recordOrphan(job, startedAt);
    }

    if (!rule.isEnabled) {
      return this.persistExecution({
        ruleId: rule.id,
        status: AutomationExecutionStatus.SKIPPED,
        trigger: job.trigger,
        triggerPayload: job.triggerData,
        actionResults: [],
        errorMessage: 'rule disabled',
        startedAt,
        finishedAt: new Date(),
      });
    }

    // Condition gate
    const conditions = (rule.conditions ?? null) as LogicExpression | null;
    if (!evaluateCondition(conditions, job.triggerData)) {
      return this.persistExecution({
        ruleId: rule.id,
        status: AutomationExecutionStatus.SKIPPED,
        trigger: job.trigger,
        triggerPayload: job.triggerData,
        actionResults: [],
        errorMessage: 'conditions did not match',
        startedAt,
        finishedAt: new Date(),
      });
    }

    // Action chain
    const context: AutomationActionContext = {
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: job.trigger,
      triggerData: job.triggerData,
    };
    const actionDefs = (rule.actions ?? []) as unknown as readonly AutomationActionDefinition[];
    const results: AutomationActionResult[] = [];
    for (let index = 0; index < actionDefs.length; index++) {
      const action = actionDefs[index];
      const result = await this.actionRegistry.execute(index, action, context);
      results.push(result);
    }

    const status = results.every((r) => r.status !== 'failed')
      ? AutomationExecutionStatus.SUCCEEDED
      : AutomationExecutionStatus.FAILED;
    const errorMessage = results
      .filter((r) => r.status === 'failed')
      .map((r) => `[${r.type}] ${r.message ?? 'unknown error'}`)
      .join('; ');

    return this.persistExecution({
      ruleId: rule.id,
      status,
      trigger: job.trigger,
      triggerPayload: job.triggerData,
      actionResults: results,
      errorMessage: errorMessage || null,
      startedAt,
      finishedAt: new Date(),
    });
  }

  /** Used by the manual "Run now" controller endpoint. */
  public async runManually(input: {
    readonly ruleId: string;
    readonly adminId: string | null;
    readonly triggerData: Readonly<Record<string, unknown>>;
  }): Promise<ExecuteRuleResult> {
    const exists = await this.prismaService.automationRule.findUnique({
      where: { id: input.ruleId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Rule not found');
    return this.executeJob({
      ruleId: input.ruleId,
      trigger: `manual:${input.adminId ?? 'system'}`,
      triggerData: input.triggerData,
    });
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private async persistExecution(input: {
    readonly ruleId: string;
    readonly status: AutomationExecutionStatus;
    readonly trigger: string;
    readonly triggerPayload: Readonly<Record<string, unknown>>;
    readonly actionResults: readonly AutomationActionResult[];
    readonly errorMessage: string | null;
    readonly startedAt: Date;
    readonly finishedAt: Date;
  }): Promise<ExecuteRuleResult> {
    const durationMs = input.finishedAt.getTime() - input.startedAt.getTime();
    const truncatedPayload = truncateJson(input.triggerPayload);
    const created = await this.prismaService.$transaction(async (tx) => {
      const execution = await tx.automationExecution.create({
        data: {
          ruleId: input.ruleId,
          status: input.status,
          trigger: input.trigger,
          triggerPayload: truncatedPayload as Prisma.InputJsonValue,
          actionResults: input.actionResults as unknown as Prisma.InputJsonValue,
          errorMessage: input.errorMessage,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          durationMs,
        },
      });
      // Best-effort: update rule's lastRun cache so list views look fresh.
      // We don't increment runCount on SKIPPED — operators expect that
      // counter to reflect "actually fired" semantics.
      const incrementRunCount = input.status === AutomationExecutionStatus.SUCCEEDED ||
        input.status === AutomationExecutionStatus.FAILED;
      await tx.automationRule.update({
        where: { id: input.ruleId },
        data: {
          lastRunAt: input.finishedAt,
          lastRunStatus: input.status,
          lastRunMessage: input.errorMessage,
          ...(incrementRunCount ? { runCount: { increment: 1 } } : {}),
        },
      });
      return execution;
    });
    return {
      executionId: created.id,
      status: input.status,
      actionResults: input.actionResults,
      errorMessage: input.errorMessage,
    };
  }

  private async recordOrphan(
    job: AutomationJobData,
    _startedAt: Date,
  ): Promise<ExecuteRuleResult> {
    this.logger.warn(`Automation job orphaned (rule deleted): ${job.ruleId}`);
    return {
      executionId: '',
      status: AutomationExecutionStatus.SKIPPED,
      actionResults: [],
      errorMessage: 'rule no longer exists',
    };
  }
}

/**
 * Trim the trigger payload before persisting. Some realtime events carry
 * large arrays (e.g. fraud signal `affectedUserIds`); we cap the JSON at
 * 8 KB to keep `automation_executions` readable. Truncated payloads are
 * marked with a sentinel key so debugging stays honest.
 */
function truncateJson(payload: Readonly<Record<string, unknown>>): unknown {
  try {
    const json = JSON.stringify(payload);
    if (json.length <= AUTOMATION_PAYLOAD_TRUNCATE_BYTES) return payload;
    return {
      __truncated: true,
      originalBytes: json.length,
      preview: json.slice(0, AUTOMATION_PAYLOAD_TRUNCATE_BYTES),
    };
  } catch {
    return { __error: 'Could not serialise trigger payload' };
  }
}
