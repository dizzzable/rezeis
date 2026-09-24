import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  convertPaidRemainder,
  convertRenewalPricedBeforeUpgrade,
  describeRenewalPricedBeforeUpgrade,
  findDaysConvertedFromPayment,
  PAID_REMAINDER_CONVERSION_KEY,
  readRenewalPricedBeforeUpgrade,
  reconstructPaidWindow,
  resolvePaidRemainderConversion,
  type PaidRemainderCandidate,
  type PaidRemainderCandidateItem,
  type PaidRemainderPlanDuration,
} from '../src/modules/subscriptions/services/paid-remainder-conversion.util';

/**
 * What is left of the old plan on an UPGRADE, as days on the new one — one
 * test per rule of `paid-remainder-conversion.util.ts`, and the owner's worked
 * examples. Every case reads the whole function: the payments as fulfilment
 * reads them, the subscription, the new plan's prices.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-24T12:00:00.000Z');
const SUB = 'sub-1';

/** `NOW` moved by `days` (negative is the past). */
function at(days: number): Date {
  return new Date(NOW.getTime() + days * DAY);
}

let sequence = 0;

/** A fulfilled payment of `SUB`, COMPLETED unless told otherwise. */
function payment(input: {
  readonly type: 'NEW' | 'ADDITIONAL' | 'RENEW' | 'UPGRADE';
  readonly paidAt: number;
  readonly days: number;
  readonly amount: string;
  readonly currency?: string;
  readonly id?: string;
  readonly status?: string;
  readonly gatewayData?: Record<string, unknown>;
  readonly planSnapshot?: Record<string, unknown>;
  readonly subscriptionId?: string | null;
  readonly items?: readonly PaidRemainderCandidateItem[];
}): PaidRemainderCandidate {
  sequence += 1;
  return {
    id: input.id ?? `tx-${sequence}`,
    subscriptionId: input.subscriptionId === undefined ? SUB : input.subscriptionId,
    purchaseType: input.type,
    status: input.status ?? 'COMPLETED',
    fulfilledAt: at(input.paidAt),
    amount: input.amount,
    currency: input.currency ?? 'RUB',
    planSnapshot: { id: 'plan-old', selectedDurationDays: input.days, ...input.planSnapshot },
    gatewayData: input.gatewayData ?? {},
    items: input.items ?? [],
  };
}

/** A plan's durations: `[days, price]` pairs in RUB, all active. */
function plan(...durations: ReadonlyArray<readonly [number, string]>): PaidRemainderPlanDuration[] {
  return durations.map(([days, price]) => ({ days, isActive: true, prices: [{ currency: 'RUB', price }] }));
}

const PREMIUM = plan([30, '650']);
const BASIC = plan([30, '200']);

function convert(input: {
  readonly candidates: readonly PaidRemainderCandidate[];
  readonly expiresInDays: number | null;
  readonly target?: readonly PaidRemainderPlanDuration[];
  readonly status?: string;
  readonly excludeTransactionId?: string;
  readonly purchasedDurationDays?: number;
  /** The subscription's `startedAt`, in days from now; unstamped (`null`) unless told. */
  readonly startedInDays?: number | null;
}) {
  return resolvePaidRemainderConversion({
    now: NOW,
    subscription: {
      id: SUB,
      status: input.status ?? 'ACTIVE',
      expiresAt: input.expiresInDays === null ? null : at(input.expiresInDays),
      startedAt: input.startedInDays === undefined || input.startedInDays === null ? null : at(input.startedInDays),
    },
    candidates: input.candidates,
    excludeTransactionId: input.excludeTransactionId,
    targetPlanDurations: input.target ?? PREMIUM,
    purchasedDurationDays: input.purchasedDurationDays ?? 30,
  });
}

describe('the owner’s worked examples', () => {
  it('Базовый 200 ₽ / 30 d, 20 days left → Премиум 650 ₽ / 30 d: 6 days (133.33 / 21.67 = 6.15, floored)', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 20,
    });

    assert.equal(result.days, 6);
    assert.equal(result.fractionalDays, '6.1538');
    assert.equal(result.remainingPaidDays, 20);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0]?.overlapDays, '20.0000');
    assert.equal(result.sources[0]?.value, '133.33');
    assert.equal(result.sources[0]?.currency, 'RUB');
  });

  it('300 ₽ / 30 d bought at −20 % (240 ₽), 20 of 30 left → 600 ₽ / 30 d: exactly 8 (160 / 20)', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '240' })],
      expiresInDays: 20,
      target: plan([30, '600']),
    });

    assert.equal(result.days, 8);
    assert.equal(result.fractionalDays, '8.0000', 'one exact fraction, not 7.999…');
    assert.equal(result.sources[0]?.value, '160.00');
  });

  it('1 000 ₽ / 180 d, 20 days left → Премиум 650 ₽ / 30 d: 5 days (111.11 / 21.67) — the long-term discount counts', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -160, days: 180, amount: '1000' })],
      expiresInDays: 20,
    });

    assert.equal(result.days, 5);
    assert.equal(result.sources[0]?.value, '111.11');
  });

  it('Премиум, 10 days left → Базовый: never more than the 10 days still paid for', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -20, days: 30, amount: '650' })],
      expiresInDays: 10,
      target: BASIC,
    });

    // 216.67 ₽ at 6.67 ₽ a day would be 32 days.
    assert.equal(result.fractionalDays, '32.5000');
    assert.equal(result.days, 10, 'capped at the whole days still paid for');
    assert.equal(result.remainingPaidDays, 10);
  });

  it('divides by the most expensive day even when a long duration is cheaper (180 d for 3 000 ₽ = 16.67 ₽ a day)', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 20,
      target: plan([30, '650'], [180, '3000']),
    });

    assert.equal(result.days, 6, '133.33 / 16.67 would be 8');
  });
});

describe('the rule', () => {
  it('takes the most expensive day, which is not always the shortest duration', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '300' })],
      expiresInDays: 20,
      // 7 days for 70 ₽ is 10 ₽ a day; 30 days for 600 ₽ is 20 ₽ a day.
      target: plan([7, '70'], [30, '600']),
    });

    assert.equal(result.days, 10, '200 ₽ / 20 ₽; the shortest would give 20');
  });

  it('gives nothing for free days: bonus days, an operator’s extension, a trial', () => {
    // No payment at all — a free trial, or days handed out.
    assert.equal(convert({ candidates: [], expiresInDays: 20 }).days, 0);
    // A paid chunk with 20 days left, and 20 more given for free on top of it.
    const extended = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 40,
    });
    assert.equal(extended.days, 6, 'only the paid 20 days convert');
    assert.equal(extended.remainingPaidDays, 20);
  });

  it('counts a paid trial for what was paid, which is next to nothing', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -1, days: 3, amount: '10' })],
      expiresInDays: 2,
    });

    assert.equal(result.fractionalDays, '0.3077');
    assert.equal(result.days, 0);
  });

  it('floors: 6.15 days is 6', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 20,
    });

    assert.equal(result.days, 6);
  });

  it('starts a renewal after a lapse at its payment, not at the old end', () => {
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -70, days: 30, amount: '200' }),
        payment({ type: 'RENEW', paidAt: -10, days: 30, amount: '200' }),
      ],
      expiresInDays: 20,
    });

    // Chained from the old end (−40) it would have run out ten days ago.
    assert.equal(result.days, 6);
    assert.equal(result.sources.length, 1);
    assert.equal(result.remainingPaidDays, 20);
  });

  it('chains a renewal onto the paid end, and converts both', () => {
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' }),
        payment({ type: 'RENEW', paidAt: -5, days: 30, amount: '200' }),
      ],
      expiresInDays: 50,
    });

    // 133.33 + 200 = 333.33 ₽ at 21.67 ₽ a day.
    assert.equal(result.fractionalDays, '15.3846');
    assert.equal(result.days, 15);
    assert.deepEqual(
      result.sources.map((source) => source.overlapDays),
      ['20.0000', '30.0000'],
    );
  });

  it('is conservative about bonus days between chunks: the paid days are assumed spent first', () => {
    // NEW runs to −5, ten bonus days follow, then a renewal paid at −20 is
    // added: the real expiry is +35 and the renewal is untouched. Rebuilt, the
    // renewal runs from −5 to +25, so 25 of its days are counted, not 30.
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -35, days: 30, amount: '200' }),
        payment({ type: 'RENEW', paidAt: -20, days: 30, amount: '200' }),
      ],
      expiresInDays: 35,
    });

    assert.equal(result.remainingPaidDays, 25);
    assert.equal(result.days, 7, '166.67 / 21.67; 30 days would give 9');
  });

  it('reads the fulfilment order, whatever order the rows come in', () => {
    const rows = [
      payment({ type: 'NEW', paidAt: -70, days: 30, amount: '200' }),
      payment({ type: 'RENEW', paidAt: -10, days: 30, amount: '200' }),
    ];

    assert.equal(convert({ candidates: [...rows].reverse(), expiresInDays: 20 }).days, 6);
  });

  it('uses only this subscription’s own line of a renewal that paid for several', () => {
    const combined = payment({
      type: 'RENEW',
      paidAt: -15,
      days: 0,
      amount: '600',
      subscriptionId: null,
      items: [
        { subscriptionId: SUB, durationDays: 30, amount: '200', currency: 'RUB', appliedAt: at(-15) },
        { subscriptionId: 'sub-2', durationDays: 30, amount: '400', currency: 'RUB', appliedAt: at(-15) },
      ],
    });
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -40, days: 30, amount: '200' }), combined],
      expiresInDays: 20,
    });

    // The line runs from −10 (the NEW's end) to +20: 200 ₽ × 20 / 30.
    assert.equal(result.days, 6, 'the whole 600 ₽ would give 18');
    assert.equal(result.sources[0]?.transactionId, combined.id);
    assert.equal(result.sources[0]?.value, '133.33');
  });

  it('gives nothing for a renewal whose share of a multi-subscription payment cannot be told', () => {
    const noOwnLine = payment({
      type: 'RENEW',
      paidAt: -10,
      days: 30,
      amount: '600',
      items: [{ subscriptionId: 'sub-2', durationDays: 30, amount: '600', currency: 'RUB', appliedAt: at(-10) }],
    });
    const twoLines = payment({
      type: 'RENEW',
      paidAt: -10,
      days: 30,
      amount: '400',
      subscriptionId: null,
      items: [
        { subscriptionId: SUB, durationDays: 30, amount: '200', currency: 'RUB', appliedAt: at(-10) },
        { subscriptionId: SUB, durationDays: 30, amount: '200', currency: 'RUB', appliedAt: at(-10) },
      ],
    });
    for (const renewal of [noOwnLine, twoLines]) {
      const result = convert({ candidates: [renewal], expiresInDays: 20 });
      assert.equal(result.days, 0, renewal.id);
      assert.deepEqual(result.sources, []);
    }
  });

  it('ignores a line of a multi-subscription payment that was never applied', () => {
    const result = convert({
      candidates: [
        payment({
          type: 'RENEW',
          paidAt: -10,
          days: 30,
          amount: '200',
          subscriptionId: null,
          items: [{ subscriptionId: SUB, durationDays: 30, amount: '200', currency: 'RUB', appliedAt: null }],
        }),
      ],
      expiresInDays: 20,
    });

    assert.equal(result.days, 0);
  });

  it('converts nothing in a currency the new plan has no price in — no exchange rates', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '5', currency: 'USD' })],
      expiresInDays: 20,
    });

    assert.equal(result.days, 0);
    assert.equal(result.sources[0]?.currency, 'USD');
    assert.equal(result.sources[0]?.value, '3.33', 'the value is still recorded');
    assert.equal(result.sources[0]?.days, '0.0000');
  });

  it('divides each chunk by the most expensive day in its own currency', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '6', currency: 'USD' })],
      expiresInDays: 20,
      target: [
        { days: 30, isActive: true, prices: [{ currency: 'RUB', price: '650' }, { currency: 'USD', price: '7.5' }] },
      ],
    });

    // 4 USD at 0.25 USD a day.
    assert.equal(result.days, 16);
  });

  it('skips an inactive duration, an unlimited one and a free price when looking for the dearest day', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 20,
      target: [
        { days: 1, isActive: false, prices: [{ currency: 'RUB', price: '1000' }] },
        { days: -1, isActive: true, prices: [{ currency: 'RUB', price: '1' }] },
        { days: 7, isActive: true, prices: [{ currency: 'RUB', price: '0' }] },
        { days: 30, isActive: true, prices: [{ currency: 'RUB', price: '650' }] },
      ],
    });

    assert.equal(result.days, 6);
  });

  it('treats a price of nothing as no price, not as an endless supply of days', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 20,
      target: plan([30, '0']),
    });

    assert.equal(result.days, 0, 'dividing by a free day would reach the cap of 20');
  });

  it('gives nothing when the new plan has no finite duration', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 20,
      target: plan([-1, '5000']),
    });

    assert.equal(result.days, 0);
  });

  it('gives nothing when the upgrade buys an unlimited term: there is no end to add days to', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 20,
      purchasedDurationDays: -1,
    });

    assert.equal(result.days, 0);
  });

  it('skips a lifetime chunk, whose money has no days to spread over', () => {
    const alone = convert({
      candidates: [payment({ type: 'RENEW', paidAt: -10, days: -1, amount: '5000' })],
      expiresInDays: null,
    });
    assert.equal(alone.days, 0);
    assert.deepEqual(alone.sources, []);

    // Beside a paid chunk it moves nothing: the NEW still runs to +20.
    const beside = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' }),
        payment({ type: 'RENEW', paidAt: -5, days: -1, amount: '5000' }),
      ],
      expiresInDays: 20,
    });
    assert.equal(beside.days, 6);
    assert.equal(beside.remainingPaidDays, 20);
  });

  it('gives nothing for an expired subscription', () => {
    const chunk = payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' });
    // Past its expiry, though the payment alone would still cover 20 days.
    assert.equal(convert({ candidates: [chunk], expiresInDays: -1 }).days, 0);
    // Marked expired.
    assert.equal(convert({ candidates: [chunk], expiresInDays: 20, status: 'EXPIRED' }).days, 0);
  });

  it('caps at an expiry an operator shortened', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' })],
      expiresInDays: 5,
    });

    // 33.33 ₽ = 1.54 days.
    assert.equal(result.remainingPaidDays, 5);
    assert.equal(result.days, 1);
  });
});

describe('what never converts', () => {
  const NEW_CHUNK = () => payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' });

  it('a withheld payment: applied to nothing, it is not in the chain at all', () => {
    const withheld = payment({
      type: 'UPGRADE',
      paidAt: -5,
      days: 30,
      amount: '650',
      gatewayData: { conversionWithheldAt: at(-5).toISOString(), trialConvertedByPaymentId: 'payment-1' },
    });
    const result = convert({ candidates: [NEW_CHUNK(), withheld], expiresInDays: 20 });

    assert.equal(result.days, 6, 'the NEW alone, neither cut short nor joined by the withheld one');
    assert.equal(result.sources.length, 1);
  });

  it('a payment with any refund on it — in full, in part, requested, under way — or charged back', () => {
    const marks: ReadonlyArray<Record<string, unknown>> = [
      { refundReversedAt: at(-1).toISOString() },
      { refundReversalClaimedAt: at(-1).toISOString() },
      { partialRefundAt: at(-1).toISOString(), refundedAmountTotal: '50.00' },
      { refundedAmountTotal: '200.00' },
      { refunds: [{ refundId: 'rf-1', amount: '20.00', at: at(-1).toISOString() }] },
      { refundRequestedAt: at(-1).toISOString() },
      { refundId: 'rf-2' },
      { refundNeedsManualReview: true },
      // «Отметить возврат»: the operator's word, committed before the reversal runs.
      { manualRefundRecordedAt: at(-1).toISOString(), manualRefundRecordedBy: 'admin-1' },
    ];
    for (const gatewayData of marks) {
      const result = convert({
        candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200', gatewayData })],
        expiresInDays: 20,
      });
      assert.equal(result.days, 0, JSON.stringify(gatewayData));
      assert.deepEqual(result.sources, [], JSON.stringify(gatewayData));
    }
    const chargedBack = convert({
      candidates: [
        payment({
          type: 'RENEW',
          paidAt: -10,
          days: 30,
          amount: '200',
          status: 'CANCELED',
          gatewayData: { providerStatus: 'CHARGEBACKED', refundReversedAt: at(-2).toISOString() },
        }),
      ],
      expiresInDays: 20,
    });
    assert.equal(chargedBack.days, 0);
    // Reversed, with the stamp lost: CANCELED alone says the money went back.
    const cancelled = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200', status: 'CANCELED' })],
      expiresInDays: 20,
    });
    assert.equal(cancelled.days, 0);
  });

  it('a payment of nothing', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '0' })],
      expiresInDays: 20,
    });

    assert.equal(result.days, 0);
  });

  it('an add-on, which buys a limit and no time', () => {
    const addOn = payment({
      type: 'ADDITIONAL',
      paidAt: -5,
      days: 30,
      amount: '99',
      planSnapshot: { snapshotSource: 'ADDON_PURCHASE', addOnId: 'addon-1' },
    });
    const result = convert({ candidates: [NEW_CHUNK(), addOn], expiresInDays: 20 });

    assert.equal(result.days, 6, 'as an ADDITIONAL purchase it would have restarted the chain at −5');
    assert.equal(result.sources.length, 1);
  });

  it('a payment imported from another bot', () => {
    const imported = payment({
      type: 'NEW',
      paidAt: -10,
      days: 30,
      amount: '200',
      planSnapshot: { importedFrom: 'bedolaga' },
    });

    assert.equal(convert({ candidates: [imported], expiresInDays: 20 }).days, 0);
  });

  it('the upgrade being fulfilled', () => {
    const upgrade = payment({ id: 'tx-upgrade', type: 'UPGRADE', paidAt: 0, days: 30, amount: '650' });
    const result = convert({
      candidates: [NEW_CHUNK(), upgrade],
      expiresInDays: 20,
      excludeTransactionId: 'tx-upgrade',
    });

    // Counted, it would restart the chain now and convert its own 650 ₽.
    assert.equal(result.days, 6);
    assert.equal(result.sources.length, 1);
    assert.ok(!result.sources.some((source) => source.transactionId === 'tx-upgrade'));
  });
});

describe('chains of plan changes accumulate nothing', () => {
  it('a second upgrade converts what the first one’s payment bought — not the days it added, not what it converted', () => {
    // NEW at −20; the upgrade at −10 converted 3 days of it and ends at +23.
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -20, days: 30, amount: '200' }),
        payment({ type: 'UPGRADE', paidAt: -10, days: 30, amount: '650' }),
      ],
      expiresInDays: 23,
    });

    assert.equal(result.remainingPaidDays, 20);
    assert.equal(result.days, 20, '433.33 ₽ at 21.67 ₽ a day; the NEW was spent by the first upgrade');
    assert.equal(result.sources.length, 1);
  });

  it('a refunded upgrade still ends what came before it: pay, refund, upgrade again converts nothing twice', () => {
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -20, days: 30, amount: '200' }),
        payment({
          type: 'UPGRADE',
          paidAt: -5,
          days: 30,
          amount: '650',
          status: 'CANCELED',
          gatewayData: { refundReversedAt: at(-1).toISOString(), refundedAmountTotal: '650.00' },
        }),
      ],
      expiresInDays: 25,
    });

    // Dropped instead, the NEW would convert its last 10 days a second time.
    assert.equal(result.days, 0);
    assert.deepEqual(result.sources, []);
  });

  it('a free plan change ends what came before it too', () => {
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -20, days: 30, amount: '200' }),
        payment({ type: 'UPGRADE', paidAt: -5, days: 30, amount: '0' }),
      ],
      expiresInDays: 25,
    });

    assert.equal(result.days, 0);
  });

  it('a renewal worth nothing — refunded, or free — is left out of the chain, like bonus days', () => {
    const worthless = [
      payment({ type: 'RENEW', paidAt: -5, days: 30, amount: '200', gatewayData: { refundedAmountTotal: '200.00' } }),
      payment({ type: 'RENEW', paidAt: -5, days: 30, amount: '0' }),
    ];
    for (const renewal of worthless) {
      const result = convert({
        candidates: [
          payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' }),
          renewal,
          payment({ type: 'RENEW', paidAt: -3, days: 30, amount: '200' }),
        ],
        expiresInDays: 80,
      });

      // The paid renewal runs from the NEW's end (+20) to +50, not from +50.
      assert.equal(result.remainingPaidDays, 50, renewal.id);
      assert.equal(result.days, 15, renewal.id);
    }
  });
});

describe('the two halves', () => {
  it('reconstructs the window and converts it the same way the whole does', () => {
    const candidates = [
      payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' }),
      payment({ type: 'RENEW', paidAt: -5, days: 30, amount: '200' }),
    ];
    const subscription = { id: SUB, status: 'ACTIVE', expiresAt: at(50), startedAt: at(-10) };
    const window = reconstructPaidWindow({ now: NOW, subscription, candidates });

    assert.equal(window.paidThrough?.toISOString(), at(50).toISOString());
    assert.equal(window.to.toISOString(), at(50).toISOString());
    assert.equal(window.overlaps.length, 2);
    assert.deepEqual(
      convertPaidRemainder({ window, targetPlanDurations: PREMIUM, purchasedDurationDays: 30 }),
      resolvePaidRemainderConversion({
        now: NOW,
        subscription,
        candidates,
        targetPlanDurations: PREMIUM,
        purchasedDurationDays: 30,
      }),
    );
  });
});

describe('a payment another worker has only claimed', () => {
  const A_SECOND_AGO = -1 / 86_400;

  it('leaves out a plan change fulfilled after the subscription started: 6 days, not 20', () => {
    // Базовый, bought ten days ago, started the subscription. A second upgrade
    // (650 ₽) is claimed a second ago and waits for this row's lock.
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' }),
        payment({ type: 'UPGRADE', paidAt: A_SECOND_AGO, days: 30, amount: '650' }),
      ],
      expiresInDays: 20,
      startedInDays: -10,
    });

    assert.equal(result.days, 6);
    assert.equal(result.sources.length, 1);
  });

  it('leaves out the second conversion of a free trial: 0 days, not 2', () => {
    const result = convert({
      candidates: [payment({ type: 'UPGRADE', paidAt: A_SECOND_AGO, days: 30, amount: '200' })],
      expiresInDays: 2,
      startedInDays: -1,
      target: plan([30, '200']),
    });

    assert.equal(result.days, 0);
    assert.deepEqual(result.sources, []);
  });

  it('keeps an applied plan change, whose payment stamped the subscription’s start', () => {
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -20, days: 30, amount: '200' }),
        payment({ type: 'UPGRADE', paidAt: -10, days: 30, amount: '650' }),
      ],
      expiresInDays: 23,
      startedInDays: -10,
    });

    assert.equal(result.days, 20);
  });

  it('cannot tell on a row nothing ever stamped, and reads every plan change there as applied', () => {
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' }),
        payment({ type: 'UPGRADE', paidAt: A_SECOND_AGO, days: 30, amount: '650' }),
      ],
      expiresInDays: 20,
      startedInDays: null,
    });

    assert.equal(result.days, 20);
  });

  it('reads a payment stamped after its start long ago as applied: the 2026-07-06 backfill, not a claim', () => {
    // Completed before `fulfilled_at` existed, the migration stamped it with
    // `updated_at` — here a day after the start it made. A claim is minutes.
    const legacyNew = convert({
      candidates: [payment({ type: 'NEW', paidAt: -9, days: 30, amount: '200' })],
      expiresInDays: 20,
      startedInDays: -10,
    });
    assert.equal(legacyNew.days, 6, 'its money is still unused');

    // The last plan change from then: 1 300 ₽ for 60 days, applied at -30 and
    // stamped at -29. Read as a claim, it would not end the 10 ₽-a-day NEW.
    const legacyUpgrade = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -60, days: 365, amount: '3650' }),
        payment({ type: 'UPGRADE', paidAt: -29, days: 60, amount: '1300' }),
      ],
      expiresInDays: 30,
      startedInDays: -30,
    });
    assert.equal(legacyUpgrade.days, 30, 'the upgrade’s 650 ₽ left, not 300 ₽ of the NEW');
  });

  it('never lets a renewal only claimed price a day the subscription holds: the excess goes off the dearest days', () => {
    // The NEW runs to +20. R1 (600 ₽, 20 ₽ a day) was claimed and is not
    // applied; R2 (200 ₽) was applied after it, so `expiresAt` = +50 holds the
    // NEW and R2. Rebuilt in order, R1 fills [+20, +50) and pushes R2 past the
    // expiry: cut from the tail, the window prices 30 days at R1's rate.
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200' }),
        payment({ id: 'r1', type: 'RENEW', paidAt: -2, days: 30, amount: '600' }),
        payment({ id: 'r2', type: 'RENEW', paidAt: -1, days: 30, amount: '200' }),
      ],
      expiresInDays: 50,
      startedInDays: -10,
    });

    // 133.33 ₽ of the NEW and 200 ₽ of R2: 15.38 days. At R1's price, 33.
    assert.equal(result.remainingPaidDays, 50);
    assert.equal(result.days, 15);
    assert.ok(!result.sources.some((source) => source.transactionId === 'r1'), JSON.stringify(result.sources));
  });

  it('takes an operator’s cut off the dearest days too', () => {
    // NEW at 10 ₽ a day, then a renewal at 5 ₽ a day; the expiry cut by 10 days.
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -10, days: 30, amount: '300' }),
        payment({ type: 'RENEW', paidAt: -5, days: 30, amount: '150' }),
      ],
      expiresInDays: 40,
      startedInDays: -10,
    });

    // 10 NEW days (100 ₽) and 30 renewal days (150 ₽): 11.5. Cut from the tail, 13.8.
    assert.equal(result.days, 11);
  });
});

describe('what actually arrived', () => {
  it('counts a payment the provider reported short at what arrived', () => {
    const result = convert({
      candidates: [
        payment({
          type: 'NEW',
          paidAt: -10,
          days: 30,
          amount: '200',
          gatewayData: { notifiedAmountShortfallAt: at(-10).toISOString(), notifiedAmount: '100' },
        }),
      ],
      expiresInDays: 20,
    });

    // 100 ₽ × 20 / 30 = 66.67 ₽: 3.08 days, not 6.
    assert.equal(result.sources[0]?.value, '66.67');
    assert.equal(result.days, 3);
  });

  it('counts a payment held as underpaid with no figure reported as nothing', () => {
    const result = convert({
      candidates: [
        payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200', gatewayData: { amountMismatchAt: at(-10).toISOString() } }),
      ],
      expiresInDays: 20,
    });

    assert.equal(result.days, 0);
  });

  it('pays no attention to a report of more than the invoice', () => {
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -10, days: 30, amount: '200', gatewayData: { notifiedAmount: '250' } })],
      expiresInDays: 20,
    });

    assert.equal(result.days, 6);
  });

  it('gives a line of a payment for several subscriptions its share of what arrived', () => {
    const combined = payment({
      type: 'RENEW',
      paidAt: -15,
      days: 0,
      amount: '600',
      subscriptionId: null,
      gatewayData: { notifiedAmountShortfallAt: at(-15).toISOString(), notifiedAmount: '300' },
      items: [
        { subscriptionId: SUB, durationDays: 30, amount: '200', currency: 'RUB', appliedAt: at(-15) },
        { subscriptionId: 'sub-2', durationDays: 30, amount: '400', currency: 'RUB', appliedAt: at(-15) },
      ],
    });
    const result = convert({
      candidates: [payment({ type: 'NEW', paidAt: -40, days: 30, amount: '200' }), combined],
      expiresInDays: 20,
    });

    // Half of the payment arrived, so half of the line: 100 ₽ × 20 / 30.
    assert.equal(result.sources[0]?.value, '66.67');
    assert.equal(result.days, 3);
  });
});

describe('the days a refunded payment bought (for its refund card)', () => {
  interface Row {
    readonly id: string;
    readonly paymentId: string;
    readonly subscriptionId: string | null;
    readonly purchaseType: string;
    readonly fulfilledAt: Date | null;
    readonly gatewayData: unknown;
    readonly items: ReadonlyArray<{ readonly subscriptionId: string }>;
  }

  /** `transactions` as the helper reads it: by id, and by subscription, type, time and id. */
  function database(rows: readonly Row[]) {
    return {
      transaction: {
        findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          const subscriptions = (where.subscriptionId as { in: string[] }).in;
          const since = (where.fulfilledAt as { gte: Date }).gte;
          const except = (where.id as { not: string }).not;
          return rows
            .filter(
              (row) =>
                row.subscriptionId !== null &&
                subscriptions.includes(row.subscriptionId) &&
                row.purchaseType === where.purchaseType &&
                row.fulfilledAt !== null &&
                row.fulfilledAt.getTime() >= since.getTime() &&
                row.id !== except,
            )
            .sort((left, right) => left.fulfilledAt!.getTime() - right.fulfilledAt!.getTime());
        },
      },
    } as never;
  }

  function converted(id: string, input: { at: number; subscriptionId?: string; days: number; sources: Record<string, string> }): Row {
    return {
      id,
      paymentId: `pay-${id}`,
      subscriptionId: input.subscriptionId ?? SUB,
      purchaseType: 'UPGRADE',
      fulfilledAt: at(input.at),
      gatewayData: {
        [PAID_REMAINDER_CONVERSION_KEY]: {
          days: input.days,
          sources: Object.entries(input.sources).map(([transactionId, days]) => ({ transactionId, days })),
        },
      },
      items: [],
    };
  }

  const NEW_ROW: Row = {
    id: 'tx-new',
    paymentId: 'pay-new',
    subscriptionId: SUB,
    purchaseType: 'NEW',
    fulfilledAt: at(-10),
    gatewayData: {},
    items: [],
  };

  it('names each later upgrade that counted the payment: the ceiling of its share, never more than it added', async () => {
    const found = await findDaysConvertedFromPayment(
      database([
        NEW_ROW,
        converted('up-1', { at: -5, days: 6, sources: { 'tx-new': '6.1538' } }),
        converted('up-2', { at: -2, days: 15, sources: { 'tx-new': '6.1538', 'tx-renew': '9.2308' } }),
      ]),
      'tx-new',
    );

    assert.deepEqual(
      found.map((entry) => [entry.upgradeTransactionId, entry.upgradePaymentId, entry.days, entry.upgradeDays]),
      [
        ['up-1', 'pay-up-1', 6, 6],
        ['up-2', 'pay-up-2', 7, 15],
      ],
    );
  });

  it('names nothing for an upgrade that counted other payments, one with no conversion, or one before the payment', async () => {
    const found = await findDaysConvertedFromPayment(
      database([
        NEW_ROW,
        converted('before', { at: -20, days: 9, sources: { 'tx-new': '9.0000' } }),
        converted('other', { at: -5, days: 6, sources: { 'tx-renew': '6.1538' } }),
        { ...converted('withheld', { at: -4, days: 0, sources: {} }), gatewayData: { conversionWithheldAt: at(-4).toISOString() } },
        converted('nothing-added', { at: -3, days: 0, sources: { 'tx-new': '0.4000' } }),
      ]),
      'tx-new',
    );

    assert.deepEqual(found, []);
  });

  it('searches every subscription a renewal paid for', async () => {
    const combined: Row = {
      id: 'tx-combined',
      paymentId: 'pay-combined',
      subscriptionId: null,
      purchaseType: 'RENEW',
      fulfilledAt: at(-10),
      gatewayData: {},
      items: [{ subscriptionId: SUB }, { subscriptionId: 'sub-2' }],
    };
    const found = await findDaysConvertedFromPayment(
      database([combined, converted('up-sub-2', { at: -5, subscriptionId: 'sub-2', days: 12, sources: { 'tx-combined': '11.2000' } })]),
      'tx-combined',
    );

    assert.deepEqual(
      found.map((entry) => [entry.subscriptionId, entry.days]),
      [['sub-2', 12]],
    );
  });

  it('names nothing for a payment never fulfilled', async () => {
    const found = await findDaysConvertedFromPayment(
      database([{ ...NEW_ROW, fulfilledAt: null }, converted('up-1', { at: -5, days: 6, sources: { 'tx-new': '6.1538' } })]),
      'tx-new',
    );

    assert.deepEqual(found, []);
  });
});

describe('a renewal priced for the plan an upgrade left', () => {
  const upgraded = { planSnapshot: { id: 'premium', name: 'Премиум' }, startedAt: at(-2) };

  it('is one when the subscription was upgraded after the renewal was drafted', () => {
    assert.deepEqual(
      readRenewalPricedBeforeUpgrade({ subscription: upgraded, paidPlanId: 'basic', draftedAt: at(-3) }),
      { currentPlanId: 'premium' },
    );
  });

  it('is not one for a renewal onto another plan drafted since, for the plan it is on, or where nothing tells', () => {
    // An archived plan's replacement, a plan the subscriber chose: drafted after the last start.
    assert.equal(readRenewalPricedBeforeUpgrade({ subscription: upgraded, paidPlanId: 'basic', draftedAt: at(-1) }), null);
    assert.equal(readRenewalPricedBeforeUpgrade({ subscription: upgraded, paidPlanId: 'premium', draftedAt: at(-3) }), null);
    assert.equal(
      readRenewalPricedBeforeUpgrade({
        subscription: { planSnapshot: { planId: 'basic' }, startedAt: at(-2) },
        paidPlanId: 'basic',
        draftedAt: at(-3),
      }),
      null,
      'the importers’ spelling of the same plan',
    );
    assert.equal(
      readRenewalPricedBeforeUpgrade({ subscription: { planSnapshot: {}, startedAt: at(-2) }, paidPlanId: 'basic', draftedAt: at(-3) }),
      null,
    );
    assert.equal(
      readRenewalPricedBeforeUpgrade({ subscription: { ...upgraded, startedAt: null }, paidPlanId: 'basic', draftedAt: at(-3) }),
      null,
    );
  });

  it('buys what its money buys on the current plan — floored, never more than it was priced for', () => {
    // 200 ₽ at Премиум's 21.67 ₽ a day: 9.23.
    const upgradedRenewal = convertRenewalPricedBeforeUpgrade({
      amount: '200',
      currency: 'RUB',
      paidDays: 30,
      currentPlanDurations: plan([30, '650'], [180, '3000']),
    });
    assert.equal(upgradedRenewal.fractionalDays, '9.2308');
    assert.equal(upgradedRenewal.days, 9, 'the most expensive day, not 180 days’ 16.67 ₽ (12 days)');
    assert.deepEqual(upgradedRenewal.dearestDay, { price: '650', days: 30 });

    // 1 000 ₽ at 6.67 ₽ a day would be 150 days of a 30-day renewal.
    const downgraded = convertRenewalPricedBeforeUpgrade({
      amount: '1000',
      currency: 'RUB',
      paidDays: 30,
      currentPlanDurations: BASIC,
    });
    assert.equal(downgraded.days, 30);
  });

  it('buys nothing in a currency the current plan has no price in', () => {
    const conversion = convertRenewalPricedBeforeUpgrade({
      amount: '5',
      currency: 'USD',
      paidDays: 30,
      currentPlanDurations: PREMIUM,
    });

    assert.equal(conversion.days, 0);
    assert.equal(conversion.dearestDay, null);
  });

  it('counts what arrived: a short report, and a line’s share of it', () => {
    const short = convertRenewalPricedBeforeUpgrade({
      amount: '200',
      currency: 'RUB',
      paidDays: 30,
      currentPlanDurations: PREMIUM,
      gatewayData: { notifiedAmountShortfallAt: at(-1).toISOString(), notifiedAmount: '100' },
    });
    assert.equal(short.amount, '100.00');
    assert.equal(short.days, 4);

    const line = convertRenewalPricedBeforeUpgrade({
      amount: '200',
      paymentAmount: '600',
      currency: 'RUB',
      paidDays: 30,
      currentPlanDurations: PREMIUM,
      gatewayData: { notifiedAmountShortfallAt: at(-1).toISOString(), notifiedAmount: '300' },
    });
    assert.equal(line.amount, '100.00');
    assert.equal(line.days, 4);
  });

  it('tells the operator what it bought, and what to do when it bought nothing', () => {
    const base = {
      subscriptionId: SUB,
      paidPlanId: 'basic',
      paidPlanName: 'Базовый',
      currentPlanId: 'premium',
      currentPlanName: 'Премиум',
    };
    assert.equal(
      describeRenewalPricedBeforeUpgrade({
        ...base,
        conversion: convertRenewalPricedBeforeUpgrade({ amount: '200', currency: 'RUB', paidDays: 30, currentPlanDurations: PREMIUM }),
      }),
      `Продление тарифа «Базовый» на 30 дн. оплачено, когда подписку ${SUB} уже улучшили до «Премиум». ` +
        'Тариф, лимиты и сквады не менялись; оплата пересчитана по самому дорогому дню нового тарифа: +9 дн. вместо 30.',
    );
    assert.match(
      describeRenewalPricedBeforeUpgrade({
        ...base,
        conversion: convertRenewalPricedBeforeUpgrade({ amount: '5', currency: 'USD', paidDays: 30, currentPlanDurations: PREMIUM }),
      }),
      /нет цены в USD: дни не добавлены\. Верните деньги или продлите подписку вручную\.$/,
    );
    // Priced there, but less than one of its dearest days (20 ₽ < 21.67 ₽):
    // nothing is renewed either, so the money goes back all the same.
    assert.match(
      describeRenewalPricedBeforeUpgrade({
        ...base,
        conversion: convertRenewalPricedBeforeUpgrade({ amount: '20', currency: 'RUB', paidDays: 30, currentPlanDurations: PREMIUM }),
      }),
      /не хватает даже на один день: дни не добавлены\. Верните деньги или продлите подписку вручную\.$/,
    );
  });
});
