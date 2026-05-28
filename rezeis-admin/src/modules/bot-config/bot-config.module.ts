import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BotFlowModule } from '../bot-flow/bot-flow.module';
import { AdminBotConfigController } from './controllers/admin-bot-config.controller';
import { InternalBotConfigController } from './controllers/internal-bot-config.controller';
import { ReiwaCacheInvalidateInterceptor } from './interceptors/reiwa-cache-invalidate.interceptor';
import { BotButtonsService } from './services/bot-buttons.service';
import { BotEmojisService } from './services/bot-emojis.service';
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
 */
@Module({
  imports: [AuthModule, BotFlowModule],
  controllers: [AdminBotConfigController, InternalBotConfigController],
  providers: [
    BotButtonsService,
    BotEmojisService,
    BotTextsService,
    InternalBotConfigService,
    ReiwaCacheInvalidatorService,
    ReiwaCacheInvalidateInterceptor,
  ],
  exports: [BotButtonsService, BotEmojisService, BotTextsService],
})
export class BotConfigModule {}
