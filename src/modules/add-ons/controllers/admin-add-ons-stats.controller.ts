import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  AddOnsStatsResultInterface,
  AddOnsStatsService,
} from '../services/add-ons-stats.service';

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

@Controller('admin/add-ons/stats')
@UseGuards(AdminJwtAuthGuard)
export class AdminAddOnsStatsController {
  public constructor(private readonly addOnsStatsService: AddOnsStatsService) {}

  @Get()
  public async getStats(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AddOnsStatsResultInterface> {
    return this.addOnsStatsService.getStats({
      from: parseBoundary(from, 'from'),
      to: parseBoundary(to, 'to'),
    });
  }
}
