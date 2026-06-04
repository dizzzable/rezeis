import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { ListSubscriptionsQueryDto } from '../dto/list-subscriptions-query.dto';
import { SubscriptionActionPolicyDto } from '../dto/subscription-action-policy.dto';
import { SubscriptionQuoteDto } from '../dto/subscription-quote.dto';
import {
  AdminSubscriptionStatsInterface,
  AdminSubscriptionsListInterface,
} from '../interfaces/admin-subscriptions-list.interface';
import {
  SubscriptionActionPolicyInterface,
  SubscriptionQuoteInterface,
} from '../interfaces/subscription-quote.interface';
import { AdminSubscriptionsListService } from '../services/admin-subscriptions-list.service';
import { SubscriptionQuoteService } from '../services/subscription-quote.service';

@Controller('admin/subscriptions')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminSubscriptionsController {
  public constructor(
    private readonly subscriptionQuoteService: SubscriptionQuoteService,
    private readonly listService: AdminSubscriptionsListService,
  ) {}

  @Get()
  @RequirePermission('subscriptions', 'view')
  public list(
    @Query() query: ListSubscriptionsQueryDto,
  ): Promise<AdminSubscriptionsListInterface> {
    return this.listService.list(query);
  }

  @Get('stats')
  @RequirePermission('subscriptions', 'view')
  public getStats(): Promise<AdminSubscriptionStatsInterface> {
    return this.listService.getStats();
  }

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
