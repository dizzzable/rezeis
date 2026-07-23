import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdClickSurface } from '@prisma/client';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { IngestClickDto } from '../dto/advertising.dto';
import { AdAttributionService } from '../services/ad-attribution.service';

/**
 * reiwa-facing advertising ingest. Called from the bot `/start` (`ad_<code>`)
 * and the Mini-App `startapp`/`?campaign=` entry. Auth: `InternalAdminAuthGuard`
 * (api_token) — reiwa proves nothing more than the Telegram id, which rezeis
 * resolves to a `User`. Always returns `{ ok: true }`: ingestion is best-effort
 * and must never make the bot welcome flow look broken.
 */
@ApiTags('internal/advertising')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/advertising')
export class InternalAdvertisingController {
  public constructor(private readonly attributionService: AdAttributionService) {}

  @Post('click')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Records an advertising click (bot/Mini-App opened via ad_<code>)' })
  public async ingestClick(@Body() input: IngestClickDto): Promise<{ ok: true }> {
    const surface = parseClickSurface(input.surface);
    await this.attributionService.recordClick({
      code: input.code,
      telegramId: input.telegramId ?? null,
      userId: input.userId ?? null,
      surface,
      isNewUser: input.isNewUser ?? false,
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      utmContent: input.utmContent,
      utmCreative: input.utmCreative,
    });
    return { ok: true };
  }
}

function parseClickSurface(raw: string | undefined): AdClickSurface {
  if (raw === 'MINIAPP') return AdClickSurface.MINIAPP;
  if (raw === 'WEB') return AdClickSurface.WEB;
  return AdClickSurface.BOT;
}
