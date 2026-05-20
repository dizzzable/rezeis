import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { CreatePlanDto } from '../dto/create-plan.dto';
import { MovePlanDto } from '../dto/move-plan.dto';
import { UpdatePlanDto } from '../dto/update-plan.dto';
import { AdminPlanInterface } from '../interfaces/admin-plan.interface';
import { PlansAdminService } from '../services/plans-admin.service';
import { RemnawaveSquadOptionInterface } from '../../remnawave/interfaces/remnawave-squad-option.interface';

@Controller('admin/plans')
@UseGuards(AdminJwtAuthGuard)
export class AdminPlansController {
  public constructor(private readonly plansAdminService: PlansAdminService) {}

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

  @Get(':planId')
  public async getPlan(
    @Param('planId') planId: string,
  ): Promise<AdminPlanInterface> {
    return this.plansAdminService.getPlan(planId);
  }

  @Post()
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
  public async updatePlan(
    @Param('planId') planId: string,
    @Body() input: UpdatePlanDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPlanInterface> {
    return this.plansAdminService.updatePlan(planId, input, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Patch(':planId/move')
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
  public async archivePlan(
    @Param('planId') planId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPlanInterface> {
    return this.plansAdminService.updatePlan(planId, { isArchived: true } as UpdatePlanDto, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Post(':planId/unarchive')
  public async unarchivePlan(
    @Param('planId') planId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPlanInterface> {
    return this.plansAdminService.updatePlan(planId, { isArchived: false } as UpdatePlanDto, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  @Delete(':planId')
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
