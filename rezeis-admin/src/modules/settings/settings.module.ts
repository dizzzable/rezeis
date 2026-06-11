import { Module } from '@nestjs/common';

import { OutboundHttpModule } from '../../common/http/outbound-http.module';
import { AuthModule } from '../auth/auth.module';
import { BotConfigModule } from '../bot-config/bot-config.module';
import { InternalBrandingController } from './controllers/internal-branding.controller';
import { InternalEventsController } from './controllers/internal-events.controller';
import { InternalPlatformPolicyController } from './controllers/internal-platform-policy.controller';
import { SettingsController } from './controllers/settings.controller';
import { AccessModeGuard } from './services/access-mode-guard.service';
import { IconUploadService } from './services/icon-upload.service';
import { SettingsService } from './services/settings.service';

/**
 * Registers the first business settings module for the admin backend.
 */
@Module({
  imports: [AuthModule, BotConfigModule, OutboundHttpModule],
  controllers: [
    SettingsController,
    InternalPlatformPolicyController,
    InternalBrandingController,
    InternalEventsController,
  ],
  providers: [SettingsService, IconUploadService, AccessModeGuard],
  exports: [SettingsService, AccessModeGuard],
})
export class SettingsModule {}
