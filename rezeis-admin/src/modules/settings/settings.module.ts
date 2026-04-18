import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalPlatformPolicyController } from './controllers/internal-platform-policy.controller';
import { SettingsController } from './controllers/settings.controller';
import { SettingsService } from './services/settings.service';

/**
 * Registers the first business settings module for the admin backend.
 */
@Module({
  imports: [AuthModule],
  controllers: [SettingsController, InternalPlatformPolicyController],
  providers: [SettingsService],
})
export class SettingsModule {}
