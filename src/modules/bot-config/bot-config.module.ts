import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminBotConfigController } from './controllers/admin-bot-config.controller';
import { BotButtonsService } from './services/bot-buttons.service';
import { BotEmojisService } from './services/bot-emojis.service';
import { BotTextsService } from './services/bot-texts.service';

/**
 * BotConfigModule
 * ───────────────
 * CRUD over the bot UI configuration: reply-keyboard buttons, premium
 * emoji catalog, copy strings. The bot service consumes these tables at
 * runtime; the admin panel writes them via the REST controller.
 *
 * Each entity owns its own service so future bot features (callback wiring,
 * inline buttons, scheduled prompts) can hang off this module without
 * forcing operators into a god-service.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminBotConfigController],
  providers: [BotButtonsService, BotEmojisService, BotTextsService],
  exports: [BotButtonsService, BotEmojisService, BotTextsService],
})
export class BotConfigModule {}
