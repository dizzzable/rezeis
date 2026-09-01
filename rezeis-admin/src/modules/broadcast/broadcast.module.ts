import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { CustomEmojiModule } from '../custom-emoji/custom-emoji.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReiwaRelayModule } from '../notifications/reiwa-relay.module';
import { SettingsModule } from '../settings/settings.module';
import { BROADCAST_DELIVERY_QUEUE } from './broadcast.constants';
import { BroadcastProcessor } from './broadcast.processor';
import { AdminBroadcastController } from './controllers/admin-broadcast.controller';
import { BroadcastDeliveryService } from './services/broadcast-delivery.service';
import { BroadcastMediaUploadService } from './services/broadcast-media-upload.service';
import { BroadcastQueueService } from './services/broadcast-queue.service';
import { BroadcastReconcilerService } from './services/broadcast-reconciler.service';
import { BroadcastService } from './services/broadcast.service';

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    NotificationsModule,
    // The operator-channel copy of a broadcast is a durable relay event, so
    // `BroadcastDeliveryService` needs the queue producer. `NotificationsModule`
    // imports `ReiwaRelayModule` but does not re-export it, and a provider is
    // resolved by the module that declares it — importing it here is what makes
    // the injection resolvable at boot rather than at `tsc` time only.
    ReiwaRelayModule,
    SettingsModule,
    CustomEmojiModule,
    BullModule.registerQueue({ name: BROADCAST_DELIVERY_QUEUE }),
  ],
  controllers: [AdminBroadcastController],
  providers: [
    BroadcastService,
    BroadcastDeliveryService,
    BroadcastMediaUploadService,
    BroadcastQueueService,
    BroadcastProcessor,
    BroadcastReconcilerService,
  ],
  exports: [BroadcastService, BroadcastDeliveryService, BroadcastQueueService],
})
export class BroadcastModule {}
