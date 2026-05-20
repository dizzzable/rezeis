import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AutomationRule,
  AutomationTriggerKind,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AutomationExecutorService } from './automation-executor.service';
import {
  AUTOMATION_ACTION_TYPES,
} from './automations.constants';
import { ListExecutionsQueryDto } from './dto/list-executions.dto';
import { UpsertAutomationRuleDto } from './dto/upsert-automation-rule.dto';
import {
  AutomationActionDefinition,
  AutomationActionResult,
} from './interfaces/automation-action.interface';
import {
  AutomationExecutionInterface,
  AutomationRuleInterface,
  ListExecutionsResult,
} from './interfaces/automation-rule.interface';
import { LogicExpression } from './utils/expression-evaluator';

@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly executorService: AutomationExecutorService,
  ) {}

  // ── Rule CRUD ──────────────────────────────────────────────────────────

  public async listRules(): Promise<readonly AutomationRuleInterface[]> {
    const rows = await this.prismaService.automationRule.findMany({
      orderBy: [{ isEnabled: 'desc' }, { name: 'asc' }],
    });
    return rows.map(mapRule);
  }

  public async getRule(id: string): Promise<AutomationRuleInterface> {
    const row = await this.prismaService.automationRule.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Rule not found');
    return mapRule(row);
  }

  public async createRule(
    dto: UpsertAutomationRuleDto,
    createdById: string | null,
  ): Promise<AutomationRuleInterface> {
    this.assertActionsValid(dto.actions);
    this.assertTriggerSpecValid(dto.triggerKind, dto.triggerSpec);

    const created = await this.prismaService.automationRule.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        isEnabled: dto.isEnabled ?? true,
        triggerKind: dto.triggerKind,
        triggerSpec: dto.triggerSpec,
        conditions: (dto.conditions as Prisma.InputJsonValue) ?? Prisma.DbNull,
        actions: dto.actions as unknown as Prisma.InputJsonValue,
        createdById,
      },
    });
    return mapRule(created);
  }

  public async updateRule(
    id: string,
    dto: UpsertAutomationRuleDto,
  ): Promise<AutomationRuleInterface> {
    const existing = await this.prismaService.automationRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Rule not found');
    this.assertActionsValid(dto.actions);
    this.assertTriggerSpecValid(dto.triggerKind, dto.triggerSpec);

    const updated = await this.prismaService.automationRule.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description ?? null,
        isEnabled: dto.isEnabled ?? true,
        triggerKind: dto.triggerKind,
        triggerSpec: dto.triggerSpec,
        conditions: (dto.conditions as Prisma.InputJsonValue) ?? Prisma.DbNull,
        actions: dto.actions as unknown as Prisma.InputJsonValue,
      },
    });
    return mapRule(updated);
  }

  public async toggleRule(id: string, isEnabled: boolean): Promise<AutomationRuleInterface> {
    try {
      const updated = await this.prismaService.automationRule.update({
        where: { id },
        data: { isEnabled },
      });
      return mapRule(updated);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Rule not found');
      }
      throw err;
    }
  }

  public async deleteRule(id: string): Promise<void> {
    try {
      await this.prismaService.automationRule.delete({ where: { id } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Rule not found');
      }
      throw err;
    }
  }

  // ── Manual / dry-run execution ─────────────────────────────────────────

  public async runRuleManually(input: {
    readonly ruleId: string;
    readonly adminId: string | null;
    readonly triggerData: Readonly<Record<string, unknown>>;
  }): Promise<{
    readonly executionId: string;
    readonly status: string;
    readonly actionResults: readonly AutomationActionResult[];
    readonly errorMessage: string | null;
  }> {
    const result = await this.executorService.runManually(input);
    return {
      executionId: result.executionId,
      status: result.status,
      actionResults: result.actionResults,
      errorMessage: result.errorMessage,
    };
  }

  // ── Execution log ──────────────────────────────────────────────────────

  public async listExecutions(
    ruleId: string | null,
    query: ListExecutionsQueryDto,
  ): Promise<ListExecutionsResult> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const where: Prisma.AutomationExecutionWhereInput = {};
    if (ruleId) where.ruleId = ruleId;
    if (query.cursor) {
      const last = await this.prismaService.automationExecution.findUnique({
        where: { id: query.cursor },
        select: { id: true, createdAt: true },
      });
      if (last) {
        where.OR = [
          { createdAt: { lt: last.createdAt } },
          { createdAt: last.createdAt, id: { lt: last.id } },
        ];
      }
    }
    const rows = await this.prismaService.automationExecution.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit).map(mapExecution);
    const nextCursor = rows.length > limit ? items[items.length - 1].id : null;
    return { items, nextCursor };
  }

  // ── Validators ─────────────────────────────────────────────────────────

  private assertActionsValid(actions: readonly { type: string }[]): void {
    if (actions.length === 0) {
      throw new BadRequestException('At least one action is required');
    }
    for (const action of actions) {
      if (!(AUTOMATION_ACTION_TYPES as readonly string[]).includes(action.type)) {
        throw new BadRequestException(`Unknown action type: ${action.type}`);
      }
    }
  }

  private assertTriggerSpecValid(
    kind: AutomationTriggerKind,
    spec: string,
  ): void {
    const trimmed = spec.trim();
    switch (kind) {
      case AutomationTriggerKind.MANUAL:
        if (trimmed.length > 0) {
          throw new BadRequestException('MANUAL triggers must have an empty triggerSpec');
        }
        return;
      case AutomationTriggerKind.REALTIME:
        if (trimmed.length === 0) {
          throw new BadRequestException('REALTIME triggers require an event-type pattern');
        }
        return;
      case AutomationTriggerKind.CRON: {
        if (trimmed.length === 0) {
          throw new BadRequestException('CRON triggers require an expression');
        }
        // Best-effort validation. We don't fail when cron-parser is
        // unavailable — runtime evaluation guards against bad rows.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const cronParser = require('cron-parser') as typeof import('cron-parser');
          cronParser.parseExpression(trimmed);
        } catch (err) {
          if ((err as Error).message?.includes('Invalid cron')) {
            throw new BadRequestException(`Invalid cron expression: ${trimmed}`);
          }
        }
        return;
      }
    }
  }
}

function mapRule(row: AutomationRule): AutomationRuleInterface {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isEnabled: row.isEnabled,
    triggerKind: row.triggerKind,
    triggerSpec: row.triggerSpec,
    conditions: (row.conditions as LogicExpression | null) ?? null,
    actions: (row.actions as unknown as readonly AutomationActionDefinition[]) ?? [],
    createdById: row.createdById,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: row.lastRunStatus,
    lastRunMessage: row.lastRunMessage,
    runCount: row.runCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapExecution(row: {
  id: string;
  ruleId: string;
  status: AutomationExecutionInterface['status'];
  trigger: string;
  triggerPayload: Prisma.JsonValue;
  actionResults: Prisma.JsonValue;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  createdAt: Date;
}): AutomationExecutionInterface {
  return {
    id: row.id,
    ruleId: row.ruleId,
    status: row.status,
    trigger: row.trigger,
    triggerPayload: normaliseRecord(row.triggerPayload),
    actionResults: (row.actionResults as unknown as readonly AutomationActionResult[]) ?? [],
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

function normaliseRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
