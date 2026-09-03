import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BotConfigModule } from '../bot-config/bot-config.module';
import {
  AdminConnectPageController,
  InternalConnectPageController,
} from './connect-page/connect-page.controllers';
import { ConnectPageService } from './connect-page/connect-page.service';
import { AdminSubpageConfigController } from './controllers/admin-subpage-config.controller';
import { InternalSubpageConfigController } from './controllers/internal-subpage-config.controller';
import { SubpageCacheInvalidateInterceptor } from './interceptors/subpage-cache-invalidate.interceptor';
import { SubpageCacheInvalidatorService } from './services/subpage-cache-invalidator.service';
import { SubpageConfigService } from './services/subpage-config.service';

/**
 * SubpageConfigModule
 * ───────────────────
 * rezeis-admin owns the subscription-page config (branding, app catalog,
 * baseSettings, translations). The admin panel edits it; rezeis-subpage reads
 * the effective config via the internal endpoint and re-validates it against
 * the full (AGPL) schema on its side. A save pushes a cache-invalidate to the
 * subpage so operator changes appear immediately.
 */
@Module({
  imports: [AuthModule, BotConfigModule],
  controllers: [
    AdminSubpageConfigController,
    InternalSubpageConfigController,
    AdminConnectPageController,
    InternalConnectPageController,
  ],
  providers: [
    SubpageConfigService,
    ConnectPageService,
    SubpageCacheInvalidatorService,
    SubpageCacheInvalidateInterceptor,
  ],
  exports: [SubpageConfigService, ConnectPageService],
})
export class SubpageConfigModule {}
