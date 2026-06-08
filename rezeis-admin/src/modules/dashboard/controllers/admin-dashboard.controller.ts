import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { DashboardSummaryInterface } from '../interfaces/dashboard-summary.interface';
import { SystemHealthResponse } from '../interfaces/system-health.interface';
import { DashboardService } from '../services/dashboard.service';
import { SystemHealthService } from '../services/system-health.service';

/**
 * Dashboard endpoints are polled by the SPA (summary every 30 s,
 * system-health every 10 s). They are read-only metrics behind admin
 * auth, so the global 60-req/min throttle would falsely flag a normal
 * dashboard session as abuse. We opt them out explicitly.
 */
@ApiTags('admin/dashboard')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@SkipThrottle()
@Controller('admin/dashboard')
export class AdminDashboardController {
  public constructor(
    private readonly dashboardService: DashboardService,
    private readonly systemHealthService: SystemHealthService,
  ) {}

  @Get('summary')
  @RequirePermission('dashboard', 'view')
  @ApiOperation({ summary: 'Returns the bounded KPI summary for the admin dashboard' })
  @ApiOkResponse({ description: 'Bounded KPI snapshot' })
  public getSummary(): Promise<DashboardSummaryInterface> {
    return this.dashboardService.getSummary();
  }

  @Get('system-health')
  @RequirePermission('dashboard', 'view')
  @ApiOperation({ summary: 'Returns real-time VPS and process health metrics' })
  @ApiOkResponse({ description: 'System health snapshot with CPU, RAM, disk, and process metrics' })
  public getSystemHealth(): Promise<SystemHealthResponse> {
    return this.systemHealthService.getSystemHealth();
  }

  @Get('system-health/reiwa')
  @RequirePermission('dashboard', 'view')
  @ApiOperation({ summary: "Returns the reiwa server's VPS and process metrics (null when unavailable)" })
  @ApiOkResponse({ description: 'reiwa system health snapshot, or null when reiwa is unreachable/unconfigured' })
  public getReiwaSystemHealth(): Promise<SystemHealthResponse | null> {
    return this.systemHealthService.getReiwaSystemHealth();
  }
}
