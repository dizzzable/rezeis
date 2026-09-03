import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType, SubscriptionStatus } from '@prisma/client';

import {
  balanceToPoints,
  isSpendable,
  mapGatewayType,
  mapSubscriptionStatus,
  promocodeAction,
  remainingUses,
  toTelegramId,
} from '../src/modules/imports/services/bedolaga-importer.service';
import type { BedolagaPromocode } from '../src/modules/imports/utils/bedolaga-backup-parser';

/**
 * The rules a Bedolaga migration turns on.
 *
 * Everything here is a place where the donor's column does not mean what its
 * name says. Each one was found by reading their source, and each one, taken
 * at face value, would have moved somebody's money or somebody's subscription
 * to the wrong place — quietly, because an import that gets a number wrong
 * still reports success.
 */

function promocode(overrides: Partial<BedolagaPromocode> = {}): BedolagaPromocode {
  return {
    id: 1,
    code: 'WELCOME',
    type: 'subscription_days',
    balance_bonus_kopeks: 0,
    subscription_days: 0,
    traffic_gb: 0,
    max_uses: 1,
    current_uses: 0,
    valid_from: null,
    valid_until: null,
    is_active: true,
    first_purchase_only: false,
    ...overrides,
  };
}

describe('the money', () => {
  it('turns a kopek balance into whole points', () => {
    // 1250.50 ₽ at one point per rouble.
    assert.equal(balanceToPoints(125050 / 100, 1), 1251);
  });

  it('gives nothing for a debt', () => {
    // Points cannot be negative, and a negative balance in Bedolaga is a real
    // debt their own account merge goes out of its way to keep. The importer
    // reports it to the operator rather than pretending it was zero.
    assert.equal(balanceToPoints(-500 / 100, 1), 0);
  });

  it('does not strand a fraction of a rouble in float dust', () => {
    // `10.005 * 100` is 1000.4999… in IEEE arithmetic; without the epsilon
    // this rounds DOWN and half a kopek of every migrated balance vanishes.
    assert.equal(balanceToPoints(10.005, 1), 10);
    assert.equal(balanceToPoints(1.005, 100), 101);
  });

  it('refuses a nonsense rate instead of inventing money', () => {
    assert.equal(balanceToPoints(100, 0), 0);
    assert.equal(balanceToPoints(100, Number.NaN), 0);
  });
});

describe('the payment history', () => {
  it('maps the gateways a customer actually paid through', () => {
    assert.equal(mapGatewayType('yookassa'), PaymentGatewayType.YOOKASSA);
    assert.equal(mapGatewayType('TELEGRAM_STARS'), PaymentGatewayType.TELEGRAM_STARS);
    assert.equal(mapGatewayType('Pal24'), PaymentGatewayType.PAYPALYCH);
  });

  it('refuses the bot moving its own numbers', () => {
    // `balance` is somebody spending a wallet we have ALREADY carried over as
    // points, and `manual` is an operator adjusting it. Counting either as
    // revenue doubles every figure that reads the transaction ledger.
    assert.equal(mapGatewayType('balance'), null);
    assert.equal(mapGatewayType('manual'), null);
    assert.equal(mapGatewayType(null), null);
  });
});

describe('the subscriptions', () => {
  it('keeps a customer over their quota as a customer', () => {
    // `limited` is the panel's word for "out of traffic, still paying".
    // Reading it as expired would cut off someone who owes nothing.
    assert.equal(mapSubscriptionStatus('limited'), SubscriptionStatus.LIMITED);
  });

  it('treats a trial as the live subscription it is', () => {
    assert.equal(mapSubscriptionStatus('trial'), SubscriptionStatus.ACTIVE);
    assert.equal(mapSubscriptionStatus('active'), SubscriptionStatus.ACTIVE);
  });

  it('does not invent a status it has never seen', () => {
    assert.equal(mapSubscriptionStatus('something-new-in-v5'), SubscriptionStatus.EXPIRED);
  });
});

describe('the promo codes', () => {
  it('reads a "discount" code as a PERCENT, not as money', () => {
    // THE TRAP. For `type = 'discount'` Bedolaga stores the percent in
    // `balance_bonus_kopeks` and the lifetime in HOURS in `subscription_days`.
    // Read literally, a 50 % coupon becomes fifty kopecks — and read the other
    // way round, fifty roubles becomes a 5000 % discount.
    const action = promocodeAction(
      promocode({ type: 'discount', balance_bonus_kopeks: 50, subscription_days: 24 }),
    );

    assert.deepEqual(action, { type: 'PURCHASE_DISCOUNT', value: 50 });
  });

  it('clamps a discount to what this panel can actually honour', () => {
    const action = promocodeAction(
      promocode({ type: 'discount', balance_bonus_kopeks: 500 }),
    );

    assert.equal(action?.value, 90);
  });

  it('carries a days code across as days', () => {
    assert.deepEqual(promocodeAction(promocode({ subscription_days: 7 })), {
      type: 'DURATION',
      value: 7,
    });
  });

  it('has no home for a code that mints money', () => {
    // We carry money as points; a code that credits a balance is not
    // something this panel can express. Skipped and counted, not guessed at.
    assert.equal(promocodeAction(promocode({ type: 'balance', balance_bonus_kopeks: 10000 })), null);
  });

  it('imports only codes somebody could still spend', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');

    assert.equal(isSpendable(promocode(), now), true);
    assert.equal(isSpendable(promocode({ is_active: false }), now), false);
    assert.equal(isSpendable(promocode({ max_uses: 1, current_uses: 1 }), now), false);
    assert.equal(
      isSpendable(promocode({ valid_until: '2026-01-01T00:00:00Z' }), now),
      false,
      'a code whose window closed is history, and history does not need to work',
    );
    assert.equal(
      isSpendable(promocode({ max_uses: 0, current_uses: 900 }), now),
      true,
      'zero uses means unlimited, not exhausted',
    );
  });
});

describe('how many times a migrated code may still be spent', () => {
  it('carries over only what is LEFT', () => {
    assert.equal(remainingUses(promocode({ max_uses: 10, current_uses: 4 })), 6);
  });

  it('keeps an unlimited code unlimited', () => {
    // Zero means unlimited on their side. Read as "nothing left", a code an
    // operator posted to a whole channel becomes single-use and the second
    // person to try it is told it is spent.
    assert.equal(remainingUses(promocode({ max_uses: 0, current_uses: 900 })), null);
  });
});

describe('the identity', () => {
  it('accepts a real telegram id', () => {
    assert.equal(toTelegramId(777000111), 777000111n);
  });

  it('refuses the placeholders that are not one', () => {
    // A user row with no telegram is normal in Bedolaga (email and OAuth
    // accounts). Turning a zero or a null into an id would collide every one
    // of them onto a single customer here.
    assert.equal(toTelegramId(null), null);
    assert.equal(toTelegramId(0), null);
    assert.equal(toTelegramId(-1), null);
  });
});
