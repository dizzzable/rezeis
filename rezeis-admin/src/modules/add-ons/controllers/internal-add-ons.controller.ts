import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { AddOnEligibilityService, AddOnEligibilityResult } from '../services/add-on-eligibility.service';
import { AddOnsService, AddOnInterface } from '../services/add-ons.service';
import { TrafficResetService } from '../services/traffic-reset.service';

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
    private readonly trafficResetService: TrafficResetService,
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

  /**
   * Takes a FREE traffic reset from the subscription's allowance.
   *
   * ── Why this is not a checkout ────────────────────────────────────────────
   *
   * A free reset is not a purchase. Routing it through the add-on checkout
   * would mean minting a zero-price transaction, choosing a gateway for money
   * nobody pays, and teaching the fulfilment path — the most consequential code
   * in this system — a second meaning for "settled". The PAID reset goes
   * through checkout exactly like every other add-on; this path exists so the
   * free one never touches the money flow at all.
   *
   * ── The allowance is re-checked HERE ──────────────────────────────────────
   *
   * The offer says whether it is free; this endpoint decides. Two tabs, a
   * double tap or a replayed request would otherwise each read "free" from a
   * stale offer and spend an allowance of one twice over. The check and the
   * reset are one call into the service, and the history row it writes is the
   * same row the count reads.
   */
  @Post('subscriptions/:subscriptionId/reset-traffic')
  @HttpCode(HttpStatus.OK)
  public async resetTraffic(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { readonly addOnId?: unknown },
  ): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
    const addOnId = typeof body.addOnId === 'string' ? body.addOnId : null;
    if (addOnId === null) {
      throw new BadRequestException('addOnId is required');
    }
    return this.trafficResetService.claimFree({ subscriptionId, addOnId });
  }
}
