import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentGatewayType, TransactionStatus } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PaymentWebhookIngressResultInterface } from '../interfaces/payment-webhook-envelope.interface';
import { PaymentWebhookIngressService } from './payment-webhook-ingress.service';

/**
 * Why a pre-checkout query gets approved or refused.
 *
 * A CODE rather than prose, because the two callers speak to different
 * audiences: the bot renders it in the buyer’s own language, while the
 * webhook path (for an install that points Telegram straight at the panel)
 * still has to hand Telegram a ready string.
 */
export type TelegramStarsPreCheckoutReason = 'OK' | 'UNKNOWN_PAYMENT' | 'NOT_PAYABLE';

export interface TelegramStarsPreCheckoutVerdict {
  readonly approve: boolean;
  readonly reason: TelegramStarsPreCheckoutReason;
}

@Injectable()
export class TelegramStarsWebhookService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly paymentWebhookIngressService: PaymentWebhookIngressService,
  ) {}

  /**
   * Whether a pre-checkout query for `paymentId` may be approved.
   *
   * This is the last moment the purchase can be refused, and Telegram gives
   * ten seconds to answer. Approving because "a row exists" lets one invoice
   * link be paid twice: reconciliation exits early on an already-fulfilled
   * transaction, so the stars are taken and nothing is delivered — and a Stars
   * refund is a manual, out-of-band affair. Only a draft still awaiting
   * payment may be approved.
   *
   * Extracted so the BOT can ask for the verdict and answer Telegram itself.
   * It has to: the bot owns the update stream through long polling, and on a
   * split deployment the panel may not have a bot token at all.
   */
  public async resolvePreCheckout(
    paymentId: string | null,
  ): Promise<TelegramStarsPreCheckoutVerdict> {
    if (paymentId === null || paymentId.trim().length === 0) {
      return { approve: false, reason: 'UNKNOWN_PAYMENT' };
    }
    const transaction = await this.prismaService.transaction.findUnique({
      where: { paymentId: paymentId.trim() },
      select: { status: true },
    });
    if (transaction === null) {
      return { approve: false, reason: 'UNKNOWN_PAYMENT' };
    }
    return transaction.status === TransactionStatus.PENDING
      ? { approve: true, reason: 'OK' }
      : { approve: false, reason: 'NOT_PAYABLE' };
  }

  public async handleTelegramUpdate(input: {
    readonly rawBody: Buffer;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly clientIp: string | null;
    readonly botToken: string | null;
  }): Promise<PaymentWebhookIngressResultInterface | null> {
    await this.paymentWebhookIngressService.verifyWebhookSignature({
      gatewayType: PaymentGatewayType.TELEGRAM_STARS,
      rawBody: input.rawBody,
      headers: input.headers,
      clientIp: input.clientIp,
    });
    const parsedPayload = parseTelegramUpdate(input.rawBody);
    if (parsedPayload.preCheckoutQueryId !== null) {
      if (input.botToken === null) {
        throw new ServiceUnavailableException('Telegram bot token is not configured');
      }
      const verdict = await this.resolvePreCheckout(parsedPayload.paymentId);
      if (verdict.reason === 'UNKNOWN_PAYMENT') {
        throw new NotFoundException('Payment transaction not found');
      }
      const payable = verdict.approve;
      await firstValueFrom(
        this.httpService.post(
          `https://api.telegram.org/bot${input.botToken}/answerPreCheckoutQuery`,
          payable
            ? {
                pre_checkout_query_id: parsedPayload.preCheckoutQueryId,
                ok: true,
              }
            : {
                pre_checkout_query_id: parsedPayload.preCheckoutQueryId,
                ok: false,
                // Shown to the buyer by Telegram, so it names the situation
                // rather than an internal state.
                error_message:
                  'Этот счёт уже обработан. Оформите оплату заново, если она ещё нужна.',
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
      verifySignature: false,
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
