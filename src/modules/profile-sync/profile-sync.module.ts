import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { redisConfig } from '../../common/config/redis.config';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { PROFILE_SYNC_QUEUE } from './profile-sync.constants';
import { ProfileSyncProcessor } from './profile-sync.processor';
import { ProfileSyncQueueService } from './profile-sync-queue.service';
import { RemnawaveProfileNamingService } from './remnawave-profile-naming.service';

/**
 * Async Remnawave profile provisioning via BullMQ.
 *
 * Donor parity: altshop uses Taskiq tasks for the same purpose. We use
 * BullMQ because the rest of rezeis-admin already depends on it (payments
 * reconciliation queue).
 */
@Module({
  imports: [
    RemnawaveModule,
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (configuration: ConfigType<typeof redisConfig>) => ({
        connection: { url: configuration.url },
      }),
    }),
    BullModule.registerQueue({ name: PROFILE_SYNC_QUEUE }),
  ],
  providers: [ProfileSyncProcessor, ProfileSyncQueueService, RemnawaveProfileNamingService],
  exports: [ProfileSyncQueueService, RemnawaveProfileNamingService],
})
export class ProfileSyncModule {}
