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

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { BackupService } from '../services/backup.service';
import {
  backupDownloadTokenFingerprint,
  verifyBackupDownloadToken,
} from '../utils/backup-download-token.util';
import { Public } from '../../../common/decorators/public.decorator';

/**
 * How long a redeemed token stays remembered as spent.
 *
 * Must be at least the token's own TTL (10 minutes in
 * `signBackupDownloadToken`), or a token could outlive the record of its own
 * use and become replayable again in the window between. 15 minutes leaves
 * margin for clock skew between this process and whatever minted the token.
 */
const REDEMPTION_TTL_SECONDS = 15 * 60;

/**
 * Internal, signature-gated backup download used by the reiwa bot to fetch a
 * backup file and upload it to Telegram on the split deployment (where rezeis
 * has no bot token). The bot does NOT hold an admin API token, so this route
 * is intentionally NOT behind `InternalAdminAuthGuard`; instead it validates a
 * short-lived HMAC token minted by rezeis when it relays the delivery.
 *
 * The token is SINGLE USE. It is minted for exactly one fetch by exactly one
 * consumer, and this route sits on `/api/internal/...` — a prefix the admin IP
 * allowlist deliberately does not cover and every shipped proxy example
 * forwards to the internet. A signature and a ten-minute expiry made the URL a
 * bearer credential for the whole database for those ten minutes: anywhere it
 * was logged (proxy access log, bot process log, an error report quoting the
 * request) it stayed redeemable. Now the first redemption spends it.
 *
 * Binding to a requesting admin was considered and is not possible: the
 * consumer is the reiwa bot, which is not an admin and holds no admin
 * identity. The recordId binding, the ten-minute expiry and single use are
 * what is available.
 */
@ApiTags('internal/backups')
@Public()
@Controller('internal/backups')
export class InternalBackupDownloadController {
  public constructor(
    private readonly backupService: BackupService,
    private readonly rawCacheService: RawCacheService,
  ) {}

  @Get('download')
  @ApiOperation({ summary: 'Stream a backup file by signed single-use token (reiwa bot relay)' })
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
    // Claimed AFTER the signature check so an unauthenticated caller cannot
    // burn a token it never held, and BEFORE the file is resolved so a race
    // between two requests cannot hand the archive to both.
    //
    // `claimOnce` is a single `SET NX EX` and fails CLOSED when the cache is
    // unreachable — which is the right way round here: without Redis there is
    // no BullMQ, so the delivery job that mints these tokens is not running
    // either, and a request arriving in that state is not a delivery.
    const claimed = await this.rawCacheService.claimOnce(
      `backup:download-token:${backupDownloadTokenFingerprint(token)}`,
      REDEMPTION_TTL_SECONDS,
    );
    if (!claimed) {
      throw new UnauthorizedException('Download token has already been used');
    }
    const file = await this.backupService.resolveBackupFileForDownload(recordId);
    if (file === null) {
      throw new NotFoundException('Backup file not found');
    }
    res.setHeader('Content-Type', 'application/gzip');
    // Sanitize the filename before it enters the response header: strip CR/LF
    // (header-injection) and quotes/backslashes (attribute break-out), and add
    // an RFC 5987 `filename*` for non-ASCII names. Defence-in-depth even though
    // backup filenames are system-generated.
    const asciiName = file.filename.replace(/[\r\n"\\]/g, '_');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    createReadStream(file.fullPath).pipe(res);
  }
}
