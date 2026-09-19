import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import {
  MOY_NALOG_CANCEL_INCOME_ATTEMPTS,
  MOY_NALOG_CANCEL_INCOME_BACKOFF_MS,
  MOY_NALOG_JOBS,
  MOY_NALOG_QUEUE,
  MOY_NALOG_REGISTER_INCOME_ATTEMPTS,
  MOY_NALOG_REGISTER_INCOME_BACKOFF_MS,
} from '../constants/moy-nalog.constant';

/**
 * Enqueues «Мой Налог» income-registration jobs. The job is best-effort and
 * idempotent (the processor skips transactions that already carry a receipt
 * uuid), so a retained finished job with the same id is safe.
 */
@Injectable()
export class MoyNalogQueueService {
  private readonly logger = new Logger(MoyNalogQueueService.name);

  public constructor(
    @InjectQueue(MOY_NALOG_QUEUE)
    private readonly queue: Queue,
  ) {}

  public async enqueueRegisterIncome(transactionId: string): Promise<void> {
    await this.queue.add(
      MOY_NALOG_JOBS.REGISTER_INCOME,
      { transactionId },
      {
        jobId: `moy_nalog_income_${transactionId}`,
        attempts: MOY_NALOG_REGISTER_INCOME_ATTEMPTS,
        backoff: { type: 'exponential', delay: MOY_NALOG_REGISTER_INCOME_BACKOFF_MS },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
    this.logger.debug(`Enqueued МойНалог income registration for transaction ${transactionId}`);
  }

  /**
   * Enqueues a «Мой Налог» income CANCELLATION for a refunded / charged-back
   * transaction. Idempotent: the processor no-ops when the transaction has no
   * stored receipt uuid or is already cancelled, so a retained finished job
   * with the same id is safe.
   */
  public async enqueueCancelIncome(transactionId: string): Promise<void> {
    await this.queue.add(
      MOY_NALOG_JOBS.CANCEL_INCOME,
      { transactionId },
      {
        jobId: `moy_nalog_cancel_${transactionId}`,
        attempts: MOY_NALOG_CANCEL_INCOME_ATTEMPTS,
        backoff: { type: 'exponential', delay: MOY_NALOG_CANCEL_INCOME_BACKOFF_MS },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
    this.logger.debug(`Enqueued МойНалог income cancellation for transaction ${transactionId}`);
  }

  /**
   * The cancellation of a receipt the registration job recorded AFTER the
   * refund's own cancellation had already run and found nothing to cancel.
   * Its own job id for that reason: the refund's job is finished and kept, so
   * enqueueing its id again would be dropped. The processor's guards make the
   * two jobs safe to overlap — whichever runs second finds the receipt
   * cancelled.
   */
  public async enqueueCancelIncomeAfterRegistration(transactionId: string): Promise<void> {
    await this.queue.add(
      MOY_NALOG_JOBS.CANCEL_INCOME,
      { transactionId },
      {
        jobId: `moy_nalog_cancel_${transactionId}_after_registration`,
        attempts: MOY_NALOG_CANCEL_INCOME_ATTEMPTS,
        backoff: { type: 'exponential', delay: MOY_NALOG_CANCEL_INCOME_BACKOFF_MS },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
    this.logger.debug(`Enqueued МойНалог income cancellation after registration for transaction ${transactionId}`);
  }
}
