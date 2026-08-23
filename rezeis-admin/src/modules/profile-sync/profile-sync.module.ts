import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminDuplicateSubscriptionMergeController } from './duplicate-subscription-merge.controller';
import { DuplicateSubscriptionMergeService } from './duplicate-subscription-merge.service';
import { AdminPanelLinkReconciliationController } from './panel-link-reconciliation.controller';
import { PanelLinkReconciliationService } from './panel-link-reconciliation.service';
import { PROFILE_SYNC_QUEUE } from './profile-sync.constants';
import { ProfileSyncProcessor } from './profile-sync.processor';
import { ProfileSyncQueueService } from './profile-sync-queue.service';
import { RemnawaveProfileNamingService } from './remnawave-profile-naming.service';

/**
 * Async Remnawave profile provisioning via BullMQ.
 */
@Module({
  imports: [
    // `AuthModule` supplies `AdminJwtAuthGuard` for the operator-facing
    // reconciliation route; the RBAC guard comes from its global module.
    AuthModule,
    RemnawaveModule,
    SettingsModule,
    BullModule.registerQueue({ name: PROFILE_SYNC_QUEUE }),
  ],
  controllers: [AdminPanelLinkReconciliationController, AdminDuplicateSubscriptionMergeController],
  providers: [
    DuplicateSubscriptionMergeService,
    PanelLinkReconciliationService,
    ProfileSyncProcessor,
    ProfileSyncQueueService,
    RemnawaveProfileNamingService,
  ],
  exports: [
    DuplicateSubscriptionMergeService,
    PanelLinkReconciliationService,
    ProfileSyncQueueService,
    RemnawaveProfileNamingService,
  ],
})
export class ProfileSyncModule {}
