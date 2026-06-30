import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import {
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
}
