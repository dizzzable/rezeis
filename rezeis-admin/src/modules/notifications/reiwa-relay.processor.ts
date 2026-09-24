import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';

import { EVENT_TYPES, type SystemEventsService } from '../../common/services/system-events.service';
import {
  CONFIG_DELIVERY_TRACKER,
  isConfigHintEvent,
  type ConfigDeliveryTracker,
} from '../bot-config/config-versions/config-versions.constants';
// Imported from the backup module rather than reimplemented: that file is
// where the relay-outcome retry classification was first reasoned out, in
// detail, for exactly this question. Three modules now read it (backup,
// broadcast, here), so its name has outlived its scope — worth moving to a
// neutral home, not worth forking the reasoning to do so.
import {
  isFinalProcessorAttempt,
  isRetryableRelayOutcome,
} from '../backup/backup-delivery-retry.util';
import {
  REIWA_RELAY_EVENTS,
  REIWA_RELAY_QUEUE,
  type ReiwaRelayEvent,
  type ReiwaRelayJobData,
} from './reiwa-relay.constants';
import {
  isDevRelayDeadEnd,
  isRelayDelivered,
  RELAY_EVENT_POLICY,
  resolveRelayBackoff,
  shouldAlertOperator,
  shouldFailRelayJob,
} from './reiwa-relay.policy';
import { BotNotifierClient, type NotifyDeliveryResult } from './services/bot-notifier.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { rememberLostChannelPost, rememberRelayedChannelPost } from './relay-channel-post';
import {
  buildRelayUndeliveredRecord,
  RELAY_UNDELIVERED_RECORDER,
  type UndeliveredRecord,
  type UndeliveredRecorder,
} from './undelivered-record';

/**
 * The one place a `reiwa.relay_undelivered` record becomes a system event.
 *
 * Reached only through `RELAY_UNDELIVERED_RECORDER`, which `ReiwaRelayModule`
 * binds to this behind the alert gate, and which both roads use: this processor
 * (a job out of attempts) and `ReiwaRelayQueueService` (a direct attempt made
 * because Redis refused the job). Same type, same category, same record builder
 * — an operator reading the audit log cannot tell the two roads apart by shape,
 * only by `enqueueError` — and the same cooldown window.
 */
export function emitRelayUndelivered(
  events: Pick<SystemEventsService, 'warn'>,
  record: UndeliveredRecord,
): void {
  events.warn(EVENT_TYPES.REIWA_RELAY_UNDELIVERED, 'SYSTEM', record.message, record.metadata);
}

/**
 * Five at a time. The relay is one HTTP hop into a single cabinet process
 * which forwards to a single bot process, so more in flight buys throughput
 * only until the cabinet becomes the bottleneck — and every one of those
 * in-flight calls can sit for its route's whole budget: 10s for a message,
 * 35s for an inline document, since the panel's deadline has to outlast the
 * cabinet's for the same route (`relayRequestTimeoutMs`). Five keeps a
 * notification backlog draining while leaving the cabinet room to serve its
 * own users.
 */
const RELAY_WORKER_CONCURRENCY = 5;

/**
 * An attempt another attempt might fix, carrying the wait the cabinet named.
 *
 * BullMQ hands the thrown error to a custom backoff strategy and to nothing
 * else, so `retryAfterSeconds` rides on the error or it does not reach the
 * scheduler at all. Same device as `TelegramDirectRetryError`.
 */
export class ReiwaRelayRetryError extends Error {
  public readonly retryAfterSeconds: number | null;

  public constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'ReiwaRelayRetryError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The worker's backoff for jobs of type `RELAY_BACKOFF_TYPE`: the event's own
 * policy, pushed back to a cabinet `Retry-After` when one came with the error.
 * The arithmetic lives in `resolveRelayBackoff`; this only finds the policy
 * and the wait.
 *
 * A job whose payload names no known event keeps the delay it was enqueued
 * with, fixed — the least surprising reading of a job this code did not write.
 */
export function relayBackoffStrategy(
  attemptsMade: number,
  _type?: string,
  err?: Error,
  job?: { readonly data?: unknown; readonly opts?: { readonly backoff?: unknown } },
): number {
  const retryAfter = err instanceof ReiwaRelayRetryError ? err.retryAfterSeconds : null;
  const event = (job?.data as { event?: unknown } | undefined)?.event;
  const policy = (REIWA_RELAY_EVENTS as readonly unknown[]).includes(event)
    ? RELAY_EVENT_POLICY[event as ReiwaRelayEvent]
    : null;
  if (policy !== null) return resolveRelayBackoff(policy, attemptsMade, retryAfter);
  const backoff = job?.opts?.backoff as { delay?: unknown } | undefined;
  const delay = typeof backoff?.delay === 'number' ? backoff.delay : 0;
  return resolveRelayBackoff({ backoff: { type: 'fixed', delay } }, attemptsMade, retryAfter);
}

/**
 * ReiwaRelayProcessor
 * ═══════════════════
 * The consumer half of durable panel → cabinet delivery, shaped after the one
 * relay that already worked (`BackupService.deliverToTelegram`): inspect the
 * outcome rather than assume it, retry only what a retry can fix, and make
 * sure that when nothing more is coming somebody is told.
 *
 * Five exits, one for each thing that can be true after an attempt:
 *
 *  - delivered → the job completes.
 *  - not delivered, retry might fix it, attempts remain → throw, so BullMQ
 *    retries with the event's backoff.
 *  - not delivered, final, and a failure of the link → record it (the alert is
 *    coalesced per cause) and FAIL the job.
 *  - not delivered, final, and Telegram refused the message → record it the
 *    same way and COMPLETE the job carrying `delivered: false`: a verdict on
 *    one message is not a slot in the bin of link failures
 *    (`shouldFailRelayJob`).
 *  - not delivered, final, and a routine per-recipient or dead-end fact
 *    (`shouldAlertOperator` says no) → a log line, and COMPLETE the job
 *    carrying `delivered: false`. The branch in `process` carries the full
 *    reasoning.
 *
 * "Record it durably" is the point of the whole exercise. Until now the entire
 * trace of a lost relay was one `logger.warn` in a 5 000-entry in-memory ring
 * buffer that a restart wipes. A `SystemEventsService` emit writes an
 * `AdminAuditLog` row that outlives the process, pushes the card to connected
 * admins over the realtime socket, and only then tries Telegram — once per
 * cause per cooldown, so that a template refused for a thousand subscribers is
 * one card and a count rather than a thousand (`undelivered-alert-gate.ts`).
 */
@Processor(REIWA_RELAY_QUEUE, {
  concurrency: RELAY_WORKER_CONCURRENCY,
  settings: { backoffStrategy: relayBackoffStrategy },
})
export class ReiwaRelayProcessor extends WorkerHost {
  private readonly logger = new Logger(ReiwaRelayProcessor.name);

  public constructor(
    private readonly botNotifier: BotNotifierClient,
    /**
     * The coalescing emitter, shared with the producer's direct fallback. Not
     * `SystemEventsService` itself: an exhausted job and a failed fallback must
     * count against one window per cause, or the gate halves nothing.
     */
    @Inject(RELAY_UNDELIVERED_RECORDER)
    private readonly recordUndeliveredSend: UndeliveredRecorder,
    private readonly prismaService: PrismaService,
    /**
     * The settings delivery check (`bot-config/config-versions/`). With it, a
     * cache hint that ran out of attempts raises no card of its own: the
     * cabinet's version poll catches a lost hint within twenty seconds, and two
     * minutes after the save the check warns only if the cabinet still holds
     * the old copy — the owner's rule. The hint's outcome goes to the check as
     * evidence instead. Absent in a module built without it: the old card.
     */
    @Optional()
    @Inject(CONFIG_DELIVERY_TRACKER)
    private readonly deliveryTracker?: ConfigDeliveryTracker,
  ) {
    super();
  }

  /** A cache hint's final outcome, told to the delivery check. Never throws. */
  private async settleHint(event: ReiwaRelayEvent, delivered: boolean, status: string): Promise<void> {
    if (this.deliveryTracker === undefined || !isConfigHintEvent(event)) return;
    try {
      await this.deliveryTracker.hintSettled(event, delivered, status);
    } catch (err: unknown) {
      this.logger.warn(
        `Could not record the outcome of ${event} for the delivery check: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Keep the address of a broadcast's operator-channel post — see
   * `rememberRelayedChannelPost`, which the direct fallback shares.
   */
  private async rememberChannelPost(
    data: ReiwaRelayJobData,
    outcome: NotifyDeliveryResult,
  ): Promise<void> {
    await rememberRelayedChannelPost(this.prismaService, data, outcome, (message) =>
      this.logger.warn(message),
    );
  }

  public async process(job: Job<ReiwaRelayJobData>): Promise<{
    readonly event: ReiwaRelayEvent;
    readonly status: string;
    readonly delivered: boolean;
  }> {
    const { event, metadata } = job.data;
    const outcome = await this.botNotifier.deliverRelayEvent(event, metadata);

    if (isRelayDelivered(event, outcome)) {
      await this.rememberChannelPost(job.data, outcome);
      await this.settleHint(event, true, outcome.status);
      return { event, status: outcome.status, delivered: true };
    }

    const retryable = isRetryableRelayOutcome(outcome);
    const finalAttempt = isFinalProcessorAttempt(job);

    if (retryable && !finalAttempt) {
      // Deliberately no operator event yet: attempt two may well deliver, and
      // an alert per attempt is three alerts for one lost message. Same split
      // the backup relay makes.
      this.logger.warn(
        `Relay ${event} ${outcome.status} (attempt ${job.attemptsMade + 1}/${
          job.opts?.attempts ?? 1
        }) — retrying`,
      );
      // The cabinet's `Retry-After` rides on the error: it is the only thing
      // `relayBackoffStrategy` is handed.
      throw new ReiwaRelayRetryError(
        `reiwa relay ${event} ${outcome.status}`,
        outcome.retryAfterSeconds ?? null,
      );
    }

    if (this.deliveryTracker !== undefined && isConfigHintEvent(event)) {
      // A cache hint out of attempts: no card here — the delivery check decides,
      // two minutes after the save, from what the cabinet holds.
      await this.settleHint(event, false, outcome.status);
    } else {
      await this.recordUndelivered(job, outcome);
    }
    // Nothing further is coming for this relay. A broadcast's channel post
    // that certainly never went up must stop reading as a public copy on the
    // broadcast page — see `rememberLostChannelPost`.
    await rememberLostChannelPost(this.prismaService, job.data, outcome, (message) =>
      this.logger.warn(message),
    );

    if (!shouldFailRelayJob(event, outcome)) {
      // ── Why this COMPLETES instead of failing ──────────────────────────
      // Three outcomes end here. The dev relay's dead ends — nobody to
      // deliver to, or a card Telegram refused to that nobody — are a
      // deployment shape rather than an incident, and `isDevRelayDeadEnd`
      // says why. `reiwa.user.notify` + `unconfirmed` is overwhelmingly "this
      // subscriber blocked the bot". And a message Telegram refused (422) is
      // alerted, once per cause, but it is a verdict on that message rather
      // than on the link.
      //
      // What they share is VOLUME. Every blocked subscriber produces one per
      // notification sent to them; a template Telegram will not parse is
      // refused once per recipient. Failing them put those in
      // `removeOnFail`'s bounded set, where they pushed out the jobs an
      // operator actually needs — a relay that burned through its attempts
      // because the cabinet was down. Raising the bound instead would only buy
      // time, and the number that buys a day depends on a platform size nobody
      // here knows.
      //
      // Nothing that was ever actionable is lost by completing:
      //   * every failure of the LINK still fails the job and writes (or
      //     counts into) a `reiwa.relay_undelivered` alert, so the retained
      //     set is now a bin of exactly those;
      //   * a refusal writes that alert too, with the cabinet's reason in it;
      //   * the blocked bot is recorded out of band — the bot flips
      //     `User.isBotBlocked`, and the cabinet-feed row the notification
      //     belongs to is untouched — plus the log line in
      //     `recordUndelivered`;
      //   * the completed job's own return value says `delivered: false`, so
      //     the terminal state answers "is more work coming?" honestly rather
      //     than claiming an arrival.
      return { event, status: outcome.status, delivered: false };
    }

    if (retryable) {
      // Transient, but out of attempts. Fail the job so it lands in BullMQ's
      // retained failed set alongside the audit-log row.
      throw new ReiwaRelayRetryError(
        `reiwa relay ${event} ${outcome.status} (attempts exhausted)`,
        outcome.retryAfterSeconds ?? null,
      );
    }
    // Permanent: a bad signature, a route the cabinet does not know, a relay
    // that was never configured. `UnrecoverableError` fails the job without
    // burning the remaining attempts on a request whose answer cannot change.
    throw new UnrecoverableError(`reiwa relay ${event} ${outcome.status} (permanent)`);
  }

  /**
   * Leave a trace that survives the process, and alert where the operator can
   * act. `shouldAlertOperator` carries the exclusions and their reasoning.
   *
   * Two levels rather than one, because `SystemEventsService.emit` has a single
   * door: it persists to `AdminAuditLog`, pushes to the realtime socket AND
   * tries Telegram, with no "record it but do not card it" variant. Adding one
   * would mean a second, divergent path that writes events — worse than the
   * problem it solves.
   *
   *  - Alertable: the record goes to `RELAY_UNDELIVERED_RECORDER`, which emits a
   *    `reiwa.relay_undelivered` system event — the `AdminAuditLog` row plus
   *    the operator's card — for the first record of its cause in a cooldown,
   *    and counts the rest into the next one. Metadata mirrors the backup
   *    relay's so the two read alike.
   *  - Not alertable: the log line below, and nothing in the retained failed
   *    set — deliberately, because that set is bounded and these are the cases
   *    that flood it. `process` explains the trade in full.
   */
  private async recordUndelivered(
    job: Job<ReiwaRelayJobData>,
    outcome: NotifyDeliveryResult,
  ): Promise<void> {
    const { event, metadata } = job.data;
    if (isDevRelayDeadEnd(event, outcome)) {
      // Debug, not warn: on an install whose dev route reaches nobody this is
      // every system event, and a warning per event is the same noise the
      // alert would have been, moved to stdout.
      this.logger.debug(
        `Relay ${event}: the dev route reached nobody (${outcome.httpStatus}${
          outcome.detail === null ? '' : `, ${outcome.detail}`
        }) — no operator alert`,
      );
      return;
    }
    if (!shouldAlertOperator(event, outcome)) {
      this.logger.warn(
        `Relay ${event} ${outcome.status} — per-recipient Telegram state, not a link ` +
          'failure; recorded on the completed job, no operator alert',
      );
      return;
    }
    try {
      // The automation hop count rides along inside the builder — see the note
      // there on why losing it re-armed a rule bound to this event for ever.
      await this.recordUndeliveredSend(
        buildRelayUndeliveredRecord({
          event,
          metadata,
          outcome,
          attemptsMade: job.attemptsMade + 1,
          attempts: job.opts?.attempts ?? 1,
        }),
      );
    } catch (err: unknown) {
      // What the job does next must not depend on whether the record could be
      // written; the log line is what is left.
      this.logger.warn(
        `Could not record the undelivered ${event}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job<ReiwaRelayJobData> | undefined, error: Error): void {
    this.logger.warn(
      `Relay job ${job?.id ?? 'unknown'} (${job?.data?.event ?? 'unknown'}) failed: ${error.message}`,
    );
  }
}
