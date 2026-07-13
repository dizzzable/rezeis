import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { RemnawaveModule } from '../remnawave/remnawave.module';
import { SettingsModule } from '../settings/settings.module';
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
    SettingsModule,
    BullModule.registerQueue({ name: PROFILE_SYNC_QUEUE }),
  ],
  providers: [
    ProfileSyncProcessor,
    ProfileSyncQueueService,
    RemnawaveProfileNamingService,
  ],
  exports: [ProfileSyncQueueService, RemnawaveProfileNamingService],
})
export class ProfileSyncModule {}
