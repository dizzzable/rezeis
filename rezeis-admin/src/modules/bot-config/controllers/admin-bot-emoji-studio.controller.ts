import { Body, Controller, Get, Put, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import type { Request } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import type { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { ReiwaCacheInvalidateInterceptor } from '../interceptors/reiwa-cache-invalidate.interceptor';
import { BotEmojiStudioService, type EmojiStudioView } from '../services/bot-emoji-studio.service';

class SetOwnerPremiumDto {
  @IsBoolean()
  public readonly enabled!: boolean;
}

/**
 * AdminBotEmojiStudioController
 * ─────────────────────────────
 * Composite read + owner-premium toggle for the Bot Emoji Studio. Separate
 * from `AdminBotConfigController` so it can carry explicit RBAC (`bot_config`)
 * without changing the existing un-gated emoji CRUD endpoints. Slot mutations
 * (fallback edit, premium bind/clear) reuse `PATCH /admin/bot-config/emojis/:id`.
 */
@ApiTags('admin/bot-config')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/bot-config/emoji-studio')
export class AdminBotEmojiStudioController {
  public constructor(private readonly studioService: BotEmojiStudioService) {}

  @Get()
  @RequirePermission('bot_config', 'view')
  @ApiOperation({ summary: 'Emoji studio: every slot with fallback, premium preview, and usage' })
  public getStudio(): Promise<EmojiStudioView> {
    return this.studioService.getStudio();
  }

  @Put('owner-premium')
  @RequirePermission('bot_config', 'edit')
  @UseInterceptors(ReiwaCacheInvalidateInterceptor)
  @ApiOperation({ summary: 'Set whether the bot owner has Telegram Premium (gates custom-emoji entities)' })
  public async setOwnerPremium(
    @Body() body: SetOwnerPremiumDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<{ readonly ownerHasPremium: boolean }> {
    const ownerHasPremium = await this.studioService.setOwnerHasPremium({
      enabled: body.enabled,
      admin,
      requestMetadata: extractRequestMetadata(req),
    });
    return { ownerHasPremium };
  }
}
