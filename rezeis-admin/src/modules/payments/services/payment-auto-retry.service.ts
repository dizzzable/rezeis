import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import {
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
} from '../constants/payment-reconciliation.constant';
import { dueForAutoRetryWhere } from '../utils/payment-webhook-auto-retry.util';

/** How many due events one pass queues. */
export const AUTO_RETRY_BATCH = 20;

/**
 * Automatic retry for failed payment webhook events.
 *
 * Every 5 minutes, the FAILED events whose next run is due are run again —
 * due by the ladder the event climbs (`payment-webhook-auto-retry.util.ts`):
 *   - every event but a dispute: 5 min after the first failure, 15 min after
 *     the second, and no more (3 runs);
 *   - a Platega dispute (chargeback) of an autopay charge: ten retries over
 *     about three days, because its handling asks Platega first and a
 *     chargeback must not wait for a person while Platega is down.
 * An event that never ran (its enqueue failed) is due at once. After the last
 * run the event stays FAILED for «Платежи» → «Вебхуки» → «Повторить».
 *
 * Due is decided here, in the query, and the job is queued to run now: the
 * ladder used to be a delay put on the job, so with days-long waits a batch
 * would fill with events already waiting in the queue and hold up the ones
 * behind them. The oldest failures go first.
 */
@Injectable()
export class PaymentAutoRetryService {
  private readonly logger = new Logger(PaymentAutoRetryService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE)
    private readonly reconciliationQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'payment-auto-retry' })
  public async retryFailedWebhooks(): Promise<void> {
    if (!shouldRunSchedules()) return;

    const failedEvents = await this.prismaService.paymentWebhookEvent.findMany({
      where: dueForAutoRetryWhere(new Date()),
      select: { id: true, reconciliationAttempts: true },
      orderBy: [{ lastTransitionAt: 'asc' }, { id: 'asc' }],
      take: AUTO_RETRY_BATCH,
    });

    if (failedEvents.length === 0) return;

    let enqueued = 0;
    for (const event of failedEvents) {
      await this.reconciliationQueue.add(
        PAYMENT_RECONCILIATION_JOB,
        { eventId: event.id },
        {
          attempts: 1,
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 604_800 },
          // One job per run: a pass that finds the event again before its job
          // has started queues nothing more.
          jobId: `auto-retry-${event.id}-${event.reconciliationAttempts + 1}`,
        },
      );
      enqueued++;
    }

    if (enqueued > 0) {
      this.logger.log(`Auto-retry: enqueued ${enqueued} failed payment webhooks`);
    }
  }
}
