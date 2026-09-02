import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PointsCashbackMode, Prisma } from '@prisma/client';

import {
  computeCashback,
  INT4_MAX,
  readCashbackSettings,
  type CashbackConfig,
  type CashbackLineInput,
} from '../src/modules/points/points-cashback.util';

const ON: CashbackConfig = { enabled: true, percent: 5, defaultCurrency: Currency.RUB };
const OFF: CashbackConfig = { ...ON, enabled: false };

const PLAN_PRICES = [
  { currency: Currency.RUB, price: new Prisma.Decimal('300') },
  { currency: Currency.XTR, price: new Prisma.Decimal('200') },
];

function plan(overrides: Partial<CashbackLineInput> = {}): CashbackLineInput {
  return {
    kind: 'PLAN',
    id: 'plan-1',
    name: 'Premium',
    durationDays: 90,
    amount: '300',
    currency: Currency.RUB,
    rule: { mode: PointsCashbackMode.INHERIT, percent: null, fixedPoints: null },
    prices: PLAN_PRICES,
    ...overrides,
  };
}

describe('computeCashback — the mode of a line', () => {
  it('INHERIT follows the global percent of the final amount', () => {
    const result = computeCashback([plan()], ON);
    assert.equal(result.points, 15);
    assert.equal(result.lines[0]!.effective, 'PERCENT');
    assert.equal(result.lines[0]!.percent, 5);
    assert.equal(result.lines[0]!.base, '300');
    assert.equal(result.lines[0]!.skipped, null);
  });

  it('the global switch off pays nothing, whatever the row says', () => {
    for (const rule of [
      { mode: PointsCashbackMode.INHERIT, percent: null, fixedPoints: null },
      { mode: PointsCashbackMode.PERCENT, percent: 10, fixedPoints: null },
      { mode: PointsCashbackMode.FIXED, percent: null, fixedPoints: 500 },
    ]) {
      const result = computeCashback([plan({ rule })], OFF);
      assert.equal(result.points, 0, rule.mode);
      assert.equal(result.lines[0]!.skipped, 'DISABLED', rule.mode);
    }
  });

  it('NONE excludes the line on purpose', () => {
    const result = computeCashback(
      [plan({ rule: { mode: PointsCashbackMode.NONE, percent: 10, fixedPoints: 500 } })],
      ON,
    );
    assert.equal(result.points, 0);
    assert.equal(result.lines[0]!.skipped, 'EXCLUDED');
    assert.equal(result.lines[0]!.mode, 'NONE');
  });

  it('PERCENT uses the row\'s own percent, not the global one', () => {
    const result = computeCashback(
      [plan({ rule: { mode: PointsCashbackMode.PERCENT, percent: 10, fixedPoints: null } })],
      ON,
    );
    assert.equal(result.points, 30);
    assert.equal(result.lines[0]!.percent, 10);
  });

  it('FIXED pays the duration\'s points whatever was paid', () => {
    const rule = { mode: PointsCashbackMode.FIXED, percent: null, fixedPoints: 500 };
    assert.equal(computeCashback([plan({ rule })], ON).points, 500);
    assert.equal(computeCashback([plan({ rule, amount: '12', currency: Currency.XTR })], ON).points, 500);
    const result = computeCashback([plan({ rule })], ON);
    assert.equal(result.lines[0]!.effective, 'FIXED');
    assert.equal(result.lines[0]!.base, null);
  });

  it('FIXED with no points on the duration is a zero rule, not an error', () => {
    const result = computeCashback(
      [plan({ rule: { mode: PointsCashbackMode.FIXED, percent: null, fixedPoints: null } })],
      ON,
    );
    assert.equal(result.points, 0);
    assert.equal(result.lines[0]!.skipped, 'ZERO_RULE');
  });

  it('a percent of zero, negative or NaN is a zero rule', () => {
    for (const percent of [0, -5, Number.NaN]) {
      const result = computeCashback(
        [plan({ rule: { mode: PointsCashbackMode.PERCENT, percent, fixedPoints: null } })],
        ON,
      );
      assert.equal(result.lines[0]!.skipped, 'ZERO_RULE', String(percent));
    }
  });

  it('a row that is gone from the catalogue pays nothing and says so', () => {
    const result = computeCashback([plan({ rule: null })], ON);
    assert.equal(result.points, 0);
    assert.equal(result.lines[0]!.skipped, 'MISSING_CATALOG');
    assert.equal(result.lines[0]!.mode, null);
  });
});

describe('computeCashback — the base of a percent', () => {
  it('converts a foreign-currency amount through the line\'s own price list', () => {
    // 200 XTR / 300 RUB for the same duration; 180 XTR paid after a 10% discount.
    const result = computeCashback([plan({ amount: '180', currency: Currency.XTR })], ON);
    assert.equal(result.lines[0]!.base, '270');
    assert.equal(result.points, 13, 'floor(270 × 5 / 100)');
  });

  it('pays no percent when the line has no price in the default currency', () => {
    const result = computeCashback(
      [plan({ amount: '180', currency: Currency.XTR, prices: [{ currency: Currency.XTR, price: '200' }] })],
      ON,
    );
    assert.equal(result.points, 0);
    assert.equal(result.lines[0]!.skipped, 'NO_DEFAULT_PRICE');
  });

  it('treats a zero price in the paid currency as no rate at all', () => {
    const result = computeCashback(
      [
        plan({
          amount: '180',
          currency: Currency.XTR,
          prices: [
            { currency: Currency.XTR, price: '0' },
            { currency: Currency.RUB, price: '300' },
          ],
        }),
      ],
      ON,
    );
    assert.equal(result.lines[0]!.skipped, 'NO_DEFAULT_PRICE');
  });

  it('needs no price list when the line is already in the default currency', () => {
    const result = computeCashback([plan({ prices: [] })], ON);
    assert.equal(result.points, 15);
  });

  it('rounds down, never up', () => {
    assert.equal(computeCashback([plan({ amount: '199' })], ON).points, 9, '9.95 → 9');
    assert.equal(computeCashback([plan({ amount: '19' })], ON).points, 0, '0.95 → 0, and no skip reason: it is a rounding, not a rule');
    assert.equal(computeCashback([plan({ amount: '19' })], ON).lines[0]!.skipped, null);
  });

  it('a line nothing was paid for earns nothing in either mode', () => {
    for (const rule of [
      { mode: PointsCashbackMode.INHERIT, percent: null, fixedPoints: null },
      { mode: PointsCashbackMode.FIXED, percent: null, fixedPoints: 500 },
    ]) {
      const result = computeCashback([plan({ rule, amount: '0' })], ON);
      assert.equal(result.points, 0, rule.mode);
      assert.equal(result.lines[0]!.skipped, 'ZERO_AMOUNT', rule.mode);
    }
  });

  it('accepts Decimal, string and number amounts alike', () => {
    for (const amount of [new Prisma.Decimal('300'), '300', 300]) {
      assert.equal(computeCashback([plan({ amount })], ON).points, 15);
    }
  });
});

describe('computeCashback — many lines', () => {
  it('sums the lines and keeps every one of them, paid or not', () => {
    const result = computeCashback(
      [
        plan(),
        {
          kind: 'ADD_ON',
          id: 'ao-1',
          name: 'Extra 10 GB',
          amount: '100',
          currency: Currency.RUB,
          rule: { mode: PointsCashbackMode.FIXED, percent: null, fixedPoints: 20 },
          prices: [],
        },
        {
          kind: 'ADD_ON',
          id: 'ao-2',
          name: 'Excluded',
          amount: '100',
          currency: Currency.RUB,
          rule: { mode: PointsCashbackMode.NONE, percent: null, fixedPoints: null },
          prices: [],
        },
      ],
      ON,
    );
    assert.equal(result.points, 35);
    assert.deepEqual(
      result.lines.map((line) => [line.id, line.effective, line.points, line.skipped]),
      [
        ['plan-1', 'PERCENT', 15, null],
        ['ao-1', 'FIXED', 20, null],
        ['ao-2', 'NONE', 0, 'EXCLUDED'],
      ],
    );
  });

  it('clamps a rule that computes past the integer column instead of failing the write', () => {
    const huge = { mode: PointsCashbackMode.FIXED, percent: null, fixedPoints: 1e12 };
    assert.equal(computeCashback([plan({ rule: huge })], ON).points, INT4_MAX);
    assert.equal(computeCashback([plan({ rule: huge }), plan({ rule: huge })], ON).points, INT4_MAX);
  });
});

describe('readCashbackSettings', () => {
  it('reads OFF from anything absent or malformed', () => {
    for (const raw of [undefined, null, {}, [], 'x', { cashback: null }, { cashback: { enabled: 'yes', percent: '7' } }]) {
      assert.deepEqual(readCashbackSettings(raw), { enabled: false, percent: 0 }, JSON.stringify(raw));
    }
  });

  it('reads the stored switch and percent, whole and non-negative', () => {
    assert.deepEqual(readCashbackSettings({ cashback: { enabled: true, percent: 7 } }), { enabled: true, percent: 7 });
    assert.deepEqual(readCashbackSettings({ cashback: { enabled: true, percent: 7.9 } }), { enabled: true, percent: 7 });
    assert.deepEqual(readCashbackSettings({ cashback: { enabled: true, percent: -3 } }), { enabled: true, percent: 0 });
    assert.deepEqual(readCashbackSettings({ cashback: { enabled: true } }), { enabled: true, percent: 0 });
  });
});
