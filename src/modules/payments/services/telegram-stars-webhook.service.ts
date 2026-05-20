import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PaymentWebhookIngressResultInterface } from '../interfaces/payment-webhook-envelope.interface';
import { PaymentWebhookIngressService } from './payment-webhook-ingress.service';

@Injectable()
export class TelegramStarsWebhookService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly paymentWebhookIngressService: PaymentWebhookIngressService,
  ) {}

  public async handleTelegramUpdate(input: {
    readonly rawBody: Buffer;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly clientIp: string | null;
    readonly botToken: string | null;
  }): Promise<PaymentWebhookIngressResultInterface | null> {
    const parsedPayload = parseTelegramUpdate(input.rawBody);
    if (parsedPayload.preCheckoutQueryId !== null) {
      if (input.botToken === null) {
        throw new ServiceUnavailableException('Telegram bot token is not configured');
      }
      const paymentId = parsedPayload.paymentId;
      if (paymentId === null) {
        throw new NotFoundException('Payment transaction not found');
      }
      const transaction = await this.prismaService.transaction.findUnique({
        where: { paymentId },
      });
      if (transaction === null) {
        throw new NotFoundException('Payment transaction not found');
      }
      await firstValueFrom(
        this.httpService.post(
          `https://api.telegram.org/bot${input.botToken}/answerPreCheckoutQuery`,
          {
            pre_checkout_query_id: parsedPayload.preCheckoutQueryId,
            ok: true,
          },
        ),
      );
      return null;
    }
    return this.paymentWebhookIngressService.ingestWebhook({
      gatewayType: PaymentGatewayType.TELEGRAM_STARS,
      rawBody: input.rawBody,
      headers: input.headers,
      clientIp: input.clientIp,
      verifySignature: true,
    });
  }
}

function parseTelegramUpdate(rawBody: Buffer): {
  readonly preCheckoutQueryId: string | null;
  readonly paymentId: string | null;
} {
  const payload = JSON.parse(rawBody.toString('utf8')) as unknown;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { preCheckoutQueryId: null, paymentId: null };
  }
  const payloadRecord = payload as Record<string, unknown>;
  const preCheckoutQuery = readRecord(payloadRecord.pre_checkout_query);
  if (Object.keys(preCheckoutQuery).length > 0) {
    const invoicePayload = readOptionalString(preCheckoutQuery, ['invoice_payload']);
    return {
      preCheckoutQueryId: readOptionalString(preCheckoutQuery, ['id']),
      paymentId: invoicePayload,
    };
  }
  return {
    preCheckoutQueryId: null,
    paymentId: null,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}
