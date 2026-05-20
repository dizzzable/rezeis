/**
 * CryptoPay (Crypto Bot) payment gateway adapter.
 *
 * Docs: https://help.crypt.bot/crypto-pay-api
 * Auth: Crypto-Pay-API-Token header. Webhook: HMAC-SHA256 of body with API token SHA256.
 *
 * Settings shape:
 *   apiToken: string
 *   isTestnet: boolean
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
export class CryptopayAdapter implements IPaymentGateway {
  readonly type = 'CRYPTOPAY';
  private readonly logger = new Logger(CryptopayAdapter.name);

  private getBaseUrl(settings: Record<string, unknown>): string {
    return settings['isTestnet'] ? 'https://testnet-pay.crypt.bot/api' : 'https://pay.crypt.bot/api';
  }

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const apiToken = settings['apiToken'] as string;
    const baseUrl = this.getBaseUrl(settings);

    const res = await fetch(`${baseUrl}/createInvoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Crypto-Pay-API-Token': apiToken,
      },
      body: JSON.stringify({
        asset: input.currency === 'USD' ? 'USDT' : input.currency,
        amount: String(input.amount),
        description: input.description.slice(0, 1024),
        payload: input.paymentId,
        paid_btn_name: 'callback',
        paid_btn_url: input.successUrl ?? '',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CryptoPay createInvoice failed: ${res.status} ${text}`);
    }

    const data = await res.json() as { ok: boolean; result?: { invoice_id: number; bot_invoice_url: string } };
    if (!data.ok || !data.result) throw new Error('CryptoPay: failed to create invoice');

    return {
      externalPaymentId: String(data.result.invoice_id),
      paymentUrl: data.result.bot_invoice_url,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const apiToken = settings['apiToken'] as string;
    const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody ?? JSON.stringify(req.body);
    const receivedSig = req.headers['crypto-pay-api-signature'] as string;
    if (!receivedSig) return { valid: false, reason: 'No signature header' };

    const secret = crypto.createHash('sha256').update(apiToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    return { valid: expected === receivedSig };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;
    const payload = body.payload ?? {};
    const statusMap: Record<string, 'SUCCESS' | 'FAILED' | 'PENDING'> = {
      paid: 'SUCCESS', expired: 'FAILED', active: 'PENDING',
    };

    return {
      paymentId: payload.payload ?? '',
      externalPaymentId: String(payload.invoice_id ?? ''),
      status: statusMap[payload.status] ?? 'PENDING',
      amount: payload.amount ? parseFloat(payload.amount) : undefined,
      currency: payload.asset ?? 'USDT',
      eventType: body.update_type ?? payload.status,
      raw: body,
    };
  }
}
