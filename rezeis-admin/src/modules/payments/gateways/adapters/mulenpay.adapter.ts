/**
 * MulenPay payment gateway adapter.
 *
 * Docs: https://mulenpay.ru/docs/api
 * Auth: API key in header, HMAC-SHA256 webhook signature.
 *
 * Settings shape:
 *   shopId: string
 *   apiKey: string
 *   secretKey: string  — for webhook signature verification
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

const BASE_URL = 'https://api.mulenpay.ru/v1';

@Injectable()
export class MulenpayAdapter implements IPaymentGateway {
  readonly type = 'MULENPAY';
  private readonly logger = new Logger(MulenpayAdapter.name);

  private async apiPost<T>(path: string, body: object, settings: Record<string, unknown>): Promise<T> {
    const apiKey = settings['apiKey'] as string;
    const shopId = settings['shopId'] as string;

    const res = await fetch(`${BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Shop-Id': shopId,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MulenPay API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const body = {
      order_id: input.paymentId,
      amount: input.amount,
      currency: 'RUB',
      description: input.description.slice(0, 255),
      success_url: input.successUrl,
      fail_url: input.failUrl,
      customer_email: input.customerEmail,
    };

    const response = await this.apiPost<{
      success: boolean;
      data?: { payment_id?: string; payment_url?: string };
      error?: string;
    }>('payments/create', body, settings);

    if (!response.success || !response.data?.payment_url) {
      throw new Error(`MulenPay checkout failed: ${response.error ?? 'unknown error'}`);
    }

    return {
      externalPaymentId: response.data.payment_id ?? input.paymentId,
      paymentUrl: response.data.payment_url,
      raw: response,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const secretKey = settings['secretKey'] as string | undefined;
    if (!secretKey) return { valid: false, reason: 'MulenPay secretKey not configured' };

    const signature = req.headers['x-signature'] as string | undefined;
    if (!signature) return { valid: false, reason: 'Missing X-Signature header' };

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8')
      ?? JSON.stringify(req.body);

    const expected = crypto.createHmac('sha256', secretKey).update(rawBody).digest('hex');
    const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    return valid ? { valid: true } : { valid: false, reason: 'Invalid MulenPay webhook signature' };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const payload = req.body as Record<string, unknown>;

    return {
      paymentId: String(payload['order_id'] ?? ''),
      externalPaymentId: String(payload['payment_id'] ?? ''),
      status: this.mapStatus(String(payload['status'] ?? '')),
      amount: payload['amount'] ? parseFloat(String(payload['amount'])) : undefined,
      currency: String(payload['currency'] ?? 'RUB'),
      eventType: String(payload['event'] ?? 'payment'),
      raw: payload,
    };
  }

  private mapStatus(status: string): WebhookEventStatus {
    switch (status.toLowerCase()) {
      case 'paid':
      case 'success':
      case 'completed': return 'SUCCESS';
      case 'failed':
      case 'error': return 'FAILED';
      case 'canceled':
      case 'cancelled': return 'CANCELED';
      case 'refunded': return 'REFUNDED';
      default: return 'PENDING';
    }
  }
}
