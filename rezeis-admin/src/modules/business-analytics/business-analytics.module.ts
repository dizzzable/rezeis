import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FxModule } from '../fx/fx.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminAnalyticsController } from './controllers/admin-analytics.controller';
import { BusinessAnalyticsService } from './services/business-analytics.service';

/**
 * Business analytics module — chart-ready aggregation for the admin UI.
 *
 * Provides the «Бизнес-аналитика» reports: the KPI/churn/funnel/payment-system
 * overview, revenue breakdowns, trial conversion, cohort retention, the
 * subscriptions ending in the coming month, top payers, LTV, and the usage
 * surfaces.
 *
 * `FxModule` is imported for the reporting base currency: money in several
 * currencies is stated in it, converted with the panel's own rates.
 * `SettingsModule` is imported for the operator's time zone, the calendar every
 * report counts its days in.
 */
@Module({
  imports: [AuthModule, RbacModule, FxModule, SettingsModule],
  controllers: [AdminAnalyticsController],
  providers: [BusinessAnalyticsService],
  exports: [BusinessAnalyticsService],
})
export class BusinessAnalyticsModule {}
