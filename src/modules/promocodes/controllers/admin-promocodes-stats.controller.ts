import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  PromocodesStatsResultInterface,
  PromocodesStatsService,
} from '../services/promocodes-stats.service';

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

@Controller('admin/promocodes/stats')
@UseGuards(AdminJwtAuthGuard)
export class AdminPromocodesStatsController {
  public constructor(private readonly promocodesStatsService: PromocodesStatsService) {}

  @Get()
  public async getStats(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('promocodeId') promocodeId?: string,
  ): Promise<PromocodesStatsResultInterface> {
    return this.promocodesStatsService.getStats({
      from: parseBoundary(from, 'from'),
      to: parseBoundary(to, 'to'),
      promocodeId: promocodeId && promocodeId.length > 0 ? promocodeId : undefined,
    });
  }
}
