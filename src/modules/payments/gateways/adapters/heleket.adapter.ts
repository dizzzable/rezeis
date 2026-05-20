/**
 * Heleket payment gateway adapter.
 *
 * Docs: https://doc.heleket.com/
 * Base URL: https://api.heleket.com/v1
 *
 * Auth (requests):
 *   Headers: merchant: <uuid>, sign: MD5(base64(json_body) + PAYMENT_API_KEY)
 *
 * Webhook verification:
 *   Body contains "sign" field = MD5(base64(json_without_sign) + PAYMENT_API_KEY)
 *   Extract sign, remove from body, recompute, compare.
 *
 * Settings shape:
 *   merchantId: string   — merchant UUID from dashboard
 *   apiKey: string       — PAYMENT API key (not payout key)
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

const BASE_URL = 'https://api.heleket.com/v1';

@Injectable()
export class HeleketAdapter implements IPaymentGateway {
  readonly type = 'HELEKET';
  private readonly logger = new Logger(HeleketAdapter.name);

  /**
   * Heleket sign: MD5(base64(JSON.stringify(body)) + apiKey)
   * Note: JSON.stringify in Node.js does NOT escape slashes by default.
   * Heleket PHP SDK escapes slashes. We must escape them to match.
   */
  private buildSign(body: object, apiKey: string): string {
    const json = JSON.stringify(body).replace(/\//g, '\\/');
    const b64 = Buffer.from(json).toString('base64');
    return crypto.createHash('md5').update(b64 + apiKey).digest('hex');
  }

  private async apiPost<T>(path: string, body: object, settings: Record<string, unknown>): Promise<T> {
    const merchantId = settings['merchantId'] as string;
    const apiKey = settings['apiKey'] as string;
    const sign = this.buildSign(body, apiKey);

    const res = await fetch(`${BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'merchant': merchantId,
        'sign': sign,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Heleket API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const body: Record<string, unknown> = {
      amount: String(input.amount),
      currency: 'USD',          // Heleket works with crypto; amount in USD, user picks crypto
      order_id: input.paymentId,
      url_success: input.successUrl,
      url_callback: undefined,  // configured per-invoice or in dashboard
      additional_data: input.paymentId,
    };
    if (input.customerEmail) body['payer_email'] = input.customerEmail;

    const response = await this.apiPost<{
      state: number;
      result?: { uuid?: string; url?: string };
      errors?: unknown;
      message?: string;
    }>('payment', body, settings);

    if (response.state !== 0 || !response.result?.url) {
      throw new Error(`Heleket checkout failed: ${response.message ?? JSON.stringify(response.errors ?? 'unknown error')}`);
    }

    return {
      externalPaymentId: response.result.uuid ?? input.paymentId,
      paymentUrl: response.result.url,
      raw: response,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const apiKey = settings['apiKey'] as string | undefined;
    if (!apiKey) return { valid: false, reason: 'Heleket apiKey not configured' };

    const payload = req.body as Record<string, unknown>;
    const receivedSign = String(payload['sign'] ?? '');
    if (!receivedSign) return { valid: false, reason: 'Missing sign in webhook body' };

    // Remove sign from body, recompute
    const bodyWithoutSign: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k !== 'sign') bodyWithoutSign[k] = v;
    }

    const expected = this.buildSign(bodyWithoutSign, apiKey);

    try {
      const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSign));
      return valid ? { valid: true } : { valid: false, reason: 'Invalid Heleket webhook signature' };
    } catch {
      return { valid: false, reason: 'Signature comparison failed' };
    }
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const payload = req.body as Record<string, unknown>;

    // order_id is our internal paymentId (passed as additional_data or order_id)
    const paymentId = String(payload['additional_data'] ?? payload['order_id'] ?? '');
    const externalPaymentId = String(payload['uuid'] ?? '');
    const status = this.mapStatus(String(payload['status'] ?? ''));

    return {
      paymentId,
      externalPaymentId,
      status,
      amount: payload['payment_amount'] ? parseFloat(String(payload['payment_amount'])) : undefined,
      currency: String(payload['currency'] ?? 'USD'),
      eventType: String(payload['type'] ?? 'payment'),
      raw: payload,
    };
  }

  /**
   * Heleket payment statuses:
   * confirm_check, paid, paid_over, fail, wrong_amount, cancel, system_fail,
   * refund_process, refund_fail, refund_paid
   */
  private mapStatus(status: string): WebhookEventStatus {
    switch (status.toLowerCase()) {
      case 'paid':
      case 'paid_over': return 'SUCCESS';
      case 'fail':
      case 'wrong_amount':
      case 'system_fail':
      case 'refund_fail': return 'FAILED';
      case 'cancel': return 'CANCELED';
      case 'refund_paid': return 'REFUNDED';
      case 'refund_process':
      case 'confirm_check':
      default: return 'PENDING';
    }
  }
}
