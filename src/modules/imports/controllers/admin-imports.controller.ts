import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { ImportsService } from '../services/imports.service';
import {
  RemnawaveImporterService,
  type RemnawaveImportSummary,
} from '../services/remnawave-importer.service';

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
 * Admin imports surface — wraps the simple altshop-style flow:
 *   • One button to import everything from Remnawave.
 *   • One button to refresh existing local users from Remnawave.
 *   • A history table for the operator to see prior runs.
 */
@Controller('admin/imports')
@UseGuards(AdminJwtAuthGuard)
export class AdminImportsController {
  public constructor(
    private readonly importsService: ImportsService,
    private readonly remnawaveImporterService: RemnawaveImporterService,
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
}
