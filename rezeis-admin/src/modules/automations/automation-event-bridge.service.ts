import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutomationTriggerKind } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';
import { OPERATOR_ONLY_EVENT_TYPES } from '../../common/services/system-events.service';
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
 *     `triggerSpec` matches the current minute (using `cron-parser` 4,
 *     a declared dependency; see `loadCronParser`).
 *
 * The bridge intentionally stays small: it only **queues** jobs. The
 * actual evaluation lives in `AutomationExecutorService`.
 */
@Injectable()
export class AutomationEventBridgeService implements OnModuleInit {
  private readonly logger = new Logger(AutomationEventBridgeService.name);
  private installedRealtimeHook = false;
  /** CRON rules whose spec cron-parser refused, by id and spec: each is named once. */
  private readonly refusedSpecs = new Set<string>();

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
    // An operator-only type reaches this broadcast because the admin panel
    // shows it live (`SystemEventsService.emit`), not for a rule to act on: a
    // withheld payment is money no rule may treat as a sale, and the event
    // catalogue never offers one as a trigger. A wildcard rule (`payment.*`)
    // would still match it here.
    if (OPERATOR_ONLY_EVENT_TYPES.has(event.type)) return;

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
   * `triggerSpec` matches the current minute, as `nextCronFire` reads it.
   *
   * ── What may stop a rule quietly, and what may not ─────────────────────
   *
   * One thing: a spec cron-parser refuses. It is skipped, as it always was,
   * and named once per process (`noteRefusedSpec`). Everything else that
   * stops a rule is an error, logged with the rule, every minute it stops
   * it — cron-parser missing or changed, the job refused or not answered.
   *
   * This loop used to hold the parse AND the enqueue in one `catch {}`
   * labelled "invalid cron spec". So cron-parser 5, which has no
   * `parseExpression` and is what BullMQ 6 depends on, would have switched
   * off every scheduled automation without a line in the log, and so did
   * every minute Redis refused the job: the rule was due, did not run, and
   * nothing said so.
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

    let parser: CronParser;
    try {
      parser = loadCronParser();
    } catch (err: unknown) {
      this.logger.error(
        `No CRON rule ran this minute (${rules.map((rule) => rule.id).join(', ')}): ${describeError(err)}`,
      );
      return;
    }

    const now = new Date();
    const startOfMinute = new Date(now);
    startOfMinute.setSeconds(0, 0);
    const endOfMinute = new Date(startOfMinute.getTime() + 60_000);

    for (const rule of rules) {
      let next: Date;
      try {
        next = nextCronFire(parser, rule.triggerSpec, startOfMinute);
      } catch (err: unknown) {
        if (err instanceof InvalidCronSpecError) {
          this.noteRefusedSpec(rule, err);
        } else {
          this.logger.error(
            `CRON rule ${rule.id} ("${rule.triggerSpec}") could not be evaluated and did not run: ` +
              describeError(err),
          );
        }
        continue;
      }
      if (next < startOfMinute || next >= endOfMinute) continue;
      try {
        await this.automationQueueService.enqueueExecution({
          ruleId: rule.id,
          trigger: `cron:${rule.triggerSpec}`,
          triggerData: {
            firedAt: next.toISOString(),
            spec: rule.triggerSpec,
          },
        });
      } catch (err: unknown) {
        this.logger.error(
          `CRON rule ${rule.id} was due at ${next.toISOString()} and was not queued, so it did not run: ` +
            describeError(err),
        );
      }
    }
  }

  /**
   * A spec cron-parser refuses is skipped, and said once per process rather
   * than every minute. Once, not never: the editor used to accept almost
   * every such spec — it refused only one with too many fields — so rules
   * like this exist, and until now they never fired and never said why.
   */
  private noteRefusedSpec(rule: { id: string; triggerSpec: string }, err: InvalidCronSpecError): void {
    const key = `${rule.id} ${rule.triggerSpec}`;
    if (this.refusedSpecs.has(key)) return;
    this.refusedSpecs.add(key);
    this.logger.warn(
      `CRON rule ${rule.id} does not run: cron-parser refuses "${rule.triggerSpec}" (${err.message}). ` +
        'Correct the expression in the rule editor.',
    );
  }
}

// ── Reading a CRON spec ─────────────────────────────────────────────────────

/** The part of cron-parser 4 a CRON rule needs. */
export type CronParser = Pick<typeof import('cron-parser'), 'parseExpression'>;

/**
 * cron-parser refused the spec itself: the one failure a CRON rule may be
 * skipped for, and the one the editor answers with a 400. Anything else that
 * stops a rule is a fault of the library or of this code, and is reported.
 */
export class InvalidCronSpecError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidCronSpecError';
  }
}

/**
 * cron-parser, as the dispatcher and the rule editor both use it.
 *
 * Required here rather than imported at the top, so a missing package costs
 * the CRON rules and not the module. And checked rather than trusted:
 * cron-parser 5 has no `parseExpression` (it is `CronExpressionParser.parse`
 * there), BullMQ 6 depends on 5, and a module without it used to reach the
 * dispatcher as a TypeError it read as "an invalid spec". The package is
 * declared in package.json, pinned to 4, for the same reason.
 */
export function loadCronParser(): CronParser {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded: unknown = require('cron-parser');
  if (hasParseExpression(loaded)) return loaded;
  throw new Error(
    'the installed cron-parser has no parseExpression (cron-parser 5 moved it to ' +
      'CronExpressionParser.parse); no CRON rule can run until it is 4.x again or this code is ported',
  );
}

/**
 * When `spec` next fires at or after `notBefore`, in UTC.
 *
 * Throws `InvalidCronSpecError` when cron-parser refuses the spec. cron-parser
 * 4 reports every fault in an expression — a value out of range, an unknown
 * alias, too many fields, a day that never comes — as a plain `Error` (each
 * of those checked against 4.9.0), so a plain `Error` is the spec's fault.
 * Anything else — the `TypeError` of a library that changed under this call,
 * a bug — is rethrown as it is, for the caller to report.
 */
export function nextCronFire(parser: CronParser, spec: string, notBefore: Date): Date {
  // A second early, because `next()` answers strictly after its start: a rule
  // due at exactly `notBefore` is due then.
  const currentDate = new Date(notBefore.getTime() - 1_000);
  try {
    return parser.parseExpression(spec, { currentDate, tz: 'UTC' }).next().toDate();
  } catch (err: unknown) {
    if (err instanceof Error && Object.getPrototypeOf(err) === Error.prototype) {
      throw new InvalidCronSpecError(err.message);
    }
    throw err;
  }
}

function hasParseExpression(loaded: unknown): loaded is CronParser {
  return (
    (typeof loaded === 'function' || (typeof loaded === 'object' && loaded !== null)) &&
    typeof (loaded as { parseExpression?: unknown }).parseExpression === 'function'
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

