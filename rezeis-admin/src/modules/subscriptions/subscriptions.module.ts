import { Module } from '@nestjs/common';

import { AddOnEntitlementsModule } from '../add-on-entitlements/add-on-entitlements.module';
import { AddOnsModule } from '../add-ons/add-ons.module';
import { AuthModule } from '../auth/auth.module';
import { PlansModule } from '../plans/plans.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { ExpiredProfileCleanupService } from '../profile-sync/expired-profile-cleanup.service';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { SettingsModule } from '../settings/settings.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminSubscriptionsController } from './controllers/admin-subscriptions.controller';
import { InternalSubscriptionsController } from './controllers/internal-subscriptions.controller';
import { AdminSubscriptionsListService } from './services/admin-subscriptions-list.service';
import { PlanSnapshotSyncService } from './services/plan-snapshot-sync.service';
import { SubscriptionDeletionService } from './services/subscription-deletion.service';
import { SubscriptionMutationsService } from './services/subscription-mutations.service';
import { SubscriptionQuoteService } from './services/subscription-quote.service';
import { SubscriptionRenewalService } from './services/subscription-renewal.service';

@Module({
  // AuthModule supplies InternalAdminAuthGuard (used by
  // InternalSubscriptionsController) along with the JwtModule it
  // depends on through the Phase 4 AuthModule re-export.
  imports: [
    AddOnEntitlementsModule,
    AddOnsModule,
    AuthModule,
    PlansModule,
    RbacModule,
    ProfileSyncModule,
    RemnawaveModule,
    SettingsModule,
  ],
  controllers: [AdminSubscriptionsController, InternalSubscriptionsController],
  providers: [
    SubscriptionQuoteService,
    SubscriptionRenewalService,
    SubscriptionMutationsService,
    SubscriptionDeletionService,
    ExpiredProfileCleanupService,
    PlanSnapshotSyncService,
    AdminSubscriptionsListService,
  ],
  exports: [
    SubscriptionQuoteService,
    SubscriptionRenewalService,
    SubscriptionMutationsService,
    SubscriptionDeletionService,
    PlanSnapshotSyncService,
  ],
})
export class SubscriptionsModule {}
