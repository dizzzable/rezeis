import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import {
  BULLMQ_RETAINED_COMPLETED_JOBS,
  BULLMQ_RETAINED_FAILED_JOBS,
  runBullMqEnqueueWithTimeout,
} from '../../../common/queue/bullmq-enqueue-options';
import {
  REIWA_RELAY_JOB,
  REIWA_RELAY_QUEUE,
  type ReiwaRelayEvent,
  type ReiwaRelayJobData,
} from '../reiwa-relay.constants';
import { RELAY_EVENT_POLICY } from '../reiwa-relay.policy';
import { BotNotifierClient } from './bot-notifier.client';

/**
 * ReiwaRelayQueueService
 * ══════════════════════
 * The producer half of durable panel → cabinet delivery. Callers hand it an
 * event and its metadata; it puts a BullMQ job on `reiwa-relay` with the retry
 * policy that event earned, and `ReiwaRelayProcessor` does the HTTP.
 *
 * The whole point is that the caller stops being the last line of defence.
 * Before this, nine event kinds went out on a single `fetch` whose result was
 * dropped by every caller — a `logger.warn` into a 5 000-entry in-memory ring
 * buffer was the entire record that a subscriber never got their message.
 *
 * Two deliberate non-guarantees:
 *
 *  - **Not transactional with the caller's write.** Enqueue happens after the
 *    row is committed, so a crash between the two still loses the relay. Fixing
 *    that means an outbox table, i.e. a migration; the queue closes the large
 *    hole (the network) without one.
 *
 *  - **Not ordered.** BullMQ retries with backoff, so two events touching the
 *    same subject can land out of order. Every event on this queue is either a
 *    cache bust (order-free by construction — a bust carries no state) or a
 *    Telegram message (which is a log, not a state machine). Nothing here
 *    reads-modify-writes cabinet state, so ordering has nothing to break.
 */
@Injectable()
export class ReiwaRelayQueueService {
  private readonly logger = new Logger(ReiwaRelayQueueService.name);

  public constructor(
    @InjectQueue(REIWA_RELAY_QUEUE)
    private readonly queue: Queue<ReiwaRelayJobData>,
    private readonly botNotifier: BotNotifierClient,
  ) {}

  /** Whether the relay is configured at all (REIWA_URL + WEBHOOK_SECRET_HEADER). */
  public get isEnabled(): boolean {
    return this.botNotifier.isEnabled;
  }

  /**
   * Queue one relay event. Never throws — the callers are `void`-ed fanouts,
   * post-response taps and interceptors, none of which can absorb one.
   *
   * Returns whether the event was accepted for durable delivery. A `false`
   * means it was either dropped (relay unconfigured) or fell back to the old
   * single direct attempt; it never means "delivered".
   */
  public async enqueue(
    event: ReiwaRelayEvent,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.botNotifier.isEnabled) {
      // No REIWA_URL / WEBHOOK_SECRET_HEADER. Queuing would bank jobs that can
      // only fail: `disabled` is not a transient status, and nothing short of
      // a restart with new env changes it.
      return false;
    }
    const policy = RELAY_EVENT_POLICY[event];
    const eventId = typeof metadata['eventId'] === 'string' ? metadata['eventId'] : null;
    try {
      await runBullMqEnqueueWithTimeout(() =>
        this.queue.add(
          REIWA_RELAY_JOB,
          { event, metadata },
          {
            attempts: policy.attempts,
            backoff: { type: policy.backoff.type, delay: policy.backoff.delay },
            removeOnComplete: BULLMQ_RETAINED_COMPLETED_JOBS,
            // Failed jobs are the durable evidence of an exhausted relay that
            // survives the process; keep the same bound as everywhere else.
            //
            // The bound stays at the shared 100 on purpose. It was the wrong
            // knob: what made this set useless was not its size but its
            // CONTENTS — every subscriber who blocked the bot produced a
            // failed `reiwa.user.notify`, so on a platform with churn the
            // routine per-recipient outcomes churned the set continuously and
            // evicted the jobs worth reading. Any number large enough to
            // outlast that on one platform is wrong on the next. Fixed at the
            // source instead: `ReiwaRelayProcessor` COMPLETES the outcome
            // `shouldAlertOperator` excludes, so what lands here is now only
            // relays that genuinely failed the link.
            removeOnFail: BULLMQ_RETAINED_FAILED_JOBS,
            // A stable job id collapses an accidental double-enqueue of the
            // same logical event into one job. Only set where the metadata
            // already carries a per-event key the producer minted — the
            // `UserNotificationEvent` CUID, `broadcast-channel:${id}`,
            // `sysevt:...` — because that key is also what the bot dedups on,
            // so the two collapses agree. Inventing one here would key on
            // nothing and defeat the purpose.
            ...(eventId !== null ? { jobId: `${event}:${eventId}` } : {}),
          },
        ),
      );
      return true;
    } catch (err: unknown) {
      // Redis is unreachable or slow. Falling back to one direct attempt keeps
      // the floor at exactly today's behaviour instead of turning a Redis blip
      // into a silently dropped notification — the failure this change exists
      // to remove.
      this.logger.warn(
        `Relay enqueue failed for ${event} (${err instanceof Error ? err.message : String(err)}); ` +
          'falling back to a single direct attempt',
      );
      const outcome = await this.botNotifier
        .deliverRelayEvent(event, metadata)
        .catch(() => null);
      this.logger.warn(
        `Relay direct fallback for ${event}: ${outcome === null ? 'threw' : outcome.status}`,
      );
      return false;
    }
  }
}
