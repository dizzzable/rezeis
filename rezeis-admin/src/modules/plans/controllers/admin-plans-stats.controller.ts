import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  PlansStatsResultInterface,
  PlansStatsService,
} from '../services/plans-stats.service';

function parseBoundary(value: string | undefined, label: 'from' | 'to'): Date | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid ${label} date`);
  }
  return parsed;
}

@Controller('admin/plans/stats')
@UseGuards(AdminJwtAuthGuard)
export class AdminPlansStatsController {
  public constructor(private readonly plansStatsService: PlansStatsService) {}

  @Get()
  public async getStats(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('planId') planId?: string,
  ): Promise<PlansStatsResultInterface> {
    return this.plansStatsService.getStats({
      from: parseBoundary(from, 'from'),
      to: parseBoundary(to, 'to'),
      planId: planId && planId.length > 0 ? planId : undefined,
    });
  }
}
