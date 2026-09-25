import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { ADD_ON_CUTOVER_QUEUE } from './add-on-cutover.constants';
import { ADD_ON_EXPIRY_NOTICE_QUEUE } from './addon-expiry-notice.constants';
import { AddOnExpiryNoticeProcessor } from './addon-expiry-notice.processor';
import { AdminAddOnEntitlementsController } from './controllers/admin-add-on-entitlements.controller';
import { EntitlementCutoverProcessor } from './entitlement-cutover.processor';
import { AddOnEntitlementService } from './services/add-on-entitlement.service';
import { AddOnEntitlementInspectionService } from './services/add-on-entitlement-inspection.service';
import { AddOnEntitlementRemediationService } from './services/add-on-entitlement-remediation.service';
import { AddOnExpiryNoticeService } from './services/addon-expiry-notice.service';
import { DeviceReductionExecutionService } from './services/device-reduction-execution.service';
import { DeviceReductionPlanService } from './services/device-reduction-plan.service';
import { EffectiveProjectionService } from './services/effective-projection.service';
import { EntitlementBoundaryService } from './services/entitlement-boundary.service';
import { EntitlementBoundarySchedulerService } from './services/entitlement-boundary-scheduler.service';
import { EntitlementCutoverService } from './services/entitlement-cutover.service';
import { EntitlementCutoverJobService } from './services/entitlement-cutover-job.service';
import { EntitlementMetricsService } from './services/entitlement-metrics.service';
import { ResetBoundaryConfirmationService } from './services/reset-boundary-confirmation.service';
import { ResetScheduleCheckService } from './services/reset-schedule-check.service';
import { SubscriptionTermHooksService } from './services/subscription-term-hooks.service';
import { SubscriptionTermService } from './services/subscription-term.service';
import { AddOnSwitchesModule } from './switches/add-on-switches.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    RemnawaveModule,
    ProfileSyncModule,
    // The stage switches («Доп. услуги» → «Настройки»): the cutover job, the
    // boundary sweep, the device reduction and the notices all read them.
    AddOnSwitchesModule,
    // The background cutover's own queue: one tick at a time under a fixed id
    // (`ADD_ON_CUTOVER_JOB_ID`), queued by `EntitlementCutoverJobService`.
    BullModule.registerQueue({ name: ADD_ON_CUTOVER_QUEUE }),
    // The customer's notices before and at a dated add-on's end: one pass at a
    // time under a fixed id (`ADD_ON_EXPIRY_NOTICE_JOB_ID`), queued by
    // `AddOnExpiryNoticeService`, sent through the one notification service.
    BullModule.registerQueue({ name: ADD_ON_EXPIRY_NOTICE_QUEUE }),
    NotificationsModule,
  ],
  controllers: [AdminAddOnEntitlementsController],
  providers: [
    AddOnEntitlementService,
    SubscriptionTermService,
    EffectiveProjectionService,
    EntitlementCutoverService,
    EntitlementCutoverJobService,
    EntitlementCutoverProcessor,
    DeviceReductionPlanService,
    DeviceReductionExecutionService,
    EntitlementBoundaryService,
    EntitlementBoundarySchedulerService,
    // The boundary sweep's confirmation of Remnawave's reset before it takes an
    // add-on «до сброса» off (and the incident when none comes).
    ResetBoundaryConfirmationService,
    // The daily check of Remnawave's resets against «Часовой пояс Remnawave».
    ResetScheduleCheckService,
    EntitlementMetricsService,
    AddOnEntitlementInspectionService,
    AddOnEntitlementRemediationService,
    SubscriptionTermHooksService,
    AddOnExpiryNoticeService,
    AddOnExpiryNoticeProcessor,
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
    // What a subscription writer OUTSIDE this module calls inside its own
    // transaction: entering the model, following an expiry, rotating a plan.
    SubscriptionTermHooksService,
  ],
})
export class AddOnEntitlementsModule {}
