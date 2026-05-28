import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalPushController } from './internal-push.controller';
import { WebPushService } from './services/web-push.service';

/**
 * InternalPushModule
 * ──────────────────
 * Browser web-push subscription persistence + delivery.
 *
 * `WebPushService` owns the `WebPushSubscription` table, talks to
 * push services (FCM / Mozilla / Apple) via the `web-push` library,
 * and is consumed by `UserNotificationsService` for fan-out alongside
 * the Telegram bot path. The controller exposes the SPA-facing
 * subscribe / unsubscribe endpoints + the VAPID public key.
 *
 * Disabled out-of-the-box — operator must generate VAPID keys with
 * `npx web-push generate-vapid-keys` and set the env vars before
 * subscriptions can deliver.
 */
@Module({
  imports: [AuthModule],
  controllers: [InternalPushController],
  providers: [WebPushService],
  exports: [WebPushService],
})
export class InternalPushModule {}
