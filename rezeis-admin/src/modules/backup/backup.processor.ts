import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { SystemEventsService, EVENT_TYPES } from '../../common/services/system-events.service';
import { BACKUP_QUEUE, BACKUP_JOBS } from './backup.constants';
import { BackupService } from './services/backup.service';

export interface BackupCreateJobData {
  readonly recordId: string;
  readonly filename: string;
  readonly scope: string;
  readonly initiatedBy: string | null;
}

export interface BackupRestoreJobData {
  readonly filename: string;
  readonly initiatedBy: string | null;
}

export interface BackupDeliverTelegramJobData {
  readonly recordId: string;
  readonly filename: string;
}

/**
 * BullMQ processor for backup operations.
 *
 * Jobs:
 *   - backup.create — runs pg_dump, compresses, checksums, applies retention
 *   - backup.restore — runs pg_restore from a backup file
 *   - backup.deliver-telegram — sends completed backup file to Telegram
 *
 * Concurrency 1: only one backup/restore at a time to avoid DB contention.
 */
@Processor(BACKUP_QUEUE, { concurrency: 1 })
export class BackupProcessor extends WorkerHost {
  private readonly logger = new Logger(BackupProcessor.name);

  public constructor(
    private readonly backupService: BackupService,
    private readonly systemEventsService: SystemEventsService,
  ) {
    super();
  }

  public async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case BACKUP_JOBS.CREATE:
        return this.handleCreate(job as Job<BackupCreateJobData>);
      case BACKUP_JOBS.RESTORE:
        return this.handleRestore(job as Job<BackupRestoreJobData>);
      case BACKUP_JOBS.DELIVER_TELEGRAM:
        return this.handleDeliverTelegram(job as Job<BackupDeliverTelegramJobData>);
      default:
        this.logger.warn(`Unknown backup job: ${job.name}`);
        return null;
    }
  }

  private async handleCreate(job: Job<BackupCreateJobData>): Promise<{ sizeBytes: number; checksum: string }> {
    const { recordId, filename, scope, initiatedBy } = job.data;
    this.logger.log(`Starting backup: ${filename} (scope=${scope})`);

    await job.updateProgress({ stage: 'dumping', percent: 10 });

    const result = await this.backupService.runDump(recordId, filename, scope, initiatedBy);

    await job.updateProgress({ stage: 'completed', percent: 100 });

    // Auto-deliver to Telegram if configured
    const shouldDeliver = await this.backupService.shouldDeliverToTelegram();
    if (shouldDeliver && result.sizeBytes > 0) {
      await this.backupService.enqueueDeliverTelegram(recordId, filename);
    }

    return result;
  }

  private async handleRestore(job: Job<BackupRestoreJobData>): Promise<{ success: boolean; migrationsApplied: boolean }> {
    const { filename, initiatedBy } = job.data;
    this.logger.log(`Starting restore from: ${filename}`);

    await job.updateProgress({ stage: 'restoring', percent: 10 });

    const success = await this.backupService.runRestore(filename);

    // Bring the schema forward to the current build. Restoring a backup from
    // an older version rolls the schema back; this re-applies the missing
    // migrations so the running app matches the data — without a restart.
    await job.updateProgress({ stage: 'migrating', percent: 70 });
    const migrationsApplied = await this.backupService.runMigrateDeploy();

    await job.updateProgress({ stage: 'completed', percent: 100 });

    this.systemEventsService.info(
      'system.restore_completed',
      'SYSTEM',
      `Database restored from ${filename}`,
      { filename, initiatedBy, success, migrationsApplied },
    );

    return { success, migrationsApplied };
  }

  private async handleDeliverTelegram(job: Job<BackupDeliverTelegramJobData>): Promise<{ delivered: boolean }> {
    const { recordId, filename } = job.data;
    this.logger.log(`Delivering backup to Telegram: ${filename}`);

    await job.updateProgress({ stage: 'uploading', percent: 30 });

    const delivered = await this.backupService.deliverToTelegram(recordId, filename);

    await job.updateProgress({ stage: 'completed', percent: 100 });

    return { delivered };
  }

  @OnWorkerEvent('completed')
  public onCompleted(job: Job): void {
    this.logger.log(`Backup job ${job.name} (${job.id}) completed`);
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job, error: Error): void {
    this.logger.error(`Backup job ${job.name} (${job.id}) failed: ${error.message}`, error.stack);
    if (job.name === BACKUP_JOBS.CREATE) {
      this.systemEventsService.error(
        EVENT_TYPES.SYSTEM_ERROR,
        'SYSTEM',
        `Backup job failed: ${error.message}`,
        { jobId: job.id, jobName: job.name, error: error.message },
      );
    }
  }
}
