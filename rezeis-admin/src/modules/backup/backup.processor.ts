import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { SystemEventsService, EVENT_TYPES } from '../../common/services/system-events.service';
import { CustomEmojiService } from '../custom-emoji/services/custom-emoji.service';
import { isFinalFailedAttempt, isFinalProcessorAttempt } from './backup-delivery-retry.util';
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
 * The only way to ask BullMQ for another attempt: throw.
 *
 * A distinct type because `onFailed` fires for this exactly as it fires for a
 * genuine crash, and the two need opposite treatment — the delivery path has
 * already told the operator by the time it throws for the last time, so
 * `onFailed` must stay quiet for this error and speak up for anything else.
 */
export class BackupDeliveryRetryError extends Error {
  /** Marks the operator alert as already emitted by the delivery path. */
  public readonly operatorAlerted: boolean;

  public constructor(reason: string, operatorAlerted: boolean) {
    super(`Backup Telegram delivery failed (${reason})`);
    this.name = 'BackupDeliveryRetryError';
    this.operatorAlerted = operatorAlerted;
  }
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
    private readonly customEmojiService: CustomEmojiService,
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

  private async handleRestore(job: Job<BackupRestoreJobData>): Promise<{
    success: boolean;
    migrationsApplied: boolean;
    customEmojiAssets: { recoveredEmojiCount: number; skippedPacks: number } | null;
  }> {
    const { filename, initiatedBy } = job.data;
    this.logger.log(`Starting restore from: ${filename}`);

    await job.updateProgress({ stage: 'restoring', percent: 10 });

    const success = await this.backupService.runRestore(filename);

    // Bring the schema forward to the current build. Restoring a backup from
    // an older version rolls the schema back; this re-applies the missing
    // migrations so the running app matches the data — without a restart.
    await job.updateProgress({ stage: 'migrating', percent: 70 });
    const migrationsApplied = await this.backupService.runMigrateDeploy();

    // SQL backups intentionally don't include the uploads volume. Recreate
    // custom emoji files from their Telegram source after the restored DB is
    // current. A missing/deleted source must never invalidate the DB restore.
    await job.updateProgress({ stage: 'recovering-custom-emoji-assets', percent: 85 });
    const customEmojiAssets = await this.customEmojiService.rehydrateMissingAssets().catch((err: unknown) => {
      this.logger.warn(
        `Custom emoji asset recovery after restore failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    });

    await job.updateProgress({ stage: 'completed', percent: 100 });

    this.systemEventsService.info(
      EVENT_TYPES.SYSTEM_RESTORE_COMPLETED,
      'SYSTEM',
      `Database restored from ${filename}`,
      { filename, initiatedBy, success, migrationsApplied, customEmojiAssets },
    );

    return { success, migrationsApplied, customEmojiAssets };
  }

  /**
   * The job is queued with `attempts: 3`, and BullMQ retries only a processor
   * that THROWS. This one used to return `{ delivered: false }` for every
   * failure, so those three attempts had never once fired: a four-second
   * timeout or a passing 502 left the backup local-only for good, where a
   * retry ten seconds later would very likely have landed it.
   *
   * So: throw on the failures worth repeating (see `isRetryableRelayOutcome`),
   * return on the ones that are not. The alert is emitted by the delivery path
   * itself and held back until the final attempt, which is why the attempt
   * count is passed down rather than kept here.
   */
  private async handleDeliverTelegram(job: Job<BackupDeliverTelegramJobData>): Promise<{ delivered: boolean }> {
    const { recordId, filename } = job.data;
    this.logger.log(`Delivering backup to Telegram: ${filename}`);

    await job.updateProgress({ stage: 'uploading', percent: 30 });

    const isFinalAttempt = isFinalProcessorAttempt(job);
    const outcome = await this.backupService.attemptTelegramDelivery(recordId, filename, {
      isFinalAttempt,
    });

    if (outcome.retryable) {
      // Not `updateProgress({ completed })` first: this attempt did not finish
      // the work. `operatorAlerted` is true exactly when the delivery path just
      // emitted the one alert this job is allowed, so `onFailed` stays quiet.
      throw new BackupDeliveryRetryError(outcome.reason ?? 'unknown', isFinalAttempt);
    }

    await job.updateProgress({ stage: 'completed', percent: 100 });

    return { delivered: outcome.delivered };
  }

  @OnWorkerEvent('completed')
  public onCompleted(job: Job): void {
    this.logger.log(`Backup job ${job.name} (${job.id}) completed`);
  }

  /**
   * Fires on EVERY failed attempt, not only the last: `Worker.handleFailed`
   * emits `failed` unconditionally, right after `moveToFailed` has decided
   * retry-vs-fail. Alerting from here without checking the count therefore
   * means one alert per attempt — two for `backup.create` (`attempts: 2`),
   * three for a retrying delivery. Gate on the last attempt.
   *
   * Delivery jobs belong here too, but only for failures the delivery path did
   * NOT already report: a `BackupDeliveryRetryError` thrown on the final
   * attempt has an alert of its own, naming the backup, the file and the relay
   * status — strictly more useful than a generic SYSTEM_ERROR carrying a job
   * id. Emitting both would be the same incident twice. Anything else that
   * escapes the delivery job — a Prisma outage in `loadTelegramConfig`, a
   * failing `updateProgress` — has told nobody, and is exactly what this is for.
   */
  @OnWorkerEvent('failed')
  public onFailed(job: Job, error: Error): void {
    this.logger.error(`Backup job ${job.name} (${job.id}) failed: ${error.message}`, error.stack);
    if (!isFinalFailedAttempt(job)) return;
    if (error instanceof BackupDeliveryRetryError && error.operatorAlerted) return;
    if (job.name === BACKUP_JOBS.CREATE || job.name === BACKUP_JOBS.DELIVER_TELEGRAM) {
      this.systemEventsService.error(
        EVENT_TYPES.SYSTEM_ERROR,
        'SYSTEM',
        `Backup job failed: ${error.message}`,
        { jobId: job.id, jobName: job.name, error: error.message },
      );
    }
  }
}
