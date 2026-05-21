/**
 * CloudPayments gateway adapter.
 *
 * Docs: https://developers.cloudpayments.ru/
 * Auth: Basic auth (publicId:apiSecret). Webhook: HMAC-SHA256 of body.
 *
 * Settings shape:
 *   publicId: string
 *   apiSecret: string
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
export class CloudpaymentsAdapter implements IPaymentGateway {
  readonly type = 'CLOUDPAYMENTS';
  private readonly logger = new Logger(CloudpaymentsAdapter.name);

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const publicId = settings['publicId'] as string;

    // CloudPayments uses a widget (client-side), so we return a widget URL with params
    const params = new URLSearchParams({
      publicId,
      description: input.description.slice(0, 200),
      amount: String(input.amount),
      currency: input.currency === 'RUB' ? 'RUB' : 'USD',
      invoiceId: input.paymentId,
      email: input.customerEmail ?? '',
    });

    // CloudPayments checkout page (widget-based)
    const paymentUrl = `https://widget.cloudpayments.ru/checkout?${params.toString()}`;

    return {
      externalPaymentId: input.paymentId,
      paymentUrl,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const apiSecret = settings['apiSecret'] as string;
    const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody ?? '';
    const receivedHmac = (req.headers['content-hmac'] as string | undefined) ?? (req.headers['x-content-hmac'] as string | undefined);

    if (!receivedHmac) return { valid: false, reason: 'No HMAC header' };

    const expected = crypto.createHmac('sha256', apiSecret).update(rawBody).digest('base64');
    return { valid: expected === receivedHmac };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body as CloudpaymentsWebhookBody;
    // CloudPayments sends Pay/Fail/Refund notifications
    const status: 'SUCCESS' | 'FAILED' | 'PENDING' =
      body.Status === 'Completed' ? 'SUCCESS' : body.Status === 'Declined' ? 'FAILED' : 'PENDING';

    return {
      paymentId: body.InvoiceId ?? '',
      externalPaymentId: String(body.TransactionId ?? ''),
      status,
      amount: body.Amount !== undefined ? parseFloat(String(body.Amount)) : undefined,
      currency: body.Currency ?? 'RUB',
      eventType: body.Status,
      raw: body,
    };
  }
}

interface CloudpaymentsWebhookBody {
  readonly Status?: string;
  readonly InvoiceId?: string;
  readonly TransactionId?: string | number;
  readonly Amount?: string | number;
  readonly Currency?: string;
}
