/**
 * Antilopay payment gateway adapter.
 *
 * Docs: https://lk.antilopay.com/api/v1/
 * Auth: SHA256WithRSA signature on request body, RSA public key for callback verification.
 *
 * Settings shape:
 *   projectIdentificator: string  — Antilopay project ID
 *   secretId: string              — X-Apay-Secret-Id header value
 *   privateKey: string            — Base64 RSA private key for signing requests
 *   publicKey: string             — Base64 RSA public key for verifying callbacks
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

const BASE_URL = 'https://lk.antilopay.com/api/v1';

@Injectable()
export class AntilopayAdapter implements IPaymentGateway {
  readonly type = 'ANTILOPAY';
  private readonly logger = new Logger(AntilopayAdapter.name);

  // ── Signature helpers ─────────────────────────────────────────────────────

  private signRequest(body: string, privateKeyBase64: string): string {
    const keyBytes = Buffer.from(privateKeyBase64, 'base64');
    const privateKey = crypto.createPrivateKey({ key: keyBytes, format: 'der', type: 'pkcs8' });
    const sign = crypto.createSign('SHA256');
    sign.update(body, 'utf8');
    return sign.sign(privateKey, 'base64');
  }

  private verifyCallbackSignature(body: string, signature: string, publicKeyBase64: string): boolean {
    try {
      const keyBytes = Buffer.from(publicKeyBase64, 'base64');
      const publicKey = crypto.createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
      const verify = crypto.createVerify('SHA256');
      verify.update(body, 'utf8');
      return verify.verify(publicKey, signature, 'base64');
    } catch (err) {
      this.logger.warn(`Antilopay signature verification error: ${(err as Error).message}`);
      return false;
    }
  }

  private async apiPost<T>(path: string, body: object, settings: Record<string, unknown>): Promise<T> {
    const secretId = settings['secretId'] as string;
    const privateKey = settings['privateKey'] as string;

    const bodyStr = JSON.stringify(body);
    const signature = this.signRequest(bodyStr, privateKey);

    const res = await fetch(`${BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Apay-Secret-Id': secretId,
        'X-Apay-Sign': signature,
        'X-Apay-Sign-Version': '1',
      },
      body: bodyStr,
    });

    const data = await res.json() as T;
    return data;
  }

  // ── IPaymentGateway ───────────────────────────────────────────────────────

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const projectIdentificator = settings['projectIdentificator'] as string;

    const body = {
      project_identificator: projectIdentificator,
      amount: input.amount,
      order_id: input.paymentId,
      currency: 'rub',
      product_name: input.description.slice(0, 100),
      product_type: 'services',
      description: input.description.slice(0, 255),
      success_url: input.successUrl,
      fail_url: input.failUrl,
      customer: {
        email: input.customerEmail ?? 'noreply@rezeis.app',
        phone: input.customerPhone,
      },
    };

    const response = await this.apiPost<{
      code: number;
      payment_id?: string;
      payment_url?: string;
      error?: string;
    }>('payment/create', body, settings);

    if (response.code !== 0 || !response.payment_id || !response.payment_url) {
      throw new Error(`Antilopay checkout failed: ${response.error ?? `code ${response.code}`}`);
    }

    return {
      externalPaymentId: response.payment_id,
      paymentUrl: response.payment_url,
      raw: response,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const publicKey = settings['publicKey'] as string | undefined;
    if (!publicKey) {
      return { valid: false, reason: 'Antilopay publicKey not configured' };
    }

    const signature = req.headers['x-apay-callback'] as string | undefined;
    if (!signature) {
      return { valid: false, reason: 'Missing X-Apay-Callback header' };
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8')
      ?? JSON.stringify(req.body);

    const valid = this.verifyCallbackSignature(rawBody, signature, publicKey);
    return valid ? { valid: true } : { valid: false, reason: 'Invalid Antilopay callback signature' };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const payload = req.body as Record<string, unknown>;

    const status = this.mapStatus(String(payload['status'] ?? ''));
    const paymentId = String(payload['order_id'] ?? '');
    const externalPaymentId = String(payload['payment_id'] ?? '');

    return {
      paymentId,
      externalPaymentId,
      status,
      amount: typeof payload['original_amount'] === 'number' ? payload['original_amount'] : undefined,
      currency: String(payload['currency'] ?? 'RUB').toUpperCase(),
      eventType: String(payload['type'] ?? 'payment'),
      raw: payload,
    };
  }

  async checkPaymentStatus(externalPaymentId: string, settings: Record<string, unknown>): Promise<WebhookEventStatus> {
    const projectIdentificator = settings['projectIdentificator'] as string;
    const response = await this.apiPost<{ code: number; status?: string }>('payment/check', {
      project_identificator: projectIdentificator,
      order_id: externalPaymentId,
    }, settings);

    return this.mapStatus(response.status ?? '');
  }

  private mapStatus(status: string): WebhookEventStatus {
    switch (status.toUpperCase()) {
      case 'SUCCESS': return 'SUCCESS';
      case 'FAIL': return 'FAILED';
      case 'CANCEL': return 'CANCELED';
      case 'EXPIRED': return 'CANCELED';
      case 'CHARGEBACK': return 'REFUNDED';
      case 'REVERSED': return 'REFUNDED';
      default: return 'PENDING';
    }
  }
}
