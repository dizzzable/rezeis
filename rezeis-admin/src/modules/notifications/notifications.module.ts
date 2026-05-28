import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalPushModule } from '../push/internal-push.module';
import { AdminNotificationTemplatesController } from './controllers/admin-notification-templates.controller';
import { BotNotifierClient } from './services/bot-notifier.client';
import { NotificationTemplatesService } from './services/notification-templates.service';
import { UserNotificationsService } from './services/user-notifications.service';

/**
 * NotificationsModule
 * ───────────────────
 * Owns the editable notification templates + the user-notification
 * fanout service. Other modules consume `UserNotificationsService`
 * when they want to notify a user — the service writes the cabinet-feed
 * row and (best-effort) pushes the rendered text to both the bot
 * (Telegram) and the user's registered web-push subscriptions
 * (browsers + iOS PWA).
 *
 * Per-channel bridges (email, BotNotificationChannel broadcast) read
 * the same `UserNotificationEvent` rows on their own schedules — this
 * module remains the source of truth for the *content*, not the
 * transport.
 */
@Module({
  imports: [AuthModule, InternalPushModule],
  controllers: [AdminNotificationTemplatesController],
  providers: [
    NotificationTemplatesService,
    BotNotifierClient,
    UserNotificationsService,
  ],
  exports: [
    NotificationTemplatesService,
    BotNotifierClient,
    UserNotificationsService,
  ],
})
export class NotificationsModule {}
