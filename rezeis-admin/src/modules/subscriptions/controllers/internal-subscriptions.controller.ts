import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SubscriptionActionPolicyDto } from '../dto/subscription-action-policy.dto';
import { InternalRenewalOptionsDto } from '../dto/internal-renewal-options.dto';
import { toDurationMap } from '../dto/renewal-duration.dto';
import { toPlanMap } from '../dto/renewal-plan.dto';
import { InternalSubscriptionDeleteDto } from '../dto/internal-subscription-delete.dto';
import { SubscriptionQuoteDto } from '../dto/subscription-quote.dto';
import {
  SubscriptionActionPolicyInterface,
  SubscriptionQuoteInterface,
} from '../interfaces/subscription-quote.interface';
import { RenewalOptionsInterface } from '../interfaces/subscription-renewal.interface';
import { SubscriptionQuoteService } from '../services/subscription-quote.service';
import { SubscriptionRenewalService } from '../services/subscription-renewal.service';
import {
  SubscriptionDeletionService,
  SubscriptionDeleteResult,
} from '../services/subscription-deletion.service';

@Controller('internal/subscriptions')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalSubscriptionsController {
  public constructor(
    private readonly subscriptionQuoteService: SubscriptionQuoteService,
    private readonly subscriptionRenewalService: SubscriptionRenewalService,
    private readonly subscriptionDeletionService: SubscriptionDeletionService,
  ) {}

  @Post('action-policy')
  public async getActionPolicy(
    @Body() input: SubscriptionActionPolicyDto,
  ): Promise<SubscriptionActionPolicyInterface> {
    return this.subscriptionQuoteService.getActionPolicy(input);
  }

  @Post('quote')
  public async getQuote(
    @Body() input: SubscriptionQuoteDto,
  ): Promise<SubscriptionQuoteInterface> {
    return this.subscriptionQuoteService.getQuote(input);
  }

  @Post('renewal-options')
  public async getRenewalOptions(
    @Body() input: InternalRenewalOptionsDto,
  ): Promise<RenewalOptionsInterface> {
    return this.subscriptionRenewalService.getRenewalOptions({
      identity: { userId: input.userId, telegramId: input.telegramId },
      subscriptionIds: input.subscriptionIds,
      gatewayType: input.gatewayType,
      channel: input.channel,
      durations: toDurationMap(input.durations),
      plans: toPlanMap(input.plans),
    });
  }

  @Post('delete')
  public async deleteSubscription(
    @Body() input: InternalSubscriptionDeleteDto,
  ): Promise<SubscriptionDeleteResult> {
    return this.subscriptionDeletionService.delete({
      userId: input.userId,
      telegramId: input.telegramId,
      subscriptionId: input.subscriptionId,
    });
  }
}
