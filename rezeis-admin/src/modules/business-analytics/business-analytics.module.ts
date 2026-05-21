import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminAnalyticsController } from './controllers/admin-analytics.controller';
import { BusinessAnalyticsService } from './services/business-analytics.service';

/**
 * Business analytics module — chart-ready aggregation for the admin UI.
 *
 * Provides:
 *  - User growth metrics (total, new today/week/month, blocked)
 *  - Subscription funnel (active/trial/expired/disabled/deleted)
 *  - Revenue by gateway
 *  - 7-day daily revenue / new users time series
 *  - Phase 7: KPI/churn/funnel/provider-health bundle, cohort retention,
 *    top payers, LTV distribution.
 */
@Module({
  imports: [AuthModule, RbacModule],
  controllers: [AdminAnalyticsController],
  providers: [BusinessAnalyticsService],
  exports: [BusinessAnalyticsService],
})
export class BusinessAnalyticsModule {}
