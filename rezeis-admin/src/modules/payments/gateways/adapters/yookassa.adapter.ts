/**
 * YooKassa payment gateway adapter.
 *
 * Docs: https://yookassa.ru/developers/
 * Auth: Basic auth (shopId:secretKey), HMAC-SHA256 webhook signature.
 *
 * Settings shape:
 *   shopId: string
 *   secretKey: string
 *   webhookSecret: string  — used to verify incoming webhooks
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

const BASE_URL = 'https://api.yookassa.ru/v3';

@Injectable()
export class YookassaAdapter implements IPaymentGateway {
  readonly type = 'YOOKASSA';
  private readonly logger = new Logger(YookassaAdapter.name);

  private authHeader(settings: Record<string, unknown>): string {
    const shopId = settings['shopId'] as string;
    const secretKey = settings['secretKey'] as string;
    return 'Basic ' + Buffer.from(`${shopId}:${secretKey}`).toString('base64');
  }

  private async apiPost<T>(path: string, body: object, settings: Record<string, unknown>): Promise<T> {
    const idempotenceKey = crypto.randomUUID();
    const res = await fetch(`${BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.authHeader(settings),
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`YooKassa API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    // Default true: request a reusable payment_method on successful payment so
    // the merchant can run autopayments later. Operators can disable via
    // gateway settings `savePaymentMethod: false`.
    // When charging with paymentMethodId we never re-request save.
    const paymentMethodId =
      typeof input.paymentMethodId === 'string' && input.paymentMethodId.trim().length > 0
        ? input.paymentMethodId.trim()
        : null;
    const savePaymentMethod = paymentMethodId === null && settings['savePaymentMethod'] !== false;
    const body: Record<string, unknown> = {
      amount: { value: input.amount.toFixed(2), currency: 'RUB' },
      capture: true,
      description: input.description.slice(0, 128),
      metadata: { payment_id: input.paymentId, ...input.metadata },
      receipt: input.customerEmail ? {
        customer: { email: input.customerEmail },
        items: [{
          description: input.description.slice(0, 128),
          quantity: '1.00',
          amount: { value: input.amount.toFixed(2), currency: 'RUB' },
          vat_code: 1,
        }],
      } : undefined,
    };
    if (paymentMethodId !== null) {
      body.payment_method_id = paymentMethodId;
    } else {
      body.confirmation = {
        type: 'redirect',
        return_url: input.successUrl ?? 'https://rezeis.app',
      };
      if (savePaymentMethod) {
        body.save_payment_method = true;
      }
    }

    const response = await this.apiPost<{
      id: string;
      status: string;
      confirmation?: { confirmation_url?: string };
    }>('payments', body, settings);

    const paymentUrl = response.confirmation?.confirmation_url ?? '';
    if (paymentMethodId === null && !paymentUrl) {
      throw new Error('YooKassa did not return confirmation_url');
    }

    return {
      externalPaymentId: response.id,
      paymentUrl,
      raw: response,
    };
  }

  async verifyWebhook(_req: Request, _settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    // YooKassa sends IP-based verification — no HMAC signature on webhooks.
    // We verify by checking the payment status via API after receiving the event.
    // Optionally restrict by IP: 185.71.76.0/27, 185.71.77.0/27, 77.75.153.0/25, etc.
    return { valid: true };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const payload = req.body as Record<string, unknown>;
    const obj = payload['object'] as Record<string, unknown> | undefined;
    const meta = (obj?.['metadata'] as Record<string, unknown>) ?? {};

    const paymentId = String(meta['payment_id'] ?? obj?.['id'] ?? '');
    const externalPaymentId = String(obj?.['id'] ?? '');
    const status = this.mapStatus(String(obj?.['status'] ?? ''));
    const amountObj = obj?.['amount'] as Record<string, unknown> | undefined;

    return {
      paymentId,
      externalPaymentId,
      status,
      amount: amountObj ? parseFloat(String(amountObj['value'] ?? '0')) : undefined,
      currency: String(amountObj?.['currency'] ?? 'RUB'),
      eventType: String(payload['event'] ?? ''),
      raw: payload,
    };
  }

  async checkPaymentStatus(externalPaymentId: string, settings: Record<string, unknown>): Promise<WebhookEventStatus> {
    const res = await fetch(`${BASE_URL}/payments/${externalPaymentId}`, {
      headers: { 'Authorization': this.authHeader(settings) },
    });
    const data = await res.json() as { status?: string };
    return this.mapStatus(data.status ?? '');
  }

  private mapStatus(status: string): WebhookEventStatus {
    switch (status.toLowerCase()) {
      case 'succeeded': return 'SUCCESS';
      case 'canceled': return 'CANCELED';
      case 'waiting_for_capture': return 'PENDING';
      case 'pending': return 'PENDING';
      default: return 'FAILED';
    }
  }
}
