import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Response } from 'express';
import { BackupScope } from '@prisma/client';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { BackupRecordDto, BackupService } from '../services/backup.service';

class ListBackupsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

class CreateBackupDto {
  @IsEnum(BackupScope)
  scope!: BackupScope;
}

interface BackupListResponse {
  readonly items: readonly BackupRecordDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

@ApiTags('admin/backup')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/backup')
export class AdminBackupController {
  public constructor(private readonly backupService: BackupService) {}

  @Get()
  @RequirePermission('backups', 'view')
  @ApiOperation({ summary: 'Lists backup records with pagination' })
  @ApiOkResponse({ description: 'Paginated backup list' })
  public list(@Query() query: ListBackupsQueryDto): Promise<BackupListResponse> {
    return this.backupService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('backups', 'create')
  @ApiOperation({ summary: 'Triggers a new pg_dump backup (returns immediately, dump runs async)' })
  public create(
    @Body() dto: CreateBackupDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<BackupRecordDto> {
    return this.backupService.createBackup({
      scope: dto.scope,
      initiatedBy: admin.id,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('backups', 'delete')
  @ApiOperation({ summary: 'Deletes a backup record and the underlying file' })
  public async delete(@Param('id') id: string): Promise<void> {
    await this.backupService.deleteBackup(id);
  }

  @Get('download/:filename')
  @RequirePermission('backups', 'view')
  @ApiOperation({ summary: 'Streams a backup file by filename' })
  public async download(
    @Param('filename') filename: string,
    @Res() response: Response,
  ): Promise<void> {
    const { stream, mimeType, filename: safeName } =
      await this.backupService.resolveDownloadStream(filename);
    response.setHeader('Content-Type', mimeType);
    response.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    stream.pipe(response);
  }
}
