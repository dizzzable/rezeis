import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { BotMapComposerService } from '../services/bot-map-composer.service';
import type { BotMapPayload } from '../interfaces/bot-map-payload.interface';

/**
 * AdminBotMapController
 * ─────────────────────
 * Read-only endpoint backing the new "Карта бота" admin module. Composes
 * a single denormalised payload over the bot-flow tables, the reply
 * keyboard, the notification templates, and the Mini App terminal
 * catalog so the SPA list view + canvas render from one round-trip.
 *
 * No mutations live here — operator edits go through the existing
 * endpoints (graph screens, reply buttons, notification templates).
 * Cache invalidation is therefore unnecessary at the controller level;
 * the SPA invalidates `['bot-map']` on every successful inspector save.
 */
@ApiTags('Bot Map')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/bot-map')
export class AdminBotMapController {
  public constructor(private readonly composer: BotMapComposerService) {}

  @Get()
  @ApiOperation({ summary: 'Get the unified bot map (nodes + edges) for the admin module' })
  public get(): Promise<BotMapPayload> {
    return this.composer.build();
  }
}
