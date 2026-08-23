import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
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
  /**
   * STEALTHNET only: convert each imported user's leftover wallet balance
   * into loyalty points on CREATE. Ignored by other sources.
   */
  readonly balanceToPoints?: { readonly enabled: boolean; readonly rate: number };
  /**
   * File imports only: after a successful import, enqueue a profile-sync for
   * every subscription this import touched (UPDATE for linked profiles, CREATE
   * for unlinked ones) so panel state is reconciled. OFF by default — imports
   * normally only READ from the panel. See `ImportProcessor.enqueuePostImportSync`.
   */
  readonly syncToPanel?: boolean;
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

// ── File staging location ───────────────────────────────────────────────────

/**
 * The directory `main.ts` hands to `express.static` under the `/uploads`
 * prefix. Reproduced here (identically) so `resolveImportStageDir` can be
 * proven to land OUTSIDE it.
 */
function resolveServedUploadsRoot(): string {
  const fromEnv = process.env.ADMIN_UPLOADS_DIR;
  if (fromEnv && fromEnv.trim().length > 0) {
    return resolve(fromEnv);
  }
  return resolve(process.cwd(), 'data', 'uploads');
}

/**
 * Where uploaded import files are staged for the worker to pick up.
 *
 * This used to be `<uploadsRoot>/imports`, i.e. the SAME expression the static
 * handler uses for its root — so every staged file was served, unauthenticated
 * and outside every Nest guard, at `/uploads/imports/<uuid><ext>`. The staged
 * files are 3x-ui SQLite databases, Remnashop/AltShop backups and `pg_dump`
 * SQL dumps of a competitor's customer table; a leaked UUID was the only thing
 * between them and the internet.
 *
 * It is now a SIBLING of the served root — `<uploadsRoot>/../import-staging`.
 * That keeps every property the old location had and adds the one it lacked:
 *   • no new environment variable — derived from `ADMIN_UPLOADS_DIR` exactly
 *     as before, just one level up;
 *   • still on the shared `rezeis-data` volume mounted at `/app/data` in both
 *     the api and worker containers, so the worker can still read what the api
 *     staged and a restart does not lose in-flight imports
 *     (`/app/data/uploads` → `/app/data/import-staging`);
 *   • not reachable by any URL, because `express.static` is rooted at
 *     `<uploadsRoot>` and a path prefix cannot escape upwards.
 */
export function resolveImportStageDir(): string {
  return resolve(resolveServedUploadsRoot(), '..', 'import-staging');
}

/**
 * Extensions an import file may carry on disk.
 *
 * None of the four parsers dispatch on the extension — `parseThreeXuiBackup`,
 * `parseRemnashopBackup`, `parseAltshopBackup` and `parseStealthnetBackup` all
 * take a `Buffer` and detect the format from its content (gzip magic `1f 8b`,
 * the `ustar` tar magic at offset 257, the SQLite header, or a JSON/SQL text
 * probe). The suffix is therefore cosmetic, which is exactly why it must not
 * come from the client unchecked: `extractExtension` previously copied
 * whatever followed the last dot in `originalname`, so `.html`, `.svg`,
 * `.xhtml` and `.js` all landed on disk under a directory that was being
 * served as static content.
 *
 * Compound suffixes are matched first so `backup.tar.gz` keeps both parts.
 */
const ALLOWED_COMPOUND_EXTENSIONS: readonly string[] = ['.tar.gz', '.sql.gz', '.json.gz'];
const ALLOWED_SIMPLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.db', // 3x-ui SQLite database
  '.sqlite',
  '.sqlite3',
  '.json', // 3x-ui / Remnashop / AltShop JSON export
  '.sql', // STEALTHNET + Remnashop pg_dump
  '.gz', // any of the above, gzipped
]);
/** Anything not on the allowlist is stored inert. */
const FALLBACK_EXTENSION = '.bin';

/**
 * Map a client-supplied filename onto an allowlisted on-disk extension.
 * Pure and exported so the allowlist is testable without a queue or a DB.
 */
export function resolveStagedExtension(filename: string): string {
  const lower = filename.toLowerCase();
  for (const compound of ALLOWED_COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound)) return compound;
  }
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return FALLBACK_EXTENSION;
  const ext = lower.slice(dot);
  return ALLOWED_SIMPLE_EXTENSIONS.has(ext) ? ext : FALLBACK_EXTENSION;
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Import queue producer — stages uploaded files and enqueues import jobs.
 *
 * File staging:
 *   Uploaded files are written to `<dataRoot>/import-staging/<uuid><ext>`
 *   (see `resolveImportStageDir`) so the BullMQ processor can read them later,
 *   even after a container restart. The directory is deliberately a sibling of
 *   the `/uploads` static root, never inside it. The staged file is cleaned up
 *   after processing.
 */
@Injectable()
export class ImportQueueService {
  private readonly logger = new Logger(ImportQueueService.name);
  private readonly stageDir = resolveImportStageDir();

  public constructor(
    @InjectQueue(IMPORT_QUEUE)
    private readonly queue: Queue,
    private readonly prismaService: PrismaService,
  ) {}

  /** The resolved staging directory — exposed so its location is assertable. */
  public getStageDir(): string {
    return this.stageDir;
  }

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
    balanceToPoints?: { enabled: boolean; rate: number };
    syncToPanel?: boolean;
  }): Promise<{ importRecordId: string; jobId: string }> {
    // Stage file to disk
    await fsp.mkdir(this.stageDir, { recursive: true });
    const ext = resolveStagedExtension(input.originalFilename);
    const stagedFilename = `${randomUUID()}${ext}`;
    const stagedFilePath = join(this.stageDir, stagedFilename);
    await fsp.writeFile(stagedFilePath, input.fileBuffer, { mode: 0o600 });

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
        ...(input.balanceToPoints ? { balanceToPoints: input.balanceToPoints } : {}),
        ...(input.syncToPanel ? { syncToPanel: true } : {}),
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
}
