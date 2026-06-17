import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Response } from 'express';
import { BackupScope } from '@prisma/client';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { BackupRecordDto, BackupService, type BackupSettingsView } from '../services/backup.service';

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

class BackupTelegramSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  chatId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  topicId?: string | null;
}

class UpdateBackupSettingsDto {
  @IsOptional()
  @IsBoolean()
  autoEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  intervalHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxKeep?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => BackupTelegramSettingsDto)
  telegram?: BackupTelegramSettingsDto;
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

  @Get('settings')
  @RequirePermission('backups', 'view')
  @ApiOperation({ summary: 'Returns the operator backup settings (schedule + Telegram delivery)' })
  public getSettings(): Promise<BackupSettingsView> {
    return this.backupService.getSettings();
  }

  @Patch('settings')
  @RequirePermission('backups', 'create')
  @ApiOperation({ summary: 'Updates the operator backup settings' })
  public updateSettings(@Body() dto: UpdateBackupSettingsDto): Promise<BackupSettingsView> {
    return this.backupService.updateSettings({
      autoEnabled: dto.autoEnabled,
      intervalHours: dto.intervalHours,
      maxKeep: dto.maxKeep,
      telegram: dto.telegram
        ? { enabled: dto.telegram.enabled, chatId: dto.telegram.chatId, topicId: dto.telegram.topicId }
        : undefined,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('backups', 'delete')
  @ApiOperation({ summary: 'Deletes a backup record and the underlying file' })
  public async delete(@Param('id') id: string): Promise<void> {
    await this.backupService.deleteBackup(id);
  }

  @Post('restore/:filename')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('backups', 'run')
  @ApiOperation({ summary: 'Restore database from a backup file (async via BullMQ)' })
  public async restore(
    @Param('filename') filename: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ jobId: string; message: string }> {
    const { jobId } = await this.backupService.restoreBackup(filename, admin.id);
    return { jobId, message: 'Restore job enqueued' };
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
