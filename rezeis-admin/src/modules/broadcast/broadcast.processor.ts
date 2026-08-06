import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { BROADCAST_DELIVERY_QUEUE, BROADCAST_JOBS } from './broadcast.constants';
import { BroadcastDeliveryService } from './services/broadcast-delivery.service';
import {
  BroadcastQueueService,
  type BroadcastBatchJobData,
  type BroadcastDeleteJobData,
  type BroadcastEditJobData,
  type BroadcastRetryJobData,
  type BroadcastStartJobData,
} from './services/broadcast-queue.service';

/**
 * BullMQ processor for all broadcast operations.
 *
 * Job types:
 *   - broadcast.start         — stage recipients, split into batch jobs
 *   - broadcast.deliver-batch — send a batch to Telegram (text/photo/video)
 *   - broadcast.edit-batch    — edit sent messages (editMessageText/Caption)
 *   - broadcast.delete-batch  — delete sent messages (deleteMessage)
 *   - broadcast.retry-failed  — retry previously failed messages
 *
 * Concurrency 2: allows parallel broadcasts without overwhelming Telegram.
 */
@Processor(BROADCAST_DELIVERY_QUEUE, { concurrency: 2 })
export class BroadcastProcessor extends WorkerHost {
  private readonly logger = new Logger(BroadcastProcessor.name);

  public constructor(
    private readonly broadcastDeliveryService: BroadcastDeliveryService,
    private readonly broadcastQueueService: BroadcastQueueService,
    private readonly systemEventsService: SystemEventsService,
  ) {
    super();
  }

  public async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case BROADCAST_JOBS.START:
        return this.handleStart(job as Job<BroadcastStartJobData>);
      case BROADCAST_JOBS.DELIVER_BATCH:
        return this.handleBatch(job as Job<BroadcastBatchJobData>);
      case BROADCAST_JOBS.EDIT_BATCH:
        return this.handleEdit(job as Job<BroadcastEditJobData>);
      case BROADCAST_JOBS.DELETE_BATCH:
        return this.handleDelete(job as Job<BroadcastDeleteJobData>);
      case BROADCAST_JOBS.RETRY_FAILED:
        return this.handleRetry(job as Job<BroadcastRetryJobData>);
      default:
        this.logger.warn(`Unknown broadcast job: ${job.name}`);
        return null;
    }
  }

  private async handleStart(job: Job<BroadcastStartJobData>): Promise<{ batches: number }> {
    const { broadcastId } = job.data;
    this.logger.log(`Starting broadcast: ${broadcastId}`);

    const messageIds = await this.broadcastDeliveryService.stageRecipients(broadcastId);
    if (messageIds.length === 0) {
      return { batches: 0 };
    }

    const BATCH_SIZE = 50;
    let batchCount = 0;
    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      await this.broadcastQueueService.enqueueBatch({ broadcastId, messageIds: batch });
      batchCount++;
    }

    this.logger.log(`Broadcast ${broadcastId}: ${messageIds.length} messages → ${batchCount} batches`);

    // Emit progress event for admin realtime
    this.systemEventsService.info(
      EVENT_TYPES.BROADCAST_STARTED,
      'SYSTEM',
      `Broadcast delivery started: ${messageIds.length} recipients in ${batchCount} batches`,
      { broadcastId, totalMessages: messageIds.length, batches: batchCount },
    );

    return { batches: batchCount };
  }

  private async handleBatch(job: Job<BroadcastBatchJobData>): Promise<{ sent: number; failed: number }> {
    const { broadcastId, messageIds } = job.data;
    const result = await this.broadcastDeliveryService.deliverBatch(broadcastId, messageIds);
    await job.updateProgress({ sent: result.sent, failed: result.failed, total: messageIds.length });

    // Emit progress for realtime dashboard
    this.systemEventsService.info(
      EVENT_TYPES.BROADCAST_BATCH_COMPLETED,
      'SYSTEM',
      `Batch: ${result.sent} sent, ${result.failed} failed`,
      { broadcastId, ...result, batchSize: messageIds.length },
    );

    return result;
  }

  private async handleEdit(job: Job<BroadcastEditJobData>): Promise<{ edited: number; failed: number }> {
    const { broadcastId, messageIds, newText, parseMode } = job.data;
    const result = await this.broadcastDeliveryService.editBatch(broadcastId, messageIds, newText, parseMode);
    await job.updateProgress({ edited: result.edited, failed: result.failed, total: messageIds.length });
    return result;
  }

  private async handleDelete(job: Job<BroadcastDeleteJobData>): Promise<{ deleted: number; failed: number }> {
    const { broadcastId, messageIds } = job.data;
    const result = await this.broadcastDeliveryService.deleteBatch(broadcastId, messageIds);
    await job.updateProgress({ deleted: result.deleted, failed: result.failed, total: messageIds.length });
    return result;
  }

  private async handleRetry(job: Job<BroadcastRetryJobData>): Promise<{ sent: number; failed: number }> {
    const { broadcastId, messageIds } = job.data;
    const result = await this.broadcastDeliveryService.retryBatch(broadcastId, messageIds);
    await job.updateProgress({ sent: result.sent, failed: result.failed, total: messageIds.length });
    return result;
  }

  @OnWorkerEvent('completed')
  public onCompleted(job: Job): void {
    this.logger.debug(`Job ${job.name} (${job.id}) completed`);
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job, error: Error): void {
    this.logger.error(`Job ${job.name} (${job.id}) failed: ${error.message}`, error.stack);
  }
}
