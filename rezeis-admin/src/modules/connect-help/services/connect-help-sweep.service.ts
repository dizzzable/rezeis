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
  CONNECT_HELP_IN_FLIGHT_MS,
  CONNECT_HELP_LAST_RESULT_KEY,
  CONNECT_HELP_MAX_FAILURES,
  CONNECT_HELP_RESUME_CAP,
  CONNECT_HELP_STEP_STALE_MS,
  CONNECT_HELP_TRIAL_TYPE,
  CONNECT_HELP_TYPE,
} from '../connect-help.constants';
import {
  claimSql,
  closeAllOpenClaimsSql,
  closeClaimSql,
  connectHelpCandidatesSql,
  connectHelpRecheckSql,
  connectHelpWindow,
  ensureStateRowSql,
  finalizeSql,
  lockPersonSql,
  mergedSiblingSql,
  recordDeferralSql,
  recordEventIdSql,
  recordFailureSql,
  recordStepsSql,
  recordStepResultSql,
  STEP_INTERRUPTED,
  STEP_SENDING,
  type CloseOutcome,
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
  /** `disabled`: the automatic help is off; nothing was looked at, begun ladders were stopped. */
  readonly standDown: 'disabled' | null;
  /** The signal the cycle saw. In `webhooks_only` and `blind` the panel was not asked. */
  readonly signal: ConnectSignalState | null;
  readonly candidates: number;
  /** Panel re-reads made before deciding. */
  readonly checked: number;
  /**
   * Found connected — no message. A new candidate gets no marker; a begun
   * ladder is closed as `skipped_connected`.
   */
  readonly connected: number;
  /** Not verifiable this cycle, left for the next («ждут проверки»). */
  readonly waiting: number;
  readonly sent: { readonly bot: number; readonly push: number; readonly email: number };
  readonly banner: number;
  readonly optedOut: number;
  readonly merged: number;
  readonly skippedUnverifiable: number;
  readonly skippedTemplateOff: number;
  /** Begun ladders stopped with nothing sent (`skipped_stopped`). */
  readonly stopped: number;
  /** Begun ladders given up after failing again and again (`skipped_failed`). */
  readonly failed: number;
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
    stopped: 0,
    failed: 0,
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
  skipped_failed: 'отправка раз за разом завершалась ошибкой, ничего не отправлено',
};

/** The push and e-mail steps: the two a second run must never ask again. */
type SendChannel = 'push' | 'email';

/** What a resumed ladder already did, read from `help_attempts`. */
interface RecordedSteps {
  /** A channel that took the notice — its finish was lost (a crash, a failed write). */
  readonly delivered: 'bot' | 'push' | 'email' | null;
  /** A push or e-mail step begun and not answered: another run sending now, or one that died. */
  readonly open: {
    readonly channel: SendChannel;
    readonly at: number;
    readonly raw: Readonly<Record<string, unknown>>;
  } | null;
  /** Steps whose run died before the answer: never asked again. */
  readonly interrupted: readonly SendChannel[];
}

/**
 * «ПОМОЩЬ С ПОДКЛЮЧЕНИЕМ» — THE SENDER
 * ═══════════════════════════════════
 * Every ten minutes, in the worker only, one cycle at a time in the process:
 * the subscriptions that became paid N hours ago (N set by the operator, 1–168)
 * — or, with trials switched on, were granted as a trial or a gift N hours ago —
 * within a 72-hour catch-up, whose VPN never connected, get ONE notice through
 * the first channel that reaches the customer (`deliverFirstReachable`: bot,
 * push, e-mail, else the cabinet banner). At most a hundred a cycle: the begun
 * ladders first (at most twenty), then the new candidates, oldest moment first.
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
 * A CLAIM ALWAYS ENDS. A ladder the relay put off is resumed — every one, at
 * any age — and each resume looks again, locally and at the panel, and asks
 * the one-message-per-person question again under the lock, for the owner the
 * subscription has NOW (an account merge moves it). It ends in a ladder
 * outcome, `merged`, or one of the closes that send nothing:
 * `skipped_connected` (connected before any channel took it),
 * `skipped_stopped` (the help or the trials were switched off, or the
 * subscription stopped being one to help), `skipped_unverifiable` (the panel
 * could not answer for a day after the decision), `skipped_failed` (thrown
 * {@link CONNECT_HELP_MAX_FAILURES} times).
 *
 * A push or an e-mail is recorded as begun BEFORE it is asked and answered at
 * once after; the bot's delivery is recorded the moment it comes back. So a
 * resume finishes on a channel that already took the notice without asking
 * anything, never asks again a step whose run died, and leaves alone a step
 * another replica is sending right now. The bot is not recorded as begun: it
 * deduplicates on the event id, which is what makes a deferred bot step safe
 * to ask again.
 *
 * After the final outcome it emits `subscription.not_connected` ONCE, from the
 * statement that recorded that outcome — not for `skipped_unverifiable` (never
 * verified not connected), and not for the other closes: the customer
 * connected, or the operator stopped the help, or the subscription ended.
 * `skipped_failed` does raise it: verified not connected, and nothing reached
 * the customer — the operator is the one who can still help.
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
      // Nothing is looked at and nothing is sent — but a ladder begun before
      // the switch went off is stopped, not left to finish by itself the day
      // it goes on again.
      try {
        const closed = await this.prismaService.$queryRaw<Array<{ readonly outcome: string }>>(
          closeAllOpenClaimsSql(clock()),
        );
        for (const { outcome } of closed) {
          if (outcome === 'bot' || outcome === 'push' || outcome === 'email') tally.sent[outcome] += 1;
          else tally.stopped += 1;
        }
      } catch (error) {
        tally.errors += 1;
        this.logger.warn(`Could not stop the begun connect help ladders: ${(error as Error).message}`);
      }
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
      connectHelpCandidatesSql({ now, settings, limit: CONNECT_HELP_BATCH, resumeCap: CONNECT_HELP_RESUME_CAP }),
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
        await this.recordFailure(candidate, error, context);
      }
    }
    return this.finish(now, clock, tally, null, signal);
  }

  private async decide(candidate: ConnectHelpCandidateRow, context: CycleContext): Promise<void> {
    if (candidate.inFlight) {
      await this.resume(candidate, context);
      return;
    }
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
    const local = await this.lookLocally(candidate, kind);
    if (local === undefined || !local.eligible || !local.stillQualifies || !local.undecided) {
      tally.skipped += 1;
      return;
    }

    // 2. The panel's look — the probe's own re-read, never one of ours.
    const read = await this.lookAtPanel(candidate, context);
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
      if (closing) {
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

    // 4. The ladder.
    await this.runLadder(candidate, kind, local, context, []);
  }

  /**
   * A claim whose ladder has not finished — every one ends here, in bounded
   * time, with an outcome: see the class comment.
   */
  private async resume(candidate: ConnectHelpCandidateRow, context: CycleContext): Promise<void> {
    const { tally } = context;
    const known = candidate.kind === 'paid' || candidate.kind === 'trial';
    const kind: ConnectHelpKind = known ? candidate.kind : 'paid';

    // 1. The local look, fresh — the list is minutes old by now.
    const local = await this.lookLocally(candidate, kind);
    if (local === undefined || !local.open) {
      // Gone with its subscription, or finished by another replica meanwhile.
      tally.skipped += 1;
      return;
    }
    const steps = readSteps(local.attempts);
    if (steps.delivered !== null) {
      // A channel took the notice and only the finish was lost: record it and
      // ask nothing — above all not the push again.
      await this.recordOutcome(candidate, kind, local, steps.delivered, [], null, context, []);
      return;
    }
    // A push or e-mail step begun and never answered: another replica sending
    // it right now (left alone — it writes the outcome), or a run that died
    // (the step is marked interrupted and never asked again).
    const skip: SendChannel[] = [...steps.interrupted];
    if (steps.open !== null) {
      if (context.clock().getTime() - steps.open.at < CONNECT_HELP_STEP_STALE_MS) {
        tally.skipped += 1;
        this.logDecision(candidate, 'busy', []);
        return;
      }
      await this.prismaService.$executeRaw(
        recordStepResultSql({
          subscriptionId: candidate.subscriptionId,
          begun: steps.open.raw,
          result: { ...steps.open.raw, result: STEP_INTERRUPTED },
          now: context.clock(),
        }),
      );
      if (!skip.includes(steps.open.channel)) skip.push(steps.open.channel);
    }
    if (!known || (kind === 'trial' && !context.settings.includeTrials)) {
      await this.close(candidate, 'skipped_stopped', context);
      return;
    }
    if (local.connected) {
      await this.close(candidate, 'skipped_connected', context);
      return;
    }
    if (!local.eligible || !local.stillQualifies) {
      await this.close(candidate, 'skipped_stopped', context);
      return;
    }

    // 2. The panel's look.
    const read = await this.lookAtPanel(candidate, context);
    if (read === 'connected') {
      await this.close(candidate, 'skipped_connected', context, read);
      return;
    }
    if (read === 'gone') {
      await this.close(candidate, 'skipped_stopped', context, read);
      return;
    }
    if (read !== 'not_connected') {
      const decidedAt = local.decidedAt ?? candidate.anchorAt;
      if (context.clock().getTime() - decidedAt.getTime() >= CONNECT_HELP_IN_FLIGHT_MS) {
        await this.close(candidate, 'skipped_unverifiable', context, read);
        return;
      }
      tally.waiting += 1;
      return;
    }

    // 3. One message per person, asked again for the owner it has NOW.
    const owner: ConnectHelpCandidateRow = { ...candidate, userId: local.userId };
    if (await this.mergeResumed(owner, context.clock())) {
      tally.merged += 1;
      this.emitNotConnected(owner, kind, 'merged', local.planName, context.clock());
      this.logDecision(owner, 'merged', []);
      return;
    }

    // 4. The ladder, on — without the steps a dead run began.
    await this.runLadder(owner, kind, local, context, skip);
  }

  /** `connectHelpRecheckSql` for one candidate; `undefined` = the subscription is gone. */
  private async lookLocally(
    candidate: ConnectHelpCandidateRow,
    kind: ConnectHelpKind,
  ): Promise<ConnectHelpRecheckRow | undefined> {
    const rows = await this.prismaService.$queryRaw<ConnectHelpRecheckRow[]>(
      connectHelpRecheckSql({
        subscriptionId: candidate.subscriptionId,
        kind,
        anchorTransactionId: candidate.anchorTransactionId,
      }),
    );
    return rows[0];
  }

  private async lookAtPanel(
    candidate: ConnectHelpCandidateRow,
    context: CycleContext,
  ): Promise<ProbeReadOutcome> {
    if (!context.canRead) return 'unavailable';
    const read = await this.probe.recheck(candidate.subscriptionId, context.clock());
    context.tally.checked += 1;
    return read;
  }

  /**
   * The ladder, with every push and e-mail step recorded as begun before it is
   * asked and answered right after, and the bot's delivery the moment it comes
   * back; the steps not recorded that way go in with the outcome (or the
   * deferral) that ends the call.
   */
  private async runLadder(
    candidate: ConnectHelpCandidateRow,
    kind: ConnectHelpKind,
    local: ConnectHelpRecheckRow,
    context: CycleContext,
    skip: readonly SendChannel[],
  ): Promise<void> {
    const { subscriptionId } = candidate;
    /** How many of this call's steps are already on the row. */
    let recorded = 0;
    let begun: LadderAttempt | null = null;
    /** Another run put a delivery on record first: it finishes the row, this one does not. */
    let takenElsewhere = false;
    const result = await this.notifications.deliverFirstReachable({
      userId: candidate.userId,
      type: kind === 'paid' ? CONNECT_HELP_TYPE : CONNECT_HELP_TRIAL_TYPE,
      payload: noticePayload(candidate, kind, local),
      eventId: candidate.eventId,
      deferrals: candidate.deferrals,
      skipChannels: skip,
      onFeedRowWritten: async (eventId) => {
        await this.prismaService.$executeRaw(recordEventIdSql(subscriptionId, eventId, context.clock()));
      },
      beforeSend: async (channel, attempts) => {
        const intent: LadderAttempt = { channel, result: STEP_SENDING, at: context.clock().toISOString() };
        const owned = await this.prismaService.$executeRaw(
          recordStepsSql({
            subscriptionId,
            steps: [...attempts.slice(recorded), intent],
            now: context.clock(),
          }),
        );
        if (owned !== 1) return false;
        recorded = attempts.length;
        begun = intent;
        return true;
      },
      afterSend: async (attempt, attempts) => {
        if (begun !== null) {
          // The push's or the letter's answer, in place of its `sending`.
          await this.prismaService.$executeRaw(
            recordStepResultSql({ subscriptionId, begun, result: attempt, now: context.clock() }),
          );
          begun = null;
          recorded = attempts.length;
          return;
        }
        // The bot took it: on record now, not only with the outcome.
        const landed = await this.prismaService.$executeRaw(
          recordStepsSql({ subscriptionId, steps: attempts.slice(recorded), now: context.clock() }),
        );
        if (landed === 1) recorded = attempts.length;
        else takenElsewhere = true;
      },
    });
    const unrecorded = result.attempts.slice(recorded);
    if (takenElsewhere) {
      // The same notice, deduplicated by the bot on its event id, was put on
      // record by a second replica: the outcome is that run's to write.
      context.tally.skipped += 1;
      this.logDecision(candidate, 'busy', result.attempts);
      return;
    }
    if (result.outcome === 'busy') {
      context.tally.skipped += 1;
      this.logDecision(candidate, 'busy', result.attempts);
      return;
    }
    if (result.outcome === 'deferred') {
      await this.prismaService.$executeRaw(
        recordDeferralSql({
          subscriptionId,
          attempts: unrecorded,
          eventId: result.eventId,
          now: context.clock(),
        }),
      );
      context.tally.deferred += 1;
      this.logDecision(candidate, 'deferred', result.attempts);
      return;
    }
    await this.recordOutcome(
      candidate,
      kind,
      local,
      result.outcome,
      unrecorded,
      result.eventId,
      context,
      result.attempts,
    );
  }

  /** A final outcome of the ladder (or `merged`), its tally, its event and its log line. */
  private async recordOutcome(
    candidate: ConnectHelpCandidateRow,
    kind: ConnectHelpKind,
    local: ConnectHelpRecheckRow,
    outcome: HelpOutcome,
    unrecorded: readonly LadderAttempt[],
    eventId: string | null,
    context: CycleContext,
    attempts: readonly LadderAttempt[],
  ): Promise<void> {
    const { tally } = context;
    const finalized = await this.prismaService.$executeRaw(
      finalizeSql({
        subscriptionId: candidate.subscriptionId,
        outcome,
        attempts: unrecorded,
        eventId,
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
    this.logDecision(candidate, outcome, attempts);
  }

  /** A begun ladder closed without sending anything. */
  private async close(
    candidate: ConnectHelpCandidateRow,
    outcome: CloseOutcome,
    context: CycleContext,
    read?: ProbeReadOutcome,
  ): Promise<void> {
    const { tally } = context;
    const closed = await this.prismaService.$executeRaw(
      closeClaimSql({ subscriptionId: candidate.subscriptionId, outcome, now: context.clock() }),
    );
    if (closed !== 1) {
      tally.skipped += 1;
      return;
    }
    if (outcome === 'skipped_connected') tally.connected += 1;
    else if (outcome === 'skipped_unverifiable') tally.skippedUnverifiable += 1;
    else if (outcome === 'skipped_stopped') tally.stopped += 1;
    else tally.failed += 1;
    this.logDecision(candidate, outcome, [], read);
  }

  /**
   * A throw while deciding. Counted on the row when the sender holds an open
   * claim on it — a new candidate that threw before its claim has none, and
   * is simply a candidate again next cycle — and given up as `skipped_failed`
   * at the {@link CONNECT_HELP_MAX_FAILURES}th.
   */
  private async recordFailure(
    candidate: ConnectHelpCandidateRow,
    error: unknown,
    context: CycleContext,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const rows = await this.prismaService.$queryRaw<Array<{ readonly outcome: string | null }>>(
        recordFailureSql({
          subscriptionId: candidate.subscriptionId,
          detail: message.length > 300 ? `${message.slice(0, 299)}…` : message,
          maxFailures: CONNECT_HELP_MAX_FAILURES,
          now: context.clock(),
        }),
      );
      const outcome = rows[0]?.outcome ?? null;
      if (outcome !== 'skipped_failed' && outcome !== 'bot' && outcome !== 'push' && outcome !== 'email') return;
      if (outcome === 'skipped_failed') context.tally.failed += 1;
      else context.tally.sent[outcome] += 1;
      const kind: ConnectHelpKind = candidate.kind === 'trial' ? 'trial' : 'paid';
      this.emitNotConnected(candidate, kind, outcome, null, context.clock());
      this.logDecision(candidate, outcome, []);
    } catch (recordError) {
      this.logger.warn(
        `connect-help sub=${candidate.subscriptionId} failure not recorded: ${(recordError as Error).message}`,
      );
    }
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
   * The claim's one-message-per-person question, asked again for a resumed
   * ladder under the same per-person lock: a sibling of the owner helped
   * within a day — a broadcast reached it meanwhile, or an account merge
   * brought the subscription to someone already helped — makes this one
   * `merged`. True when THIS call recorded it.
   */
  private async mergeResumed(candidate: ConnectHelpCandidateRow, now: Date): Promise<boolean> {
    return this.prismaService.$transaction(
      async (tx) => {
        await tx.$executeRaw(lockPersonSql(candidate.userId));
        const sibling = await tx.$queryRaw<Array<{ readonly merged: boolean }>>(
          mergedSiblingSql({ userId: candidate.userId, subscriptionId: candidate.subscriptionId, now }),
        );
        if (sibling[0]?.merged !== true) return false;
        const merged = await tx.$executeRaw(
          finalizeSql({
            subscriptionId: candidate.subscriptionId,
            outcome: 'merged',
            attempts: [],
            eventId: null,
            now,
          }),
        );
        return merged === 1;
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
          `templateOff=${result.skippedTemplateOff} stopped=${result.stopped} failed=${result.failed} ` +
          `deferred=${result.deferred} skipped=${result.skipped} ` +
          `leftOver=${result.leftOver} errors=${result.errors} signal=${signal ?? 'unknown'}`,
      );
    } else if (result.stopped > 0) {
      this.logger.log(`connect-help cycle: disabled, stopped=${result.stopped} begun ladders`);
    }
    return result;
  }
}

/**
 * What a resumed ladder already did. Only the sender writes `help_attempts`,
 * but it is JSON: anything malformed is ignored, never trusted.
 */
function readSteps(value: unknown): RecordedSteps {
  let delivered: RecordedSteps['delivered'] = null;
  let open: RecordedSteps['open'] = null;
  const interrupted: SendChannel[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const step = entry as Readonly<Record<string, unknown>>;
    const channel = step['channel'];
    const result = step['result'];
    if (
      delivered === null &&
      ((channel === 'bot' && result === 'confirmed') ||
        (channel === 'push' && result === 'delivered') ||
        (channel === 'email' && result === 'queued'))
    ) {
      delivered = channel;
    }
    if (channel !== 'push' && channel !== 'email') continue;
    if (result === STEP_SENDING && open === null) {
      // An unreadable time reads as long ago: taken over, never waited on for ever.
      const at = typeof step['at'] === 'string' ? Date.parse(step['at']) : Number.NaN;
      open = { channel, at: Number.isNaN(at) ? 0 : at, raw: step };
    }
    if (result === STEP_INTERRUPTED && !interrupted.includes(channel)) interrupted.push(channel);
  }
  return { delivered, open, interrupted };
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
