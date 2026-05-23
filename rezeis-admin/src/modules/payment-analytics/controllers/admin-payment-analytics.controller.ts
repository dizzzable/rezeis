import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { PaymentAnalyticsWindowQueryDto } from '../dto/payment-analytics-query.dto';
import { PaymentAnalyticsService } from '../services/payment-analytics.service';

/**
 * Admin payment-analytics controller.
 *
 * Sits next to the broader business-analytics one but is bound to the
 * payment subdomain so its results are easy to discover and so we don't
 * fight for the `analytics:view` permission slot when we eventually add
 * payment-only roles. The permission is shared today and can be split
 * later without breaking URLs.
 */
@ApiTags('admin/payment-analytics')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller()
export class AdminPaymentAnalyticsController {
  public constructor(private readonly analyticsService: PaymentAnalyticsService) {}

  @Get('admin/analytics/payments/providers')
  @RequirePermission('analytics', 'view')
  @ApiOperation({
    summary: 'Per-gateway payment performance report',
    description:
      'Aggregates transactions in the requested window into a per-provider breakdown: GMV, ' +
      'success/checkout rates, percentile time-to-pay, top failure reasons, channel mix, ' +
      'period-over-period delta and a daily trend series for sparklines.',
  })
  public getProviders(@Query() query: PaymentAnalyticsWindowQueryDto) {
    return this.analyticsService.getProviderReport(query.days ?? 30);
  }

  @Get('admin/analytics/payments/webhooks')
  @RequirePermission('analytics', 'view')
  @ApiOperation({
    summary: 'Webhook health report',
    description:
      'Delivery rate, replay rate, latency percentiles and top errors per gateway, plus the ' +
      'global reconciliation gap (transactions without a webhook and webhooks without a transaction).',
  })
  public getWebhookHealth(@Query() query: PaymentAnalyticsWindowQueryDto) {
    return this.analyticsService.getWebhookHealth(query.days ?? 7);
  }
}
