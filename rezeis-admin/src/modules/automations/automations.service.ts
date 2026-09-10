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
import { POPUP_CAPABLE_EVENTS, canCarryPopup } from './popup-capable-events';
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
    this.assertActionsValid(dto.actions, dto.triggerKind, dto.triggerSpec);
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
    this.assertActionsValid(dto.actions, dto.triggerKind, dto.triggerSpec);
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

  /**
   * Actions that choose their own recipients, and so cannot ride an event.
   *
   * `show_hint_to_audience` resolves a cohort and raises a hint for each of up
   * to five hundred people. On a schedule that is the point; on a realtime rule
   * it would do all of it again on EVERY system event.
   *
   * The action refuses at execution time, which stops the queries — but by then
   * the engine has already enqueued a job, inserted an `automation_executions`
   * row and updated the rule. A `*` pattern under a payment burst is thousands
   * of those a minute, in a table nothing sweeps. Refusing the SAVE is what
   * actually costs nothing, and it tells the operator while they are still
   * looking at the form rather than in a run log they may never open.
   *
   * The editor defaults a new rule to REALTIME, so this is not an exotic
   * mistake — it is what happens if somebody picks the action and presses save.
   */
  private static readonly SCHEDULE_ONLY_ACTIONS: readonly string[] = ['show_hint_to_audience'];

  private assertActionsValid(
    actions: readonly { type: string }[],
    triggerKind: AutomationTriggerKind,
    triggerSpec: string,
  ): void {
    if (actions.length === 0) {
      throw new BadRequestException('At least one action is required');
    }
    for (const action of actions) {
      if (!(AUTOMATION_ACTION_TYPES as readonly string[]).includes(action.type)) {
        throw new BadRequestException(`Unknown action type: ${action.type}`);
      }
      if (
        triggerKind === AutomationTriggerKind.REALTIME &&
        AutomationsService.SCHEDULE_ONLY_ACTIONS.includes(action.type)
      ) {
        throw new BadRequestException(
          `Action "${action.type}" picks its own recipients, so it cannot run on an event. ` +
            `Use a scheduled trigger.`,
        );
      }
      // ── A pop-up on an event that cannot carry one ──────────────────────
      //
      // This is refused HERE because there is nowhere later that can say it.
      // A rule bound to an event nothing emits is never selected by the
      // pattern filter, so it produces no execution row, no error and no log
      // line — it reads "enabled" in the list for ever. Four of the eight
      // ready-made pop-ups shipped in exactly that state, and the only way an
      // operator could have found out was that customers never mentioned it.
      //
      // The list is closed on purpose, and that is a real cost: a custom type
      // raised through `POST /api/internal/events` carrying a `userId` WOULD
      // work at run time, and this refuses it. The trade is deliberate — an
      // event worth binding a pop-up to is worth an entry in
      // `POPUP_CAPABLE_EVENTS`, where a spec proves it is emitted and does
      // name a customer. Silence is the thing being bought out.
      if (
        action.type === 'show_hint' &&
        triggerKind === AutomationTriggerKind.REALTIME &&
        !canCarryPopup(triggerSpec)
      ) {
        throw new BadRequestException(
          `"${triggerSpec.trim()}" cannot show a pop-up: it is either never emitted or it does ` +
            'not name a customer, and a rule bound to it would fail silently. ' +
            `Events that can: ${POPUP_CAPABLE_EVENTS.map((event) => event.type).join(', ')}`,
        );
      }
      // ── A pop-up on a schedule has nobody to show it to ─────────────────
      //
      // The check above was gated on REALTIME alone, which let the same
      // mistake through the other door: the action picker offers "show a hint"
      // for every trigger kind, so an operator could pick it, switch the
      // trigger to a nightly cron, and save. The cron dispatcher builds
      // `triggerData` as `{ firedAt, spec }` — there is no customer in it and
      // there cannot be, because a schedule is not about anybody — so every
      // 03:00 run writes a FAILED execution row.
      //
      // Louder than the silent case, and still worth refusing up front: the
      // operator is on the page that could tell them.
      //
      // MANUAL is deliberately not refused. A manual run carries the
      // admin-supplied `triggerData`, and `params.userId` names the person on
      // purpose — that is how an operator sends one pop-up to one customer.
      if (
        action.type === 'show_hint' &&
        triggerKind === AutomationTriggerKind.CRON
      ) {
        throw new BadRequestException(
          'A pop-up needs somebody to show it to, and a schedule names nobody. ' +
            'Bind this rule to an event about a customer, or run it manually with a user id.',
        );
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
