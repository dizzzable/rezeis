import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PLAN_MIGRATION_QUEUE, PLAN_MIGRATION_TICK_JOB } from './plan-migration.constants';
import { PlanMigrationRunnerService, type PlanMigrationTickJobData } from './plan-migration-runner.service';

/**
 * Concurrency 1: a tick is a loop of short transactions on one run, and two
 * runs of different plans in parallel buy nothing an operator waits for while
 * doubling the lock traffic on `subscriptions`. A tick that throws is retried
 * by BullMQ; everything it did before the throw is committed per item.
 */
@Processor(PLAN_MIGRATION_QUEUE, { concurrency: 1 })
export class PlanMigrationProcessor extends WorkerHost {
  private readonly logger = new Logger(PlanMigrationProcessor.name);

  public constructor(private readonly runner: PlanMigrationRunnerService) {
    super();
  }

  public async process(job: Job<PlanMigrationTickJobData>): Promise<void> {
    if (job.name !== PLAN_MIGRATION_TICK_JOB) {
      this.logger.warn(`Unknown plan migration job: ${job.name}`);
      return;
    }
    await this.runner.processTick(job.data.runId);
  }
}
