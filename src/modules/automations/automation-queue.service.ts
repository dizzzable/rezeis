import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';

import { AbstractQueueService } from '../../common/queue/abstract-queue.service';
import {
  buildBoundedBullMqDefaultJobOptions,
  runBullMqEnqueueWithTimeout,
} from '../../common/queue/bullmq-enqueue-options';
import {
  AUTOMATION_JOB_NAMES,
  AUTOMATION_QUEUE,
} from './automations.constants';

export interface AutomationJobData {
  readonly ruleId: string;
  /** Human-friendly trigger label persisted on the execution row. */
  readonly trigger: string;
  /** Trigger payload — projected against rule conditions and actions. */
  readonly triggerData: Readonly<Record<string, unknown>>;
}

/**
 * Lightweight queue facade for the automation engine.
 *
 * Each job is one rule × one trigger fire. Splitting them per-rule keeps
 * BullMQ retries and timing isolated: a slow webhook on rule #3 doesn't
 * delay rule #4's notify.
 */
@Injectable()
export class AutomationQueueService extends AbstractQueueService implements OnModuleInit {
  public constructor(
    @InjectQueue(AUTOMATION_QUEUE)
    private readonly automationQueue: Queue<AutomationJobData>,
  ) {
    super(AutomationQueueService.name);
  }

  public override get queue(): Queue<AutomationJobData> {
    return this.automationQueue;
  }

  public async onModuleInit(): Promise<void> {
    this.initEventListeners();
  }

  public async enqueueExecution(data: AutomationJobData): Promise<void> {
    await runBullMqEnqueueWithTimeout(() =>
      this.automationQueue.add(
        AUTOMATION_JOB_NAMES.EXECUTE_RULE,
        data,
        buildBoundedBullMqDefaultJobOptions(),
      ),
    );
  }
}
