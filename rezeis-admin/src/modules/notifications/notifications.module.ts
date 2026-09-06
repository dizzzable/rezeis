import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalPushModule } from '../push/internal-push.module';
import { CustomEmojiModule } from '../custom-emoji/custom-emoji.module';
import { ReiwaRelayModule } from './reiwa-relay.module';
import { TelegramDirectModule } from './telegram-direct.module';
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
 *   - email, when the operator has switched it on (see below).
 *
 * ── The email leg, and what it is not ───────────────────────────────────
 *
 * This block used to claim a "per-channel email bridge reads the same
 * `UserNotificationEvent` rows on its own schedule". No such schedule ever
 * existed: the only readers of that table are the cabinet feed, the
 * auto-renew dedup, the broadcast, and the retention deleter. The cabinet
 * meanwhile told customers their notifications could arrive by mail.
 *
 * The leg is real now and rides `fanout()` with the other three, behind four
 * gates: the operator's `email.notifyUsers` switch (off until set), SMTP
 * being configured at all, a TEMPLATE render — never a `preRenderedText`
 * send, so broadcasts and support replies keep their own mailers instead of
 * arriving twice — and a VERIFIED address.
 *
 * `EmailEventBridgeService` is a different thing and still is: it hangs off
 * `SystemEventsService`, matching a template whose type equals the dotted
 * EVENT type. Only three dotted types have templates and auto-renew emits no
 * system events at all, so nothing about subscriber notifications reaches it.
 *
 * One trap remains, and it is worth knowing before touching a template:
 * `NotificationTemplate.isActive` is ONE flag shared by Telegram, web-push
 * and email. Switching a template off to stop the mail silently kills the
 * other two channels for that type.
 */
@Module({
  imports: [AuthModule, InternalPushModule, CustomEmojiModule, ReiwaRelayModule, TelegramDirectModule],
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
