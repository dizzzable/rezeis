import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { AddOnEligibilityService, AddOnEligibilityResult } from '../services/add-on-eligibility.service';
import { AddOnsService, AddOnInterface } from '../services/add-ons.service';

/**
 * Internal add-ons endpoint for reiwa.
 * Returns active add-ons applicable to a specific plan.
 */
@Controller('internal/add-ons')
@UseGuards(InternalAdminAuthGuard)
export class InternalAddOnsController {
  public constructor(
    private readonly addOnsService: AddOnsService,
    private readonly addOnEligibilityService: AddOnEligibilityService,
  ) {}

  /**
   * Legacy plan-scoped listing (contract v1). Retained during rollout for
   * existing clients; it must NOT power new checkout authority.
   */
  @Get('plan/:planId')
  public listForPlan(@Param('planId') planId: string): Promise<readonly AddOnInterface[]> {
    return this.addOnsService.listForPlan(planId);
  }

  /**
   * Subscription/term-specific eligibility (contract v2). Authoritative for
   * discovery: returns only add-ons eligible for this subscription's active
   * term, each with activation timing, expiry and an explanation code.
   *
   * `userId`/`telegramId` identify the calling cabinet user; the service scopes
   * the subscription to that owner (a mismatch is a 404) so one user can never
   * read another's eligibility. The reiwa BFF always forwards the authenticated
   * session identity.
   */
  @Get('subscriptions/:subscriptionId')
  public listForSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @Query('userId') userId?: string,
    @Query('telegramId') telegramId?: string,
  ): Promise<AddOnEligibilityResult> {
    return this.addOnEligibilityService.listForSubscription(subscriptionId, { userId, telegramId });
  }
}
