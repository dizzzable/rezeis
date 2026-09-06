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
 * ── There is no email leg here, and there never was ─────────────────────
 *
 * This block used to claim a "per-channel email bridge reads the same
 * `UserNotificationEvent` rows on its own schedule". No such schedule exists:
 * the only readers of that table are the cabinet feed, the auto-renew dedup,
 * the broadcast, and the retention deleter. Email is absent from
 * `NOTIFICATION_DELIVERY_CHANNELS` and from `fanout()` alike.
 *
 * What DOES exist is `EmailEventBridgeService`, and it hangs off a different
 * stream entirely: `SystemEventsService`, matching an active
 * `NotificationTemplate` whose type equals the dotted EVENT type. Only three
 * dotted types have templates, and auto-renew emits no system events at all —
 * so the expiry mail its own docstring advertises is unreachable by
 * construction, not merely unconfigured.
 *
 * Two things follow, and both are worth knowing before wiring anything:
 *
 *  - `NotificationTemplate.isActive` is ONE flag shared by Telegram, web-push
 *    and this bridge. Switching a template off to stop email silently kills
 *    the other two channels for that type.
 *  - Turning the email leg on is an outward-facing change: it starts sending
 *    mail to customers who linked an address for sign-in and never asked for
 *    notifications there. It needs an operator switch of its own, not a code
 *    change that quietly starts delivering.
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
