import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PartnersModule } from '../partners/partners.module';
import { AdminReferralsController } from './controllers/admin-referrals.controller';
import { InternalReferralsController } from './controllers/internal-referrals.controller';
import { AdminReferralAnalyticsService } from './services/admin-referral-analytics.service';
import { AdminRewardsService } from './services/admin-rewards.service';
import { ReferralInviteLimitsService } from './services/referral-invite-limits.service';
import { ReferralManualAttachService } from './services/referral-manual-attach.service';
import { ReferralPointsExchangeService } from './services/referral-points-exchange.service';
import { ReferralQualificationService } from './services/referral-qualification.service';
import { ReferralsService } from './services/referrals.service';

@Module({
  imports: [AuthModule, forwardRef(() => PartnersModule)],
  controllers: [AdminReferralsController, InternalReferralsController],
  providers: [
    ReferralsService,
    ReferralQualificationService,
    ReferralInviteLimitsService,
    ReferralPointsExchangeService,
    ReferralManualAttachService,
    AdminRewardsService,
    AdminReferralAnalyticsService,
  ],
  exports: [
    ReferralsService,
    ReferralQualificationService,
    ReferralInviteLimitsService,
    ReferralPointsExchangeService,
    ReferralManualAttachService,
    AdminRewardsService,
    AdminReferralAnalyticsService,
  ],
})
export class ReferralsModule {}
