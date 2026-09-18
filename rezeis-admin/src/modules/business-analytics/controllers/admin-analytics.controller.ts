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
 * Admin Business Analytics — the «Бизнес-аналитика» page's reports.
 *
 * Permission: `analytics:view` (auto-registered in `rbac.resources.ts`) on
 * EVERY route — the page asks for nothing else, so an operator who may open it
 * never meets a 403 on one of its cards.
 *
 * Removed in the 2026-09 review, with nothing left calling them (both repos
 * searched): `/admin/business-analytics` (an alias of the overview),
 * `/admin/analytics/baseline` (a 7-day report that summed money across
 * currencies and dated payments by `updated_at`) and
 * `/admin/analytics/revenue-by-currency` (superseded by `/admin/analytics/revenue`).
 */
@ApiTags('admin/analytics')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller()
export class AdminAnalyticsController {
  public constructor(private readonly analyticsService: BusinessAnalyticsService) {}

  @Get('admin/analytics/overview')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'KPIs against the previous window, their series, the funnel and the payment systems' })
  public getOverview(@Query() query: AnalyticsWindowQueryDto) {
    return this.analyticsService.getAdvancedReport(query.days ?? 30);
  }

  @Get('admin/analytics/revenue')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Revenue of the window by bar, currency, kind of purchase, plan and payment system' })
  public getRevenue(@Query() query: AnalyticsWindowQueryDto) {
    return this.analyticsService.getRevenueReport(query.days ?? 30);
  }

  @Get('admin/analytics/cohorts')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Month-over-month retention cohort matrix' })
  public async getCohorts() {
    const cohorts = await this.analyticsService.getCohortRetention();
    return { cohorts };
  }

  @Get('admin/analytics/expiring')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Live subscriptions ending in the coming 30 days, by day and by whether autopay will charge' })
  public getExpiring() {
    return this.analyticsService.getExpiring();
  }

  @Get('admin/analytics/top-payers')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Leaderboard of users by lifetime spend' })
  public getTopPayers(@Query() query: TopPayersQueryDto) {
    return this.analyticsService.getTopPayers(query.limit ?? 20);
  }

  @Get('admin/analytics/ltv-distribution')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Histogram of paying-user lifetime value' })
  public getLtvDistribution() {
    return this.analyticsService.getLtvDistribution();
  }

  @Get('admin/analytics/trial-conversion')
  @RequirePermission('analytics', 'view')
  @ApiOperation({ summary: 'Trial-to-paid conversion and the time customers take to pay first' })
  public getTrialConversion(@Query() query: AnalyticsWindowQueryDto) {
    return this.analyticsService.getTrialConversion(query.days ?? 30);
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
