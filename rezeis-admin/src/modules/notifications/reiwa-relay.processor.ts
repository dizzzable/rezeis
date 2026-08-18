import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';

import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
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
  REIWA_RELAY_QUEUE,
  type ReiwaRelayEvent,
  type ReiwaRelayJobData,
} from './reiwa-relay.constants';
import { isRelayDelivered, shouldAlertOperator } from './reiwa-relay.policy';
import { BotNotifierClient, type NotifyDeliveryResult } from './services/bot-notifier.client';

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
 * ReiwaRelayProcessor
 * ═══════════════════
 * The consumer half of durable panel → cabinet delivery, shaped after the one
 * relay that already worked (`BackupService.deliverToTelegram`): inspect the
 * outcome rather than assume it, retry only what a retry can fix, and make
 * sure that when nothing more is coming somebody is told.
 *
 * Four exits, one for each thing that can be true after an attempt:
 *
 *  - delivered → the job completes.
 *  - not delivered, retry might fix it, attempts remain → throw, so BullMQ
 *    retries with the event's backoff.
 *  - not delivered, final, and the failure is the operator's to act on →
 *    record it durably, alert, and FAIL the job.
 *  - not delivered, final, and the failure is a routine per-recipient fact
 *    (`shouldAlertOperator` says no) → record it in the log and COMPLETE the
 *    job carrying `delivered: false`. The branch in `process` carries the
 *    full reasoning.
 *
 * "Record it durably" is the point of the whole exercise. Until now the entire
 * trace of a lost relay was one `logger.warn` in a 5 000-entry in-memory ring
 * buffer that a restart wipes. A `SystemEventsService` emit writes an
 * `AdminAuditLog` row that outlives the process, pushes the card to connected
 * admins over the realtime socket, and only then tries Telegram.
 */
@Processor(REIWA_RELAY_QUEUE, { concurrency: RELAY_WORKER_CONCURRENCY })
export class ReiwaRelayProcessor extends WorkerHost {
  private readonly logger = new Logger(ReiwaRelayProcessor.name);

  public constructor(
    private readonly botNotifier: BotNotifierClient,
    private readonly systemEventsService: SystemEventsService,
  ) {
    super();
  }

  public async process(job: Job<ReiwaRelayJobData>): Promise<{
    readonly event: ReiwaRelayEvent;
    readonly status: string;
    readonly delivered: boolean;
  }> {
    const { event, metadata } = job.data;
    const outcome = await this.botNotifier.deliverRelayEvent(event, metadata);

    if (isRelayDelivered(event, outcome)) {
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
      throw new Error(`reiwa relay ${event} ${outcome.status}`);
    }

    this.recordUndelivered(job, outcome);

    if (!shouldAlertOperator(event, outcome)) {
      // ── Why this COMPLETES instead of failing ──────────────────────────
      // The one outcome `shouldAlertOperator` excludes is `reiwa.user.notify`
      // + `unconfirmed`, i.e. overwhelmingly "this subscriber blocked the
      // bot". It is also, by a wide margin, the highest-VOLUME undelivered
      // outcome on this queue: on a platform with churn every blocked
      // subscriber produces one per notification sent to them.
      //
      // Failing it put those in `removeOnFail`'s bounded set, where they
      // pushed out the jobs an operator actually needs — a relay that burned
      // through its attempts because the cabinet was down. Raising the bound
      // instead would only buy time, and the number that buys a day depends
      // on a platform size nobody here knows.
      //
      // Nothing that was ever actionable is lost by completing:
      //   * every ALERTABLE undelivered outcome still fails the job AND
      //     writes a `reiwa.relay_undelivered` row into `AdminAuditLog`, so
      //     the retained set is now a bin of exactly those;
      //   * this one is already recorded out of band — the bot flips
      //     `User.isBotBlocked`, and the cabinet-feed row the notification
      //     belongs to is untouched — plus the `logger.warn` in
      //     `recordUndelivered`;
      //   * the completed job's own return value says `delivered: false`, so
      //     the terminal state answers "is more work coming?" honestly rather
      //     than claiming an arrival.
      return { event, status: outcome.status, delivered: false };
    }

    if (retryable) {
      // Transient, but out of attempts. Fail the job so it lands in BullMQ's
      // retained failed set alongside the audit-log row.
      throw new Error(`reiwa relay ${event} ${outcome.status} (attempts exhausted)`);
    }
    // Permanent: a bad signature, a payload the bot refuses, a relay that was
    // never configured. `UnrecoverableError` fails the job without burning the
    // remaining attempts on a request whose answer cannot change.
    throw new UnrecoverableError(`reiwa relay ${event} ${outcome.status} (permanent)`);
  }

  /**
   * Leave a trace that survives the process, and alert where the operator can
   * act. `shouldAlertOperator` carries the one exclusion and its reasoning.
   *
   * Two levels rather than one, because `SystemEventsService.emit` has a single
   * door: it persists to `AdminAuditLog`, pushes to the realtime socket AND
   * tries Telegram, with no "record it but do not card it" variant. Adding one
   * would mean a second, divergent path that writes events — worse than the
   * problem it solves.
   *
   *  - Alertable: a `reiwa.relay_undelivered` system event — the `AdminAuditLog`
   *    row plus the operator's card — and the job then fails, so BullMQ also
   *    retains it (payload, error, attempt count) in Redis. Metadata mirrors
   *    the backup relay's so the two read alike.
   *  - Not alertable: the `logger.warn` below, and nothing in the retained
   *    failed set — deliberately, because that set is bounded and this case is
   *    the one that floods it. `process` explains the trade in full.
   */
  private recordUndelivered(job: Job<ReiwaRelayJobData>, outcome: NotifyDeliveryResult): void {
    const { event, metadata } = job.data;
    if (!shouldAlertOperator(event, outcome)) {
      this.logger.warn(
        `Relay ${event} ${outcome.status} — per-recipient Telegram state, not a link ` +
          'failure; recorded on the failed job, no operator alert',
      );
      return;
    }
    const eventId = typeof metadata['eventId'] === 'string' ? metadata['eventId'] : null;
    this.systemEventsService.warn(
      EVENT_TYPES.REIWA_RELAY_UNDELIVERED,
      'SYSTEM',
      `Reiwa relay did not deliver ${event} (${outcome.status})`,
      {
        relayEvent: event,
        relayStatus: outcome.status,
        httpStatus: outcome.httpStatus,
        detail: outcome.detail,
        attemptsMade: job.attemptsMade + 1,
        attempts: job.opts?.attempts ?? 1,
        ...(eventId !== null ? { relayEventId: eventId } : {}),
      },
    );
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job<ReiwaRelayJobData> | undefined, error: Error): void {
    this.logger.warn(
      `Relay job ${job?.id ?? 'unknown'} (${job?.data?.event ?? 'unknown'}) failed: ${error.message}`,
    );
  }
}
