import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  AnalyticsWindowQueryDto,
  TopPayersQueryDto,
} from '../dto/analytics-query.dto';
import { BusinessAnalyticsService } from '../services/business-analytics.service';

/**
 * Admin Business Analytics — Phase 7.
 *
 * Exposes a single bundled endpoint for the dashboard
 * (`/admin/analytics/overview`) plus targeted endpoints for the heavier
 * cohort/LTV/top-payers panels (kept separate so the dashboard load
 * doesn't pay for what it doesn't render on first paint).
 *
 * Permission: `analytics:view` (auto-registered in `rbac.resources.ts`).
 *
 * Backwards compatibility
 *   The legacy frontend hit `/admin/business-analytics?days=30` — we
 *   keep that path as an alias to `overview` so the existing
 *   `analytics-page.tsx` and any saved bookmarks keep working.
 */
@ApiTags('admin/analytics')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller()
export class AdminAnalyticsController {
  public constructor(private readonly analyticsService: BusinessAnalyticsService) {}

  @Get('admin/analytics/overview')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Bundled KPI report (KPIs + churn + funnel + providers + daily series)' })
  public getOverview(@Query() query: AnalyticsWindowQueryDto) {
    return this.analyticsService.getAdvancedReport(query.days ?? 30);
  }

  @Get('admin/business-analytics')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Legacy alias for the overview endpoint' })
  public getOverviewLegacy(@Query() query: AnalyticsWindowQueryDto) {
    return this.analyticsService.getAdvancedReport(query.days ?? 30);
  }

  @Get('admin/analytics/cohorts')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Month-over-month retention cohort matrix' })
  public async getCohorts() {
    const cohorts = await this.analyticsService.getCohortRetention();
    return { cohorts };
  }

  @Get('admin/analytics/top-payers')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Leaderboard of users by lifetime spend' })
  public async getTopPayers(@Query() query: TopPayersQueryDto) {
    const payers = await this.analyticsService.getTopPayers(query.limit ?? 20);
    return { payers };
  }

  @Get('admin/analytics/ltv-distribution')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Histogram of paying-user lifetime value' })
  public async getLtvDistribution() {
    const buckets = await this.analyticsService.getLtvDistribution();
    return { buckets };
  }

  @Get('admin/analytics/baseline')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Original 7-day baseline report (kept for the dashboard widget)' })
  public getBaseline() {
    return this.analyticsService.getReport();
  }

  @Get('admin/analytics/trial-conversion')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Trial-to-paid conversion metrics' })
  public getTrialConversion(@Query() query: AnalyticsWindowQueryDto) {
    return this.analyticsService.getTrialConversion(query.days ?? 30);
  }

  @Get('admin/analytics/revenue-by-currency')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Revenue breakdown by currency' })
  public getRevenueByCurrency(@Query() query: AnalyticsWindowQueryDto) {
    return this.analyticsService.getRevenueByCurrency(query.days ?? 30);
  }

  @Get('admin/analytics/subscriptions-by-plan')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Active subscription distribution by plan' })
  public getSubscriptionsByPlan() {
    return this.analyticsService.getSubscriptionsByPlan();
  }

  @Get('admin/analytics/surfaces')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Usage surfaces (tma/pwa/browser), form factors, OS + PWA installs' })
  public getSurfaceAnalytics() {
    return this.analyticsService.getSurfaceAnalytics();
  }
}
