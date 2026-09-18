import {
  Controller,
  ParseEnumPipe,
  Post,
  RawBody,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PaymentGatewayType } from '@prisma/client';
import type { Request } from 'express';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { PaymentWebhookIngressResultInterface } from '../interfaces/payment-webhook-envelope.interface';
import { PaymentWebhookIngressService } from '../services/payment-webhook-ingress.service';

@Controller('internal/payments/webhooks')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
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
      // Internal path is already behind InternalAdminAuthGuard (service auth).
      // YooKassa public ingress still verifies trusted source IPs; here the
      // caller is our own stack (proxy/worker), so IP checks would always fail
      // and signature verification is skipped for the same reason.
      clientIp: null,
      verifySignature: false,
    });
  }
}
