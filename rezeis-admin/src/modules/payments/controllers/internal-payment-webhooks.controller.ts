import {
  Controller,
  ParseEnumPipe,
  Post,
  RawBody,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';
import type { Request } from 'express';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { PaymentWebhookIngressResultInterface } from '../interfaces/payment-webhook-envelope.interface';
import { PaymentWebhookIngressService } from '../services/payment-webhook-ingress.service';

@Controller('internal/payments/webhooks')
@UseGuards(InternalAdminAuthGuard)
export class InternalPaymentWebhooksController {
  public constructor(
    private readonly paymentWebhookIngressService: PaymentWebhookIngressService,
  ) {}

  @Post(':gatewayType')
  public async ingest(
    @Param('gatewayType', new ParseEnumPipe(PaymentGatewayType)) gatewayType: PaymentGatewayType,
    @RawBody() rawBody: Buffer | undefined,
    @Req() request: Request,
  ): Promise<PaymentWebhookIngressResultInterface> {
    return this.paymentWebhookIngressService.ingestWebhook({
      gatewayType,
      rawBody: rawBody ?? Buffer.from('{}', 'utf8'),
      headers: request.headers,
      clientIp: null,
      verifySignature: true,
    });
  }
}
