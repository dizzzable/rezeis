import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { DashboardSummaryInterface } from '../interfaces/dashboard-summary.interface';
import { DashboardService } from '../services/dashboard.service';

@ApiTags('admin/dashboard')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/dashboard')
export class AdminDashboardController {
  public constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Returns the bounded KPI summary for the admin dashboard' })
  @ApiOkResponse({ description: 'Bounded KPI snapshot' })
  public getSummary(): Promise<DashboardSummaryInterface> {
    return this.dashboardService.getSummary();
  }
}
