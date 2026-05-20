import { Module } from '@nestjs/common';

import { BotFlowService } from './services/bot-flow.service';
import { BotFlowScreenService } from './services/bot-flow-screen.service';
import { AdminBotFlowController } from './controllers/admin-bot-flow.controller';
import { InternalBotFlowController } from './controllers/internal-bot-flow.controller';

@Module({
  controllers: [AdminBotFlowController, InternalBotFlowController],
  providers: [BotFlowService, BotFlowScreenService],
  exports: [BotFlowService, BotFlowScreenService],
})
export class BotFlowModule {}
