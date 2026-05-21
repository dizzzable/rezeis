import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { ImportSummary } from '../interfaces/import-summary.interface';
import { AltshopImporterService } from '../services/altshop-importer.service';
import { ImportsService } from '../services/imports.service';
import {
  RemnawaveImporterService,
  type RemnawaveImportSummary,
} from '../services/remnawave-importer.service';
import { RemnashopImporterService } from '../services/remnashop-importer.service';
import { ThreeXuiImporterService } from '../services/threexui-importer.service';
import { parseAltshopBackup } from '../utils/altshop-backup-parser';
import { parseRemnashopBackup } from '../utils/remnashop-backup-parser';
import { parseThreeXuiBackup } from '../utils/threexui-backup-parser';

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
}

interface ListImportsResponse {
  readonly items: readonly ImportRecordPayload[];
  readonly total: number;
}

/**
 * Admin imports surface — supports multiple import sources:
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
    private readonly remnawaveImporterService: RemnawaveImporterService,
    private readonly threexuiImporterService: ThreeXuiImporterService,
    private readonly remnashopImporterService: RemnashopImporterService,
    private readonly altshopImporterService: AltshopImporterService,
  ) {}

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
    }));
    return { items, total: items.length };
  }

  // ── Remnawave (live API) ────────────────────────────────────────────────

  @Post('remnawave')
  @HttpCode(HttpStatus.OK)
  public async importFromRemnawave(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<RemnawaveImportSummary> {
    return this.remnawaveImporterService.run({ mode: 'import', createdBy: admin.id });
  }

  @Post('remnawave/sync')
  @HttpCode(HttpStatus.OK)
  public async syncFromRemnawave(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<RemnawaveImportSummary> {
    return this.remnawaveImporterService.run({ mode: 'sync', createdBy: admin.id });
  }

  // ── 3x-ui (file upload: .db or .json) ──────────────────────────────────

  @Post('3xui')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  public async importFrom3xui(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ImportSummary> {
    if (!file) {
      throw new BadRequestException('File is required. Upload a .db (SQLite) or .json file.');
    }

    const clients = parseThreeXuiBackup(file.buffer);

    return this.threexuiImporterService.run({
      mode: 'import',
      createdBy: admin.id,
      clients,
    });
  }

  // ── Remnashop (file upload: .tar.gz or .json) ───────────────────────────

  @Post('remnashop')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  public async importFromRemnashop(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ImportSummary> {
    if (!file) {
      throw new BadRequestException('File is required. Upload a .tar.gz backup or .json export.');
    }

    const { users, subscriptions } = await parseRemnashopBackup(file.buffer);

    return this.remnashopImporterService.run({
      mode: 'import',
      createdBy: admin.id,
      users,
      subscriptions,
    });
  }

  // ── Altshop (file upload: .tar.gz or .json) ─────────────────────────────

  @Post('altshop')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  public async importFromAltshop(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ImportSummary> {
    if (!file) {
      throw new BadRequestException('File is required. Upload a .tar.gz backup or database.json.');
    }

    const { users, subscriptions, transactions } = await parseAltshopBackup(file.buffer);

    return this.altshopImporterService.run({
      mode: 'import',
      createdBy: admin.id,
      users,
      subscriptions,
      transactions,
    });
  }
}
