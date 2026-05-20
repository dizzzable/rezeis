/**
 * Stripe payment gateway adapter.
 *
 * Docs: https://docs.stripe.com/api
 * Auth: Bearer token (secret key). Webhook: Stripe-Signature header (HMAC-SHA256).
 *
 * Settings shape:
 *   secretKey: string
 *   webhookSecret: string — whsec_xxx for verifying webhooks
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

const BASE_URL = 'https://api.stripe.com/v1';

@Injectable()
export class StripeAdapter implements IPaymentGateway {
  readonly type = 'STRIPE';
  private readonly logger = new Logger(StripeAdapter.name);

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const secretKey = settings['secretKey'] as string;
    const amountCents = Math.round(input.amount * 100);

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('line_items[0][price_data][currency]', input.currency.toLowerCase());
    params.append('line_items[0][price_data][product_data][name]', input.description.slice(0, 100));
    params.append('line_items[0][price_data][unit_amount]', String(amountCents));
    params.append('line_items[0][quantity]', '1');
    params.append('client_reference_id', input.paymentId);
    params.append('metadata[paymentId]', input.paymentId);
    if (input.successUrl) params.append('success_url', input.successUrl);
    if (input.failUrl) params.append('cancel_url', input.failUrl);
    if (input.customerEmail) params.append('customer_email', input.customerEmail);

    const res = await fetch(`${BASE_URL}/checkout/sessions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stripe checkout failed: ${res.status} ${text}`);
    }

    const data = await res.json() as { id: string; url: string };
    return { externalPaymentId: data.id, paymentUrl: data.url };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const webhookSecret = settings['webhookSecret'] as string;
    const signature = req.headers['stripe-signature'] as string;
    if (!signature || !webhookSecret) return { valid: false, reason: 'Missing signature or secret' };

    const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody ?? '';
    const parts = signature.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {} as Record<string, string>);

    const timestamp = parts['t'];
    const v1 = parts['v1'];
    if (!timestamp || !v1) return { valid: false, reason: 'Invalid signature format' };

    const payload = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');

    return { valid: expected === v1 };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;
    const event = body.type;
    const obj = body.data?.object ?? {};

    const statusMap: Record<string, 'SUCCESS' | 'FAILED' | 'PENDING' | 'REFUNDED'> = {
      'checkout.session.completed': 'SUCCESS',
      'payment_intent.succeeded': 'SUCCESS',
      'payment_intent.payment_failed': 'FAILED',
      'charge.refunded': 'REFUNDED',
    };

    return {
      paymentId: obj.client_reference_id ?? obj.metadata?.paymentId ?? '',
      externalPaymentId: obj.id ?? obj.payment_intent ?? '',
      status: statusMap[event] ?? 'PENDING',
      amount: obj.amount_total ? obj.amount_total / 100 : obj.amount ? obj.amount / 100 : undefined,
      currency: (obj.currency ?? 'usd').toUpperCase(),
      eventType: event,
      raw: body,
    };
  }
}
