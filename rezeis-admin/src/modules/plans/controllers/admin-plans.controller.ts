import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import {
  RequireAllPermissions,
  RequirePermission,
} from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { CreatePlanDto } from '../dto/create-plan.dto';
import { MovePlanDto } from '../dto/move-plan.dto';
import { ReorderPlansDto } from '../dto/reorder-plans.dto';
import { UpdatePlanDto } from '../dto/update-plan.dto';
import { AdminPlanInterface } from '../interfaces/admin-plan.interface';
import { PlanSquadPropagationStatus } from '../services/plan-squad-propagation.service';
import { AdminPlanUpdateResultInterface, PlansAdminService } from '../services/plans-admin.service';
import { RemnawaveSquadOptionInterface } from '../../remnawave/interfaces/remnawave-squad-option.interface';
import {
  UnknownSquadAuditService,
  type UnknownSquadReport,
} from '../services/unknown-squad-audit.service';

@Controller('admin/plans')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('plans', 'view')
export class AdminPlansController {
  public constructor(
    private readonly plansAdminService: PlansAdminService,
    private readonly unknownSquadAudit: UnknownSquadAuditService,
  ) {}

  /**
   * Subscriptions and plans still naming a squad the panel does not serve.
   *
   * MOUNTED BEFORE `@Get(':planId')`, and that is load-bearing. Nest registers
   * routes in declaration order and Express answers from the first match, so a
   * literal path declared after a `:param` route on the same prefix is
   * unreachable — this controller's own module comment records the release
   * where exactly that happened to `admin/plans/stats`.
   *
   * Read-only: it answers a question, it repairs nothing.
   *
   * Gated on `subscriptions:view` AS WELL as the controller's `plans:view`,
   * because the answer is a list of subscription and user identifiers. The
   * seeded `finance` role holds `plans:view` and neither of the other two, so
   * on the class gate alone it could read ids it cannot list anywhere else.
   */
  @Get('unknown-squads')
  @RequireAllPermissions(['plans', 'view'], ['subscriptions', 'view'])
  public async unknownSquads(): Promise<UnknownSquadReport> {
    return this.unknownSquadAudit.audit();
  }

  @Get()
  public async listPlans(): Promise<readonly AdminPlanInterface[]> {
    return this.plansAdminService.listPlans();
  }

  @Get('options/internal-squads')
  public async getInternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    return this.plansAdminService.getInternalSquadOptions();
  }

  @Get('options/external-squads')
  public async getExternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    return this.plansAdminService.getExternalSquadOptions();
  }

  // Declared BEFORE the `:planId` routes so the literal `reorder` path is
  // matched ahead of the `:planId` param (otherwise Nest would treat
  // "reorder" as a planId).
  @Patch('reorder')
  @RequirePermission('plans', 'edit')
  public async reorderPlans(
    @Body() input: ReorderPlansDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<readonly AdminPlanInterface[]> {
    return this.plansAdminService.reorderPlans(input.orderedIds, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Get(':planId')
  public async getPlan(
    @Param('planId') planId: string,
  ): Promise<AdminPlanInterface> {
    return this.plansAdminService.getPlan(planId);
  }

  /**
   * Progress of the plan's most recent squad propagation. Editing a plan's
   * squads queues a background push to every existing subscriber; this is how
   * the operator sees whether that push is still running, and whether any of it
   * failed. `isComplete: true` with `total: 0` means nothing was ever queued.
   */
  @Get(':planId/squad-propagation')
  public async getSquadPropagationStatus(
    @Param('planId') planId: string,
  ): Promise<PlanSquadPropagationStatus> {
    return this.plansAdminService.getSquadPropagationStatus(planId);
  }

  @Post()
  @RequirePermission('plans', 'create')
  public async createPlan(
    @Body() input: CreatePlanDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPlanInterface> {
    return this.plansAdminService.createPlan(input, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Patch(':planId')
  @RequirePermission('plans', 'edit')
  public async updatePlan(
    @Param('planId') planId: string,
    @Body() input: UpdatePlanDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPlanUpdateResultInterface> {
    return this.plansAdminService.updatePlan(planId, input, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Patch(':planId/move')
  @RequirePermission('plans', 'edit')
  public async movePlan(
    @Param('planId') planId: string,
    @Body() input: MovePlanDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPlanInterface> {
    return this.plansAdminService.movePlan(planId, input.direction, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Post(':planId/archive')
  @RequirePermission('plans', 'edit')
  public async archivePlan(
    @Param('planId') planId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPlanUpdateResultInterface> {
    return this.plansAdminService.updatePlan(planId, { isArchived: true } as UpdatePlanDto, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Post(':planId/unarchive')
  @RequirePermission('plans', 'edit')
  public async unarchivePlan(
    @Param('planId') planId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPlanUpdateResultInterface> {
    return this.plansAdminService.updatePlan(planId, { isArchived: false } as UpdatePlanDto, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Delete(':planId')
  @RequirePermission('plans', 'delete')
  public async deletePlan(
    @Param('planId') planId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ readonly deleted: true }> {
    await this.plansAdminService.deletePlan(planId, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
    return { deleted: true } as const;
  }
}
