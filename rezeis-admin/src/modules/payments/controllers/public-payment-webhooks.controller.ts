import { BadRequestException, Controller, ParseEnumPipe, Post, RawBody, Param, Req, Inject } from '@nestjs/common';
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
  ): Promise<
    | PaymentWebhookIngressResultInterface
    | { readonly accepted: true; readonly lifecycleStatus: 'TELEGRAM_PRECHECKOUT' }
  > {
    const resolvedRawBody = rawBody ?? Buffer.from('{}', 'utf8');
    if (resolvedRawBody.byteLength > webhookBodyLimit(gatewayType)) {
      throw new BadRequestException('PAYMENT_WEBHOOK_BODY_TOO_LARGE');
    }
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

function webhookBodyLimit(gatewayType: PaymentGatewayType): number {
  switch (gatewayType) {
    case PaymentGatewayType.TELEGRAM_STARS:
      return 256 * 1024;
    case PaymentGatewayType.YOOKASSA:
    case PaymentGatewayType.CRYPTOPAY:
      return 128 * 1024;
    default:
      return 256 * 1024;
  }
}

function resolveClientIp(request: Request): string | null {
  // Express resolves req.ip from the socket and the configured trust-proxy
  // boundary. Reading forwarding headers directly would trust attacker input.
  return request.ip ?? request.socket.remoteAddress ?? null;
}
