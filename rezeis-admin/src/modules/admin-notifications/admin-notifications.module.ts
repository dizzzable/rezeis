import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalPushModule } from '../push/internal-push.module';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminNotificationInboxService } from './services/admin-notification-inbox.service';

/**
 * AdminNotificationsModule
 * ────────────────────────
 * The panel's notification centre: what the bell lists, and what «прочитано»
 * and «удалить» act on.
 *
 * It keeps the alerts the panel already raises rather than inventing any of
 * its own — `resolveNotificationRoute` and `AdminNotificationPreferencesService`
 * both live in `InternalPushModule`, and this module borrows them so that the
 * bell and the phone can never disagree about what an alert is.
 *
 * `PrismaService`, `RbacService` and `SystemEventsService` are global.
 */
@Module({
  imports: [AuthModule, InternalPushModule],
  controllers: [AdminNotificationsController],
  providers: [AdminNotificationInboxService],
  exports: [AdminNotificationInboxService],
})
export class AdminNotificationsModule {}
