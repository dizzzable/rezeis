import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminSupportTicketsController } from './controllers/admin-support-tickets.controller';
import { InternalGuestSupportController } from './controllers/internal-guest-support.controller';
import { InternalUserSupportController } from './controllers/internal-user-support.controller';
import { SupportNotificationsService } from './services/support-notifications.service';
import { SupportAttachmentService } from './services/support-attachment.service';
import { SupportGuestService } from './services/support-guest.service';
import { SupportTicketsService } from './services/support-tickets.service';

@Module({
  imports: [AuthModule, NotificationsModule, SettingsModule],
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
  ],
  exports: [SupportTicketsService, SupportGuestService],
})
export class SupportTicketsModule {}
