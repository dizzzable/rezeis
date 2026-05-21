import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { AddOnsService, AddOnInterface } from '../services/add-ons.service';

/**
 * Internal add-ons endpoint for reiwa.
 * Returns active add-ons applicable to a specific plan.
 */
@Controller('internal/add-ons')
@UseGuards(InternalAdminAuthGuard)
export class InternalAddOnsController {
  public constructor(private readonly addOnsService: AddOnsService) {}

  /** Returns active add-ons for a given plan (used in purchase flow). */
  @Get('plan/:planId')
  public listForPlan(@Param('planId') planId: string): Promise<readonly AddOnInterface[]> {
    return this.addOnsService.listForPlan(planId);
  }
}
