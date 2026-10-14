import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type AntilopayCharge,
  ANTILOPAY_MAX_DELAY_DAYS,
  assignAntilopayChargeRoles,
  buildAntilopayRecurrent,
  isAntilopayDelayUnit,
  makeAntilopayDelay,
  readAntilopayDelay,
} from '../src/modules/payments/utils/antilopay-recurrent.util';
import { normalizeGatewaySettingsForStorage } from '../src/modules/payments/utils/payment-gateway-settings.util';
import {
  ANTILOPAY_DELAY_UNITS,
  antilopayDelayUnitDays,
  type AntilopayDelayUnit,
  antilopayPeriodForDays,
  antilopayRecurrentTypeFor,
  type ProviderPeriod,
} from '../src/modules/payments/utils/provider-subscription-period.util';
import { PaymentGatewayType } from '@prisma/client';

const KEYS = { projectIdentificator: 'project-1', secretId: 'secret-id-1' };

/** The wire words, written out: a derived expectation would follow a typo in the code. */
const WIRE_UNITS = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;
const PERIODS: ReadonlyArray<{ readonly period: ProviderPeriod; readonly type: string }> = [
  { period: { unit: 'week', count: 1 }, type: 'WEEK' },
  { period: { unit: 'month', count: 1 }, type: 'MONTH' },
  { period: { unit: 'month', count: 3 }, type: 'QUARTER' },
  { period: { unit: 'year', count: 1 }, type: 'YEAR' },
];

describe('the units of a delay', () => {
  it('are exactly Antilopay\'s five words, upper-case', () => {
    assert.deepEqual([...ANTILOPAY_DELAY_UNITS], [...WIRE_UNITS]);
    for (const unit of WIRE_UNITS) assert.equal(isAntilopayDelayUnit(unit), true, unit);
    for (const wrong of ['day', 'Day', 'DAYS', 'week', 'Month', 'HOUR', '', ' DAY', 'DAY ', null, undefined, 1]) {
      assert.equal(isAntilopayDelayUnit(wrong), false, String(wrong));
    }
  });

  it('are worth a day, a week of 7, a month of 30, a quarter of 90 and a year of 365', () => {
    assert.deepEqual(
      WIRE_UNITS.map((unit) => antilopayDelayUnitDays(unit)),
      [1, 7, 30, 90, 365],
    );
  });

  it('count a day as the charging periods do: the same word is the same days', () => {
    for (const { period, type } of PERIODS) {
      const days = antilopayDelayUnitDays(type as AntilopayDelayUnit);
      assert.deepEqual(antilopayPeriodForDays(days), period, type);
      assert.equal(antilopayRecurrentTypeFor(period), type);
    }
  });
});

/** A count each unit allows (a year of years would pass the cap of a year). */
const COUNT_OF: Readonly<Record<(typeof WIRE_UNITS)[number], number>> = { DAY: 3, WEEK: 3, MONTH: 3, QUARTER: 1, YEAR: 1 };

describe('the wire payload of an SBP sign-up with a delay', () => {
  for (const unit of WIRE_UNITS) {
    for (const { period, type } of PERIODS) {
      it(`sends delay ${COUNT_OF[unit]} and delay_type ${unit} for a ${type} subscription`, () => {
        const delay = makeAntilopayDelay(COUNT_OF[unit], unit);
        assert.ok(delay);
        const request = buildAntilopayRecurrent({ period, method: 'SBP', paymentCount: null, delay });
        assert.deepEqual(request, {
          recurrent: { type, category: 'SUBSCRIPTION', delay: COUNT_OF[unit], delay_type: unit },
          preferMethods: ['SBP'],
        });
        // Case-sensitive on the wire: the string that is signed and sent.
        const wire = JSON.stringify(request?.recurrent);
        assert.ok(wire.includes(`"delay_type":"${unit}"`), wire);
        assert.ok(wire.includes(`"type":"${type}"`), wire);
        assert.ok(wire.includes('"category":"SUBSCRIPTION"'), wire);
        assert.equal(wire.includes(`"delay_type":"${unit.toLowerCase()}"`), false, wire);
      });
    }
  }

  it('keeps today\'s payload when there is no delay: delay 0, in the period\'s own word', () => {
    for (const { period, type } of PERIODS) {
      const expected = {
        recurrent: { type, category: 'SUBSCRIPTION', delay: 0, delay_type: type },
        preferMethods: ['SBP'],
      };
      assert.deepEqual(buildAntilopayRecurrent({ period, method: 'SBP', paymentCount: null }), expected);
      assert.deepEqual(buildAntilopayRecurrent({ period, method: 'SBP', paymentCount: null, delay: null }), expected);
    }
  });

  it('puts the operator\'s count of charges beside the delay', () => {
    const delay = makeAntilopayDelay(7, 'DAY');
    const request = buildAntilopayRecurrent({
      period: { unit: 'month', count: 1 },
      method: 'SBP',
      paymentCount: 12,
      delay,
    });
    assert.deepEqual(request?.recurrent, {
      type: 'MONTH',
      category: 'SUBSCRIPTION',
      delay: 7,
      delay_type: 'DAY',
      payment_count: 12,
    });
  });

  it('gives a card no delay at all: its first payment is charged on the form', () => {
    const delay = makeAntilopayDelay(7, 'DAY');
    for (const { period, type } of PERIODS) {
      const request = buildAntilopayRecurrent({ period, method: 'CARD', paymentCount: null, delay });
      assert.deepEqual(request, {
        recurrent: { type, category: 'PAYMENT_TEMPLATE' },
        preferMethods: ['CARD_RU'],
      });
    }
  });

  it('asks for nothing of a period Antilopay does not have', () => {
    const delay = makeAntilopayDelay(7, 'DAY');
    assert.equal(
      buildAntilopayRecurrent({ period: { unit: 'day', count: 5 }, method: 'SBP', paymentCount: null, delay }),
      null,
    );
  });
});

describe('a delay as a number of days', () => {
  it('is worth count × unit, and nothing past a year', () => {
    assert.deepEqual(makeAntilopayDelay(1, 'DAY'), { count: 1, unit: 'DAY', days: 1 });
    assert.deepEqual(makeAntilopayDelay(2, 'WEEK'), { count: 2, unit: 'WEEK', days: 14 });
    assert.deepEqual(makeAntilopayDelay(1, 'MONTH'), { count: 1, unit: 'MONTH', days: 30 });
    assert.deepEqual(makeAntilopayDelay(2, 'QUARTER'), { count: 2, unit: 'QUARTER', days: 180 });
    assert.deepEqual(makeAntilopayDelay(1, 'YEAR'), { count: 1, unit: 'YEAR', days: 365 });
    assert.equal(ANTILOPAY_MAX_DELAY_DAYS, 366);
    assert.ok(makeAntilopayDelay(366, 'DAY'));
    assert.equal(makeAntilopayDelay(367, 'DAY'), null);
    assert.equal(makeAntilopayDelay(2, 'YEAR'), null);
    assert.equal(makeAntilopayDelay(13, 'MONTH'), null);
  });

  it('is none for a count that is not a whole number of at least 1, or a unit that is not one of the five', () => {
    for (const count of [0, -1, 1.5, Number.NaN, '3', null, undefined]) {
      assert.equal(makeAntilopayDelay(count, 'DAY'), null, String(count));
    }
    for (const unit of ['day', 'Day', 'HOUR', '', null, undefined]) {
      assert.equal(makeAntilopayDelay(3, unit), null, String(unit));
    }
  });
});

describe('«Отсрочка первого списания по СБП» as the operator stored it', () => {
  it('reads a number or its text with a unit, and nothing else', () => {
    assert.deepEqual(readAntilopayDelay({ sbpDelayCount: 7, sbpDelayUnit: 'DAY' }), { count: 7, unit: 'DAY', days: 7 });
    assert.deepEqual(readAntilopayDelay({ sbpDelayCount: ' 2 ', sbpDelayUnit: 'WEEK' }), { count: 2, unit: 'WEEK', days: 14 });
    assert.equal(readAntilopayDelay({}), null);
    assert.equal(readAntilopayDelay({ sbpDelayCount: 0, sbpDelayUnit: 'DAY' }), null);
    assert.equal(readAntilopayDelay({ sbpDelayCount: '', sbpDelayUnit: 'DAY' }), null);
    assert.equal(readAntilopayDelay({ sbpDelayCount: 7 }), null);
    assert.equal(readAntilopayDelay({ sbpDelayUnit: 'DAY' }), null);
  });

  it('never sends a unit in the wrong case, even from a row somebody edited by hand', () => {
    assert.equal(readAntilopayDelay({ sbpDelayCount: 7, sbpDelayUnit: 'day' }), null);
    assert.equal(readAntilopayDelay({ sbpDelayCount: 7, sbpDelayUnit: 'Week' }), null);
    assert.equal(readAntilopayDelay({ sbpDelayCount: 90, sbpDelayUnit: 'YEAR' }), null);
  });
});

describe('saving the Antilopay settings with a delay', () => {
  const save = (extra: Record<string, unknown>) =>
    normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, { ...KEYS, ...extra });
  const refused = (extra: Record<string, unknown>): void =>
    assert.throws(() => save(extra), /PAYMENT_GATEWAY_SETTINGS_INVALID/, JSON.stringify(extra));

  it('stores a count and one of the five units, from a number or from the form\'s text', () => {
    assert.deepEqual(save({ sbpDelayCount: 7, sbpDelayUnit: 'DAY' }), { ...KEYS, sbpDelayCount: 7, sbpDelayUnit: 'DAY' });
    assert.deepEqual(save({ sbpDelayCount: '7', sbpDelayUnit: 'DAY' }), { ...KEYS, sbpDelayCount: 7, sbpDelayUnit: 'DAY' });
    for (const unit of WIRE_UNITS) {
      assert.deepEqual(save({ sbpDelayCount: '1', sbpDelayUnit: unit }), { ...KEYS, sbpDelayCount: 1, sbpDelayUnit: unit });
    }
  });

  it('takes none: nothing, or 0 with or without a unit', () => {
    assert.deepEqual(save({}), KEYS);
    assert.deepEqual(save({ sbpDelayCount: 0 }), { ...KEYS, sbpDelayCount: 0 });
    assert.deepEqual(save({ sbpDelayCount: '0', sbpDelayUnit: 'WEEK' }), { ...KEYS, sbpDelayCount: 0, sbpDelayUnit: 'WEEK' });
    assert.deepEqual(save({ sbpDelayUnit: 'WEEK' }), { ...KEYS, sbpDelayUnit: 'WEEK' });
  });

  it('refuses a unit in the wrong case and a unit Antilopay does not have', () => {
    for (const unit of ['day', 'Day', 'week', 'WEEKS', 'Month', 'quarter', 'year', 'HOUR', 'MINUTE', '']) {
      refused({ sbpDelayCount: 3, sbpDelayUnit: unit });
    }
  });

  it('refuses a count that is not a whole number of at least 0', () => {
    for (const count of [-1, 1.5, 'abc', '1.5', '-2', null, true]) refused({ sbpDelayCount: count, sbpDelayUnit: 'DAY' });
  });

  it('refuses a count without a unit, and a delay of more than a year', () => {
    refused({ sbpDelayCount: 7 });
    refused({ sbpDelayCount: '7' });
    refused({ sbpDelayCount: 367, sbpDelayUnit: 'DAY' });
    refused({ sbpDelayCount: 2, sbpDelayUnit: 'YEAR' });
    refused({ sbpDelayCount: 13, sbpDelayUnit: 'MONTH' });
    assert.ok(save({ sbpDelayCount: 366, sbpDelayUnit: 'DAY' }));
    assert.ok(save({ sbpDelayCount: 12, sbpDelayUnit: 'MONTH' }));
  });

  it('is not the setting of any other gateway', () => {
    assert.throws(
      () => normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, { merchantId: 'm', secret: 's', sbpDelayCount: 3 }),
      /PAYMENT_GATEWAY_SETTINGS_INVALID/,
    );
  });
});

describe('which charge is which when the first charge is delayed', () => {
  const charge = (id: string, at: string, orderId: string | null = null): AntilopayCharge => ({
    id,
    orderId,
    at: new Date(at),
    providerStatus: 'SUCCESS',
    disputed: false,
    amount: '299',
    refunds: [],
  });
  const base = {
    providerSubscriptionId: 'APAY-first',
    firstOrderId: 'ours-1',
    method: 'SBP',
    signedUpAt: new Date('2026-10-01T09:00:00Z'),
    firstDelivered: false,
  };

  it('makes every charge a renewal, even one a day after the start that would have been the charge at activation', () => {
    const charges = [charge('APAY-scheduled', '2026-10-02T09:00:00Z', 'made-up-by-antilopay')];
    const undelayed = assignAntilopayChargeRoles({ ...base, charges });
    assert.equal(undelayed.get('APAY-scheduled'), 'FIRST', 'without a delay it is the charge made at activation');
    const delayed = assignAntilopayChargeRoles({ ...base, charges, delayed: true });
    assert.equal(delayed.get('APAY-scheduled'), 'RENEW');
  });

  it('never takes the start for a charge, and never gives the checkout to a charge as a last resort', () => {
    const charges = [charge('APAY-first', '2026-10-01T09:00:01Z', 'ours-1'), charge('APAY-second', '2026-10-08T09:00:00Z')];
    const roles = assignAntilopayChargeRoles({ ...base, charges, delayed: true });
    assert.equal(roles.get('APAY-first'), 'START');
    assert.equal(roles.get('APAY-second'), 'RENEW');
    const lone = assignAntilopayChargeRoles({ ...base, charges: [charge('APAY-late', '2026-10-08T09:00:00Z')], delayed: true });
    assert.equal(lone.get('APAY-late'), 'RENEW', 'the checkout is the grant, not a charge');
  });
});
