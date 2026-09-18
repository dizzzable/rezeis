import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PurchaseChannel } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { InternalPlanCatalogQueryDto } from '../dto/internal-plan-catalog-query.dto';
import { PlanCatalogPlanInterface } from '../interfaces/plan-catalog.interface';
import { PlanCatalogService } from '../services/plan-catalog.service';

@Controller('internal/catalog')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalPlanCatalogController {
  public constructor(
    private readonly planCatalogService: PlanCatalogService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get('plans')
  public async getPlans(
    @Query() query: InternalPlanCatalogQueryDto,
  ): Promise<readonly PlanCatalogPlanInterface[]> {
    // Resolve the caller to a rezeis user id so the catalog is scoped to
    // their context (so paid trials + NEW/EXISTING/INVITED plans surface).
    // `userId` (CUID) wins; otherwise resolve the telegramId. An
    // unresolved/absent identity falls through to the anonymous catalog
    // (only `availability=ALL`).
    let userId = query.userId;
    if (userId === undefined && query.telegramId !== undefined && /^\d+$/.test(query.telegramId)) {
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(query.telegramId) },
        select: { id: true },
      });
      userId = user?.id;
    }
    return this.planCatalogService.getCatalogPlans({
      channel: query.channel ?? PurchaseChannel.WEB,
      userId,
    });
  }
}
