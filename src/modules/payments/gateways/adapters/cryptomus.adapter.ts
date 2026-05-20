/**
 * Cryptomus payment gateway adapter.
 *
 * Docs: https://doc.cryptomus.com/
 * Auth: MD5(base64(body) + apiKey) in sign header.
 *
 * Settings shape:
 *   merchantId: string
 *   apiKey: string
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

const BASE_URL = 'https://api.cryptomus.com/v1';

@Injectable()
export class CryptomusAdapter implements IPaymentGateway {
  readonly type = 'CRYPTOMUS';
  private readonly logger = new Logger(CryptomusAdapter.name);

  private sign(body: string, apiKey: string): string {
    const base64Body = Buffer.from(body).toString('base64');
    return crypto.createHash('md5').update(base64Body + apiKey).digest('hex');
  }

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const merchantId = settings['merchantId'] as string;
    const apiKey = settings['apiKey'] as string;

    const payload = {
      amount: String(input.amount),
      currency: input.currency === 'USD' ? 'USD' : 'USDT',
      order_id: input.paymentId,
      url_callback: input.metadata?.['webhookUrl'] ?? '',
      url_return: input.successUrl ?? '',
      is_payment_multiple: false,
    };

    const bodyStr = JSON.stringify(payload);
    const signature = this.sign(bodyStr, apiKey);

    const res = await fetch(`${BASE_URL}/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'merchant': merchantId,
        'sign': signature,
      },
      body: bodyStr,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cryptomus payment failed: ${res.status} ${text}`);
    }

    const data = await res.json() as { result?: { uuid?: string; url?: string } };
    return {
      externalPaymentId: data.result?.uuid ?? input.paymentId,
      paymentUrl: data.result?.url ?? '',
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const apiKey = settings['apiKey'] as string;
    const receivedSign = req.body?.sign;
    if (!receivedSign) return { valid: false, reason: 'No sign in body' };

    const bodyWithoutSign = { ...req.body };
    delete bodyWithoutSign.sign;
    const bodyStr = JSON.stringify(bodyWithoutSign);
    const expected = this.sign(bodyStr, apiKey);

    return { valid: expected === receivedSign };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;
    const statusMap: Record<string, 'SUCCESS' | 'FAILED' | 'PENDING'> = {
      paid: 'SUCCESS', paid_over: 'SUCCESS', confirm_check: 'PENDING',
      wrong_amount: 'FAILED', fail: 'FAILED', cancel: 'FAILED',
    };

    return {
      paymentId: body.order_id ?? '',
      externalPaymentId: body.uuid ?? '',
      status: statusMap[body.status] ?? 'PENDING',
      amount: body.amount ? parseFloat(body.amount) : undefined,
      currency: body.currency ?? 'USD',
      eventType: body.status,
      raw: body,
    };
  }
}
