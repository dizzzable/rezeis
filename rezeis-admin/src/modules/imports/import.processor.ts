import { promises as fsp } from 'node:fs';

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ImportStatus } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemEventsService } from '../../common/services/system-events.service';
import { IMPORT_QUEUE, IMPORT_JOBS } from './imports.constants';
import { AltshopImporterService } from './services/altshop-importer.service';
import { BulkPlanAssignmentService } from './services/bulk-plan-assignment.service';
import {
  type ImportAssignPlanJobData,
  type ImportRunJobData,
} from './services/import-queue.service';
import { RemnashopImporterService } from './services/remnashop-importer.service';
import { RemnawaveImporterService } from './services/remnawave-importer.service';
import { ThreeXuiImporterService } from './services/threexui-importer.service';
import { parseAltshopBackup } from './utils/altshop-backup-parser';
import { parseRemnashopBackup } from './utils/remnashop-backup-parser';
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
    private readonly bulkPlanAssignmentService: BulkPlanAssignmentService,
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
    const { importRecordId, sourceType, mode, createdBy, stagedFilePath } = job.data;
    this.logger.log(`Processing import: source=${sourceType} mode=${mode} record=${importRecordId}`);

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
          result = await this.remnawaveImporterService.run({ mode, createdBy });
          break;

        case '3xui': {
          if (!stagedFilePath) throw new Error('Staged file path missing for 3xui import');
          const buffer = await fsp.readFile(stagedFilePath);
          const clients = parseThreeXuiBackup(buffer);
          await job.updateProgress({ stage: 'parsed', percent: 20, records: clients.length });
          result = await this.threexuiImporterService.run({ mode, createdBy, clients });
          break;
        }

        case 'remnashop': {
          if (!stagedFilePath) throw new Error('Staged file path missing for remnashop import');
          const buffer = await fsp.readFile(stagedFilePath);
          const { users, subscriptions } = await parseRemnashopBackup(buffer);
          await job.updateProgress({ stage: 'parsed', percent: 20, records: users.length });
          result = await this.remnashopImporterService.run({ mode, createdBy, users, subscriptions });
          break;
        }

        case 'altshop': {
          if (!stagedFilePath) throw new Error('Staged file path missing for altshop import');
          const buffer = await fsp.readFile(stagedFilePath);
          const { users, subscriptions, transactions } = await parseAltshopBackup(buffer);
          await job.updateProgress({ stage: 'parsed', percent: 20, records: users.length });
          result = await this.altshopImporterService.run({ mode, createdBy, users, subscriptions, transactions });
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
        await fsp.unlink(stagedFilePath).catch(() => undefined);
      }
    }
  }

  private async handleAssignPlan(job: Job<ImportAssignPlanJobData>): Promise<unknown> {
    const { importRecordId, planId, createdBy, userIds, applyImmediately } = job.data;
    this.logger.log(`Processing bulk plan assignment: plan=${planId} import=${importRecordId} applyImmediately=${applyImmediately === true}`);

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
