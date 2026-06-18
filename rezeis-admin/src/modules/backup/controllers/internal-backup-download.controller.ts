import { createReadStream } from 'node:fs';

import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { BackupService } from '../services/backup.service';
import { verifyBackupDownloadToken } from '../utils/backup-download-token.util';

/**
 * Internal, signature-gated backup download used by the reiwa bot to fetch a
 * backup file and upload it to Telegram on the split deployment (where rezeis
 * has no bot token). The bot does NOT hold an admin API token, so this route
 * is intentionally NOT behind `InternalAdminAuthGuard`; instead it validates a
 * short-lived HMAC token minted by rezeis when it relays the delivery.
 */
@ApiTags('internal/backups')
@Controller('internal/backups')
export class InternalBackupDownloadController {
  public constructor(private readonly backupService: BackupService) {}

  @Get('download')
  @ApiOperation({ summary: 'Stream a backup file by signed token (reiwa bot relay)' })
  public async download(
    @Query('recordId') recordId: string,
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const secret = process.env.REZEIS_CRYPT_KEY ?? '';
    if (secret.length === 0 || !recordId || !token) {
      throw new UnauthorizedException('Invalid download request');
    }
    if (verifyBackupDownloadToken(token, secret) !== recordId) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const file = await this.backupService.resolveBackupFileForDownload(recordId);
    if (file === null) {
      throw new NotFoundException('Backup file not found');
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    createReadStream(file.fullPath).pipe(res);
  }
}
