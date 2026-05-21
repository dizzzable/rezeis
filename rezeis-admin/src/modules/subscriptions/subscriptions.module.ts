import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PlansModule } from '../plans/plans.module';
import { AdminSubscriptionsController } from './controllers/admin-subscriptions.controller';
import { InternalSubscriptionsController } from './controllers/internal-subscriptions.controller';
import { PlanSnapshotSyncService } from './services/plan-snapshot-sync.service';
import { SubscriptionMutationsService } from './services/subscription-mutations.service';
import { SubscriptionQuoteService } from './services/subscription-quote.service';

@Module({
  // AuthModule supplies InternalAdminAuthGuard (used by
  // InternalSubscriptionsController) along with the JwtModule it
  // depends on through the Phase 4 AuthModule re-export.
  imports: [AuthModule, PlansModule],
  controllers: [AdminSubscriptionsController, InternalSubscriptionsController],
  providers: [SubscriptionQuoteService, SubscriptionMutationsService, PlanSnapshotSyncService],
  exports: [SubscriptionQuoteService, SubscriptionMutationsService, PlanSnapshotSyncService],
})
export class SubscriptionsModule {}
