import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { plategaPeriodForDays, wholeRoubles } from '../src/modules/payments/utils/provider-subscription-period.util';

describe('plategaPeriodForDays', () => {
  it('maps the durations operators sell to the period the payer reads', () => {
    assert.deepEqual(plategaPeriodForDays(30), { unit: 'month', count: 1 });
    assert.deepEqual(plategaPeriodForDays(90), { unit: 'month', count: 3 });
    assert.deepEqual(plategaPeriodForDays(180), { unit: 'month', count: 6 });
    assert.deepEqual(plategaPeriodForDays(360), { unit: 'month', count: 12 });
    assert.deepEqual(plategaPeriodForDays(365), { unit: 'year', count: 1 });
    assert.deepEqual(plategaPeriodForDays(1095), { unit: 'year', count: 3 });
    assert.deepEqual(plategaPeriodForDays(7), { unit: 'week', count: 1 });
    assert.deepEqual(plategaPeriodForDays(28), { unit: 'week', count: 4 });
    assert.deepEqual(plategaPeriodForDays(1), { unit: 'day', count: 1 });
    assert.deepEqual(plategaPeriodForDays(31), { unit: 'day', count: 31 });
  });

  it('offers nothing for a duration no provider period equals', () => {
    // 45 days charged every 30 would take money for days nobody bought.
    for (const days of [45, 35, 100, 364, 390, 1460, 0, -30, 30.5]) {
      assert.equal(plategaPeriodForDays(days), null, String(days));
    }
  });
});

describe('wholeRoubles', () => {
  it('passes a whole price in every shape the panel holds one', () => {
    assert.equal(wholeRoubles(new Prisma.Decimal('299')), 299);
    assert.equal(wholeRoubles(new Prisma.Decimal('299.00000000')), 299);
    assert.equal(wholeRoubles('1490.00'), 1490);
    assert.equal(wholeRoubles(99), 99);
  });

  it('refuses kopecks, zero and anything that is not a price', () => {
    for (const amount of [new Prisma.Decimal('149.90'), '0.50', 0, '0', -10, 'abc', '']) {
      assert.equal(wholeRoubles(amount), null, String(amount));
    }
  });
});
