import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { IMPORT_QUEUE, IMPORT_JOBS } from '../imports.constants';

// ── Job Data Interfaces ─────────────────────────────────────────────────────

export interface ImportRunJobData {
  /** Import record ID (created before enqueue). */
  readonly importRecordId: string;
  /** Source type: 'remnawave' | '3xui' | 'remnashop' | 'altshop'. */
  readonly sourceType: string;
  /** Mode: 'import' (create new users) or 'sync' (update existing only). */
  readonly mode: 'import' | 'sync';
  /** Admin who initiated. */
  readonly createdBy: string;
  /**
   * For file-based imports: path to the staged file on disk.
   * For remnawave: null (data is pulled from API at processing time).
   */
  readonly stagedFilePath: string | null;
}

export interface ImportAssignPlanJobData {
  readonly importRecordId: string;
  readonly planId: string;
  readonly createdBy: string;
  readonly userIds?: string[];
  /**
   * Forwarded to BulkPlanAssignmentService. When false (default) the new
   * plan limits land in our DB but are NOT pushed to Remnawave — they
   * apply on the next renewal/upgrade through the customer flow.
   */
  readonly applyImmediately?: boolean;
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Import queue producer — stages uploaded files and enqueues import jobs.
 *
 * File staging:
 *   Uploaded files are written to `/app/data/uploads/imports/<uuid>.<ext>`
 *   so the BullMQ processor can read them later (even after container restart).
 *   The staged file is cleaned up after processing.
 */
@Injectable()
export class ImportQueueService {
  private readonly logger = new Logger(ImportQueueService.name);
  private readonly stageDir = join(
    process.env.ADMIN_UPLOADS_DIR ?? join(process.cwd(), 'data', 'uploads'),
    'imports',
  );

  public constructor(
    @InjectQueue(IMPORT_QUEUE)
    private readonly queue: Queue,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * Stage a file upload and enqueue an import job.
   * Returns the import record ID immediately (202 pattern).
   */
  public async enqueueFileImport(input: {
    sourceType: string;
    mode: 'import' | 'sync';
    createdBy: string;
    fileBuffer: Buffer;
    originalFilename: string;
  }): Promise<{ importRecordId: string; jobId: string }> {
    // Stage file to disk
    await fsp.mkdir(this.stageDir, { recursive: true });
    const ext = this.extractExtension(input.originalFilename);
    const stagedFilename = `${randomUUID()}${ext}`;
    const stagedFilePath = join(this.stageDir, stagedFilename);
    await fsp.writeFile(stagedFilePath, input.fileBuffer);

    // Create import record in DRAFT status
    const record = await this.prismaService.importRecord.create({
      data: {
        filename: input.originalFilename,
        sourceType: input.sourceType,
        status: 'DRAFT',
        recordsTotal: 0,
        recordsOk: 0,
        recordsFailed: 0,
        createdBy: input.createdBy,
      },
    });

    // Enqueue job
    const job = await this.queue.add(
      IMPORT_JOBS.RUN,
      {
        importRecordId: record.id,
        sourceType: input.sourceType,
        mode: input.mode,
        createdBy: input.createdBy,
        stagedFilePath,
      } satisfies ImportRunJobData,
      {
        attempts: 1, // imports should not auto-retry (data mutation)
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );

    this.logger.log(
      `Enqueued import job: source=${input.sourceType} file=${input.originalFilename} recordId=${record.id}`,
    );

    return { importRecordId: record.id, jobId: job.id ?? record.id };
  }

  /**
   * Enqueue a Remnawave live-API import (no file needed).
   */
  public async enqueueRemnawaveImport(input: {
    mode: 'import' | 'sync';
    createdBy: string;
  }): Promise<{ importRecordId: string; jobId: string }> {
    const record = await this.prismaService.importRecord.create({
      data: {
        filename: `remnawave-${input.mode}-${new Date().toISOString()}.json`,
        sourceType: 'remnawave',
        status: 'DRAFT',
        recordsTotal: 0,
        recordsOk: 0,
        recordsFailed: 0,
        createdBy: input.createdBy,
      },
    });

    const job = await this.queue.add(
      IMPORT_JOBS.RUN,
      {
        importRecordId: record.id,
        sourceType: 'remnawave',
        mode: input.mode,
        createdBy: input.createdBy,
        stagedFilePath: null,
      } satisfies ImportRunJobData,
      {
        attempts: 1,
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );

    this.logger.log(`Enqueued remnawave import: mode=${input.mode} recordId=${record.id}`);
    return { importRecordId: record.id, jobId: job.id ?? record.id };
  }

  /**
   * Enqueue bulk plan assignment job.
   */
  public async enqueueAssignPlan(input: ImportAssignPlanJobData): Promise<string> {
    const job = await this.queue.add(IMPORT_JOBS.ASSIGN_PLAN, input, {
      attempts: 1,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    });
    return job.id ?? input.importRecordId;
  }

  /**
   * Cancel a pending import by removing its job from the queue.
   */
  public async cancelImport(importRecordId: string): Promise<boolean> {
    const waiting = await this.queue.getJobs(['waiting', 'delayed']);
    for (const job of waiting) {
      if (job.data?.importRecordId === importRecordId) {
        await job.remove();
        await this.prismaService.importRecord.update({
          where: { id: importRecordId },
          data: { status: 'ROLLED_BACK', rolledBackAt: new Date(), errorMessage: 'Canceled by admin' },
        });
        return true;
      }
    }
    return false;
  }

  private extractExtension(filename: string): string {
    if (filename.endsWith('.tar.gz')) return '.tar.gz';
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot) : '';
  }
}
