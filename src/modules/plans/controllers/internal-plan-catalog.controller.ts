import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PurchaseChannel } from '@prisma/client';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { InternalPlanCatalogQueryDto } from '../dto/internal-plan-catalog-query.dto';
import { PlanCatalogPlanInterface } from '../interfaces/plan-catalog.interface';
import { PlanCatalogService } from '../services/plan-catalog.service';

@Controller('internal/catalog')
@UseGuards(InternalAdminAuthGuard)
export class InternalPlanCatalogController {
  public constructor(private readonly planCatalogService: PlanCatalogService) {}

  @Get('plans')
  public async getPlans(
    @Query() query: InternalPlanCatalogQueryDto,
  ): Promise<readonly PlanCatalogPlanInterface[]> {
    return this.planCatalogService.getCatalogPlans({
      channel: query.channel ?? PurchaseChannel.WEB,
      userId: query.userId,
    });
  }
}
