import { Module } from '@nestjs/common';

import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { AdminAddOnEntitlementsController } from './controllers/admin-add-on-entitlements.controller';
import { AddOnEntitlementService } from './services/add-on-entitlement.service';
import { AddOnEntitlementInspectionService } from './services/add-on-entitlement-inspection.service';
import { AddOnEntitlementRemediationService } from './services/add-on-entitlement-remediation.service';
import { DeviceReductionExecutionService } from './services/device-reduction-execution.service';
import { DeviceReductionPlanService } from './services/device-reduction-plan.service';
import { EffectiveProjectionService } from './services/effective-projection.service';
import { EntitlementBoundaryService } from './services/entitlement-boundary.service';
import { EntitlementBoundarySchedulerService } from './services/entitlement-boundary-scheduler.service';
import { EntitlementCutoverService } from './services/entitlement-cutover.service';
import { EntitlementMetricsService } from './services/entitlement-metrics.service';
import { SubscriptionTermService } from './services/subscription-term.service';

@Module({
  imports: [PrismaModule, AuthModule, RemnawaveModule, ProfileSyncModule],
  controllers: [AdminAddOnEntitlementsController],
  providers: [
    AddOnEntitlementService,
    SubscriptionTermService,
    EffectiveProjectionService,
    EntitlementCutoverService,
    DeviceReductionPlanService,
    DeviceReductionExecutionService,
    EntitlementBoundaryService,
    EntitlementBoundarySchedulerService,
    EntitlementMetricsService,
    AddOnEntitlementInspectionService,
    AddOnEntitlementRemediationService,
  ],
  exports: [
    AddOnEntitlementService,
    SubscriptionTermService,
    EffectiveProjectionService,
    EntitlementCutoverService,
    DeviceReductionPlanService,
    DeviceReductionExecutionService,
    EntitlementBoundaryService,
    EntitlementBoundarySchedulerService,
    EntitlementMetricsService,
    AddOnEntitlementInspectionService,
    AddOnEntitlementRemediationService,
  ],
})
export class AddOnEntitlementsModule {}
