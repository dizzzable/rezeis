import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BotFlowModule } from '../bot-flow/bot-flow.module';
import { AdminBotConfigController } from './controllers/admin-bot-config.controller';
import { AdminBotEmojiStudioController } from './controllers/admin-bot-emoji-studio.controller';
import { InternalBotConfigController } from './controllers/internal-bot-config.controller';
import { ReiwaCacheInvalidateInterceptor } from './interceptors/reiwa-cache-invalidate.interceptor';
import { BotBannerUploadService } from './services/bot-banner-upload.service';
import { BotBannerService } from './services/bot-banner.service';
import { BotButtonsService } from './services/bot-buttons.service';
import { BotEmojisService } from './services/bot-emojis.service';
import { BotEmojiStudioService } from './services/bot-emoji-studio.service';
import { BotTextsService } from './services/bot-texts.service';
import { InternalBotConfigService } from './services/internal-bot-config.service';
import { ReiwaCacheInvalidatorService } from './services/reiwa-cache-invalidator.service';

/**
 * BotConfigModule
 * ───────────────
 * CRUD over the bot UI configuration: reply-keyboard buttons, premium
 * emoji catalog, copy strings, plus dynamic screens projected from the
 * `BotFlow` graph (BotFlowModule). The bot service consumes the
 * combined payload at runtime; the admin panel writes via the REST
 * controller.
 *
 * Each entity owns its own service so future bot features (callback
 * wiring, inline buttons, scheduled prompts) can hang off this module
 * without forcing operators into a god-service.
 *
 * `ReiwaCacheInvalidatorService` + `ReiwaCacheInvalidateInterceptor`
 * push a synchronous cache-bust to reiwa-bot after every successful
 * mutation, so operator changes propagate to live bot users in ~50ms
 * instead of waiting for the 5-minute TTL refresh.
 *
 * `BotBannerUploadService` persists welcome-banner uploads on the
 * admin host's filesystem and writes the resulting URL to the
 * `bot.banner_url` BotText row — reiwa-bot then fetches the file
 * directly from `/uploads/bot-banners/<id>.jpg`.
 */
@Module({
  imports: [AuthModule, BotFlowModule],
  controllers: [AdminBotConfigController, AdminBotEmojiStudioController, InternalBotConfigController],
  providers: [
    BotBannerUploadService,
    BotBannerService,
    BotButtonsService,
    BotEmojisService,
    BotEmojiStudioService,
    BotTextsService,
    InternalBotConfigService,
    ReiwaCacheInvalidatorService,
    ReiwaCacheInvalidateInterceptor,
  ],
  exports: [BotButtonsService, BotEmojisService, BotTextsService, ReiwaCacheInvalidatorService],
})
export class BotConfigModule {}
