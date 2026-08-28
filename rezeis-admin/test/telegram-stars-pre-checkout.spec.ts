import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TransactionStatus } from '@prisma/client';

import { TelegramStarsWebhookService } from '../src/modules/payments/services/telegram-stars-webhook.service';

/**
 * The Telegram Stars pre-checkout decision.
 *
 * This is the last moment a Stars purchase can be refused, and the two
 * mistakes are not symmetrical. Refusing costs the buyer nothing — no stars
 * are taken and the invoice can be paid again. Approving wrongly takes their
 * money for something we may not deliver: on an already-fulfilled transaction
 * reconciliation exits early, so the stars are gone and nothing is granted —
 * and a Stars refund is manual and out-of-band, with no path in the admin UI
 * (`payment-refund.service.ts` reports `PAYMENT_REFUND_UNSUPPORTED_GATEWAY`
 * for every gateway but YooKassa).
 *
 * So every arm below that is not "a draft still awaiting payment" refuses, and
 * each is here because it is separately reachable: an invoice link survives the
 * draft it was made for, it can be opened twice, and a buyer can pay one that
 * was cancelled minutes earlier.
 *
 * The service had no spec at all before this. It was written, wired, and never
 * exercised — which fits, because until the bot started forwarding these
 * updates nothing could reach it.
 */

function buildService(transaction: { readonly status: TransactionStatus } | null) {
  const seen: unknown[] = [];
  const prisma = {
    transaction: {
      findUnique: async (args: unknown) => {
        seen.push(args);
        return transaction;
      },
    },
  };
  const service = new TelegramStarsWebhookService(
    prisma as never,
    {} as never,
    {} as never,
  );
  return { service, seen };
}

describe('Telegram Stars pre-checkout verdict', () => {
  it('approves a draft that is still awaiting payment', async () => {
    const { service, seen } = buildService({ status: TransactionStatus.PENDING });

    assert.deepStrictEqual(await service.resolvePreCheckout('pay_1'), {
      approve: true,
      reason: 'OK',
    });
    // Looked up by `paymentId` — the invoice payload rezeis put on the invoice
    // at checkout is the only link between the query and the transaction.
    assert.deepStrictEqual(seen, [
      { where: { paymentId: 'pay_1' }, select: { status: true } },
    ]);
  });

  it('refuses a transaction that is no longer a draft', async () => {
    // The double-pay case: one invoice link, paid twice. The second payment
    // would be taken and silently dropped by reconciliation.
    for (const status of [
      TransactionStatus.COMPLETED,
      TransactionStatus.CANCELED,
      TransactionStatus.FAILED,
    ]) {
      const { service } = buildService({ status });
      assert.deepStrictEqual(
        await service.resolvePreCheckout('pay_1'),
        { approve: false, reason: 'NOT_PAYABLE' },
        `status ${status} must not be payable`,
      );
    }
  });

  it('refuses a payload naming no transaction we know', async () => {
    // An invoice link outlives the draft it was created for, so this is the
    // ordinary state of an old link, not an attack.
    const { service } = buildService(null);
    assert.deepStrictEqual(await service.resolvePreCheckout('pay_gone'), {
      approve: false,
      reason: 'UNKNOWN_PAYMENT',
    });
  });

  it('refuses an empty or missing payload without querying', async () => {
    // Nothing to look up, and the caller is inside Telegram's ten-second
    // budget — spending part of it to reach the same refusal helps nobody.
    for (const payload of [null, '', '   ']) {
      const { service, seen } = buildService({ status: TransactionStatus.PENDING });
      assert.deepStrictEqual(await service.resolvePreCheckout(payload), {
        approve: false,
        reason: 'UNKNOWN_PAYMENT',
      });
      assert.deepStrictEqual(seen, [], 'must not reach the database');
    }
  });

  it('trims the payload before matching', async () => {
    // Telegram echoes the invoice payload verbatim; a stray space would
    // otherwise turn a live draft into "unknown payment" and refuse a
    // legitimate purchase.
    const { service, seen } = buildService({ status: TransactionStatus.PENDING });
    await service.resolvePreCheckout('  pay_1  ');
    assert.deepStrictEqual(seen, [
      { where: { paymentId: 'pay_1' }, select: { status: true } },
    ]);
  });
});
