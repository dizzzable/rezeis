import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReiwaCacheInvalidateInterceptor } from '../bot-config/interceptors/reiwa-cache-invalidate.interceptor';
import { ReiwaCacheInvalidatorService } from '../bot-config/services/reiwa-cache-invalidator.service';
import { ReiwaRelayModule } from '../notifications/reiwa-relay.module';
import { BotFlowService } from './services/bot-flow.service';
import { BotFlowScreenService } from './services/bot-flow-screen.service';
import { AdminBotFlowController } from './controllers/admin-bot-flow.controller';
import { InternalBotFlowController } from './controllers/internal-bot-flow.controller';

// `ReiwaRelayModule` because this module declares its OWN
// `ReiwaCacheInvalidatorService` (see `LegalDocumentsModule` for why), and that
// service now enqueues invalidations instead of firing a single `fetch`. A
// provider declared locally is resolved locally: without this import Nest
// cannot construct it, and nothing but a boot failure would say so.
@Module({
  imports: [AuthModule, ReiwaRelayModule],
  controllers: [AdminBotFlowController, InternalBotFlowController],
  providers: [
    BotFlowService,
    BotFlowScreenService,
    ReiwaCacheInvalidatorService,
    ReiwaCacheInvalidateInterceptor,
  ],
  exports: [BotFlowService, BotFlowScreenService],
})
export class BotFlowModule {}
