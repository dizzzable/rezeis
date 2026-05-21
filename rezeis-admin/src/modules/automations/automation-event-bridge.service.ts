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

  private async findMatchingRealtimeRules(eventType: string): Promise<Array<{ id: string; triggerSpec: string }>> {
    const rules = await this.prismaService.automationRule.findMany({
      where: {
        isEnabled: true,
        triggerKind: AutomationTriggerKind.REALTIME,
      },
      select: { id: true, triggerSpec: true },
      take: AUTOMATION_RULES_PER_EVENT_LIMIT,
    });
    return rules.filter((rule) => matchEventPattern(rule.triggerSpec, eventType));
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

/**
 * Match an event type against a glob-like pattern.
 *
 *   `*`            → match anything
 *   `payment.*`    → namespace match (anything starting with `payment.`)
 *   `payment.completed` → exact match
 *
 * Empty patterns never match (defensive — a rule with no spec is
 * effectively unfinished).
 */
export function matchEventPattern(pattern: string, eventType: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === '*') return true;
  if (trimmed.endsWith('.*')) {
    const prefix = trimmed.slice(0, -2);
    return eventType === prefix || eventType.startsWith(`${prefix}.`);
  }
  return eventType === trimmed;
}
