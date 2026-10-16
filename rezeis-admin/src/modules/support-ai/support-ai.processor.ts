import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { SUPPORT_AI_JOBS, SUPPORT_AI_QUEUE, type SupportAiReplyJob } from '../support-tickets/support-ai.constants';
import { SupportAiResponderService, type SupportAiOutcome } from './support-ai-responder.service';

/**
 * The AI assistant's worker: one job, one answer to one client message.
 *
 * Concurrency 2: an answer is a few seconds of waiting on the provider, and
 * two at once keeps a burst of tickets moving without running up the
 * operator's bill faster than a person could notice.
 */
@Processor(SUPPORT_AI_QUEUE, { concurrency: 2 })
export class SupportAiProcessor extends WorkerHost {
  private readonly logger = new Logger(SupportAiProcessor.name);

  public constructor(private readonly responder: SupportAiResponderService) {
    super();
  }

  public async process(job: Job<SupportAiReplyJob>): Promise<SupportAiOutcome | null> {
    if (job.name !== SUPPORT_AI_JOBS.REPLY) {
      this.logger.warn(`Unknown support-ai job: ${job.name}`);
      return null;
    }
    return this.responder.answer(job.data);
  }

  /**
   * The last attempt failed: hand the thread over so a person answers. An
   * earlier attempt's failure is BullMQ's to retry.
   */
  @OnWorkerEvent('failed')
  public onFailed(job: Job<SupportAiReplyJob> | undefined, error: Error): void {
    if (job === undefined) return;
    this.logger.warn(`AI answer for ticket ${job.data.ticketId} failed (attempt ${job.attemptsMade}): ${error.message}`);
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    void this.responder.giveUp(job.data).catch((err: unknown) => {
      this.logger.error(
        `AI hand-over after failure did not land for ticket ${job.data.ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
}
