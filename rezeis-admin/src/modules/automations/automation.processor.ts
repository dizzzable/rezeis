import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { AutomationExecutorService } from './automation-executor.service';
import { AutomationJobData } from './automation-queue.service';
import { AUTOMATION_QUEUE } from './automations.constants';

/**
 * BullMQ processor wrapper around `AutomationExecutorService.executeJob`.
 *
 * The executor is also called synchronously from
 * `AutomationsService.runManually()` so live operator clicks bypass the
 * queue entirely (acceptable: manual runs are user-initiated and the
 * round-trip should feel instantaneous).
 */
@Processor(AUTOMATION_QUEUE)
export class AutomationProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationProcessor.name);

  public constructor(private readonly executorService: AutomationExecutorService) {
    super();
  }

  public async process(job: Job<AutomationJobData>): Promise<void> {
    try {
      await this.executorService.executeJob(job.data);
    } catch (err) {
      this.logger.error(
        `Automation job ${job.id} crashed: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
