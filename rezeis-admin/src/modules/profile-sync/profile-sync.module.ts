import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { RemnawaveModule } from '../remnawave/remnawave.module';
import { ExpiredProfileCleanupService } from './expired-profile-cleanup.service';
import { PROFILE_SYNC_QUEUE } from './profile-sync.constants';
import { ProfileSyncProcessor } from './profile-sync.processor';
import { ProfileSyncQueueService } from './profile-sync-queue.service';
import { RemnawaveProfileNamingService } from './remnawave-profile-naming.service';

/**
 * Async Remnawave profile provisioning via BullMQ.
 */
@Module({
  imports: [
    RemnawaveModule,
    BullModule.registerQueue({ name: PROFILE_SYNC_QUEUE }),
  ],
  providers: [
    ProfileSyncProcessor,
    ProfileSyncQueueService,
    RemnawaveProfileNamingService,
    ExpiredProfileCleanupService,
  ],
  exports: [ProfileSyncQueueService, RemnawaveProfileNamingService],
})
export class ProfileSyncModule {}
