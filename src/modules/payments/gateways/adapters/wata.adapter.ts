/**
 * WATA payment gateway adapter.
 *
 * Auth: API key in header + HMAC-SHA256 webhook signature.
 *
 * Settings shape:
 *   apiKey: string
 *   shopId: string
 *   webhookSecret: string
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

const BASE_URL = 'https://api.wata.pro/api/v1';

@Injectable()
export class WataAdapter implements IPaymentGateway {
  readonly type = 'WATA';
  private readonly logger = new Logger(WataAdapter.name);

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const apiKey = settings['apiKey'] as string;
    const shopId = settings['shopId'] as string;

    const payload = {
      shop_id: shopId,
      amount: input.amount,
      currency: input.currency === 'RUB' ? 'RUB' : 'USD',
      order_id: input.paymentId,
      description: input.description.slice(0, 200),
      success_url: input.successUrl ?? '',
      fail_url: input.failUrl ?? '',
    };

    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WATA order creation failed: ${res.status} ${text}`);
    }

    const data = await res.json() as { id?: string; payment_url?: string; link?: string };
    return {
      externalPaymentId: data.id ?? input.paymentId,
      paymentUrl: data.payment_url ?? data.link ?? '',
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const webhookSecret = settings['webhookSecret'] as string;
    const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody ?? JSON.stringify(req.body);
    const receivedSig = req.headers['x-signature'] as string ?? req.headers['x-wata-signature'] as string;

    if (!receivedSig || !webhookSecret) return { valid: false, reason: 'Missing signature or secret' };

    const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    return { valid: expected === receivedSig };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;
    const statusMap: Record<string, 'SUCCESS' | 'FAILED' | 'PENDING'> = {
      paid: 'SUCCESS', completed: 'SUCCESS', failed: 'FAILED', expired: 'FAILED', pending: 'PENDING',
    };

    return {
      paymentId: body.order_id ?? body.merchant_order_id ?? '',
      externalPaymentId: body.id ?? body.payment_id ?? '',
      status: statusMap[body.status] ?? 'PENDING',
      amount: body.amount ? parseFloat(body.amount) : undefined,
      currency: body.currency ?? 'RUB',
      eventType: body.status ?? body.event,
      raw: body,
    };
  }
}
