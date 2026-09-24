import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { ADD_ON_EXPIRY_NOTICE_QUEUE, ADD_ON_EXPIRY_NOTICE_TICK_JOB } from './addon-expiry-notice.constants';
import { AddOnExpiryNoticeService } from './services/addon-expiry-notice.service';

/**
 * Concurrency 1, and only ever one job to run: the pass's id is fixed (see
 * `ADD_ON_EXPIRY_NOTICE_JOB_ID`). A pass that throws is not retried here
 * (`attempts: 1`) — the next cron queues a fresh one, and every notice the
 * failed pass decided is already recorded.
 */
@Processor(ADD_ON_EXPIRY_NOTICE_QUEUE, { concurrency: 1 })
export class AddOnExpiryNoticeProcessor extends WorkerHost {
  private readonly logger = new Logger(AddOnExpiryNoticeProcessor.name);

  public constructor(private readonly notices: AddOnExpiryNoticeService) {
    super();
  }

  public async process(job: Job): Promise<void> {
    if (job.name !== ADD_ON_EXPIRY_NOTICE_TICK_JOB) {
      this.logger.warn(`Unknown add-on notice job: ${job.name}`);
      return;
    }
    await this.notices.runTick();
  }
}
