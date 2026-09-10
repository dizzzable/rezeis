import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutomationTriggerKind } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';
import {
  RealtimeEventInterface,
} from '../realtime/interfaces/realtime-event.interface';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AutomationQueueService } from './automation-queue.service';
import { AUTOMATION_RULES_PER_EVENT_LIMIT } from './automations.constants';
import { AUTOMATION_CHAIN_DEPTH_LIMIT, chainExhausted, chainOriginOf } from './chain-depth';
// Re-exported: this module was its home, and several tests and callers still
// reach for it here.
export { matchEventPattern } from './event-pattern';
import { matchEventPattern } from './event-pattern';

/**
 * Event bridge — wires the SystemEventsService stream into the
 * automations queue.
 *
 * Two trigger kinds funnel through here:
 *   - `REALTIME` rules listen to a wildcard event-type pattern. We tap
 *     the realtime channel (already emitted by `SystemEventsService`)
 *     by piggybacking on `RealtimeGateway.broadcast()` via a small
 *     monkey-patch installed on `onModuleInit`. This keeps the bridge
 *     decoupled from individual feature modules.
 *   - `CRON` rules are dispatched by the scheduler tick below — every
 *     minute we look up enabled cron rules and check whether their
 *     `triggerSpec` matches the current minute (using `cron-parser`,
 *     already installed transitively via BullMQ).
 *
 * The bridge intentionally stays small: it only **queues** jobs. The
 * actual evaluation lives in `AutomationExecutorService`.
 */
@Injectable()
export class AutomationEventBridgeService implements OnModuleInit {
  private readonly logger = new Logger(AutomationEventBridgeService.name);
  private installedRealtimeHook = false;

  public constructor(
    private readonly moduleRef: ModuleRef,
    private readonly prismaService: PrismaService,
    private readonly automationQueueService: AutomationQueueService,
  ) {}

  public onModuleInit(): void {
    this.installRealtimeHook();
  }

  // ── Realtime trigger bridge ────────────────────────────────────────────

  /**
   * Installs a one-shot wrapper around `RealtimeGateway.broadcast`. Every
   * payload that flows over the WebSocket is also offered to the
   * automations bridge. We deliberately avoid creating a separate event
   * bus to keep the moving-parts count low.
   */
  private installRealtimeHook(): void {
    if (this.installedRealtimeHook) return;
    let gateway: RealtimeGateway | null = null;
    try {
      gateway = this.moduleRef.get(RealtimeGateway, { strict: false });
    } catch {
      gateway = null;
    }
    if (!gateway) {
      this.logger.warn('RealtimeGateway not available — realtime triggers disabled');
      return;
    }
    const original = gateway.broadcast.bind(gateway);
    gateway.broadcast = (event: RealtimeEventInterface): void => {
      original(event);
      // Schedule the dispatch on the next tick so a slow rule chain
      // never delays the websocket fan-out.
      setImmediate(() => {
        this.dispatchRealtime(event).catch((err) => {
          this.logger.warn(`Realtime dispatch failed: ${(err as Error).message}`);
        });
      });
    };
    this.installedRealtimeHook = true;
  }

  private async dispatchRealtime(event: RealtimeEventInterface): Promise<void> {
    // ── The stop that keeps a rule from feeding itself ──────────────────────
    //
    // Every emitted event comes back through here, and three actions emit. One
    // rule closes a loop on its own — `automation.*` with a `system_event`
    // action raising `automation.custom` — and two rules close one with no
    // wildcard at all. Each lap costs a queue job, an execution row, a rule
    // update, an audit write, a Telegram attempt and an outbound webhook.
    //
    // Chaining is deliberate and documented, so the cure cannot be refusing to
    // chain: the event carries how many automation hops produced it, and it
    // stops being dispatched when it has travelled far enough. Anything that
    // happened in the world carries no depth and starts at zero.
    if (chainExhausted(event.metadata)) {
      // Names the last rule in the chain, which `chainMetadata` put on the
      // event, rather than asserting a cause. "A rule is most likely triggering
      // itself" was a guess — a legitimate five-deep chain reaches this line
      // too — and it was made while holding the one identifier that would let
      // an operator go and look.
      const from = chainOriginOf(event.metadata);
      this.logger.warn(
        `"${event.type}" reached the automation chain limit of ` +
          `${AUTOMATION_CHAIN_DEPTH_LIMIT} hops and will not fire further rules` +
          `${from === null ? '' : `; the last hop was rule ${from}`}. ` +
          'Either a rule is triggering itself, directly or through a second ' +
          'rule, or a legitimate chain is longer than the limit.',
      );
      return;
    }
    const matchingRules = await this.findMatchingRealtimeRules(event.type);
    if (matchingRules.length === 0) return;
    for (const rule of matchingRules) {
      await this.automationQueueService.enqueueExecution({
        ruleId: rule.id,
        trigger: `event:${event.type}`,
        triggerData: {
          type: event.type,
          category: event.category,
          severity: event.severity,
          message: event.message,
          metadata: event.metadata ?? {},
          timestamp: event.timestamp,
        },
      });
    }
  }

  /**
   * The rules that want this event.
   *
   * ── The cap is on MATCHES, and it says so when it bites ──────────────────
   *
   * `AUTOMATION_RULES_PER_EVENT_LIMIT` used to be a `take` on this query. That
   * made it a cap on rules LOADED, applied before the pattern filter and with
   * no `orderBy` to decide which — so an install with more than 64 enabled
   * realtime rules had the database hand back an arbitrary 64, and every rule
   * outside that slice stopped firing. Silently: a rule that is never selected
   * produces no execution row, no error and no log line, and goes on reading
   * "enabled" in the operator's list for ever. Worse, the slice was not even
   * stable — `persistExecution` writes to `automation_rules` on every run, and
   * a rewritten tuple can move in the heap, so which rules were invisible
   * shifted as other rules fired.
   *
   * Ordering by `createdAt` is what makes the cap honest rather than merely
   * bounded: if it is ever reached, the same rules win every time, so an
   * operator sees a stable symptom instead of an intermittent one.
   */
  private async findMatchingRealtimeRules(eventType: string): Promise<Array<{ id: string; triggerSpec: string }>> {
    const rules = await this.prismaService.automationRule.findMany({
      where: {
        isEnabled: true,
        triggerKind: AutomationTriggerKind.REALTIME,
      },
      select: { id: true, triggerSpec: true },
      // `id` SECOND, because `createdAt` alone is not a total order. The column
      // is `Timestamptz(3)`, so several rules saved in the same millisecond —
      // which is what applying a template library of eight does — tie, and
      // Postgres gives no guarantee about tied rows. Whichever of them straddle
      // the cap would then reshuffle as the heap moved, producing exactly the
      // intermittent symptom the cap was written to replace.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const matching = rules.filter((rule) => matchEventPattern(rule.triggerSpec, eventType));
    if (matching.length <= AUTOMATION_RULES_PER_EVENT_LIMIT) return matching;

    // Loud, because the alternative is a rule that never fires and never says
    // why. An operator who reads this knows both the number and the event.
    const skipped = matching.slice(AUTOMATION_RULES_PER_EVENT_LIMIT);
    this.logger.warn(
      `${matching.length} enabled rules match "${eventType}"; running the first ` +
        `${AUTOMATION_RULES_PER_EVENT_LIMIT} by creation date and skipping ` +
        `${skipped.length}. ` +
        // THE IDS, because a count is not actionable. The skipped rules produce
        // no execution row and go on reading "enabled" in the operator's list,
        // so this line is the only place they are named at all — and an
        // operator who cannot tell WHICH five lost has learned nothing they can
        // act on.
        `Skipped: ${skipped.map((rule) => rule.id).join(', ')}. ` +
        'Rules beyond the cap will not fire for this event until the count drops.',
    );
    return matching.slice(0, AUTOMATION_RULES_PER_EVENT_LIMIT);
  }

  // ── Cron trigger bridge ────────────────────────────────────────────────

  /**
   * Tick once per minute and enqueue any cron-driven rule whose
   * `triggerSpec` matches the current minute. We use `cron-parser`
   * (already a transitive dep of BullMQ) to evaluate the expression.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  public async tickCronRules(): Promise<void> {
    if (!shouldRunSchedules()) return;
    let rules: Array<{ id: string; triggerSpec: string }>;
    try {
      rules = await this.prismaService.automationRule.findMany({
        where: {
          isEnabled: true,
          triggerKind: AutomationTriggerKind.CRON,
        },
        select: { id: true, triggerSpec: true },
      });
    } catch (err) {
      this.logger.warn(`Failed to load cron rules: ${(err as Error).message}`);
      return;
    }
    if (rules.length === 0) return;

    // Resolve cron-parser lazily so the module loads even when the lib
    // is unavailable — failure here only disables cron triggers, it
    // doesn't break realtime/manual.
    let cronParser: typeof import('cron-parser') | null = null;
    try {
      cronParser = await import('cron-parser');
    } catch {
      this.logger.warn('cron-parser not installed — cron triggers disabled');
      return;
    }

    const now = new Date();
    const startOfMinute = new Date(now);
    startOfMinute.setSeconds(0, 0);
    const endOfMinute = new Date(startOfMinute.getTime() + 60_000);

    for (const rule of rules) {
      try {
        const interval = (cronParser as typeof import('cron-parser')).parseExpression(rule.triggerSpec, {
          currentDate: new Date(startOfMinute.getTime() - 1000),
          tz: 'UTC',
        });
        const next = interval.next().toDate();
        if (next >= startOfMinute && next < endOfMinute) {
          await this.automationQueueService.enqueueExecution({
            ruleId: rule.id,
            trigger: `cron:${rule.triggerSpec}`,
            triggerData: {
              firedAt: next.toISOString(),
              spec: rule.triggerSpec,
            },
          });
        }
      } catch {
        // Invalid cron spec — quietly skip. The rule editor validates
        // expressions on save, so this only happens when an operator
        // hand-edits the DB.
      }
    }
  }
}

