import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { ADD_ON_CUTOVER_QUEUE, ADD_ON_CUTOVER_TICK_JOB } from './add-on-cutover.constants';
import { EntitlementCutoverJobService } from './services/entitlement-cutover-job.service';

/**
 * Concurrency 1, and only ever one job to run: the tick's id is fixed, so a
 * second tick cannot exist while one does (see `ADD_ON_CUTOVER_JOB_ID`). A
 * tick that throws is not retried here (`attempts: 1`) — the next cron queues
 * a fresh one, and everything the failed one finished is already committed
 * per subscription.
 */
@Processor(ADD_ON_CUTOVER_QUEUE, { concurrency: 1 })
export class EntitlementCutoverProcessor extends WorkerHost {
  private readonly logger = new Logger(EntitlementCutoverProcessor.name);

  public constructor(private readonly jobService: EntitlementCutoverJobService) {
    super();
  }

  public async process(job: Job): Promise<void> {
    if (job.name !== ADD_ON_CUTOVER_TICK_JOB) {
      this.logger.warn(`Unknown add-on cutover job: ${job.name}`);
      return;
    }
    await this.jobService.runTick();
  }
}
