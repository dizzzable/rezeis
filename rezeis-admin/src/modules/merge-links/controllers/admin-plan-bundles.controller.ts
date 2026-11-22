import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { AdminPlanBundleCreateDto, AdminPlanBundleUpdateDto } from '../dto/admin-plan-bundle.dto';
import { PlanBundleInterface } from '../interfaces/plan-bundle.interface';
import { PlanBundlesService } from '../services/plan-bundles.service';

/**
 * «Объединить тарифы» — the plans page's grouping dialog.
 *
 * A separate controller rather than four more routes on `admin/plans`: that
 * controller's comment records the release where a literal path declared after
 * `@Get(':planId')` became unreachable, and a new prefix sidesteps the question
 * entirely. The permissions are the plans ones on purpose — a bundle is a
 * property of the catalogue, not a new kind of object to grant separately.
 */
@Controller('admin/plan-bundles')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('plans', 'view')
export class AdminPlanBundlesController {
  public constructor(private readonly planBundlesService: PlanBundlesService) {}

  @Get()
  public list(): Promise<readonly PlanBundleInterface[]> {
    return this.planBundlesService.list();
  }

  @Post()
  @RequirePermission('plans', 'create')
  public create(@Body() body: AdminPlanBundleCreateDto): Promise<PlanBundleInterface> {
    return this.planBundlesService.create(body);
  }

  @Patch(':id')
  @RequirePermission('plans', 'edit')
  public update(
    @Param('id') id: string,
    @Body() body: AdminPlanBundleUpdateDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<PlanBundleInterface> {
    return this.planBundlesService.update(id, body, {
      currentAdmin: admin,
      requestMetadata: extractRequestMetadata(req),
    });
  }

  @Delete(':id')
  @RequirePermission('plans', 'delete')
  public async delete(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<{ deleted: true }> {
    await this.planBundlesService.delete(id, {
      currentAdmin: admin,
      requestMetadata: extractRequestMetadata(req),
    });
    return { deleted: true };
  }
}
