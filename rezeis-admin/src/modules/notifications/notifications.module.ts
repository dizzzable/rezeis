import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminNotificationTemplatesController } from './controllers/admin-notification-templates.controller';
import { NotificationTemplatesService } from './services/notification-templates.service';

/**
 * NotificationsModule
 * ───────────────────
 * Owns the editable notification templates table. Other modules consume the
 * service when they want to render a stored template; the admin UI talks to
 * the controller for CRUD + a one-shot "seed defaults" action.
 *
 * Delivery (Telegram, email, push) is handled by feature-specific services
 * elsewhere — this module is the source of truth for the *content*, not the
 * transport.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminNotificationTemplatesController],
  providers: [NotificationTemplatesService],
  exports: [NotificationTemplatesService],
})
export class NotificationsModule {}
