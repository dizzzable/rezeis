import {
  Controller,
  ParseEnumPipe,
  Post,
  RawBody,
  Param,
  Req,
  Inject,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PaymentGatewayType } from '@prisma/client';
import type { Request } from 'express';

import { paymentsConfig } from '../../../common/config/payments.config';
import { PaymentWebhookIngressResultInterface } from '../interfaces/payment-webhook-envelope.interface';
import { PaymentWebhookIngressService } from '../services/payment-webhook-ingress.service';
import { TelegramStarsWebhookService } from '../services/telegram-stars-webhook.service';
import { Public } from '../../../common/decorators/public.decorator';

@Controller('v1/payments/webhooks')
@Public()
export class PublicPaymentWebhooksController {
  public constructor(
    private readonly paymentWebhookIngressService: PaymentWebhookIngressService,
    private readonly telegramStarsWebhookService: TelegramStarsWebhookService,
    @Inject(paymentsConfig.KEY)
    private readonly configuration: ConfigType<typeof paymentsConfig>,
  ) {}

  @Post(':gatewayType')
  public async ingest(
    @Param('gatewayType', new ParseEnumPipe(PaymentGatewayType)) gatewayType: PaymentGatewayType,
    @RawBody() rawBody: Buffer | undefined,
    @Req() request: Request,
  ): Promise<PaymentWebhookIngressResultInterface | { readonly accepted: true; readonly lifecycleStatus: 'TELEGRAM_PRECHECKOUT' }> {
    const resolvedRawBody = rawBody ?? Buffer.from('{}', 'utf8');
    if (gatewayType === PaymentGatewayType.TELEGRAM_STARS) {
      const telegramResult = await this.telegramStarsWebhookService.handleTelegramUpdate({
        rawBody: resolvedRawBody,
        headers: request.headers,
        clientIp: resolveClientIp(request),
        botToken: this.configuration.botToken,
      });
      if (telegramResult === null) {
        return {
          accepted: true,
          lifecycleStatus: 'TELEGRAM_PRECHECKOUT',
        };
      }
      return telegramResult;
    }
    return this.paymentWebhookIngressService.ingestWebhook({
      gatewayType,
      rawBody: resolvedRawBody,
      headers: request.headers,
      clientIp: resolveClientIp(request),
      verifySignature: true,
    });
  }
}

function resolveClientIp(request: Request): string | null {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }
  const realIp = request.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim().length > 0) {
    return realIp.trim();
  }
  return request.ip ?? request.socket.remoteAddress ?? null;
}
