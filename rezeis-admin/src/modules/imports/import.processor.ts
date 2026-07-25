import { promises as fsp } from 'node:fs';

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ImportStatus, Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemEventsService } from '../../common/services/system-events.service';
import { ProfileSyncQueueService } from '../profile-sync/profile-sync-queue.service';
import { IMPORT_QUEUE, IMPORT_JOBS } from './imports.constants';
import { AltshopImporterService } from './services/altshop-importer.service';
import { BulkPlanAssignmentService } from './services/bulk-plan-assignment.service';
import {
  type ImportAssignPlanJobData,
  type ImportRunJobData,
} from './services/import-queue.service';
import { RemnashopImporterService } from './services/remnashop-importer.service';
import { RemnawaveImporterService } from './services/remnawave-importer.service';
import { StealthnetImporterService } from './services/stealthnet-importer.service';
import { ThreeXuiImporterService } from './services/threexui-importer.service';
import { parseAltshopBackup } from './utils/altshop-backup-parser';
import { parseRemnashopBackup } from './utils/remnashop-backup-parser';
import { parseStealthnetBackup } from './utils/stealthnet-backup-parser';
import { parseThreeXuiBackup } from './utils/threexui-backup-parser';

/**
 * BullMQ processor for import operations.
 *
 * Handles:
 *   - import.run — executes the actual import (file parse + DB writes)
 *   - import.assign-plan — bulk plan assignment post-import
 *
 * Concurrency 1: imports are heavy DB operations, running one at a time
 * prevents lock contention and keeps progress reporting accurate.
 */
@Processor(IMPORT_QUEUE, { concurrency: 1 })
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly systemEventsService: SystemEventsService,
    private readonly remnawaveImporterService: RemnawaveImporterService,
    private readonly threexuiImporterService: ThreeXuiImporterService,
    private readonly remnashopImporterService: RemnashopImporterService,
    private readonly altshopImporterService: AltshopImporterService,
    private readonly stealthnetImporterService: StealthnetImporterService,
    private readonly bulkPlanAssignmentService: BulkPlanAssignmentService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
  ) {
    super();
  }

  public async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case IMPORT_JOBS.RUN:
        return this.handleRun(job as Job<ImportRunJobData>);
      case IMPORT_JOBS.ASSIGN_PLAN:
        return this.handleAssignPlan(job as Job<ImportAssignPlanJobData>);
      default:
        this.logger.warn(`Unknown import job: ${job.name}`);
        return null;
    }
  }

  private async handleRun(job: Job<ImportRunJobData>): Promise<unknown> {
    const { importRecordId, sourceType, mode, createdBy, stagedFilePath, balanceToPoints } =
      job.data;
    this.logger.log(
      `Processing import: source=${sourceType} mode=${mode} record=${importRecordId}`,
    );

    // Mark as PROCESSING (custom status — we'll use DRY_RUN as "in progress")
    await this.prismaService.importRecord.update({
      where: { id: importRecordId },
      data: { status: ImportStatus.DRY_RUN },
    });

    await job.updateProgress({ stage: 'processing', percent: 5 });

    try {
      let result: unknown;

      switch (sourceType) {
        case 'remnawave':
          result = await this.remnawaveImporterService.run({ mode, createdBy, importRecordId });
          break;

        case '3xui': {
          if (!stagedFilePath) throw new Error('Staged file path missing for 3xui import');
          const buffer = await fsp.readFile(stagedFilePath);
          const clients = parseThreeXuiBackup(buffer);
          await job.updateProgress({ stage: 'parsed', percent: 20, records: clients.length });
          result = await this.threexuiImporterService.run({
            mode,
            createdBy,
            clients,
            importRecordId,
          });
          break;
        }

        case 'remnashop': {
          if (!stagedFilePath) throw new Error('Staged file path missing for remnashop import');
          const buffer = await fsp.readFile(stagedFilePath);
          const {
            users,
            subscriptions,
            transactions,
            referrals,
            referralRewards,
            excludedData,
            plans,
            planDurations,
            planPrices,
          } = await parseRemnashopBackup(buffer);
          await job.updateProgress({ stage: 'parsed', percent: 20, records: users.length });
          result = await this.remnashopImporterService.run({
            mode,
            createdBy,
            users,
            subscriptions,
            transactions,
            referrals,
            referralRewards,
            excludedData,
            importRecordId,
            plans,
            planDurations,
            planPrices,
          });
          break;
        }

        case 'altshop': {
          if (!stagedFilePath) throw new Error('Staged file path missing for altshop import');
          const buffer = await fsp.readFile(stagedFilePath);
          const {
            users,
            subscriptions,
            transactions,
            webAccounts,
            referrals,
            referralRewards,
            partners,
            partnerReferrals,
            partnerTransactions,
            excludedData,
            plans,
            planDurations,
            planPrices,
          } = await parseAltshopBackup(buffer);
          await job.updateProgress({ stage: 'parsed', percent: 20, records: users.length });
          result = await this.altshopImporterService.run({
            mode,
            createdBy,
            users,
            subscriptions,
            transactions,
            webAccounts,
            referrals,
            referralRewards,
            partners,
            partnerReferrals,
            partnerTransactions,
            excludedData,
            importRecordId,
            plans,
            planDurations,
            planPrices,
          });
          break;
        }

        case 'stealthnet': {
          if (!stagedFilePath) throw new Error('Staged file path missing for stealthnet import');
          const buffer = await fsp.readFile(stagedFilePath);
          const {
            clients,
            subscriptions,
            tariffs,
            tariffCategories,
            tariffPriceOptions,
            payments,
            referralCredits,
          } = await parseStealthnetBackup(buffer);
          await job.updateProgress({ stage: 'parsed', percent: 20, records: clients.length });
          result = await this.stealthnetImporterService.run({
            mode,
            createdBy,
            importRecordId,
            clients,
            subscriptions,
            tariffs,
            tariffCategories,
            tariffPriceOptions,
            payments,
            referralCredits,
            ...(balanceToPoints ? { balanceToPoints } : {}),
          });
          break;
        }

        default:
          throw new Error(`Unknown source type: ${sourceType}`);
      }

      await job.updateProgress({ stage: 'completed', percent: 100 });

      // Emit realtime event
      this.systemEventsService.info(
        'import.completed',
        'SYSTEM',
        `Import completed: ${sourceType} (${mode})`,
        { importRecordId, sourceType, mode, result },
      );

      // Optional post-import reconciliation: file imports only READ from the
      // panel by default. When the operator opted in (`syncToPanel`), push every
      // subscription this import touched back to Remnawave so the panel reflects
      // the imported state (UPDATE linked profiles, CREATE unlinked ones).
      // Strictly best-effort: the import itself has already committed with a
      // terminal status + result. A post-sync failure must NEVER fall through to
      // handleRun's outer catch and flip that COMMITTED record to FAILED — isolate
      // it here. Any left-behind PENDING sync job is reconciled by the sweep.
      if (job.data.syncToPanel === true) {
        try {
          await this.enqueuePostImportSync(importRecordId, sourceType, mode);
        } catch (syncErr) {
          this.logger.error(
            `Post-import sync failed for import ${importRecordId} (import itself succeeded; sweep will reconcile): ${
              (syncErr as Error).message
            }`,
          );
        }
      }

      return result;
    } catch (err) {
      const message = (err as Error).message;

      // Mark import as FAILED
      await this.prismaService.importRecord.update({
        where: { id: importRecordId },
        data: { status: ImportStatus.FAILED, errorMessage: message.slice(0, 1000) },
      });

      this.systemEventsService.error(
        'import.failed',
        'SYSTEM',
        `Import failed: ${sourceType} — ${message}`,
        { importRecordId, sourceType, mode, error: message },
      );

      throw err;
    } finally {
      // Cleanup staged file
      if (stagedFilePath) {
        await fsp.unlink(stagedFilePath).catch((): void => undefined);
      }
    }
  }

  /**
   * Enqueues a profile-sync for every subscription produced by this import so
   * the operator's opt-in "sync to panel after import" reconciles Remnawave.
   *
   * Targets subscriptions by the durable `planSnapshot.importRecordId` stamp
   * (the same stamp `BulkPlanAssignmentService.resolveUserIds` uses), so it hits
   * EXACTLY this import's rows. Linked profiles → UPDATE, unlinked → CREATE.
   * Best-effort per row: a failed enqueue is logged and the periodic
   * profile-sync sweep re-drives the PENDING job, so one bad enqueue never
   * aborts the rest.
   */
  private async enqueuePostImportSync(
    importRecordId: string,
    sourceType: string,
    mode: 'import' | 'sync',
  ): Promise<void> {
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        planSnapshot: { path: ['importRecordId'], equals: importRecordId },
        NOT: { status: SubscriptionStatus.DELETED },
      },
      select: { id: true, remnawaveId: true },
    });

    let enqueued = 0;
    let skipped = 0;
    for (const subscription of subscriptions) {
      try {
        // Some importers already enqueue a CREATE for freshly-provisioned rows
        // (e.g. 3x-ui for new ACTIVE subs). Skip any subscription that still has
        // an un-finished sync job so we never queue a duplicate CREATE that would
        // race the first one into a spurious "duplicate username" FAILED.
        const pending = await this.prismaService.profileSyncJob.findFirst({
          where: {
            subscriptionId: subscription.id,
            status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
          },
          select: { id: true },
        });
        if (pending) {
          skipped += 1;
          continue;
        }

        const syncJob = await this.prismaService.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            payload: { source: 'IMPORT_SYNC', importRecordId } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        await this.profileSyncQueueService.enqueue(syncJob.id);
        enqueued += 1;
      } catch (err) {
        this.logger.warn(
          `Post-import sync enqueue failed for subscription ${subscription.id} (sweep will retry): ${
            (err as Error).message
          }`,
        );
      }
    }

    this.logger.log(
      `Post-import sync: enqueued ${enqueued}/${subscriptions.length} profile-sync job(s) for import ${importRecordId}` +
        (skipped > 0 ? ` (${skipped} skipped — already had an in-flight sync job)` : ''),
    );
    this.systemEventsService.info(
      'import.sync_enqueued',
      'SYSTEM',
      `Post-import Remnawave sync enqueued: ${enqueued} subscription(s)`,
      { importRecordId, sourceType, mode, enqueued, skipped, total: subscriptions.length },
    );
  }

  private async handleAssignPlan(job: Job<ImportAssignPlanJobData>): Promise<unknown> {
    const { importRecordId, planId, createdBy, userIds, applyImmediately } = job.data;
    this.logger.log(
      `Processing bulk plan assignment: plan=${planId} import=${importRecordId} applyImmediately=${applyImmediately === true}`,
    );

    await job.updateProgress({ stage: 'assigning', percent: 10 });

    const result = await this.bulkPlanAssignmentService.assignPlan({
      planId,
      importRecordId,
      userIds,
      createdBy,
      applyImmediately: applyImmediately === true,
    });

    await job.updateProgress({ stage: 'completed', percent: 100 });

    this.systemEventsService.info(
      'import.plan_assigned',
      'SYSTEM',
      `Bulk plan assignment: ${result.updated} updated`,
      { importRecordId, planId, ...result },
    );

    return result;
  }

  @OnWorkerEvent('completed')
  public onCompleted(job: Job): void {
    this.logger.log(`Import job ${job.name} (${job.id}) completed`);
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job, error: Error): void {
    this.logger.error(`Import job ${job.name} (${job.id}) failed: ${error.message}`, error.stack);
  }
}
