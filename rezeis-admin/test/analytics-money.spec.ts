import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chooseLtvBins } from '../src/modules/business-analytics/utils/analytics-customer-value.util';
import {
  chooseMoneyView,
  convertAmount,
  type FxSnapshot,
  hasUnconverted,
  moneyFigure,
  viewRates,
} from '../src/modules/business-analytics/utils/analytics-money.util';
import { assembleOverview, type OverviewRows } from '../src/modules/business-analytics/utils/analytics-overview.util';
import { planAnalyticsWindow } from '../src/modules/business-analytics/utils/analytics-window.util';
import { UTC_ZONE } from '../src/modules/business-analytics/utils/analytics-zone.util';

/**
 * Money in the analytics reports is never one number across currencies.
 *
 * On the HEAD service, 1 000 RUB and 10 USDT completed today read as
 * `totalRevenue: 1010` (measured against a real PostgreSQL before the rewrite);
 * the ARPPU, the daily bars and the providers' revenue were built on the same
 * sum. A report now states its figures in one currency: the only one there is,
 * natively, or the panel's base with every other currency converted at the
 * rate kept in `fx_rates` — and a currency with no rate is left out and named.
 */

const fetchedAt = new Date('2026-09-18T09:00:00.000Z');
const fx = (rates: Record<string, number>, base = 'RUB'): FxSnapshot => ({
  base,
  rates: new Map(Object.entries(rates).map(([quote, rate]) => [quote, { rate, source: 'TEST', fetchedAt }])),
});

describe('the currency a report speaks', () => {
  it('one currency: that currency, natively — even when it is not the base', () => {
    const view = chooseMoneyView(['USDT', 'USDT'], fx({ USDT: 80 }));
    assert.deepEqual(view, { currency: 'USDT', converted: false, rates: [], unconverted: [] });
    assert.equal(convertAmount(view, 'USDT', 12.5), 12.5);
  });

  it('several: the base, every other currency at the panel’s rate, and each rate named', () => {
    const view = chooseMoneyView(['RUB', 'USDT'], fx({ USDT: 80, USD: 82 }));
    assert.equal(view.currency, 'RUB');
    assert.equal(view.converted, true);
    assert.deepEqual(view.rates, [{ currency: 'USDT', rate: 80, source: 'TEST', fetchedAt: fetchedAt.toISOString() }]);
    assert.deepEqual(view.unconverted, []);
    const figure = moneyFigure(view, [
      { currency: 'RUB', amount: 1000 },
      { currency: 'USDT', amount: 10 },
    ]);
    // 1 000 ₽ + 10 × 80 ₽ — never 1 010.
    assert.equal(figure.value, 1800);
    assert.deepEqual(figure.byCurrency, [
      { currency: 'RUB', amount: 1000 },
      { currency: 'USDT', amount: 10 },
    ]);
  });

  it('a currency with no rate is left out of the value, named, and kept exactly in the breakdown', () => {
    const view = chooseMoneyView(['RUB', 'XTR'], fx({ USDT: 80 }));
    assert.deepEqual(view.unconverted, ['XTR']);
    assert.equal(view.converted, false, 'nothing was actually converted');
    const figure = moneyFigure(view, new Map([['RUB', 500], ['XTR', 1500]]));
    assert.equal(figure.value, 500);
    assert.deepEqual(figure.byCurrency, [
      { currency: 'RUB', amount: 500 },
      { currency: 'XTR', amount: 1500 },
    ]);
    assert.equal(hasUnconverted(view, figure), true);
    assert.equal(convertAmount(view, 'XTR', 1500), null);
  });

  it('hands SQL the rates it converts with, the view currency at 1', () => {
    const view = chooseMoneyView(['RUB', 'USDT', 'XTR'], fx({ USDT: 80 }));
    assert.deepEqual(viewRates(view), { RUB: 1, USDT: 80 });
  });

  it('no money at all: the base currency, nothing converted', () => {
    assert.deepEqual(chooseMoneyView([], fx({}, 'USD')), { currency: 'USD', converted: false, rates: [], unconverted: [] });
  });
});

describe('the overview’s figures in that currency', () => {
  const window = planAnalyticsWindow(30, new Date('2026-09-18T12:00:00.000Z'), UTC_ZONE);
  const rows = (payments: OverviewRows['payments'], payers: number): OverviewRows => ({
    payments,
    payers: [
      { previous: 0, bucket: null, payers, wholeWindow: 1 },
      { previous: 1, bucket: null, payers: 0, wholeWindow: 1 },
    ],
    newUsers: [],
    subscriptions: {
      activeNow: 0,
      activeThen: 0,
      churnBase: 0,
      churned: 0,
      previousChurnBase: 0,
      previousChurned: 0,
      trialsNow: 0,
    },
    activeSeries: [],
    funnel: { registered: 0, activated: 0, paid: 0, repeat: 0 },
    providers: [],
    partnerBalance: [],
    totalUsers: 4,
  });

  it('adds converted amounts, and divides by payers only when all of it converted', () => {
    const report = assembleOverview(
      window,
      rows(
        [
          { previous: 0, bucket: 29, currency: 'RUB', amount: '1000', payments: 1, newSubscriptions: 1 },
          { previous: 0, bucket: 28, currency: 'USDT', amount: '10', payments: 1, newSubscriptions: 0 },
        ],
        2,
      ),
      fx({ USDT: 80 }),
    );
    assert.equal(report.kpis.totalRevenue, 1800);
    assert.equal(report.metrics.arppu.current, 900);
    assert.equal(report.series.revenue[28], 800);
    assert.equal(report.series.revenue[29], 1000);
    assert.equal(report.money.currency, 'RUB');
  });

  it('withholds the average check while part of the money has no rate — its payers are counted, its money is not', () => {
    const report = assembleOverview(
      window,
      rows(
        [
          { previous: 0, bucket: 29, currency: 'RUB', amount: '1000', payments: 1, newSubscriptions: 1 },
          { previous: 0, bucket: 29, currency: 'XTR', amount: '500', payments: 1, newSubscriptions: 1 },
        ],
        2,
      ),
      fx({ USDT: 80 }),
    );
    assert.equal(report.metrics.revenue.current.value, 1000);
    assert.deepEqual(report.money.unconverted, ['XTR']);
    assert.equal(report.metrics.arppu.current, null);
    assert.equal(report.series.arppu[29], null);
  });
});

describe('the LTV histogram’s bins', () => {
  it('covers the 95th percentile in about eight round steps and leaves the tail to an open bin', () => {
    assert.deepEqual(chooseLtvBins(4200), { step: 500, bins: 9 });
    assert.deepEqual(chooseLtvBins(199), { step: 25, bins: 8 });
    assert.deepEqual(chooseLtvBins(0.0123), { step: 0.002, bins: 7 });
  });

  it('has one bin for no money', () => {
    assert.deepEqual(chooseLtvBins(null), { step: 1, bins: 1 });
    assert.deepEqual(chooseLtvBins(0), { step: 1, bins: 1 });
  });
});
