import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { InternalBotConfigInterface } from '../interfaces/internal-bot-config.interface';
import { InternalBotConfigService } from '../services/internal-bot-config.service';

/**
 * InternalBotConfigController
 * ───────────────────────────
 * User-edge facing read-only mirror of `AdminBotConfigController`. Reiwa
 * (the Telegram bot runtime + Mini App BFF) calls this once at startup and
 * every 5 minutes thereafter to refresh the bot UI configuration:
 *   - menu buttons (label / order / style / premium-emoji icon),
 *   - emoji catalog (premium custom_emoji_id mapping),
 *   - translation strings.
 *
 * Auth: `InternalAdminAuthGuard` (the same Bearer api_token reiwa already
 * uses for every other `/api/internal/...` endpoint). Operators issue
 * those tokens from the admin panel under "Settings → API tokens".
 */
@ApiTags('internal/bot-config')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/bot-config')
export class InternalBotConfigController {
  public constructor(private readonly internalBotConfigService: InternalBotConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Read-only bot UI configuration consumed by reiwa' })
  public async getBotConfig(): Promise<InternalBotConfigInterface> {
    return this.internalBotConfigService.getConfig();
  }
}
