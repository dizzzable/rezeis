/**
 * YooMoney (ex-Yandex.Money) payment gateway adapter.
 *
 * Docs: https://yoomoney.ru/docs/wallet
 * Auth: notification_secret for webhook verification (SHA-1 hash).
 *
 * Settings shape:
 *   walletId: string — YooMoney wallet number
 *   notificationSecret: string — for webhook verification
 *   redirectUrl: string — URL for payment form redirect
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'node:crypto';
import type {
  GatewayCheckoutInput,
  GatewayCheckoutResult,
  IPaymentGateway,
  NormalizedWebhookEvent,
  WebhookVerifyResult,
} from '../gateway.interface';

@Injectable()
export class YoomoneyAdapter implements IPaymentGateway {
  readonly type = 'YOOMONEY';
  private readonly logger = new Logger(YoomoneyAdapter.name);

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const walletId = settings['walletId'] as string;

    // YooMoney quickpay form URL
    const params = new URLSearchParams({
      receiver: walletId,
      'quickpay-form': 'shop',
      targets: input.description.slice(0, 128),
      paymentType: 'AC', // Bank card
      sum: String(input.amount),
      label: input.paymentId,
      successURL: input.successUrl ?? '',
    });

    const paymentUrl = `https://yoomoney.ru/quickpay/confirm.xml?${params.toString()}`;

    return {
      externalPaymentId: input.paymentId,
      paymentUrl,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const notificationSecret = settings['notificationSecret'] as string;
    const body = req.body;

    if (!notificationSecret) return { valid: false, reason: 'No notification secret configured' };

    // SHA-1 hash: notification_type&operation_id&amount&currency&datetime&sender&codepro&notification_secret&label
    const hashStr = [
      body.notification_type,
      body.operation_id,
      body.amount,
      body.currency,
      body.datetime,
      body.sender,
      body.codepro,
      notificationSecret,
      body.label,
    ].join('&');

    const expected = crypto.createHash('sha1').update(hashStr).digest('hex');
    const received = body.sha1_hash;

    return { valid: expected === received };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;

    return {
      paymentId: body.label ?? '',
      externalPaymentId: body.operation_id ?? '',
      status: body.unaccepted === 'true' ? 'PENDING' : 'SUCCESS',
      amount: body.withdraw_amount ? parseFloat(body.withdraw_amount) : parseFloat(body.amount ?? '0'),
      currency: body.currency === '643' ? 'RUB' : body.currency,
      eventType: body.notification_type ?? 'p2p-incoming',
      raw: body,
    };
  }
}
