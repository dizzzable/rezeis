import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminPaymentAnalyticsController } from './controllers/admin-payment-analytics.controller';
import { PaymentAnalyticsService } from './services/payment-analytics.service';

/**
 * Payment-analytics module.
 *
 * Lives separately from `business-analytics` because it's tied to the
 * payment subdomain (transactions + webhook events) and pulls heavier
 * percentile aggregates that aren't a fit for the dashboard's
 * everyone-touches-everything bundle.
 *
 * Exposes:
 *   - `GET /admin/analytics/payments/providers?days=N`
 *   - `GET /admin/analytics/payments/webhooks?days=N`
 *
 * Both endpoints are guarded by the existing `analytics:view` permission.
 */
@Module({
  imports: [AuthModule, RbacModule],
  controllers: [AdminPaymentAnalyticsController],
  providers: [PaymentAnalyticsService],
  exports: [PaymentAnalyticsService],
})
export class PaymentAnalyticsModule {}
