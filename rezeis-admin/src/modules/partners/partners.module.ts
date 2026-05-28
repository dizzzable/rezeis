import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminPartnersController } from './controllers/admin-partners.controller';
import { InternalPartnerController } from './controllers/internal-partner.controller';
import { AdminPartnerAnalyticsService } from './services/admin-partner-analytics.service';
import { PartnerCsvExportService } from './services/partner-csv-export.service';
import { PartnerDetailService } from './services/partner-detail.service';
import { PartnerEarningsService } from './services/partner-earnings.service';
import { PartnerNotificationsService } from './services/partner-notifications.service';
import { PartnersService } from './services/partners.service';

/**
 * Partner program module — donor: altshop `src/services/partner*.py`.
 *
 * The module exposes:
 *  - admin CRUD + withdrawal lifecycle under `/admin/partners`
 *  - per-partner detail (overview/earnings/referrals/withdrawals/audit)
 *  - analytics (funnel/timeseries/top/level/gateway/throughput)
 *  - internal user-facing endpoints under `/internal/user/:telegramId/partner`
 *  - `PartnerEarningsService` for post-payment accrual (called by payments
 *    module) and retroactive partner-referral chain backfill on activation
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AdminPartnersController, InternalPartnerController],
  providers: [
    PartnersService,
    PartnerEarningsService,
    PartnerDetailService,
    AdminPartnerAnalyticsService,
    PartnerCsvExportService,
    PartnerNotificationsService,
  ],
  exports: [
    PartnersService,
    PartnerEarningsService,
    PartnerDetailService,
    AdminPartnerAnalyticsService,
    PartnerCsvExportService,
    PartnerNotificationsService,
  ],
})
export class PartnersModule {}
