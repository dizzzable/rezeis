import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalPushModule } from '../push/internal-push.module';
import { AdminNotificationChannelsController } from './controllers/admin-notification-channels.controller';
import { AdminNotificationTemplatesController } from './controllers/admin-notification-templates.controller';
import { BotNotificationChannelsService } from './services/bot-notification-channels.service';
import { BotNotifierClient } from './services/bot-notifier.client';
import { NotificationTemplatesService } from './services/notification-templates.service';
import { UserNotificationsService } from './services/user-notifications.service';

/**
 * NotificationsModule
 * ───────────────────
 * Owns the editable notification templates + the user-notification
 * fanout service + the operator-managed broadcast channels.
 *
 * `UserNotificationsService` is the single source of truth for "notify
 * a user". It writes the cabinet-feed row and (best-effort) pushes
 * the rendered text to:
 *   - the bot (Telegram, per-user direct message),
 *   - the user's registered web-push subscriptions (browsers + iOS PWA),
 *   - every `BotNotificationChannel` whose `kindFilter` accepts the type.
 *
 * Per-channel email bridge reads `UserNotificationEvent` rows on its
 * own schedule; this module remains the source of truth for the
 * *content*, not the transport.
 */
@Module({
  imports: [AuthModule, InternalPushModule],
  controllers: [
    AdminNotificationTemplatesController,
    AdminNotificationChannelsController,
  ],
  providers: [
    NotificationTemplatesService,
    BotNotifierClient,
    BotNotificationChannelsService,
    UserNotificationsService,
  ],
  exports: [
    NotificationTemplatesService,
    BotNotifierClient,
    BotNotificationChannelsService,
    UserNotificationsService,
  ],
})
export class NotificationsModule {}
