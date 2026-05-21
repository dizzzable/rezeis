/**
 * Platega payment gateway adapter.
 *
 * Docs: https://docs.platega.io/
 * Base URL: https://app.platega.io/
 *
 * Auth: Headers X-MerchantId + X-Secret (no body signing for requests)
 *
 * Create payment: POST /api/payments (without method) or POST /api/payments/method
 *   Body: { amount, currency, orderId, description, successUrl, failUrl, callbackUrl }
 *
 * Callback (webhook):
 *   POST to callbackUrl with CallbackPayload
 *   Verification: check sign field in payload
 *   sign = HMAC-SHA256(sorted_params_string, secretKey) — per CallbackPayload schema
 *
 * Settings shape:
 *   merchantId: string   — X-MerchantId header value
 *   secretKey: string    — X-Secret header value (also used for callback sign)
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'node:crypto';
import type {
  GatewayCheckoutInput,
  GatewayCheckoutResult,
  IPaymentGateway,
  NormalizedWebhookEvent,
  WebhookEventStatus,
  WebhookVerifyResult,
} from '../gateway.interface';

const BASE_URL = 'https://app.platega.io';

@Injectable()
export class PlategalAdapter implements IPaymentGateway {
  readonly type = 'PLATEGA';
  private readonly logger = new Logger(PlategalAdapter.name);

  private async apiPost<T>(path: string, body: object, settings: Record<string, unknown>): Promise<T> {
    const merchantId = settings['merchantId'] as string;
    const secretKey = settings['secretKey'] as string;

    const res = await fetch(`${BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MerchantId': merchantId,
        'X-Secret': secretKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Platega API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const body = {
      amount: input.amount,
      currency: 'RUB',
      orderId: input.paymentId,
      description: input.description.slice(0, 255),
      successUrl: input.successUrl,
      failUrl: input.failUrl,
      // callbackUrl: configured in dashboard or passed here
      customerEmail: input.customerEmail,
    };

    const response = await this.apiPost<{
      success?: boolean;
      data?: { id?: string; paymentUrl?: string; url?: string };
      error?: string;
      message?: string;
      // Direct fields if no wrapper
      id?: string;
      paymentUrl?: string;
      url?: string;
    }>('api/payments', body, settings);

    // Handle both wrapped and unwrapped responses
    const data = response.data ?? response;
    const paymentUrl = (data as Record<string, unknown>)['paymentUrl'] as string
      ?? (data as Record<string, unknown>)['url'] as string;

    if (!paymentUrl) {
      throw new Error(`Platega checkout failed: ${response.error ?? response.message ?? 'no paymentUrl returned'}`);
    }

    return {
      externalPaymentId: ((data as Record<string, unknown>)['id'] as string) ?? input.paymentId,
      paymentUrl,
      raw: response,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const secretKey = settings['secretKey'] as string | undefined;
    if (!secretKey) return { valid: false, reason: 'Platega secretKey not configured' };

    const payload = req.body as Record<string, unknown>;
    const receivedSign = String(payload['sign'] ?? '');
    if (!receivedSign) return { valid: false, reason: 'Missing sign in Platega callback payload' };

    // Build sign from all fields except 'sign', sorted alphabetically
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k !== 'sign' && v !== null && v !== undefined) {
        params[k] = String(v);
      }
    }

    const sortedStr = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');

    const expected = crypto.createHmac('sha256', secretKey).update(sortedStr).digest('hex');

    try {
      const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSign));
      return valid ? { valid: true } : { valid: false, reason: 'Invalid Platega callback signature' };
    } catch {
      return { valid: false, reason: 'Platega signature comparison failed' };
    }
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const payload = req.body as Record<string, unknown>;

    return {
      paymentId: String(payload['orderId'] ?? payload['order_id'] ?? ''),
      externalPaymentId: String(payload['id'] ?? payload['transactionId'] ?? ''),
      status: this.mapStatus(String(payload['status'] ?? '')),
      amount: payload['amount'] ? parseFloat(String(payload['amount'])) : undefined,
      currency: String(payload['currency'] ?? 'RUB'),
      eventType: 'payment',
      raw: payload,
    };
  }

  /**
   * Platega statuses (from CallbackPayload schema): SUCCESS, FAIL, PENDING, REFUNDED, CANCELED
   */
  private mapStatus(status: string): WebhookEventStatus {
    switch (status.toUpperCase()) {
      case 'SUCCESS':
      case 'PAID': return 'SUCCESS';
      case 'FAIL':
      case 'FAILED':
      case 'ERROR': return 'FAILED';
      case 'CANCELED':
      case 'CANCELLED': return 'CANCELED';
      case 'REFUNDED': return 'REFUNDED';
      default: return 'PENDING';
    }
  }
}
