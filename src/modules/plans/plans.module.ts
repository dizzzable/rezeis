import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { PlanSnapshotSyncService } from '../subscriptions/services/plan-snapshot-sync.service';
import { AdminPlansController } from './controllers/admin-plans.controller';
import { AdminPlansStatsController } from './controllers/admin-plans-stats.controller';
import { InternalPlanCatalogController } from './controllers/internal-plan-catalog.controller';
import { PlanCatalogService } from './services/plan-catalog.service';
import { PlansAdminService } from './services/plans-admin.service';
import { PlansAdminValidators } from './services/plans-admin.validators';
import { PlansStatsService } from './services/plans-stats.service';
import { PricingService } from './services/pricing.service';

@Module({
  imports: [AuthModule, RemnawaveModule],
  controllers: [AdminPlansController, AdminPlansStatsController, InternalPlanCatalogController],
  providers: [
    PricingService,
    PlanCatalogService,
    PlansAdminService,
    PlansAdminValidators,
    PlanSnapshotSyncService,
    PlansStatsService,
  ],
  exports: [PlanCatalogService, PricingService, PlanSnapshotSyncService],
})
export class PlansModule {}
