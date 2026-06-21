import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BotConfigModule } from '../bot-config/bot-config.module';
import { BotFlowModule } from '../bot-flow/bot-flow.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { AdminBotMapController } from './controllers/admin-bot-map.controller';
import { BotMapComposerService } from './services/bot-map-composer.service';

/**
 * Backs the "Карта бота" admin module. Read-only composer over
 * bot-flow + bot-config + notifications data; no DB writes here, so
 * the new module is safe to ship behind a single deploy without
 * touching the reiwa contract.
 */
@Module({
  imports: [AuthModule, BotFlowModule, BotConfigModule, NotificationsModule],
  controllers: [AdminBotMapController],
  providers: [BotMapComposerService],
  exports: [BotMapComposerService],
})
export class BotMapModule {}
