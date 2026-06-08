import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PlansModule } from '../plans/plans.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
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
  imports: [AuthModule, PlansModule, RbacModule, ProfileSyncModule],
  controllers: [AdminSubscriptionsController, InternalSubscriptionsController],
  providers: [
    SubscriptionQuoteService,
    SubscriptionRenewalService,
    SubscriptionMutationsService,
    SubscriptionDeletionService,
    PlanSnapshotSyncService,
    AdminSubscriptionsListService,
  ],
  exports: [
    SubscriptionQuoteService,
    SubscriptionRenewalService,
    SubscriptionMutationsService,
    PlanSnapshotSyncService,
  ],
})
export class SubscriptionsModule {}
