/**
 * RioPay payment gateway adapter.
 *
 * Docs: https://docs.riopay.online/ru/docs
 * Base URL: https://api.riopay.online/v1
 *
 * Auth: X-Api-Token header
 *
 * Create payment: POST /v1/orders
 *   Body: { amount, externalId, externalUserId?, isFeeOnUser?, purpose, successUrl, failUrl, callbackUrl }
 *   Response: { id, status, paymentLink, ... }
 *
 * Webhook: POST to callbackUrl
 *   Verification: check via API status endpoint (no HMAC documented)
 *
 * Settings shape:
 *   apiToken: string     — X-Api-Token value
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type {
  GatewayCheckoutInput,
  GatewayCheckoutResult,
  IPaymentGateway,
  NormalizedWebhookEvent,
  WebhookEventStatus,
  WebhookVerifyResult,
} from '../gateway.interface';

const BASE_URL = 'https://api.riopay.online/v1';

@Injectable()
export class RiopayAdapter implements IPaymentGateway {
  readonly type = 'RIOPAY';
  private readonly logger = new Logger(RiopayAdapter.name);

  private async apiPost<T>(
    path: string,
    body: object,
    settings: Record<string, unknown>,
  ): Promise<T> {
    const apiToken = settings['apiToken'] as string;

    const res = await fetch(`${BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Token': apiToken,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RioPay API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async apiGet<T>(path: string, settings: Record<string, unknown>): Promise<T> {
    const apiToken = settings['apiToken'] as string;

    const res = await fetch(`${BASE_URL}/${path}`, {
      method: 'GET',
      headers: {
        'X-Api-Token': apiToken,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RioPay API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async createCheckout(
    input: GatewayCheckoutInput,
    settings: Record<string, unknown>,
  ): Promise<GatewayCheckoutResult> {
    const body = {
      amount: String(input.amount),
      externalId: input.paymentId,
      externalUserId: input.metadata?.['telegramId'],
      isFeeOnUser: false,
      purpose: input.description.slice(0, 255),
      successUrl: input.successUrl,
      failUrl: input.failUrl,
      // callbackUrl can be set here or in dashboard settings
    };

    const response = await this.apiPost<{
      id?: string;
      status?: string;
      paymentLink?: string;
      externalId?: string;
      error?: string;
      message?: string;
    }>('orders', body, settings);

    if (!response.paymentLink) {
      throw new Error(
        `RioPay checkout failed: ${response.error ?? response.message ?? 'no paymentLink returned'}`,
      );
    }

    return {
      externalPaymentId: response.id ?? input.paymentId,
      paymentUrl: response.paymentLink,
      raw: response,
    };
  }

  async verifyWebhook(
    _req: Request,
    _settings: Record<string, unknown>,
  ): Promise<WebhookVerifyResult> {
    const apiToken = _settings['apiToken'] as string | undefined;
    const signature = _req.headers['x-signature'];
    const rawBody = (_req as Request & { rawBody?: Buffer }).rawBody;
    if (!apiToken || typeof signature !== 'string' || rawBody === undefined) {
      return { valid: false, reason: 'Missing RioPay webhook signature or raw body' };
    }
    const expected = createHmac('sha512', apiToken).update(rawBody).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'utf8');
    if (
      expectedBuffer.length !== signatureBuffer.length ||
      !timingSafeEqual(expectedBuffer, signatureBuffer)
    ) {
      return { valid: false, reason: 'Invalid RioPay webhook signature' };
    }
    return { valid: true };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const payload = req.body as Record<string, unknown>;

    // RioPay webhook body mirrors the order object
    const paymentId = String(payload['externalId'] ?? '');
    const externalPaymentId = String(payload['id'] ?? '');
    const status = this.mapStatus(String(payload['status'] ?? ''));

    return {
      paymentId,
      externalPaymentId,
      status,
      amount: payload['amount'] ? parseFloat(String(payload['amount'])) : undefined,
      currency: String(payload['currency'] ?? 'RUB'),
      eventType: 'payment',
      raw: payload,
    };
  }

  async checkPaymentStatus(
    externalPaymentId: string,
    settings: Record<string, unknown>,
  ): Promise<WebhookEventStatus> {
    const response = await this.apiGet<{ status?: string }>(
      `orders/${externalPaymentId}`,
      settings,
    );
    return this.mapStatus(response.status ?? '');
  }

  /**
   * RioPay order statuses: PENDING, PAID, FAILED, CANCELED, REFUNDED
   */
  private mapStatus(status: string): WebhookEventStatus {
    switch (status.toUpperCase()) {
      case 'PAID':
      case 'SUCCESS':
      case 'COMPLETED':
        return 'SUCCESS';
      case 'FAILED':
      case 'ERROR':
        return 'FAILED';
      case 'CANCELED':
      case 'CANCELLED':
        return 'CANCELED';
      case 'REFUNDED':
        return 'REFUNDED';
      default:
        return 'PENDING';
    }
  }
}
