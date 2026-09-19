import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AutomationRule,
  AutomationTriggerKind,
  Prisma,
} from '@prisma/client';

import { HEADER_FIELD_VALUE_RULE, isHeaderFieldValue } from '../../common/net/header-value';
import { checkOutboundUrl, describeOutboundUrlRefusal } from '../../common/net/outbound-url';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../common/utils/admin-audit-log.util';
import { RequestMetadataInterface } from '../auth/interfaces/request-metadata.interface';
import { HINT_AUDIENCES } from '../user-hints/services/hint-audience.service';
import { InvalidCronSpecError, loadCronParser, nextCronFire } from './automation-event-bridge.service';
import { AutomationExecutorService, type AuthorizeRule } from './automation-executor.service';
import { CUSTOM_EVENT_TYPE_RULE, isCustomEventType, systemEventTypeOf } from './custom-event-type';
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
import {
  BlockAddressUnverifiableError,
  BlockIpSafetyService,
  describeBlockProtection,
} from './services/block-ip-safety.service';
import { describeConditionProblem, findConditionProblem } from './utils/condition-validator';
import { LogicExpression } from './utils/expression-evaluator';
import { parseBlockEntry } from './utils/network-address.util';

/**
 * Who changed a rule, for the audit row written in the same transaction as the
 * change. Optional on the service so it stays callable without a request
 * behind it; the controller always supplies it.
 */
export interface AutomationAuditContext {
  readonly actorId: string;
  readonly requestMetadata: RequestMetadataInterface;
}

/**
 * What a reader of a rule may see of it.
 *
 * A `webhook_post` URL usually carries its receiver's secret in the path or the
 * query — Slack, Zapier and RequestBin all key it there — so the full URL goes
 * only to a reader who may edit that action: `automations:edit` AND
 * `webhooks:create`. Everyone else reads its origin and a marker
 * (`maskWebhookUrl`). The audit rows store the host alone for the same reason.
 */
export interface RuleReadView {
  readonly webhookUrls: boolean;
}

/** The view anything that did not ask for more is given. */
export const MASKED_RULE_VIEW: RuleReadView = { webhookUrls: false };

export interface AutomationWriteOptions {
  readonly audit?: AutomationAuditContext;
  /** What the answer to the write may show: the writer is its reader. */
  readonly view?: RuleReadView;
  /**
   * The requester's address, resolved the way `BlockedIpGuard` resolves it. A
   * `block_ip` address written into the rule may not cover it — the manual
   * blocklist screen's own check.
   */
  readonly requestIp?: string | null;
}

/** What validation reads off a rule, whether it arrives in a request or from a row. */
interface RuleShape {
  readonly triggerKind: AutomationTriggerKind;
  readonly triggerSpec: string;
  readonly conditions?: unknown;
  readonly actions: unknown;
}

/** One stored or submitted action, read defensively: an import can put anything in the column. */
interface ActionShape {
  readonly type: string;
  readonly params?: unknown;
}

@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly executorService: AutomationExecutorService,
    /**
     * The lockout check for an address written into a `block_ip` action.
     * Optional only so a service built by hand in a spec still constructs;
     * absent, such an address is refused as unverifiable rather than saved
     * unchecked.
     */
    @Optional()
    private readonly blockIpSafety?: BlockIpSafetyService,
  ) {}

  // ── Rule CRUD ──────────────────────────────────────────────────────────

  public async listRules(view: RuleReadView = MASKED_RULE_VIEW): Promise<readonly AutomationRuleInterface[]> {
    const rows = await this.prismaService.automationRule.findMany({
      orderBy: [{ isEnabled: 'desc' }, { name: 'asc' }],
    });
    return rows.map((row) => mapRule(row, view));
  }

  public async getRule(id: string, view: RuleReadView = MASKED_RULE_VIEW): Promise<AutomationRuleInterface> {
    const row = await this.prismaService.automationRule.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Rule not found');
    return mapRule(row, view);
  }

  public async createRule(
    dto: UpsertAutomationRuleDto,
    createdById: string | null,
    options: AutomationWriteOptions = {},
  ): Promise<AutomationRuleInterface> {
    // A new rule has no saved header or hidden URL for a reference to keep.
    const actions = keepSavedHeaders(keepHiddenUrls(dto.actions, null), null);
    await this.assertRuleValid({ ...dto, actions }, options.requestIp ?? null);

    const data: Prisma.AutomationRuleCreateInput = {
      name: dto.name,
      description: dto.description ?? null,
      isEnabled: dto.isEnabled ?? true,
      triggerKind: dto.triggerKind,
      triggerSpec: dto.triggerSpec,
      conditions: (dto.conditions as Prisma.InputJsonValue) ?? Prisma.DbNull,
      actions: actions as Prisma.InputJsonValue,
      createdById,
    };
    const audit = options.audit;
    const view = options.view ?? MASKED_RULE_VIEW;
    if (audit === undefined) {
      return mapRule(await this.prismaService.automationRule.create({ data }), view);
    }
    const created = await this.prismaService.$transaction(async (tx) => {
      const row = await tx.automationRule.create({ data });
      await tx.adminAuditLog.create({ data: ruleAuditData('automations.rule_created', audit, row) });
      return row;
    });
    return mapRule(created, view);
  }

  public async updateRule(
    id: string,
    dto: UpsertAutomationRuleDto,
    options: AutomationWriteOptions = {},
  ): Promise<AutomationRuleInterface> {
    const existing = await this.prismaService.automationRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Rule not found');
    // The headers and the hidden URLs the editor never saw come back as
    // references to the row just read; the check and the write below both see
    // the real values. The URLs first: a kept header is bound to the URL it was
    // saved with, and that is the URL a kept hidden one resolves to.
    const actions = keepSavedHeaders(keepHiddenUrls(dto.actions, existing.actions), existing.actions);
    await this.assertRuleValid({ ...dto, actions }, options.requestIp ?? null);

    const data: Prisma.AutomationRuleUpdateInput = {
      name: dto.name,
      description: dto.description ?? null,
      isEnabled: dto.isEnabled ?? true,
      triggerKind: dto.triggerKind,
      triggerSpec: dto.triggerSpec,
      conditions: (dto.conditions as Prisma.InputJsonValue) ?? Prisma.DbNull,
      actions: actions as Prisma.InputJsonValue,
    };
    const audit = options.audit;
    const view = options.view ?? MASKED_RULE_VIEW;
    if (audit === undefined) {
      const updated = await this.prismaService.automationRule.update({ where: { id }, data });
      return mapRule(updated, view);
    }
    const updated = await notFoundIfGone(() =>
      this.prismaService.$transaction(async (tx) => {
        const row = await tx.automationRule.update({ where: { id }, data });
        await tx.adminAuditLog.create({
          data: ruleAuditData('automations.rule_updated', audit, row, { previous: ruleSnapshot(existing) }),
        });
        return row;
      }),
    );
    return mapRule(updated, view);
  }

  /**
   * Switches a rule on or off.
   *
   * ── SWITCHING ON IS A SAVE ───────────────────────────────────────────────
   *
   * It used to be a bare `UPDATE … SET is_enabled`, so the switch in the list
   * put into force a rule no save would accept — conditions the evaluator
   * cannot read, a webhook aimed at the loopback, a block that covers an
   * admin — and it asked the operator for nothing beyond `automations:edit`.
   * Now switching ON asks exactly what a save asks: the same validation, and
   * `authorize` — the permission every action in the rule needs, of the admin
   * pressing the switch.
   *
   * Switching OFF asks nothing of the actions. Stopping a rule must never need
   * more than stopping it: whoever may edit rules can always turn one off.
   *
   * ── ONLY WHAT WAS CHECKED IS SWITCHED ON ─────────────────────────────────
   *
   * The checks run on the row read here, so the write that switches it on is
   * conditional on that row still being the one read: `updatedAt` must be
   * unchanged. An edit that lands in between — another admin adding an action
   * this one may not use, say — would otherwise be switched on by a check that
   * never saw it. On a mismatch nothing is written and the answer is 409:
   * the operator reloads the rule and decides again on what it now holds.
   * Switching OFF stays unconditional; it asks nothing of what the rule holds.
   */
  public async toggleRule(
    id: string,
    isEnabled: boolean,
    options: AutomationWriteOptions & { readonly authorize: AuthorizeRule },
  ): Promise<AutomationRuleInterface> {
    const existing = await this.prismaService.automationRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Rule not found');
    if (isEnabled) {
      await options.authorize({ id: existing.id, name: existing.name, actions: existing.actions });
      await this.assertRuleValid(existing, options.requestIp ?? null);
    }

    const audit = options.audit;
    const write = async (tx: Prisma.TransactionClient | PrismaService): Promise<AutomationRule> => {
      if (!isEnabled) return tx.automationRule.update({ where: { id }, data: { isEnabled } });
      const switched = await tx.automationRule.updateMany({
        where: { id, updatedAt: existing.updatedAt },
        data: { isEnabled },
      });
      if (switched.count !== 1) {
        throw new ConflictException(RULE_CHANGED_WHILE_SWITCHING_ON);
      }
      const row = await tx.automationRule.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('Rule not found');
      return row;
    };
    const updated = await notFoundIfGone(() => {
      if (audit === undefined) return write(this.prismaService);
      return this.prismaService.$transaction(async (tx) => {
        const row = await write(tx);
        await tx.adminAuditLog.create({
          data: ruleAuditData('automations.rule_toggled', audit, row, {
            previousIsEnabled: existing.isEnabled,
          }),
        });
        return row;
      });
    });
    return mapRule(updated, options.view ?? MASKED_RULE_VIEW);
  }

  public async deleteRule(id: string, options: { readonly audit?: AutomationAuditContext } = {}): Promise<void> {
    const audit = options.audit;
    await notFoundIfGone(async () => {
      if (audit === undefined) {
        await this.prismaService.automationRule.delete({ where: { id } });
        return;
      }
      await this.prismaService.$transaction(async (tx) => {
        // Read inside the transaction that deletes it, so the row the audit
        // names is the row that went.
        const row = await tx.automationRule.findUnique({ where: { id } });
        if (!row) throw new NotFoundException('Rule not found');
        await tx.automationRule.delete({ where: { id } });
        await tx.adminAuditLog.create({ data: ruleAuditData('automations.rule_deleted', audit, row) });
      });
    });
  }

  // ── Manual execution ───────────────────────────────────────────────────
  //
  // A real run, not a dry one: every action does what it does. It runs even
  // while the rule is switched off (the switch governs automatic firing), and
  // `showAgain` reaches the actions from here only — see `runManually`.
  //
  // `authorize` is required: running a rule by hand is a decision like saving
  // it, and it is asked the same question — every action's permission, of the
  // admin who pressed the button — on the rule exactly as it runs.

  public async runRuleManually(input: {
    readonly ruleId: string;
    readonly adminId: string | null;
    readonly triggerData: Readonly<Record<string, unknown>>;
    readonly showAgain?: boolean;
    readonly requestIp?: string | null;
    readonly authorize: AuthorizeRule;
    readonly audit?: AutomationAuditContext;
  }): Promise<{
    readonly executionId: string;
    readonly status: string;
    readonly actionResults: readonly AutomationActionResult[];
    readonly errorMessage: string | null;
  }> {
    let ran: { readonly id: string; readonly name: string; readonly actions: unknown } | null = null;
    const result = await this.executorService.runManually({
      ruleId: input.ruleId,
      adminId: input.adminId,
      triggerData: input.triggerData,
      showAgain: input.showAgain,
      requestIp: input.requestIp ?? null,
      authorize: async (rule) => {
        await input.authorize(rule);
        ran = rule;
      },
    });
    if (input.audit !== undefined) {
      await this.recordManualRun(input.audit, input, ran, result);
    }
    return {
      executionId: result.executionId,
      status: result.status,
      actionResults: result.actionResults,
      errorMessage: result.errorMessage,
    };
  }

  /**
   * The audit row for «Запустить сейчас».
   *
   * AFTER the run and best-effort, unlike every other row here, which shares
   * its write's transaction. By now the actions have done what they do — a
   * webhook left, an address was blocked — and answering the operator 500
   * because the audit insert failed would read as "the run failed" and invite
   * a second one. The failure is logged loudly instead.
   */
  private async recordManualRun(
    audit: AutomationAuditContext,
    input: { readonly ruleId: string; readonly triggerData: Readonly<Record<string, unknown>>; readonly showAgain?: boolean },
    rule: { readonly id: string; readonly name: string; readonly actions: unknown } | null,
    result: { readonly executionId: string; readonly status: string },
  ): Promise<void> {
    try {
      await this.prismaService.adminAuditLog.create({
        data: buildAdminAuditLogData({
          action: 'automations.rule_run',
          actorId: audit.actorId,
          requestMetadata: audit.requestMetadata,
          metadata: {
            requestId: audit.requestMetadata.requestId,
            targetType: 'automation_rule',
            targetId: input.ruleId,
            ruleName: rule?.name ?? null,
            actionTypes: actionTypesOf(rule?.actions),
            webhookHosts: webhookHostsOf(rule?.actions),
            executionId: result.executionId === '' ? null : result.executionId,
            status: result.status,
            showAgain: input.showAgain === true,
            // What the run was pointed at, when the body named it. Only these
            // two keys: the rest of `triggerData` is whatever the caller sent.
            requestedUserId: boundedString(input.triggerData['userId']),
            requestedAddress:
              boundedString(input.triggerData['ip']) ?? boundedString(input.triggerData['ipAddress']),
          },
        }),
      });
    } catch (err) {
      this.logger.error(
        `Audit row for the manual run of rule ${input.ruleId} was not written: ${(err as Error).message}`,
      );
    }
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
   * Everything a rule must be to be saved — or switched on.
   *
   * One pipeline for both, so that the switch in the list can never put into
   * force a rule the editor would refuse. The checks that were here first run
   * first, in their old order, so their refusals read exactly as they did.
   */
  private async assertRuleValid(rule: RuleShape, requestIp: string | null): Promise<void> {
    const actions = asActionList(rule.actions);
    this.assertActionsValid(actions, rule.triggerKind, rule.triggerSpec);
    this.assertTriggerSpecValid(rule.triggerKind, rule.triggerSpec);
    assertConditionsValid(rule.conditions);
    assertActionParamsValid(actions);
    assertBlockAddressAvailable(actions, rule.triggerKind);
    await this.assertBlockAddressesSafe(actions, requestIp);
  }

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
    actions: readonly ActionShape[],
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
          `Action "${action.type}" picks its own recipients, so it cannot run on an event ` +
            `— use a scheduled trigger`,
        );
      }
      // ── An audience rule has to name its audience ───────────────────────
      //
      // The action refuses a missing or unknown `audience` when it runs — on
      // EVERY run, so a nightly rule saved without one failed every night from
      // the night it was saved, and the editor's picker starts empty. Refused
      // here, it is said while the operator is still looking at the form. The
      // same trimmed read the action makes (`readString`), against the same
      // list (`HINT_AUDIENCES`), so a rule this accepts is one it can run.
      if (action.type === 'show_hint_to_audience' && !namesKnownAudience(action.params)) {
        throw new BadRequestException(
          `Action "${action.type}" needs an audience, one of: ${HINT_AUDIENCES.join(', ')}`,
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
            'not name a customer, and a rule bound to it would fail silently — events that ' +
            `can: ${POPUP_CAPABLE_EVENTS.map((event) => event.type).join(', ')}`,
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
      // MANUAL is deliberately not refused. A manual run names its customer in
      // the run body's `triggerData.userId` (for a pop-up that wins over a
      // `params.userId` pinned on the action), and it runs on a rule of any
      // trigger kind, even while the rule is switched off. A MANUAL rule is
      // simply one that only ever goes out that way — one pop-up to one
      // customer, by hand.
      if (
        action.type === 'show_hint' &&
        triggerKind === AutomationTriggerKind.CRON
      ) {
        throw new BadRequestException(
          'A pop-up needs somebody to show it to, and a schedule names nobody — ' +
            'bind this rule to an event about a customer, or run it manually with a user id',
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
        // The dispatcher's own question, on the same parser (`nextCronFire`),
        // so a spec saved here is one the scheduler can read. This used to
        // refuse only what cron-parser words as "Invalid cron expression",
        // which is a spec with too many fields: `61 * * * *`, `0 25 * * *` and
        // `abc` were saved, and then never ran.
        try {
          nextCronFire(loadCronParser(), trimmed, new Date());
        } catch (err: unknown) {
          if (err instanceof InvalidCronSpecError) {
            throw new BadRequestException(`Invalid cron expression: ${trimmed} (${err.message})`);
          }
          // Not the expression's fault: cron-parser is missing or changed, and
          // then no CRON rule runs at all. The save still goes through, as it
          // always did — but no longer silently, and the dispatcher repeats it
          // every minute with the rules it stopped.
          this.logger.error(
            `Could not check the cron expression "${trimmed}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
    }
  }

  /**
   * An address written into a `block_ip` action may not cover anything the
   * action itself would refuse to block — checked HERE as well, with the
   * requester's own address, so the operator is told while looking at the
   * form rather than in a run log (see `BlockIpSafetyService`).
   *
   * An address that arrives from a trigger cannot be known at save; the action
   * runs the same check on it when it fires.
   */
  private async assertBlockAddressesSafe(
    actions: readonly ActionShape[],
    requestIp: string | null,
  ): Promise<void> {
    for (const [index, action] of actions.entries()) {
      if (action.type !== 'block_ip') continue;
      const raw = pinnedBlockAddress(action.params);
      if (raw === null) continue;
      const entry = parseBlockEntry(raw);
      // Refused by `assertActionParamsValid` already; kept for the type.
      if (entry === null) continue;
      const label = `Action ${index + 1} (block_ip)`;
      if (this.blockIpSafety === undefined) {
        throw new ServiceUnavailableException(
          `${label}: the address could not be checked against the addresses it must not cover, ` +
            'so the rule was not saved',
        );
      }
      let refusal;
      try {
        refusal = await this.blockIpSafety.refusalFor(entry, { requestIp });
      } catch (err) {
        if (!(err instanceof BlockAddressUnverifiableError)) throw err;
        this.logger.warn(`block_ip address check could not run: ${err.message}`);
        throw new ServiceUnavailableException(
          `${label}: the administrators' addresses could not be read to check the address against, ` +
            'so the rule was not saved; try again',
        );
      }
      if (refusal !== null) {
        throw new BadRequestException(
          `${label}: the address ${entry.canonical} covers ${describeBlockProtection(refusal)}`,
        );
      }
    }
  }
}

// ── Validation that needs nothing but the rule ──────────────────────────

/** The action list, or a refusal: an import can put anything in the column. */
function asActionList(actions: unknown): readonly ActionShape[] {
  if (!Array.isArray(actions)) {
    throw new BadRequestException('Actions must be a list');
  }
  return actions.map((action: unknown) => {
    if (typeof action !== 'object' || action === null || Array.isArray(action)) {
      return { type: String(action) };
    }
    const record = action as Record<string, unknown>;
    return { type: typeof record['type'] === 'string' ? record['type'] : String(record['type']), params: record['params'] };
  });
}

/**
 * Conditions the evaluator will actually read — see `condition-validator.ts`.
 * It collapses whatever it does not understand to `false` without a word, so a
 * rule saved with a typo in its conditions never runs and never says why.
 */
function assertConditionsValid(conditions: unknown): void {
  const problem = findConditionProblem(conditions);
  if (problem !== null) throw new BadRequestException(describeConditionProblem(problem));
}

/**
 * What each action's params must be, where the action cannot say it later.
 *
 *   webhook_post  the URL passes `checkOutboundUrl` — the panel's own webhook
 *                 rules (http or https, parses, at most 2048 characters), and
 *                 neither the machine itself nor a cloud metadata service
 *                 (`common/net/outbound-url.ts`). The action checks it again
 *                 when it sends, where DNS can be asked too. Nor is it the
 *                 shortened form a read shows in place of a hidden URL
 *                 (`isHiddenUrlForm`): that parses, and reaches no receiver.
 *                 `authorizationHeader`, when present, is one line of text:
 *                 Node refuses a header with a control character in it, so
 *                 such a rule could only ever fail.
 *   block_ip      an `address` written into the rule is an IP address or a
 *                 CIDR range; `expiresAt` is a date. Both used to reach the
 *                 database as written and fail there, on every run.
 */
function assertActionParamsValid(actions: readonly ActionShape[]): void {
  actions.forEach((action, index) => {
    const params = isRecord(action.params) ? action.params : {};
    const label = `Action ${index + 1} (${action.type})`;
    if (action.type === 'webhook_post') {
      const target = checkOutboundUrl(params['url']);
      if (!target.ok) {
        throw new BadRequestException(`${label}: ${describeOutboundUrlRefusal(target.refusal)}`);
      }
      if (isHiddenUrlForm(params['url'])) {
        throw new BadRequestException(`${label}: ${HIDDEN_URL_FORM_RULE}`);
      }
      const header = params['authorizationHeader'];
      if (header !== undefined && header !== null && (typeof header !== 'string' || !isHeaderFieldValue(header))) {
        throw new BadRequestException(`${label}: "authorizationHeader" ${HEADER_FIELD_VALUE_RULE}`);
      }
    }
    if (action.type === 'system_event' && !isCustomEventType(systemEventTypeOf(params))) {
      throw new BadRequestException(`${label}: ${CUSTOM_EVENT_TYPE_RULE}`);
    }
    if (action.type === 'block_ip') {
      const address = params['address'];
      if (address !== undefined && address !== null && typeof address !== 'string') {
        throw new BadRequestException(`${label}: "address" is not an IP address or CIDR range`);
      }
      const pinned = pinnedBlockAddress(params);
      if (pinned !== null && parseBlockEntry(pinned) === null) {
        throw new BadRequestException(`${label}: "address" is not an IP address or CIDR range`);
      }
      const expiresAt = params['expiresAt'];
      if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
        if (typeof expiresAt !== 'string' || Number.isNaN(new Date(expiresAt).getTime())) {
          throw new BadRequestException(`${label}: "expiresAt" is not a valid date`);
        }
      }
    }
  });
}

/**
 * Whether a header value holds none of the control characters Node refuses in
 * one: every C0 character but TAB, and DEL. Compared by code, so the source
 * carries none of those characters and no regex that lint would refuse.
 */
/** The 409 of a switch-on whose rule changed after it was checked (`toggleRule`). */
export const RULE_CHANGED_WHILE_SWITCHING_ON =
  'The rule changed while it was being switched on — reload it and try again';

/** The address a `block_ip` action names itself, trimmed the way the action reads it; null when none. */
/**
 * A `block_ip` without an address of its own, on a rule that runs by itself.
 *
 * The action takes an address from the rule, or from the trigger data's
 * top-level `ip` / `ipAddress` — and only a MANUAL run can put one there (the
 * request body of «Запустить сейчас»). An event's payload is
 * `{ type, category, severity, message, metadata, timestamp }`
 * (`AutomationEventBridgeService.dispatchRealtime`), a schedule's is
 * `{ firedAt, spec }`, and no event the panel or the cabinet emits carries a
 * client address even inside `metadata`: `fraud.signal_opened` names the
 * signal, its score and its customers, never an address, including for an
 * `ip_sharing` signal whose addresses stay on the signal row. So such a rule
 * failed "no address" on every run it ever made — which is what the retired
 * «Антифрод → блок IP» template produced — and it is refused here instead.
 */
function assertBlockAddressAvailable(
  actions: readonly ActionShape[],
  triggerKind: AutomationTriggerKind,
): void {
  if (triggerKind === AutomationTriggerKind.MANUAL) return;
  actions.forEach((action, index) => {
    if (action.type !== 'block_ip' || pinnedBlockAddress(action.params) !== null) return;
    throw new BadRequestException(
      `Action ${index + 1} (block_ip): no event or schedule carries an IP address, ` +
        'so a rule that runs on its own needs the address written into the action',
    );
  });
}

function pinnedBlockAddress(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const value = params['address'];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ── Audit ────────────────────────────────────────────────────────────────

/**
 * An audit row about a rule: who (the actor and the request), when (the row's
 * own time), and which rule — its id and name, its trigger and every action
 * TYPE it holds.
 *
 * NEVER ITS PARAMS. `authorizationHeader` is a credential, and a webhook URL
 * routinely carries its secret in the path or the query; the host is the one
 * part of it an incident responder needs ("who pointed data at that?") and the
 * one part that is not a secret.
 */
function ruleAuditData(
  action: string,
  audit: AutomationAuditContext,
  rule: AutomationRule,
  extra: Record<string, unknown> = {},
): Prisma.AdminAuditLogCreateInput {
  return buildAdminAuditLogData({
    action,
    actorId: audit.actorId,
    requestMetadata: audit.requestMetadata,
    metadata: {
      requestId: audit.requestMetadata.requestId,
      targetType: 'automation_rule',
      targetId: rule.id,
      ...ruleSnapshot(rule),
      ...extra,
    },
  });
}

function ruleSnapshot(rule: AutomationRule): Record<string, unknown> {
  return {
    ruleName: rule.name,
    isEnabled: rule.isEnabled,
    triggerKind: rule.triggerKind,
    triggerSpec: rule.triggerSpec,
    actionTypes: actionTypesOf(rule.actions),
    webhookHosts: webhookHostsOf(rule.actions),
  };
}

function actionTypesOf(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions.map((action: unknown) =>
    isRecord(action) && typeof action['type'] === 'string' ? action['type'] : 'unknown',
  );
}

function webhookHostsOf(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  const hosts = new Set<string>();
  for (const action of actions) {
    if (!isRecord(action) || action['type'] !== 'webhook_post' || !isRecord(action['params'])) continue;
    const url = action['params']['url'];
    if (typeof url !== 'string') continue;
    try {
      hosts.add(new URL(url.trim()).hostname);
    } catch {
      // Not a URL: there is no host to name, and the string itself may be anything.
    }
  }
  return [...hosts];
}

/** A short string from a caller-shaped payload, or null. */
function boundedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
}

/** A write whose row vanished under it (P2025) is the rule that is not found, not a 500. */
async function notFoundIfGone<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if ((err as { code?: string }).code === 'P2025') {
      throw new NotFoundException('Rule not found');
    }
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── The authorization header is write-only ──────────────────────────────────
//
// A `webhook_post` action's `authorizationHeader` is a credential for somebody
// else's system, and every rule read used to hand it to anyone holding
// `automations:view` — the list, the rule, the answer to a save or a switch.
// Now no read returns it. In its place a read carries a reference,
// `{ "stored": true, "index": <the action's place in the saved list> }`, and a
// save answers each of the three things an editor can mean:
//
//   the reference, unchanged   keep the header saved on that action;
//   a string                   replace it;
//   null, "" or nothing        remove it.
//
// The reference is not a mask: it can never be stored as the header, because
// it is resolved against the SAVED row here or refused. It names the saved
// action by place rather than trusting its own, so an editor that deletes or
// reorders the actions around it keeps each header on its own action.
//
// ── A header never follows its URL anywhere ─────────────────────────────────
//
// Whoever may edit a rule may point its URL at a receiver of their own. Were a
// kept header carried along, that would read a credential out through the
// door the read path just closed — and not only across hosts: Slack, Zapier
// and RequestBin key a receiver by its PATH, so `webhook.site/VICTIM` changed
// to `webhook.site/ATTACKER` on the same origin is another receiver. So a kept
// header is bound to the EXACT saved URL (after trimming): any change to it,
// even one a URL parser would call the same, needs the header typed again or
// dropped. And a reference is good only for the action it came from — the
// same place in the list and the same type — so it cannot be fanned out onto
// new actions either: at most one action sits at that place.

/**
 * What a read puts in place of a saved `authorizationHeader` — and in
 * `urlHidden`, beside a URL the reader may not see whole (`keepHiddenUrls`).
 */
export interface SavedHeaderReference {
  readonly stored: true;
  readonly index: number;
}

function isSavedHeaderReference(value: unknown): value is SavedHeaderReference {
  return (
    isRecord(value) &&
    value['stored'] === true &&
    typeof value['index'] === 'number' &&
    Number.isInteger(value['index']) &&
    value['index'] >= 0
  );
}

/**
 * The submitted actions with every reference replaced by the header it names,
 * or refused. `saved` is the rule's stored `actions` — `null` on a create,
 * where there is nothing to keep. Anything that is not a list is handed on as
 * it is, for `asActionList` to refuse.
 */
function keepSavedHeaders(actions: unknown, saved: unknown): unknown {
  if (!Array.isArray(actions)) return actions;
  const savedList: readonly unknown[] = Array.isArray(saved) ? saved : [];
  return actions.map((action: unknown, index) => {
    if (!isRecord(action) || !isRecord(action['params'])) return action;
    const params = action['params'];
    if (!Object.prototype.hasOwnProperty.call(params, 'authorizationHeader')) return action;
    const { authorizationHeader: header, ...rest } = params;
    if (header === null || header === undefined || header === '') {
      return { ...action, params: rest };
    }
    // A new value, or something the params check below refuses as it is.
    if (!isSavedHeaderReference(header)) return action;

    const label = `Action ${index + 1} (${String(action['type'])})`;
    if (saved === null) {
      throw new BadRequestException(
        `${label}: "authorizationHeader" refers to a saved rule, and a new rule has none — enter the header itself`,
      );
    }
    const source = savedList[header.index];
    if (header.index !== index || !isRecord(source) || source['type'] !== action['type']) {
      throw new BadRequestException(
        `${label}: the saved "authorizationHeader" it refers to belongs to another action — enter it again or remove it`,
      );
    }
    const sourceParams = isRecord(source['params']) ? source['params'] : {};
    const value = sourceParams['authorizationHeader'];
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException(
        `${label}: the saved "authorizationHeader" it refers to is no longer on the rule — enter it again or remove it`,
      );
    }
    if (action['type'] === 'webhook_post' && !sameUrl(params['url'], sourceParams['url'])) {
      throw new BadRequestException(
        `${label}: the URL changed, so the saved "authorizationHeader" was not carried over — enter it again or remove it`,
      );
    }
    return { ...action, params: { ...rest, authorizationHeader: value } };
  });
}

/** The same URL, character for character once trimmed. */
function sameUrl(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();
}

// ── A hidden URL is kept by reference, never saved as its mask ──────────────
//
// A reader who may not edit a `webhook_post` action reads its URL as its origin
// and "…" (`maskWebhookUrl`). That mask is a valid URL, so a save that sent a
// read straight back — an editor replaying what a viewer was shown, or a screen
// loaded before its admin's role gained the rights — stored it in place of the
// real URL, and every run after that posted to `<origin>/…`.
//
// So a read marks a hidden URL with `urlHidden`, the same reference a saved
// header gets — the action's place in the saved list — and a save reads it the
// same way:
//
//   the reference, unchanged   keep the URL saved on that action; `url` is left
//                              out, or is exactly what the read showed;
//   false, null or nothing     the `url` sent is the URL.
//
// It keeps a URL only for the action it came from — the same place and the same
// type — so an editor who removes an action above it cannot hand one action's
// URL to another, even when both are on one host and their masks are the same.
// And the mask is refused as a URL whatever arrives with it (`isHiddenUrlForm`).

/** Where a read marks a URL it hid, and where a save finds the URL to keep. */
const URL_HIDDEN_PARAM = 'urlHidden';

/**
 * The submitted actions with every hidden-URL reference replaced by the URL it
 * names, or refused. `saved` is the rule's stored `actions` — `null` on a
 * create, where there is nothing to keep. Anything that is not a list is handed
 * on as it is, for `asActionList` to refuse.
 */
function keepHiddenUrls(actions: unknown, saved: unknown): unknown {
  if (!Array.isArray(actions)) return actions;
  const savedList: readonly unknown[] = Array.isArray(saved) ? saved : [];
  return actions.map((action: unknown, index) => {
    if (!isRecord(action) || !isRecord(action['params'])) return action;
    const params = action['params'];
    if (!Object.prototype.hasOwnProperty.call(params, URL_HIDDEN_PARAM)) return action;
    const { [URL_HIDDEN_PARAM]: reference, ...rest } = params;
    if (reference === false || reference === null || reference === undefined) {
      return { ...action, params: rest };
    }

    const label = `Action ${index + 1} (${String(action['type'])})`;
    if (!isSavedHeaderReference(reference)) {
      throw new BadRequestException(
        `${label}: "urlHidden" does not name a saved URL — read the rule again, or send the URL itself without "urlHidden"`,
      );
    }
    if (saved === null) {
      throw new BadRequestException(
        `${label}: "urlHidden" keeps the URL saved on a rule, and a new rule has none — enter the URL itself`,
      );
    }
    const source = savedList[reference.index];
    if (
      reference.index !== index ||
      action['type'] !== 'webhook_post' ||
      !isRecord(source) ||
      source['type'] !== action['type']
    ) {
      throw new BadRequestException(
        `${label}: the saved URL "urlHidden" refers to belongs to another action — enter the URL again`,
      );
    }
    const sourceParams = isRecord(source['params']) ? source['params'] : {};
    const savedUrl = sourceParams['url'];
    if (typeof savedUrl !== 'string' || savedUrl.trim().length === 0) {
      throw new BadRequestException(
        `${label}: the saved URL "urlHidden" refers to is no longer on the rule — enter the URL again`,
      );
    }
    const sent = rest['url'];
    if (sent !== undefined && sent !== null && !(typeof sent === 'string' && showsSavedUrl(sent, savedUrl))) {
      throw new BadRequestException(
        `${label}: "url" and "urlHidden" disagree — send a new URL without "urlHidden", or "urlHidden" without a URL`,
      );
    }
    return { ...action, params: { ...rest, url: savedUrl } };
  });
}

/** What a read showed of `saved`: its mask, or the URL itself to a reader who may see it. */
function showsSavedUrl(sent: string, saved: string): boolean {
  const shown = sent.trim();
  return shown === maskWebhookUrl(saved) || shown === saved.trim();
}

/**
 * The stored `actions` as a read may show them: a list or nothing — the editor
 * walks this, and an import can leave any JSON in the column; the executor
 * refuses to run a non-list either way — with every saved header replaced by
 * its reference and, for a reader who may not edit it, every webhook URL by
 * its origin (`RuleReadView`) with a reference beside it that a save keeps the
 * URL by (`keepHiddenUrls`).
 */
function withSavedHeadersHidden(actions: unknown, view: RuleReadView): readonly AutomationActionDefinition[] {
  if (!Array.isArray(actions)) return [];
  return actions.map((action: unknown, index) => {
    if (!isRecord(action) || !isRecord(action['params'])) return action;
    let params: Record<string, unknown> = action['params'];
    // Only a read writes `urlHidden`. One in the stored row is what the old
    // overwrite left beside the mask, and it means nothing: shown to a reader
    // who may see the URL, it would come back on the next save and be refused.
    if (Object.prototype.hasOwnProperty.call(params, URL_HIDDEN_PARAM)) {
      params = { ...params };
      delete params['urlHidden'];
    }
    if (Object.prototype.hasOwnProperty.call(params, 'authorizationHeader')) {
      const { authorizationHeader: header, ...rest } = params;
      const reference: SavedHeaderReference = { stored: true, index };
      params = typeof header === 'string' && header.length > 0 ? { ...rest, authorizationHeader: reference } : rest;
    }
    if (!view.webhookUrls && action['type'] === 'webhook_post' && Object.prototype.hasOwnProperty.call(params, 'url')) {
      const reference: SavedHeaderReference = { stored: true, index };
      params = { ...params, url: maskWebhookUrl(params['url']), [URL_HIDDEN_PARAM]: reference };
    }
    return { ...action, params };
  }) as unknown as readonly AutomationActionDefinition[];
}

/**
 * A webhook URL as a reader who may not edit it sees it: its origin and a
 * marker where the path and the query were. Nothing that is not a URL survives.
 */
export function maskWebhookUrl(value: unknown): string {
  if (typeof value !== 'string') return '…';
  try {
    const url = new URL(value.trim());
    return url.origin === 'null' ? '…' : `${url.origin}/…`;
  } catch {
    return '…';
  }
}

/** The path `maskWebhookUrl` writes, as a URL parser reads it back: the ellipsis percent-encoded. */
const HIDDEN_URL_PATH = '/%E2%80%A6';

/**
 * Whether a URL is the shortened form a read shows in place of a hidden one —
 * an origin, "…" and nothing after it — however it is written: with spaces
 * around it, the ellipsis encoded, the default port spelt out. It parses, so
 * the outbound check lets it through; saved as an action's URL it reaches no
 * receiver, and it is where the real URL used to be.
 */
export function isHiddenUrlForm(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.pathname === HIDDEN_URL_PATH && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/** The refusal of a URL that is the shortened form (`isHiddenUrlForm`). */
const HIDDEN_URL_FORM_RULE =
  'the URL is the shortened form the panel shows in place of a hidden one — enter the full URL';

function mapRule(row: AutomationRule, view: RuleReadView): AutomationRuleInterface {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isEnabled: row.isEnabled,
    triggerKind: row.triggerKind,
    triggerSpec: row.triggerSpec,
    conditions: (row.conditions as LogicExpression | null) ?? null,
    actions: withSavedHeadersHidden(row.actions, view),
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

/** Whether an audience action's params name an audience it can resolve — trimmed, like the action reads it. */
function namesKnownAudience(params: unknown): boolean {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  const audience = (params as Record<string, unknown>)['audience'];
  return (
    typeof audience === 'string' &&
    (HINT_AUDIENCES as readonly string[]).includes(audience.trim())
  );
}

function normaliseRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
