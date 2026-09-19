import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import type { ConnectHelpSettingsView } from '../../connect-signal/connect-help-settings';
import type { HelpOutcome } from '../../connect-signal/connect-sql';
import {
  ConnectSignalHealthService,
  type ConnectSignalState,
} from '../../connect-signal/services/connect-signal-health.service';
import {
  ConnectSignalProbeService,
  type ProbeReadOutcome,
} from '../../connect-signal/services/connect-signal-probe.service';
import {
  UserNotificationsService,
  type LadderAttempt,
} from '../../notifications/services/user-notifications.service';
import {
  CONNECT_HELP_BATCH,
  CONNECT_HELP_CRON,
  CONNECT_HELP_CYCLE_BUDGET_MS,
  CONNECT_HELP_LAST_RESULT_KEY,
  CONNECT_HELP_TRIAL_TYPE,
  CONNECT_HELP_TYPE,
} from '../connect-help.constants';
import {
  claimSql,
  connectHelpCandidatesSql,
  connectHelpRecheckSql,
  connectHelpWindow,
  ensureStateRowSql,
  finalizeSql,
  lockPersonSql,
  mergedSiblingSql,
  recordDeferralSql,
  recordEventIdSql,
  type ConnectHelpCandidateRow,
  type ConnectHelpKind,
  type ConnectHelpRecheckRow,
  type ConnectHelpWindow,
} from '../connect-help.sql';
import { ConnectHelpSettingsService } from './connect-help-settings.service';

/**
 * One cycle, as the operator's card reads it back
 * (`rezeis:connect-help:last-result`). Instants are ISO strings.
 */
export interface ConnectHelpCycleResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** `disabled`: the automatic help is off and nothing was looked at. */
  readonly standDown: 'disabled' | null;
  /** The signal the cycle saw. In `webhooks_only` and `blind` the panel was not asked. */
  readonly signal: ConnectSignalState | null;
  readonly candidates: number;
  /** Panel re-reads made before deciding. */
  readonly checked: number;
  /** Re-read and found connected — no message, no marker. */
  readonly connected: number;
  /** Not verifiable this cycle, left for the next («ждут проверки»). */
  readonly waiting: number;
  readonly sent: { readonly bot: number; readonly push: number; readonly email: number };
  readonly banner: number;
  readonly optedOut: number;
  readonly merged: number;
  readonly skippedUnverifiable: number;
  readonly skippedTemplateOff: number;
  /** Bot steps put off to the next cycle (the relay did not answer). */
  readonly deferred: number;
  /** No longer a candidate by its turn, or decided by somebody else first. */
  readonly skipped: number;
  /** Not reached this cycle — out of time, or the switch went off mid-cycle. */
  readonly leftOver: number;
  readonly errors: number;
}

type Tally = {
  -readonly [K in keyof Omit<ConnectHelpCycleResult, 'startedAt' | 'finishedAt' | 'durationMs' | 'standDown' | 'signal' | 'sent'>]: number;
} & { sent: { bot: number; push: number; email: number } };

function emptyTally(): Tally {
  return {
    candidates: 0,
    checked: 0,
    connected: 0,
    waiting: 0,
    sent: { bot: 0, push: 0, email: 0 },
    banner: 0,
    optedOut: 0,
    merged: 0,
    skippedUnverifiable: 0,
    skippedTemplateOff: 0,
    deferred: 0,
    skipped: 0,
    leftOver: 0,
    errors: 0,
  };
}

/** What a cycle carries from candidate to candidate. */
interface CycleContext {
  readonly window: ConnectHelpWindow;
  readonly settings: ConnectHelpSettingsView;
  /** The panel may be asked: the signal is `live` or `starting`. */
  readonly canRead: boolean;
  /** The cycle's "now", advanced by the real time the cycle has taken. */
  readonly clock: () => Date;
  readonly tally: Tally;
}

/** The subscriber's Russian name for a final outcome, on the operator's card. */
const HELPED_BY_NOTE: Readonly<Record<string, string>> = {
  bot: 'сообщение в Telegram-боте',
  push: 'push-уведомление в браузере',
  email: 'письмо на подтверждённую почту',
  banner: 'баннер в кабинете — других каналов у клиента нет',
  opted_out: 'клиент отключил эти уведомления, ничего не отправлено',
  merged: 'клиенту уже помогли по другой подписке за последние сутки',
  skipped_template_off: 'шаблон выключен, ничего не отправлено',
};

/**
 * «ПОМОЩЬ С ПОДКЛЮЧЕНИЕМ» — THE SENDER
 * ═══════════════════════════════════
 * Every ten minutes, in the worker only, one cycle at a time in the process:
 * the subscriptions that became paid N hours ago (N set by the operator, 1–168)
 * — or, with trials switched on, were granted as a trial or a gift N hours ago —
 * within a 72-hour catch-up, whose VPN never connected, get ONE notice through
 * the first channel that reaches the customer (`deliverFirstReachable`: bot,
 * push, e-mail, else the cabinet banner). At most a hundred a cycle, the oldest
 * moment first.
 *
 * Per candidate, before anything is sent, it looks again:
 *
 *   1. locally, fresh — still live, not imported, customer not blocked, not
 *      connected, not decided; the anchor payment still COMPLETED (a trial:
 *      still no paid money); the switches still on;
 *   2. at the panel — `ConnectSignalProbeService.recheck`, never a read of its
 *      own. `connected`: nothing, no marker. `missing`, `unaddressable`,
 *      `unavailable`: not verifiable — left for the next cycle, and once the
 *      window is about to close on it, claimed as `skipped_unverifiable` so it
 *      is not asked about again. While the signal is `webhooks_only` or
 *      `blind`, the panel is not asked at all: nothing is sent on unknown.
 *
 * Then the claim — `help_decided_at`, the once-marker — under a per-person
 * lock: a second subscription of a person already helped within a day is
 * `merged`, without a second message. Exactly one claimer wins, whether the
 * other is a second worker or a broadcast being staged.
 *
 * After the final outcome it emits `subscription.not_connected` ONCE, from the
 * statement that recorded that outcome — not for `skipped_unverifiable`: that
 * subscription was never verified not connected.
 *
 * A resumed ladder (a bot step deferred by a relay outage) raced by a second
 * replica sends the same event id twice: the bot deduplicates it, the push
 * carries the same tag and replaces itself in the tray, the e-mail job id is
 * the same and BullMQ keeps one — and only one finalize matches.
 */
@Injectable()
export class ConnectHelpSweepService {
  private readonly logger = new Logger(ConnectHelpSweepService.name);

  /** True while a cycle runs, so an overlapping tick stands down. */
  private running = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly settingsService: ConnectHelpSettingsService,
    private readonly probe: ConnectSignalProbeService,
    private readonly health: ConnectSignalHealthService,
    private readonly notifications: UserNotificationsService,
    private readonly rawCacheService: RawCacheService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  @Cron(CONNECT_HELP_CRON, { name: 'connect-help-cycle' })
  public async tick(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (this.running) {
      this.logger.debug('Connect help cycle still running; this tick stands down');
      return;
    }
    this.running = true;
    try {
      await this.runCycle();
    } catch (error) {
      this.logger.error(
        'Connect help cycle failed',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      // `finally`, so a throw cannot leave the flag set and silence the sender
      // for the lifetime of the process.
      this.running = false;
    }
  }

  /** One cycle. `now` is injectable so the specs can put it where only their rows are. */
  public async runCycle(now: Date = new Date()): Promise<ConnectHelpCycleResult> {
    const startedMs = Date.now();
    const clock = (): Date => new Date(now.getTime() + (Date.now() - startedMs));
    const tally = emptyTally();
    const settings = await this.settingsService.read();
    if (!settings.enabled) {
      return this.finish(now, clock, tally, 'disabled', null);
    }
    const signal = await this.readSignalState(now);
    const context: CycleContext = {
      window: connectHelpWindow(now, settings.delayHours),
      settings,
      canRead: signal === 'live' || signal === 'starting',
      clock,
      tally,
    };
    const candidates = await this.prismaService.$queryRaw<ConnectHelpCandidateRow[]>(
      connectHelpCandidatesSql({ now, settings, limit: CONNECT_HELP_BATCH }),
    );
    tally.candidates = candidates.length;
    for (let index = 0; index < candidates.length; index += 1) {
      if (Date.now() - startedMs > CONNECT_HELP_CYCLE_BUDGET_MS) {
        tally.leftOver = candidates.length - index;
        break;
      }
      // The switch is read again for every candidate: an operator who turns
      // the help off mid-cycle must stop it, not wait out a hundred sends.
      const current = await this.settingsService.read();
      if (!current.enabled) {
        tally.leftOver = candidates.length - index;
        break;
      }
      const candidate = candidates[index];
      try {
        await this.decide(candidate, { ...context, settings: current });
      } catch (error) {
        tally.errors += 1;
        this.logger.warn(
          `connect-help sub=${candidate.subscriptionId} failed: ${(error as Error).message}`,
        );
      }
    }
    return this.finish(now, clock, tally, null, signal);
  }

  private async decide(candidate: ConnectHelpCandidateRow, context: CycleContext): Promise<void> {
    const { tally } = context;
    const kind = candidate.kind;
    if (kind !== 'paid' && kind !== 'trial') {
      tally.skipped += 1;
      return;
    }
    if (kind === 'trial' && !context.settings.includeTrials) {
      tally.skipped += 1;
      return;
    }

    // 1. The local look, fresh.
    const rows = await this.prismaService.$queryRaw<ConnectHelpRecheckRow[]>(
      connectHelpRecheckSql({
        subscriptionId: candidate.subscriptionId,
        kind,
        anchorTransactionId: candidate.anchorTransactionId,
      }),
    );
    const local = rows[0];
    if (
      local === undefined ||
      !local.eligible ||
      !local.stillQualifies ||
      (!candidate.inFlight && !local.undecided)
    ) {
      tally.skipped += 1;
      return;
    }

    // 2. The panel's look — the probe's own re-read, never one of ours.
    const read: ProbeReadOutcome = context.canRead
      ? await this.probe.recheck(candidate.subscriptionId, context.clock())
      : 'unavailable';
    if (context.canRead) tally.checked += 1;
    if (read === 'connected') {
      tally.connected += 1;
      this.logDecision(candidate, 'connected', []);
      return;
    }
    if (read === 'gone') {
      tally.skipped += 1;
      return;
    }
    if (read !== 'not_connected') {
      const closing = candidate.anchorAt.getTime() < context.window.closingBefore.getTime();
      if (!candidate.inFlight && closing) {
        const claim = await this.claim(candidate, kind, 'skipped_unverifiable', context.clock());
        if (claim === 'claimed') {
          tally.skippedUnverifiable += 1;
          this.logDecision(candidate, 'skipped_unverifiable', [], read);
        } else {
          tally.skipped += 1;
        }
        return;
      }
      tally.waiting += 1;
      return;
    }

    // 3. The once-marker.
    if (!candidate.inFlight) {
      const claim = await this.claim(candidate, kind, null, context.clock());
      if (claim === 'lost') {
        tally.skipped += 1;
        return;
      }
      if (claim === 'merged') {
        tally.merged += 1;
        this.emitNotConnected(candidate, kind, 'merged', local.planName, context.clock());
        this.logDecision(candidate, 'merged', []);
        return;
      }
    }

    // 4. The ladder.
    const result = await this.notifications.deliverFirstReachable({
      userId: candidate.userId,
      type: kind === 'paid' ? CONNECT_HELP_TYPE : CONNECT_HELP_TRIAL_TYPE,
      payload: noticePayload(candidate, kind, local),
      eventId: candidate.eventId,
      deferrals: candidate.deferrals,
      onFeedRowWritten: async (eventId) => {
        await this.prismaService.$executeRaw(
          recordEventIdSql(candidate.subscriptionId, eventId, context.clock()),
        );
      },
    });
    if (result.outcome === 'deferred') {
      await this.prismaService.$executeRaw(
        recordDeferralSql({
          subscriptionId: candidate.subscriptionId,
          attempts: result.attempts,
          eventId: result.eventId,
          now: context.clock(),
        }),
      );
      tally.deferred += 1;
      this.logDecision(candidate, 'deferred', result.attempts);
      return;
    }
    const outcome: HelpOutcome = result.outcome;
    const finalized = await this.prismaService.$executeRaw(
      finalizeSql({
        subscriptionId: candidate.subscriptionId,
        outcome,
        attempts: result.attempts,
        eventId: result.eventId,
        now: context.clock(),
      }),
    );
    if (outcome === 'bot' || outcome === 'push' || outcome === 'email') tally.sent[outcome] += 1;
    else if (outcome === 'banner') tally.banner += 1;
    else if (outcome === 'opted_out') tally.optedOut += 1;
    else if (outcome === 'skipped_template_off') tally.skippedTemplateOff += 1;
    // The event is the finalize's to emit, and only when THIS finalize is the
    // one that recorded the outcome.
    if (finalized === 1) {
      this.emitNotConnected(candidate, kind, outcome, local.planName, context.clock());
    }
    this.logDecision(candidate, outcome, result.attempts);
  }

  /**
   * The claim, under the per-person lock. `merged` when a sibling of the same
   * person was helped within a day (unless the claim is itself a final
   * outcome, `skipped_unverifiable`); `lost` when somebody else decided first.
   */
  private async claim(
    candidate: ConnectHelpCandidateRow,
    kind: ConnectHelpKind,
    finalOutcome: 'skipped_unverifiable' | null,
    now: Date,
  ): Promise<'claimed' | 'merged' | 'lost'> {
    return this.prismaService.$transaction(
      async (tx) => {
        await tx.$executeRaw(lockPersonSql(candidate.userId));
        await tx.$executeRaw(ensureStateRowSql(candidate.subscriptionId, now));
        let outcome: HelpOutcome | null = finalOutcome;
        if (outcome === null) {
          const sibling = await tx.$queryRaw<Array<{ readonly merged: boolean }>>(
            mergedSiblingSql({ userId: candidate.userId, subscriptionId: candidate.subscriptionId, now }),
          );
          if (sibling[0]?.merged === true) outcome = 'merged';
        }
        const claimed = await tx.$executeRaw(
          claimSql({
            subscriptionId: candidate.subscriptionId,
            kind,
            anchorAt: candidate.anchorAt,
            outcome,
            now,
          }),
        );
        if (claimed !== 1) return 'lost';
        return outcome === 'merged' ? 'merged' : 'claimed';
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  }

  /**
   * `subscription.not_connected`, once per subscription, after its final
   * outcome. `helpedBy` is the outcome; the Russian `note` is what the
   * operator's card prints.
   */
  private emitNotConnected(
    candidate: ConnectHelpCandidateRow,
    kind: ConnectHelpKind,
    helpedBy: HelpOutcome,
    planName: string | null,
    now: Date,
  ): void {
    const hoursSincePurchase = Math.max(
      0,
      Math.floor((now.getTime() - candidate.anchorAt.getTime()) / (60 * 60 * 1000)),
    );
    this.systemEvents.info(
      EVENT_TYPES.SUBSCRIPTION_NOT_CONNECTED,
      'SUBSCRIPTION',
      `Subscription ${candidate.subscriptionId} has not connected ${hoursSincePurchase}h after it was ${
        kind === 'paid' ? 'bought' : 'granted'
      } (${helpedBy})`,
      {
        userId: candidate.userId,
        subscriptionId: candidate.subscriptionId,
        kind,
        anchorAt: candidate.anchorAt.toISOString(),
        hoursSincePurchase,
        helpedBy,
        ...(planName === null ? {} : { planName }),
        note:
          `${kind === 'paid' ? 'Оплатил' : 'Пробный период или подарок'}: прошло ${hoursSincePurchase} ч, ` +
          `VPN ни разу не подключался. Как помогли: ${HELPED_BY_NOTE[helpedBy] ?? helpedBy}.`,
      },
    );
  }

  /** One structured line per decision: `connect-help sub=<id> kind outcome steps`. */
  private logDecision(
    candidate: ConnectHelpCandidateRow,
    outcome: string,
    attempts: readonly LadderAttempt[],
    read?: ProbeReadOutcome,
  ): void {
    const steps = attempts.length === 0 ? '-' : attempts.map((a) => `${a.channel}:${a.result}`).join(',');
    this.logger.log(
      `connect-help sub=${candidate.subscriptionId} kind=${candidate.kind} outcome=${outcome} ` +
        `steps=${steps}${read === undefined ? '' : ` read=${read}`}${candidate.inFlight ? ' resumed' : ''}`,
    );
  }

  /** The signal state, or `null` when it could not be read — which the cycle treats as "do not ask". */
  private async readSignalState(now: Date): Promise<ConnectSignalState | null> {
    try {
      return (await this.health.current(now)).state;
    } catch (error) {
      this.logger.warn(`Could not read the connection signal: ${(error as Error).message}`);
      return null;
    }
  }

  private async finish(
    now: Date,
    clock: () => Date,
    tally: Tally,
    standDown: 'disabled' | null,
    signal: ConnectSignalState | null,
  ): Promise<ConnectHelpCycleResult> {
    const finishedAt = clock();
    const result: ConnectHelpCycleResult = {
      startedAt: now.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - now.getTime(),
      standDown,
      signal,
      ...tally,
      sent: { ...tally.sent },
    };
    try {
      await this.rawCacheService.set(CONNECT_HELP_LAST_RESULT_KEY, result);
    } catch (error) {
      this.logger.warn(`Could not mirror the connect help cycle: ${(error as Error).message}`);
    }
    if (standDown === null) {
      this.logger.log(
        `connect-help cycle: candidates=${result.candidates} checked=${result.checked} ` +
          `connected=${result.connected} waiting=${result.waiting} bot=${result.sent.bot} ` +
          `push=${result.sent.push} email=${result.sent.email} banner=${result.banner} ` +
          `optedOut=${result.optedOut} merged=${result.merged} unverifiable=${result.skippedUnverifiable} ` +
          `templateOff=${result.skippedTemplateOff} deferred=${result.deferred} skipped=${result.skipped} ` +
          `leftOver=${result.leftOver} errors=${result.errors} signal=${signal ?? 'unknown'}`,
      );
    }
    return result;
  }
}

/**
 * The feed row's payload: the subscription it is about (the cabinet's deep
 * link and the push url read `subscriptionId`), and the facts the template may
 * print — read from the local row, no panel call.
 */
function noticePayload(
  candidate: ConnectHelpCandidateRow,
  kind: ConnectHelpKind,
  local: ConnectHelpRecheckRow,
): Record<string, unknown> {
  const plan = local.planName ?? '';
  return {
    subscriptionId: candidate.subscriptionId,
    kind,
    plan,
    planName: plan,
    expiresAt: local.expiresAt === null ? null : local.expiresAt.toISOString(),
    trafficLimitGb: local.trafficLimit,
    deviceLimit: local.deviceLimit,
    ...(local.profile === null ? {} : { profile: local.profile }),
  };
}
