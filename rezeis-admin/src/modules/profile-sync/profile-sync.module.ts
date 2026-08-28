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
 *
 * Every panel call in this module goes through `PanelUsersClient`, which
 * `RemnawaveModule` both provides and exports — so there is nothing to declare
 * here beyond that import. Injecting it by class token rather than re-providing
 * it locally is what keeps ONE executor, and therefore one `LegacyPanelRefusal`
 * and one cached version answer, in front of the whole process; a second
 * provider would give this module its own transport and its own idea of which
 * panel it is talking to.
 */
@Module({
  imports: [
    // `AuthModule` supplies `AdminJwtAuthGuard` for the operator-facing
    // reconciliation route; the RBAC guard comes from its global module.
    AuthModule,
    // `PanelUsersClient` for the processor, the expiry sweep, the
    // reconciliation sweep and the duplicate merge.
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
