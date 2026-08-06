import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { PlanSnapshotSyncService } from '../subscriptions/services/plan-snapshot-sync.service';
import { AdminPlansController } from './controllers/admin-plans.controller';
import { AdminPlansStatsController } from './controllers/admin-plans-stats.controller';
import { InternalPlanCatalogController } from './controllers/internal-plan-catalog.controller';
import { PlanCatalogService } from './services/plan-catalog.service';
import { PlanSquadPropagationService } from './services/plan-squad-propagation.service';
import { PlansAdminService } from './services/plans-admin.service';
import { PlansAdminValidators } from './services/plans-admin.validators';
import { PlansStatsService } from './services/plans-stats.service';
import { PricingService } from './services/pricing.service';

@Module({
  // `ProfileSyncModule` supplies the queue a plan squad edit fans out onto —
  // see `PlanSquadPropagationService`.
  imports: [AuthModule, ProfileSyncModule, RemnawaveModule],
  controllers: [AdminPlansController, AdminPlansStatsController, InternalPlanCatalogController],
  providers: [
    PricingService,
    PlanCatalogService,
    PlanSquadPropagationService,
    PlansAdminService,
    PlansAdminValidators,
    PlanSnapshotSyncService,
    PlansStatsService,
  ],
  exports: [PlanCatalogService, PricingService, PlanSnapshotSyncService],
})
export class PlansModule {}
