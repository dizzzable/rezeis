import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  ListPaymentWebhookEventsQueryDto,
  PaymentWebhookEventDetailQueryDto,
} from '../dto/list-payment-webhook-events-query.dto';
import { ReplayPaymentWebhookEventDto } from '../dto/replay-payment-webhook-event.dto';
import {
  AdminPaymentWebhookEventDetailInterface,
  AdminPaymentWebhookEventListItemInterface,
  AdminReplayPaymentWebhookEventResultInterface,
} from '../interfaces/admin-payment-webhook-event.interface';
import { PaymentWebhookOpsService } from '../services/payment-webhook-ops.service';

@Controller('admin/payments/webhooks/events')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminPaymentWebhooksController {
  public constructor(
    private readonly paymentWebhookOpsService: PaymentWebhookOpsService,
  ) {}

  @Get()
  @RequirePermission('payment_webhooks', 'view')
  public async listEvents(
    @Query() query: ListPaymentWebhookEventsQueryDto,
  ): Promise<readonly AdminPaymentWebhookEventListItemInterface[]> {
    return this.paymentWebhookOpsService.listEvents(query);
  }

  @Get(':eventId')
  @RequirePermission('payment_webhooks', 'resolve')
  public async getEventDetail(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Query() query: PaymentWebhookEventDetailQueryDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminPaymentWebhookEventDetailInterface> {
    if (query.includeRaw === true) {
      await this.paymentWebhookOpsService.auditPayloadReveal({
        eventId,
        currentAdmin,
        requestMetadata: extractRequestMetadata(request),
      });
    }
    return this.paymentWebhookOpsService.getEventDetail({
      eventId,
      includeRaw: query.includeRaw === true,
    });
  }

  @Post(':eventId/replay')
  @RequirePermission('payment_webhooks', 'run')
  public async replayEvent(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Body() body: ReplayPaymentWebhookEventDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminReplayPaymentWebhookEventResultInterface> {
    return this.paymentWebhookOpsService.replayEvent({
      eventId,
      reason: body.reason,
      force: body.force ?? false,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }
}
