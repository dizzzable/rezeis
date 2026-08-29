import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BlockedIdentitiesModule } from '../blocked-identities/blocked-identities.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminSupportTicketsController } from './controllers/admin-support-tickets.controller';
import { InternalGuestSupportController } from './controllers/internal-guest-support.controller';
import { InternalUserSupportController } from './controllers/internal-user-support.controller';
import { SupportNotificationsService } from './services/support-notifications.service';
import { SupportAttachmentService } from './services/support-attachment.service';
import { GuestGateService } from './services/guest-gate.service';
import { SupportGuestService } from './services/support-guest.service';
import { SupportTicketsService } from './services/support-tickets.service';

@Module({
  // For `BlockedIdentityService`: silencing a guest device is a MANUAL
  // blocklist entry, and manual is what separates a refusal from the
  // cascade rows every block writes automatically.
  imports: [AuthModule, BlockedIdentitiesModule, NotificationsModule, SettingsModule],
  controllers: [
    AdminSupportTicketsController,
    InternalUserSupportController,
    InternalGuestSupportController,
  ],
  providers: [
    SupportTicketsService,
    SupportNotificationsService,
    SupportGuestService,
    SupportAttachmentService,
    GuestGateService,
  ],
  exports: [SupportTicketsService, SupportGuestService],
})
export class SupportTicketsModule {}
