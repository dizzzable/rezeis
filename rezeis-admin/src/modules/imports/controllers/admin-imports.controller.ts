import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { ImportQueueService } from '../services/import-queue.service';
import { ImportsService } from '../services/imports.service';

interface ImportRecordPayload {
  readonly id: string;
  readonly filename: string;
  readonly sourceType: string;
  readonly status: string;
  readonly recordsTotal: number;
  readonly recordsOk: number;
  readonly recordsFailed: number;
  readonly errorMessage: string | null;
  readonly createdBy: string | null;
  readonly committedAt: string | null;
  readonly rolledBackAt: string | null;
  readonly createdAt: string;
  /**
   * Per-source structured payload — set by the importer at the very end
   * of the run. For Remnawave imports this is `RemnawaveImportSummary`
   * shape: { mode, fetched, created, updated, skipped, subscriptionsCreated,
   * subscriptionsUpdated, descriptionWritebacks, errors[] }.
   * Optional because the row exists in DRY_RUN status before the run
   * finishes — clients should treat absence as "still processing".
   */
  readonly result?: Record<string, unknown> | null;
}

interface ListImportsResponse {
  readonly items: readonly ImportRecordPayload[];
  readonly total: number;
}

interface ImportEnqueuedResponse {
  readonly importRecordId: string;
  readonly jobId: string;
  readonly message: string;
}

/**
 * Admin imports surface — all imports are now async via BullMQ.
 *
 * Flow:
 *   1. Admin uploads file / clicks "Import from Remnawave"
 *   2. API stages the file, creates ImportRecord(DRAFT), enqueues job
 *   3. Returns 202 with { importRecordId, jobId }
 *   4. Worker processes the import, emits progress via WebSocket
 *   5. Admin polls GET /admin/imports/:id or watches realtime events
 *
 * Sources:
 *   • Remnawave — live API pull (one-button)
 *   • 3x-ui — file upload (.db SQLite or .json)
 *   • Remnashop — file upload (.tar.gz or .json)
 *   • Altshop — file upload (.tar.gz or .json)
 */
@Controller('admin/imports')
@UseGuards(AdminJwtAuthGuard)
export class AdminImportsController {
  public constructor(
    private readonly importsService: ImportsService,
    private readonly importQueueService: ImportQueueService,
  ) {}

  // ── List & Detail ───────────────────────────────────────────────────────

  @Get()
  public async listImports(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ListImportsResponse> {
    const parsedLimit = limit !== undefined ? Number.parseInt(limit, 10) : 50;
    const parsedOffset = offset !== undefined ? Number.parseInt(offset, 10) : 0;
    const records = await this.importsService.list({
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
      offset: Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
    });
    const items: ImportRecordPayload[] = records.map((record) => ({
      id: record.id,
      filename: record.filename,
      sourceType: record.sourceType,
      status: record.status,
      recordsTotal: record.recordsTotal,
      recordsOk: record.recordsOk,
      recordsFailed: record.recordsFailed,
      errorMessage: record.errorMessage,
      createdBy: record.createdBy,
      committedAt: record.committedAt?.toISOString() ?? null,
      rolledBackAt: record.rolledBackAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      result: serializeImportResult(record.result),
    }));
    return { items, total: items.length };
  }

  @Get(':importId')
  public async getImport(
    @Param('importId') importId: string,
  ): Promise<ImportRecordPayload> {
    const record = await this.importsService.getById(importId);
    return {
      id: record.id,
      filename: record.filename,
      sourceType: record.sourceType,
      status: record.status,
      recordsTotal: record.recordsTotal,
      recordsOk: record.recordsOk,
      recordsFailed: record.recordsFailed,
      errorMessage: record.errorMessage,
      createdBy: record.createdBy,
      committedAt: record.committedAt?.toISOString() ?? null,
      rolledBackAt: record.rolledBackAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      result: serializeImportResult(record.result),
    };
  }

  // ── Remnawave (live API) ────────────────────────────────────────────────

  @Post('remnawave')
  @HttpCode(HttpStatus.ACCEPTED)
  public async importFromRemnawave(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<ImportEnqueuedResponse> {
    const { importRecordId, jobId } = await this.importQueueService.enqueueRemnawaveImport({
      mode: 'import',
      createdBy: admin.id,
    });
    return { importRecordId, jobId, message: 'Remnawave import enqueued' };
  }

  @Post('remnawave/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  public async syncFromRemnawave(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<ImportEnqueuedResponse> {
    const { importRecordId, jobId } = await this.importQueueService.enqueueRemnawaveImport({
      mode: 'sync',
      createdBy: admin.id,
    });
    return { importRecordId, jobId, message: 'Remnawave sync enqueued' };
  }

  // ── 3x-ui (file upload: .db or .json) ──────────────────────────────────

  @Post('3xui')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  public async importFrom3xui(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ImportEnqueuedResponse> {
    if (!file) {
      throw new BadRequestException('File is required. Upload a .db (SQLite) or .json file.');
    }
    const { importRecordId, jobId } = await this.importQueueService.enqueueFileImport({
      sourceType: '3xui',
      mode: 'import',
      createdBy: admin.id,
      fileBuffer: file.buffer,
      originalFilename: file.originalname,
    });
    return { importRecordId, jobId, message: '3x-ui import enqueued' };
  }

  // ── Remnashop (file upload: .tar.gz or .json) ───────────────────────────

  @Post('remnashop')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  public async importFromRemnashop(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ImportEnqueuedResponse> {
    if (!file) {
      throw new BadRequestException('File is required. Upload a .tar.gz backup or .json export.');
    }
    const { importRecordId, jobId } = await this.importQueueService.enqueueFileImport({
      sourceType: 'remnashop',
      mode: 'import',
      createdBy: admin.id,
      fileBuffer: file.buffer,
      originalFilename: file.originalname,
    });
    return { importRecordId, jobId, message: 'Remnashop import enqueued' };
  }

  // ── Altshop (file upload: .tar.gz or .json) ─────────────────────────────

  @Post('altshop')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  public async importFromAltshop(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ImportEnqueuedResponse> {
    if (!file) {
      throw new BadRequestException('File is required. Upload a .tar.gz backup or database.json.');
    }
    const { importRecordId, jobId } = await this.importQueueService.enqueueFileImport({
      sourceType: 'altshop',
      mode: 'import',
      createdBy: admin.id,
      fileBuffer: file.buffer,
      originalFilename: file.originalname,
    });
    return { importRecordId, jobId, message: 'Altshop import enqueued' };
  }

  // ── Bulk Plan Assignment ────────────────────────────────────────────────

  @Post('assign-plan')
  @HttpCode(HttpStatus.ACCEPTED)
  public async assignPlanToImported(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Body() body: { planId: string; importRecordId?: string; userIds?: string[]; applyImmediately?: boolean },
  ): Promise<{ jobId: string; message: string }> {
    if (!body.planId) {
      throw new BadRequestException('planId is required');
    }
    if (!body.importRecordId && (!body.userIds || body.userIds.length === 0)) {
      throw new BadRequestException('Either importRecordId or userIds must be provided');
    }
    const jobId = await this.importQueueService.enqueueAssignPlan({
      importRecordId: body.importRecordId ?? '',
      planId: body.planId,
      createdBy: admin.id,
      userIds: body.userIds,
      applyImmediately: body.applyImmediately === true,
    });
    return { jobId, message: 'Plan assignment enqueued' };
  }

  // ── Cancel ──────────────────────────────────────────────────────────────

  @Post(':importId/cancel')
  @HttpCode(HttpStatus.OK)
  public async cancelImport(
    @Param('importId') importId: string,
  ): Promise<{ canceled: boolean; message: string }> {
    const canceled = await this.importQueueService.cancelImport(importId);
    return {
      canceled,
      message: canceled ? 'Import canceled' : 'Import not found in queue (may already be processing)',
    };
  }
}


/**
 * Coerce the Prisma JSON column for `ImportRecord.result` into a plain
 * `Record<string, unknown> | null` for the API response. The column can
 * be `null` (DRY_RUN before completion), `undefined` (very fresh row)
 * or an arbitrary JSON value the importer wrote — we only forward
 * object shapes; arrays / scalars / `null` collapse to `null`.
 */
function serializeImportResult(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
