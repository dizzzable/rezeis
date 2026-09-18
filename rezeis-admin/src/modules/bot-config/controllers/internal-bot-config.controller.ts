import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

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
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalBotConfigController {
  public constructor(private readonly internalBotConfigService: InternalBotConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Read-only bot UI configuration consumed by reiwa' })
  public async getBotConfig(): Promise<InternalBotConfigInterface> {
    return this.internalBotConfigService.getConfig();
  }
}
