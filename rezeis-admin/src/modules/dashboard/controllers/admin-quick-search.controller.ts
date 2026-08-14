import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { QuickSearchQueryDto } from '../dto/quick-search-query.dto';
import { QuickSearchHitInterface } from '../interfaces/quick-search-result.interface';
import { QuickSearchService } from '../services/quick-search.service';

/**
 * Backs the Cmd+K overlay rendered in `quick-search-overlay.tsx`.
 *
 * Mounted under `/admin/quick-search` so the existing frontend client
 * (`api.get('/admin/quick-search')`) keeps working without changes.
 *
 * Permission model
 *   Two layers, and they answer different questions.
 *
 *   The outer one is `dashboard:view` on the route below: may this admin use
 *   the panel's global search at all. It is deliberately the weakest gate every
 *   signed-in operator already holds — `operator`, `support` and `finance` all
 *   seed it — because the overlay is panel chrome mounted in the admin shell,
 *   not a domain screen. Gating it on a domain permission would be a trap:
 *   `finance` holds `payments:view` and no `users:view`, so `users:view` here
 *   would take transaction lookup away from the role that exists to do it.
 *
 *   The inner one does the real narrowing and lives in the service:
 *   `QuickSearchService.search` resolves `users` / `subscriptions` / `payments`
 *   / `promocodes` / `partners` `:view` per caller and searches only the
 *   domains they hold. An admin with the gate but no domain permissions gets an
 *   empty list, not a leak.
 */
@ApiTags('admin/quick-search')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/quick-search')
export class AdminQuickSearchController {
  public constructor(private readonly quickSearchService: QuickSearchService) {}

  @Get()
  @RequirePermission('dashboard', 'view')
  @ApiOperation({ summary: 'Cross-domain admin search for the Cmd+K overlay' })
  @ApiOkResponse({ description: 'List of mixed-domain hits, capped at `limit`' })
  public search(
    @Query() query: QuickSearchQueryDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<QuickSearchHitInterface[]> {
    return this.quickSearchService.search({
      rawQuery: query.q,
      limit: query.limit,
      currentAdmin,
    });
  }
}
