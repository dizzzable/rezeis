import { Logger } from '@nestjs/common';
import { Queue, Job, JobsOptions, BulkJobOptions } from 'bullmq';

/**
 * Abstract base class for BullMQ queue services.
 * Inspired by remnawave backend-main AbstractQueueService.
 *
 * Provides: connection check, event listeners, job add/bulk, drain, pause/resume.
 */
export abstract class AbstractQueueService {
  protected readonly logger: Logger;

  abstract get queue(): Queue;

  constructor(loggerContext: string) {
    this.logger = new Logger(loggerContext);
  }

  protected async checkConnection(): Promise<void> {
    const client = await this.queue.client;
    if (client.status !== 'ready') {
      const msg = `Queue "${this.queue.name}" is not connected. Status: [${client.status.toUpperCase()}]`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    this.logger.log(`Queue "${this.queue.name}" connected.`);
  }

  protected initEventListeners(): void {
    this.queue.on('error', (error: Error) => {
      this.logger.error(`Queue error: [${error.message}]`);
    });
  }

  protected async addJob<TData, TResult>(
    name: string,
    data: TData,
    options?: JobsOptions,
  ): Promise<Job<TData, TResult>> {
    return this.queue.add(name, data, options);
  }

  protected async addBulk<TData, TResult>(
    jobs: Array<{ name: string; data: TData; options?: BulkJobOptions }>,
  ): Promise<Array<Job<TData, TResult, string>>> {
    return this.queue.addBulk(jobs);
  }

  protected async drain(delayed?: boolean): Promise<void> {
    return this.queue.drain(delayed);
  }

  protected async pauseQueue(): Promise<void> {
    return this.queue.pause();
  }

  protected async resumeQueue(): Promise<void> {
    return this.queue.resume();
  }

  protected async closeQueue(): Promise<void> {
    return this.queue.close();
  }

  protected async obliterate(options?: { force: boolean }): Promise<void> {
    return this.queue.obliterate(options);
  }
}
