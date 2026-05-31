import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { AuthModule } from '../auth/auth.module';
import { InternalBrandingController } from './controllers/internal-branding.controller';
import { InternalEventsController } from './controllers/internal-events.controller';
import { InternalPlatformPolicyController } from './controllers/internal-platform-policy.controller';
import { SettingsController } from './controllers/settings.controller';
import { IconUploadService } from './services/icon-upload.service';
import { SettingsService } from './services/settings.service';

/**
 * Registers the first business settings module for the admin backend.
 */
@Module({
  imports: [AuthModule, HttpModule],
  controllers: [
    SettingsController,
    InternalPlatformPolicyController,
    InternalBrandingController,
    InternalEventsController,
  ],
  providers: [SettingsService, IconUploadService],
  exports: [SettingsService],
})
export class SettingsModule {}
