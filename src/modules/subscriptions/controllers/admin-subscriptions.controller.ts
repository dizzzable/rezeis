import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { SubscriptionActionPolicyDto } from '../dto/subscription-action-policy.dto';
import { SubscriptionQuoteDto } from '../dto/subscription-quote.dto';
import {
  SubscriptionActionPolicyInterface,
  SubscriptionQuoteInterface,
} from '../interfaces/subscription-quote.interface';
import { SubscriptionQuoteService } from '../services/subscription-quote.service';

@Controller('admin/subscriptions')
@UseGuards(AdminJwtAuthGuard)
export class AdminSubscriptionsController {
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
