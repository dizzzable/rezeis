/**
 * Telegram Stars payment gateway adapter.
 *
 * Uses Telegram Bot API's sendInvoice for native in-app payments.
 * Currency: XTR (Telegram Stars).
 * No external webhook — uses pre_checkout_query + successful_payment events.
 *
 * Settings shape:
 *   botToken: string — Telegram bot token
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type {
  GatewayCheckoutInput,
  GatewayCheckoutResult,
  IPaymentGateway,
  NormalizedWebhookEvent,
  WebhookVerifyResult,
} from '../gateway.interface';

@Injectable()
export class TelegramStarsAdapter implements IPaymentGateway {
  readonly type = 'TELEGRAM_STARS';
  private readonly logger = new Logger(TelegramStarsAdapter.name);

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const botToken = settings['botToken'] as string;
    const telegramId = input.metadata?.['telegramId'];

    if (!botToken || !telegramId) {
      throw new Error('TelegramStars: botToken and telegramId are required');
    }

    // Amount in Stars (XTR) — integer
    const starsAmount = Math.ceil(input.amount);

    const payload = JSON.stringify({ paymentId: input.paymentId });

    const res = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.description.slice(0, 32),
        description: input.description,
        payload,
        currency: 'XTR',
        prices: [{ label: input.description.slice(0, 16), amount: starsAmount }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`TelegramStars createInvoiceLink failed: ${res.status} ${text}`);
    }

    const data = await res.json() as { ok: boolean; result?: string };
    if (!data.ok || !data.result) {
      throw new Error('TelegramStars: failed to create invoice link');
    }

    return {
      externalPaymentId: input.paymentId,
      paymentUrl: data.result,
    };
  }

  async verifyWebhook(_req: Request, _settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    // Telegram Stars webhooks come through the bot update handler
    // Verification is done by Telegram itself (bot token validates the update)
    return { valid: true };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;
    // successful_payment update from Telegram
    const payment = body?.message?.successful_payment ?? body?.successful_payment ?? body;
    const payload = JSON.parse(payment?.invoice_payload ?? '{}');

    return {
      paymentId: payload.paymentId ?? '',
      externalPaymentId: payment?.telegram_payment_charge_id ?? '',
      status: 'SUCCESS',
      amount: payment?.total_amount,
      currency: 'XTR',
      eventType: 'successful_payment',
      raw: body,
    };
  }
}
