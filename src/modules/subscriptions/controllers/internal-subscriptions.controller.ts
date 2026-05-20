import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SubscriptionActionPolicyDto } from '../dto/subscription-action-policy.dto';
import { SubscriptionQuoteDto } from '../dto/subscription-quote.dto';
import {
  SubscriptionActionPolicyInterface,
  SubscriptionQuoteInterface,
} from '../interfaces/subscription-quote.interface';
import { SubscriptionQuoteService } from '../services/subscription-quote.service';

@Controller('internal/subscriptions')
@UseGuards(InternalAdminAuthGuard)
export class InternalSubscriptionsController {
  public constructor(private readonly subscriptionQuoteService: SubscriptionQuoteService) {}

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
}
