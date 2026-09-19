import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FxSnapshot } from '../src/modules/business-analytics/utils/analytics-money.util';
import { planAnalyticsWindow } from '../src/modules/business-analytics/utils/analytics-window.util';
import { UTC_ZONE } from '../src/modules/business-analytics/utils/analytics-zone.util';
import {
  assembleProviderReport,
  type GatewayCatalogEntry,
  type ProviderReportRows,
  type ProviderWindowRow,
} from '../src/modules/payment-analytics/utils/payment-provider-report.util';

/**
 * «Платежи» → «Аналитика» put together from its statements' rows: the money
 * of «Бизнес-аналитика» (one currency per report, a partner's balance apart),
 * the outcomes of «Обзор» → «Платёжные системы», one point per local day.
 * `payment-analytics-postgres.spec.ts` runs the statements themselves.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');
const fetchedAt = new Date('2026-09-18T09:00:00.000Z');
const fx = (rates: Record<string, number>, base = 'RUB'): FxSnapshot => ({
  base,
  rates: new Map(Object.entries(rates).map(([quote, rate]) => [quote, { rate, source: 'TEST', fetchedAt }])),
});

const NO_ROWS: ProviderReportRows = { windows: [], days: [], timeToPay: [], stuck: [], channels: [], failures: [], partnerBalance: [] };

function row(partial: Partial<ProviderWindowRow> & Pick<ProviderWindowRow, 'gateway'>): ProviderWindowRow {
  return { previous: 0, outcome: 'completed', currency: 'RUB', checkouts: 1, payments: 1, amount: '0', ...partial };
}

const CATALOG: readonly GatewayCatalogEntry[] = [
  { type: 'YOOKASSA', isActive: true, currency: 'RUB' },
  { type: 'CRYPTOPAY', isActive: true, currency: 'USDT' },
  { type: 'TELEGRAM_STARS', isActive: true, currency: 'XTR' },
];

describe('the payments tab’s money', () => {
  it('states several currencies in the base at the panel’s rate — never 1 000 + 10 = 1 010 — and names the one with no rate', () => {
    const window = planAnalyticsWindow(30, NOW, UTC_ZONE);
    const report = assembleProviderReport(
      window,
      {
        ...NO_ROWS,
        windows: [
          row({ gateway: 'YOOKASSA', amount: '1000' }),
          row({ gateway: 'CRYPTOPAY', currency: 'USDT', amount: '10' }),
          row({ gateway: 'TELEGRAM_STARS', currency: 'XTR', amount: '500' }),
        ],
      },
      CATALOG,
      fx({ USDT: 80 }),
    );
    assert.deepEqual(report.money, {
      currency: 'RUB',
      converted: true,
      rates: [{ currency: 'USDT', rate: 80, source: 'TEST', fetchedAt: fetchedAt.toISOString() }],
      unconverted: ['XTR'],
    });
    assert.equal(report.revenue.value, 1800);
    assert.deepEqual(report.revenue.byCurrency, [
      { currency: 'RUB', amount: 1000 },
      { currency: 'USDT', amount: 10 },
      { currency: 'XTR', amount: 500 },
    ]);
    assert.equal(report.payments, 3);
    const byGateway = Object.fromEntries(report.providers.map((p) => [p.gatewayType, p]));
    assert.equal(byGateway['CRYPTOPAY']?.revenue.value, 800);
    assert.equal(byGateway['TELEGRAM_STARS']?.revenue.value, 0, 'no rate: in no value — and not at 1:1');
    // The average payment: in the view where it converts, natively where nothing of it does.
    assert.deepEqual(byGateway['YOOKASSA']?.averagePayment, { currency: 'RUB', amount: 1000 });
    assert.deepEqual(byGateway['CRYPTOPAY']?.averagePayment, { currency: 'RUB', amount: 800 });
    assert.deepEqual(byGateway['TELEGRAM_STARS']?.averagePayment, { currency: 'XTR', amount: 500 });
  });

  it('states money in one currency natively, whatever the base is', () => {
    const report = assembleProviderReport(
      planAnalyticsWindow(7, NOW, UTC_ZONE),
      { ...NO_ROWS, windows: [row({ gateway: 'CRYPTOPAY', currency: 'USDT', amount: '12.5' })] },
      CATALOG,
      fx({ USDT: 80 }),
    );
    assert.deepEqual(report.money, { currency: 'USDT', converted: false, rates: [], unconverted: [] });
    assert.equal(report.revenue.value, 12.5);
  });

  it('keeps a partner’s balance as a row for its health — never revenue — and states its spend apart', () => {
    const report = assembleProviderReport(
      planAnalyticsWindow(30, NOW, UTC_ZONE),
      {
        ...NO_ROWS,
        windows: [
          row({ gateway: 'YOOKASSA', amount: '1000' }),
          // `moneyReceivedSql` gives a partner's balance no payments and no money.
          row({ gateway: 'PARTNER_BALANCE', checkouts: 2, payments: 0, amount: '0' }),
          row({ gateway: 'PARTNER_BALANCE', outcome: 'failed', checkouts: 1, payments: 0, amount: '0' }),
        ],
        partnerBalance: [{ currency: 'RUB', amount: '300', payments: 2 }],
      },
      CATALOG,
      fx({}),
    );
    const partner = report.providers.find((p) => p.gatewayType === 'PARTNER_BALANCE');
    assert.ok(partner !== undefined, 'a partner’s balance has no catalog row and is listed all the same');
    assert.equal(partner.countsAsRevenue, false);
    assert.deepEqual([partner.transactions, partner.completed, partner.failed], [3, 2, 1]);
    assert.equal(partner.successRate, 2 / 3);
    assert.deepEqual(partner.revenue, { value: 0, byCurrency: [] });
    assert.equal(partner.averagePayment, null);
    assert.equal(report.providers.find((p) => p.gatewayType === 'YOOKASSA')?.countsAsRevenue, true);
    assert.equal(report.revenue.value, 1000);
    assert.deepEqual(report.partnerBalance, { figure: { value: 300, byCurrency: [{ currency: 'RUB', amount: 300 }] }, payments: 2 });
    // The totals are the payment systems’: the balance’s three checkouts are in its row, not in them.
    assert.deepEqual([report.totalTransactions, report.totalPaid, report.totalCompleted], [1, 1, 1]);
  });

  it('leaves a partner’s balance out of the totals that make «Конверсия»: YooKassa 1 paid of 2 is 50 %, not 75 %', () => {
    const report = assembleProviderReport(
      planAnalyticsWindow(7, NOW, UTC_ZONE),
      {
        ...NO_ROWS,
        windows: [
          row({ gateway: 'YOOKASSA', amount: '100' }),
          row({ gateway: 'YOOKASSA', outcome: 'failed', payments: 0 }),
          row({ gateway: 'PARTNER_BALANCE', checkouts: 2, payments: 0, amount: '0' }),
        ],
        partnerBalance: [{ currency: 'RUB', amount: '600', payments: 2 }],
      },
      CATALOG,
      fx({}),
    );
    assert.equal(report.totalPaid / report.totalTransactions, 0.5);
    assert.deepEqual([report.totalTransactions, report.totalPaid, report.totalCompleted], [2, 1, 1]);
    const partner = report.providers.find((p) => p.gatewayType === 'PARTNER_BALANCE');
    assert.deepEqual([partner?.transactions, partner?.completed, partner?.successRate], [2, 2, 1]);
    assert.equal(report.partnerBalance.payments, 2);
  });

  it('withholds the average of a gateway whose money is partly in a currency with no rate', () => {
    const report = assembleProviderReport(
      planAnalyticsWindow(30, NOW, UTC_ZONE),
      {
        ...NO_ROWS,
        windows: [
          row({ gateway: 'YOOKASSA', amount: '1000' }),
          row({ gateway: 'YOOKASSA', currency: 'XTR', amount: '50' }),
        ],
      },
      CATALOG,
      fx({}),
    );
    const yookassa = report.providers.find((p) => p.gatewayType === 'YOOKASSA');
    assert.equal(yookassa?.payments, 2);
    assert.equal(yookassa?.averagePayment, null);
  });
});

describe('the payments tab’s checkouts', () => {
  it('counts a full refund as a checkout that went through — not canceled — and rates the outcomes like «Платёжные системы»', () => {
    const report = assembleProviderReport(
      planAnalyticsWindow(7, NOW, UTC_ZONE),
      {
        ...NO_ROWS,
        windows: [
          row({ gateway: 'YOOKASSA', checkouts: 2, payments: 2, amount: '200' }),
          row({ gateway: 'YOOKASSA', outcome: 'refunded', checkouts: 1, payments: 0 }),
          row({ gateway: 'YOOKASSA', outcome: 'canceled', checkouts: 1, payments: 0 }),
          row({ gateway: 'YOOKASSA', outcome: 'failed', checkouts: 1, payments: 0 }),
          row({ gateway: 'YOOKASSA', outcome: 'pending', checkouts: 1, payments: 0 }),
        ],
      },
      CATALOG,
      fx({}),
    );
    const yookassa = report.providers.find((p) => p.gatewayType === 'YOOKASSA');
    assert.deepEqual(
      [yookassa?.transactions, yookassa?.completed, yookassa?.refunded, yookassa?.canceled, yookassa?.failed, yookassa?.pending],
      [6, 2, 1, 1, 1, 1],
    );
    assert.equal(yookassa?.successRate, 3 / 5);
    assert.equal(yookassa?.checkoutRate, 3 / 6);
    assert.deepEqual([report.totalTransactions, report.totalCompleted, report.totalPaid], [6, 2, 3]);
  });

  it('takes each failure reason’s share of all the gateway’s failed and canceled checkouts, not of the five listed', () => {
    const report = assembleProviderReport(
      planAnalyticsWindow(7, NOW, UTC_ZONE),
      {
        ...NO_ROWS,
        windows: [
          row({ gateway: 'YOOKASSA', outcome: 'failed', checkouts: 8, payments: 0 }),
          row({ gateway: 'YOOKASSA', outcome: 'canceled', checkouts: 2, payments: 0 }),
        ],
        failures: [
          { gateway: 'YOOKASSA', reason: 'a', count: 3 },
          { gateway: 'YOOKASSA', reason: 'b', count: 2 },
          { gateway: 'YOOKASSA', reason: 'c', count: 1 },
          { gateway: 'YOOKASSA', reason: 'd', count: 1 },
          { gateway: 'YOOKASSA', reason: 'e', count: 1 },
        ],
      },
      CATALOG,
      fx({}),
    );
    const reasons = report.providers.find((p) => p.gatewayType === 'YOOKASSA')?.topFailureReasons;
    assert.deepEqual(reasons?.map((reason) => [reason.reason, reason.share]), [
      ['a', 0.3],
      ['b', 0.2],
      ['c', 0.1],
      ['d', 0.1],
      ['e', 0.1],
    ]);
  });

  it('compares with the previous window: the change of the revenue value, and nothing where there is nothing to compare', () => {
    const report = assembleProviderReport(
      planAnalyticsWindow(30, NOW, UTC_ZONE),
      {
        ...NO_ROWS,
        windows: [
          row({ gateway: 'YOOKASSA', amount: '1500' }),
          row({ gateway: 'YOOKASSA', previous: 1, amount: '1000' }),
          row({ gateway: 'YOOKASSA', previous: 1, outcome: 'failed', payments: 0 }),
          // A gateway with a previous window and no outcome in this one.
          row({ gateway: 'CRYPTOPAY', outcome: 'pending', payments: 0 }),
          row({ gateway: 'CRYPTOPAY', previous: 1, currency: 'RUB', amount: '0', payments: 0, outcome: 'failed' }),
        ],
      },
      CATALOG,
      fx({}),
    );
    const byGateway = Object.fromEntries(report.providers.map((p) => [p.gatewayType, p.delta]));
    assert.deepEqual(byGateway['YOOKASSA'], { revenuePct: 0.5, transactionsPct: -0.5, successRateDelta: 0.5 });
    // No money before: no percentage of zero. No outcome now: no change of a rate.
    assert.deepEqual(byGateway['CRYPTOPAY'], { revenuePct: null, transactionsPct: 0, successRateDelta: null });
    assert.deepEqual(byGateway['TELEGRAM_STARS'], { revenuePct: null, transactionsPct: null, successRateDelta: null });
  });
});

describe('the payments tab’s days', () => {
  it('draws one point per local day of the window — 90 days as 90 points, labelled with the zone’s dates', () => {
    const zone = { name: 'Europe/Moscow', fallback: false };
    // 22:30 UTC on 18 September is 01:30 on the 19th in Moscow.
    const window = planAnalyticsWindow(90, new Date('2026-09-18T22:30:00.000Z'), zone);
    const report = assembleProviderReport(
      window,
      {
        ...NO_ROWS,
        windows: [row({ gateway: 'YOOKASSA', amount: '100', checkouts: 2, payments: 2 })],
        days: [
          { day: 0, gateway: 'YOOKASSA', currency: 'RUB', checkouts: 1, paid: 1, amount: '40' },
          { day: 89, gateway: 'YOOKASSA', currency: 'RUB', checkouts: 1, paid: 1, amount: '60' },
          { day: 90, gateway: 'YOOKASSA', currency: 'RUB', checkouts: 5, paid: 5, amount: '500' },
        ],
      },
      CATALOG,
      fx({}),
    );
    const daily = report.providers.find((p) => p.gatewayType === 'YOOKASSA')?.daily ?? [];
    assert.equal(daily.length, 90);
    assert.deepEqual(daily[0], { day: '2026-06-22', revenueValue: 40, transactions: 1, successful: 1 });
    assert.deepEqual(daily[89], { day: '2026-09-19', revenueValue: 60, transactions: 1, successful: 1 });
    assert.equal(daily.reduce((sum, point) => sum + point.revenueValue, 0), 100, 'a day outside the window is no point of it');
    assert.equal(report.windowStart, '2026-06-21T21:00:00.000Z');
    assert.deepEqual([report.timeZone, report.timeZoneFallback], ['Europe/Moscow', false]);
  });

  it('lists every catalog gateway, and every type a stuck checkout names that the catalog has no row for', () => {
    const report = assembleProviderReport(
      planAnalyticsWindow(7, NOW, UTC_ZONE),
      { ...NO_ROWS, stuck: [{ gateway: 'PLATEGA', stuck: 2 }] },
      CATALOG,
      fx({}),
    );
    // Nothing to rank by money or checkouts: by name.
    assert.deepEqual(
      report.providers.map((p) => [p.gatewayType, p.stuckPending, p.isActive]),
      [
        ['CRYPTOPAY', 0, true],
        ['PLATEGA', 2, false],
        ['TELEGRAM_STARS', 0, true],
        ['YOOKASSA', 0, true],
      ],
    );
  });
});
