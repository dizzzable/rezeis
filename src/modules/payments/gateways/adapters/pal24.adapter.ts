/**
 * Pal24 payment gateway adapter.
 *
 * Auth: merchant_id + secret_key → MD5 signature.
 *
 * Settings shape:
 *   merchantId: string
 *   secretKey: string
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
export class Pal24Adapter implements IPaymentGateway {
  readonly type = 'PAL24';
  private readonly logger = new Logger(Pal24Adapter.name);

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const merchantId = settings['merchantId'] as string;
    const secretKey = settings['secretKey'] as string;

    const amount = input.amount.toFixed(2);
    const signStr = `${merchantId}:${amount}:${input.paymentId}:${secretKey}`;
    const signature = crypto.createHash('md5').update(signStr).digest('hex');

    const params = new URLSearchParams({
      merchant_id: merchantId,
      amount,
      order_id: input.paymentId,
      description: input.description.slice(0, 128),
      sign: signature,
      currency: input.currency === 'RUB' ? 'RUB' : 'USD',
      ...(input.successUrl ? { success_url: input.successUrl } : {}),
      ...(input.failUrl ? { fail_url: input.failUrl } : {}),
    });

    const paymentUrl = `https://pal24.io/pay?${params.toString()}`;

    return {
      externalPaymentId: input.paymentId,
      paymentUrl,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const secretKey = settings['secretKey'] as string;
    const body = req.body;
    const receivedSign = body.sign ?? body.signature;
    if (!receivedSign) return { valid: false, reason: 'No signature' };

    const signStr = `${body.merchant_id}:${body.amount}:${body.order_id}:${secretKey}`;
    const expected = crypto.createHash('md5').update(signStr).digest('hex');

    return { valid: expected === receivedSign };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;
    const statusMap: Record<string, 'SUCCESS' | 'FAILED'> = { success: 'SUCCESS', fail: 'FAILED' };

    return {
      paymentId: body.order_id ?? '',
      externalPaymentId: body.transaction_id ?? body.order_id ?? '',
      status: statusMap[body.status] ?? 'SUCCESS',
      amount: body.amount ? parseFloat(body.amount) : undefined,
      currency: body.currency ?? 'RUB',
      eventType: body.status ?? 'callback',
      raw: body,
    };
  }
}
