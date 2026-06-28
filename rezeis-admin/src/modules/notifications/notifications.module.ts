import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalPushModule } from '../push/internal-push.module';
import { CustomEmojiModule } from '../custom-emoji/custom-emoji.module';
import { AdminNotificationTemplatesController } from './controllers/admin-notification-templates.controller';
import { AdminUserNotificationEventsController } from './controllers/admin-user-notification-events.controller';
import { BotNotifierClient } from './services/bot-notifier.client';
import { NotificationTemplatesService } from './services/notification-templates.service';
import { UserNotificationsService } from './services/user-notifications.service';

/**
 * NotificationsModule
 * ───────────────────
 * Owns the editable notification templates + the user-notification
 * fanout service.
 *
 * `UserNotificationsService` is the single source of truth for "notify
 * a user". It writes the cabinet-feed row and (best-effort) pushes
 * the rendered text to:
 *   - the bot (Telegram, per-user direct message),
 *   - the user's registered web-push subscriptions (browsers + iOS PWA),
 *   - the operator Telegram chat (when `mirrorUserNotifications` is
 *     enabled in Settings → Telegram delivery — variant A: one
 *     Telegram delivery surface, no separate broadcast-channels table).
 *
 * Per-channel email bridge reads the same `UserNotificationEvent` rows
 * on its own schedule; this module remains the source of truth for the
 * *content*, not the transport.
 */
@Module({
  imports: [AuthModule, InternalPushModule, CustomEmojiModule],
  controllers: [AdminNotificationTemplatesController, AdminUserNotificationEventsController],
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
