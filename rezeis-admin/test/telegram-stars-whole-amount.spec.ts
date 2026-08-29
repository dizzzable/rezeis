import 'reflect-metadata';

import assert from 'node:assert/strict';

import { of } from 'rxjs';
import { describe, it } from 'node:test';

import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';

/**
 * Half a Star does not exist
 * ══════════════════════════
 *
 * `prices[].amount` for XTR is a COUNT of Stars, not a minor unit. The amount
 * arrives from a plan price an operator typed — a `Decimal` with two places,
 * like every other currency — and was handed to `Number()` and sent as-is.
 *
 * Telegram answered a generic `400 BAD_REQUEST`, which surfaced as "Telegram
 * Stars invoice creation failed": a message naming the integration and not the
 * price. The operator had nothing to act on, and the customer saw a checkout
 * that would not open.
 */

function buildService(post: (...args: unknown[]) => unknown) {
  const service = new PaymentProviderExecutionService(
    { post } as never,
    { publicUrl: 'https://panel.example' } as never,
    { redact: (v: unknown) => v } as never,
    undefined as never,
  );
  // The token lookup reaches optional deps this test has no interest in; the
  // guard under test sits after it, so it is stubbed rather than wired.
  (service as unknown as { resolveTelegramBotToken: () => Promise<string> })
    .resolveTelegramBotToken = async () => 'bot-token';
  return service as unknown as {
    createTelegramStarsCheckout(input: unknown): Promise<unknown>;
  };
}

function input(amount: string) {
  return {
    gateway: { type: 'TELEGRAM_STARS', settings: { botToken: 'tok' } },
    transaction: {
      paymentId: 'pay-1',
      currency: 'XTR',
      amount: { toString: () => amount },
    },
    description: 'Standard plan',
  };
}

describe('a Telegram Stars invoice needs a whole number of Stars', () => {
  it('refuses a fractional price, naming the number', async () => {
    let called = false;
    const service = buildService(() => {
      called = true;
      throw new Error('should not reach Telegram');
    });

    await assert.rejects(
      () => service.createTelegramStarsCheckout(input('10.50')),
      (err: Error) => err.message.includes('10.50'),
    );
    // Refused BEFORE the call: sending it earns a generic 400 that names the
    // integration rather than the price.
    assert.equal(called, false);
  });

  it('refuses zero and negative prices', async () => {
    const service = buildService(() => {
      throw new Error('should not reach Telegram');
    });

    await assert.rejects(() => service.createTelegramStarsCheckout(input('0')));
    await assert.rejects(() => service.createTelegramStarsCheckout(input('-5')));
  });

  it('sends a whole price through unchanged — the control', async () => {
    const sentPayloads: Array<{ prices: Array<{ amount: number }> }> = [];
    const service = buildService((..._args: unknown[]) => {
      sentPayloads.push(_args[1] as { prices: Array<{ amount: number }> });
      // `firstValueFrom` wants an Observable, so `of()` is the honest double —
      // a hand-rolled thenable throws inside rxjs and the failure reads as a
      // defect in the code under test.
      return of({ data: { ok: true, result: 'https://t.me/invoice/x' } });
    });

    await service.createTelegramStarsCheckout(input('150'));

    assert.equal(sentPayloads[0]?.prices[0]?.amount, 150);
  });
});
