/**
 * OverPay payment gateway adapter.
 *
 * Docs: https://docs.overpay.io/en/
 * This is a beGateway-based platform.
 *
 * Checkout: POST https://checkout.overpay.io/ctp/api/checkouts
 *   Auth: HTTP Basic (shopId:secretKey)
 *   Headers: Content-Type: application/json, Accept: application/json, X-API-Version: 2
 *
 * Webhook verification:
 *   Header: Content-Signature — RSA digital signature (SHA256, Base64)
 *   Verify with RSA public key from Overpay back office.
 *   Use raw body (no JSON serialization/deserialization).
 *
 * Settings shape:
 *   shopId: string       — Shop ID from back office
 *   secretKey: string    — Secret Key from back office
 *   publicKey: string    — RSA public key (PEM or Base64) for webhook verification
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

const CHECKOUT_URL = 'https://checkout.overpay.io/ctp/api/checkouts';

@Injectable()
export class OverpayAdapter implements IPaymentGateway {
  readonly type = 'OVERPAY';
  private readonly logger = new Logger(OverpayAdapter.name);

  private basicAuth(shopId: string, secretKey: string): string {
    return 'Basic ' + Buffer.from(`${shopId}:${secretKey}`).toString('base64');
  }

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const shopId = settings['shopId'] as string;
    const secretKey = settings['secretKey'] as string;

    const body = {
      checkout: {
        test: false,
        transaction_type: 'payment',
        order: {
          amount: Math.round(input.amount * 100), // in minor units (kopecks)
          currency: 'RUB',
          description: input.description.slice(0, 255),
          tracking_id: input.paymentId,
        },
        settings: {
          success_url: input.successUrl,
          fail_url: input.failUrl,
          notification_url: undefined, // configured in dashboard
          language: 'ru',
        },
        customer: input.customerEmail ? {
          email: input.customerEmail,
        } : undefined,
      },
    };

    const res = await fetch(CHECKOUT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-Version': '2',
        'Authorization': this.basicAuth(shopId, secretKey),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OverPay API error ${res.status}: ${text}`);
    }

    const response = await res.json() as {
      checkout?: {
        token?: string;
        redirect_url?: string;
        status?: string;
      };
      errors?: unknown;
    };

    const redirectUrl = response.checkout?.redirect_url;
    if (!redirectUrl) {
      throw new Error(`OverPay did not return redirect_url: ${JSON.stringify(response.errors ?? response)}`);
    }

    return {
      externalPaymentId: response.checkout?.token ?? input.paymentId,
      paymentUrl: redirectUrl,
      raw: response,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const publicKeyRaw = settings['publicKey'] as string | undefined;
    if (!publicKeyRaw) {
      // If no public key configured, skip signature check (not recommended for production)
      this.logger.warn('OverPay publicKey not configured — skipping signature verification');
      return { valid: true };
    }

    const signature = req.headers['content-signature'] as string | undefined;
    if (!signature) return { valid: false, reason: 'Missing Content-Signature header' };

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) return { valid: false, reason: 'Raw body not available' };

    try {
      // Public key may be PEM or Base64 DER
      let publicKey: crypto.KeyObject;
      if (publicKeyRaw.includes('BEGIN')) {
        publicKey = crypto.createPublicKey(publicKeyRaw);
      } else {
        const keyBytes = Buffer.from(publicKeyRaw, 'base64');
        publicKey = crypto.createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
      }

      const verify = crypto.createVerify('SHA256');
      verify.update(rawBody);
      const valid = verify.verify(publicKey, signature, 'base64');
      return valid ? { valid: true } : { valid: false, reason: 'Invalid OverPay webhook signature' };
    } catch (err) {
      return { valid: false, reason: `OverPay signature error: ${(err as Error).message}` };
    }
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const payload = req.body as Record<string, unknown>;

    // beGateway webhook structure: { transaction: { ... } }
    const tx = (payload['transaction'] as Record<string, unknown>) ?? payload;
    const order = (tx['order'] as Record<string, unknown>) ?? {};
    const trackingId = String(order['tracking_id'] ?? tx['tracking_id'] ?? '');
    const uid = String(tx['uid'] ?? '');
    const statusStr = String(tx['status'] ?? '');
    const amountObj = order['amount'];

    return {
      paymentId: trackingId,
      externalPaymentId: uid,
      status: this.mapStatus(statusStr),
      amount: amountObj ? Number(amountObj) / 100 : undefined, // minor units → major
      currency: String(order['currency'] ?? 'RUB'),
      eventType: String(tx['type'] ?? 'payment'),
      raw: payload,
    };
  }

  /**
   * beGateway transaction statuses: successful, failed, incomplete, expired, authorized
   */
  private mapStatus(status: string): WebhookEventStatus {
    switch (status.toLowerCase()) {
      case 'successful': return 'SUCCESS';
      case 'failed':
      case 'error': return 'FAILED';
      case 'expired':
      case 'incomplete': return 'CANCELED';
      case 'refunded': return 'REFUNDED';
      default: return 'PENDING';
    }
  }
}
