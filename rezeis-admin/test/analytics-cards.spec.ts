import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assembleAutopay,
  AUTOPAY_FIRST_DAYS,
  AUTOPAY_LATER_DAYS,
  AUTOPAY_PERIOD_FROM_DAYS_AGO,
  AUTOPAY_PERIOD_TO_DAYS_AGO,
} from '../src/modules/business-analytics/utils/analytics-autopay.util';
import {
  assembleDiscounts,
  DISCOUNT_BUCKETS,
  DISCOUNT_REPEAT_AFTER_DAYS,
} from '../src/modules/business-analytics/utils/analytics-discount.util';
import { assembleFirstPaymentLtv } from '../src/modules/business-analytics/utils/analytics-first-payment-ltv.util';
import {
  assemblePaidCohorts,
  PAID_COHORT_OFFSETS,
} from '../src/modules/business-analytics/utils/analytics-first-payment-cohort.util';
import { PAID_COVERAGE_GRACE_DAYS } from '../src/modules/business-analytics/utils/analytics-paid-coverage.util';
import { planAnalyticsWindow } from '../src/modules/business-analytics/utils/analytics-window.util';
import { UTC_ZONE } from '../src/modules/business-analytics/utils/analytics-zone.util';

const at = (iso: string): Date => new Date(iso);

/**
 * The pure halves of the newer cards of «Бизнес-аналитика» — what the SQL
 * returns, turned into what the page draws. The SQL itself is held by
 * `analytics-cards-postgres.spec.ts`.
 */
describe('retention by month of first payment (assembly)', () => {
  const NOW = at('2026-10-14T09:00:00Z');

  it('names a row for each of the last twelve months, oldest first, empty months with no cells', () => {
    const report = assemblePaidCohorts(NOW, UTC_ZONE, []);
    assert.equal(report.cohorts.length, 12);
    assert.equal(report.cohorts[0]?.cohort, '2025-11');
    assert.equal(report.cohorts[11]?.cohort, '2026-10');
    assert.equal(report.cohorts.every((row) => row.cohortSize === 0 && row.retentionByMonth.length === 0), true);
    assert.equal(report.graceDays, PAID_COVERAGE_GRACE_DAYS);
    assert.equal(report.timeZone, 'UTC');
  });

  it('divides each covered count by the cohort size', () => {
    const report = assemblePaidCohorts(NOW, UTC_ZONE, [
      { kind: 'size', cohort: '2026-01', offset: 0, users: 4 },
      { kind: 'covered', cohort: '2026-01', offset: 1, users: 4 },
      { kind: 'covered', cohort: '2026-01', offset: 2, users: 3 },
      { kind: 'covered', cohort: '2026-01', offset: 3, users: 1 },
    ]);
    const row = report.cohorts.find((cohort) => cohort.cohort === '2026-01');
    assert.deepEqual(row?.retentionByMonth.slice(0, 4), [1, 0.75, 0.25, 0]);
    assert.equal(row?.retentionByMonth.length, PAID_COHORT_OFFSETS);
  });

  it('shows a cell only when the latest date it can mean, plus the grace, has passed', () => {
    // January's clients paid up to 31 January; month 8 for the last of them is 31 Aug + grace,
    // and the row's latest date for it is 1 Feb + 8 months = 1 October, +4 days = 5 October: before 14 October.
    // Month 9 is 1 November + 4 days: not yet.
    const report = assemblePaidCohorts(NOW, UTC_ZONE, [{ kind: 'size', cohort: '2026-01', offset: 0, users: 2 }]);
    const row = report.cohorts.find((cohort) => cohort.cohort === '2026-01')?.retentionByMonth ?? [];
    assert.equal(row[7], 0);
    assert.equal(row[8], null);
  });

  it('keeps a cell back until the grace days after the month turn have passed', () => {
    const justAfterTurn = at('2026-10-02T00:00:00Z');
    const justPast = at('2026-10-05T00:00:00Z');
    const rows = [{ kind: 'size' as const, cohort: '2026-01', offset: 0, users: 1 }];
    // Month 8 of January's row is 1 October + 4 days = 5 October.
    assert.equal(assemblePaidCohorts(justAfterTurn, UTC_ZONE, rows).cohorts.find((c) => c.cohort === '2026-01')?.retentionByMonth[7], null);
    assert.equal(assemblePaidCohorts(justPast, UTC_ZONE, rows).cohorts.find((c) => c.cohort === '2026-01')?.retentionByMonth[7], 0);
  });

  it('puts the current month as a row with no cell yet, and a last-month row with none past month one', () => {
    const report = assemblePaidCohorts(NOW, UTC_ZONE, [
      { kind: 'size', cohort: '2026-10', offset: 0, users: 5 },
      { kind: 'size', cohort: '2026-09', offset: 0, users: 5 },
    ]);
    const october = report.cohorts[11]?.retentionByMonth ?? [];
    assert.equal(october.every((cell) => cell === null), true);
    // September: month 1 is 1 November + 4 days away from the latest first payment — not yet.
    const september = report.cohorts[10]?.retentionByMonth ?? [];
    assert.equal(september.every((cell) => cell === null), true);
  });
});

describe('autopay (assembly)', () => {
  const NOW = at('2026-10-14T09:00:00Z');

  it('sums the header over both states and files each outcome under its group', () => {
    const report = assembleAutopay(NOW, [
      { kind: 'payers', autopay: true, outcome: null, count: 30 },
      { kind: 'payers', autopay: false, outcome: null, count: 70 },
      { kind: 'periods', autopay: true, outcome: 'early', count: 50 },
      { kind: 'periods', autopay: true, outcome: 'firstDays', count: 5 },
      { kind: 'periods', autopay: true, outcome: 'later', count: 3 },
      { kind: 'periods', autopay: true, outcome: 'gone', count: 2 },
      { kind: 'periods', autopay: false, outcome: 'early', count: 10 },
      { kind: 'periods', autopay: false, outcome: 'gone', count: 40 },
    ]);
    assert.equal(report.payingClients, 100);
    assert.equal(report.withAutopay, 30);
    assert.deepEqual(report.withAutopayPeriods, { early: 50, firstDays: 5, later: 3, gone: 2 });
    assert.deepEqual(report.withoutAutopayPeriods, { early: 10, firstDays: 0, later: 0, gone: 40 });
  });

  it('states the window it compared, from the same constants the SQL uses', () => {
    const report = assembleAutopay(NOW, []);
    assert.equal(report.fromDaysAgo, AUTOPAY_PERIOD_FROM_DAYS_AGO);
    assert.equal(report.toDaysAgo, AUTOPAY_PERIOD_TO_DAYS_AGO);
    assert.equal(report.firstDays, AUTOPAY_FIRST_DAYS);
    assert.equal(report.laterDays, AUTOPAY_LATER_DAYS);
    assert.equal(report.generatedAt, '2026-10-14T09:00:00.000Z');
    assert.equal(report.payingClients, 0);
  });

  it('ignores a periods row with no outcome rather than adding it to a group', () => {
    const report = assembleAutopay(NOW, [{ kind: 'periods', autopay: true, outcome: null, count: 9 }]);
    assert.deepEqual(report.withAutopayPeriods, { early: 0, firstDays: 0, later: 0, gone: 0 });
  });
});

describe('discounts (assembly)', () => {
  const NOW = at('2026-10-14T09:00:00Z');
  const window = planAnalyticsWindow(30, NOW, UTC_ZONE);
  const purchases = (key: string, count: number, sum: number | null = null) =>
    ({ kind: 'purchases', key, count, sum, known: null, full: null }) as const;

  it('counts the full ones in the denominator, the bucketed ones as discounted, and averages over the discounted', () => {
    const report = assembleDiscounts(window, [
      purchases('full', 6),
      purchases('b10', 2, 30),
      purchases('b30', 1, 35),
      purchases('b50', 1, 60),
      purchases('unknown', 3),
    ]);
    assert.equal(report.purchases, 10);
    assert.equal(report.discounted, 4);
    assert.equal(report.averageDiscount, 31.25);
    assert.equal(report.unknown, 3);
    assert.equal(report.windowDays, 30);
  });

  it('always carries every bucket, in order, the last one open, with zero for an empty one', () => {
    const report = assembleDiscounts(window, [purchases('b20', 2, 44)]);
    assert.deepEqual(
      report.buckets.map((bucket) => [bucket.from, bucket.to, bucket.purchases]),
      [
        [1, 10, 0],
        [10, 20, 0],
        [20, 30, 2],
        [30, 40, 0],
        [40, 50, 0],
        [50, null, 0],
      ],
    );
    assert.equal(DISCOUNT_BUCKETS.length, 6);
  });

  it('has no average when nothing was discounted', () => {
    const report = assembleDiscounts(window, [purchases('full', 3)]);
    assert.equal(report.discounted, 0);
    assert.equal(report.averageDiscount, null);
  });

  it('reads the repeat block: clients and those who bought again per group, and the full-price second purchase', () => {
    const report = assembleDiscounts(window, [
      { kind: 'first', key: 'discount', count: 10, sum: 4, known: 4, full: 3 },
      { kind: 'first', key: 'full', count: 20, sum: 12, known: 12, full: 9 },
    ]);
    assert.deepEqual(report.repeat.withDiscount, { clients: 10, boughtAgain: 4 });
    assert.deepEqual(report.repeat.withoutDiscount, { clients: 20, boughtAgain: 12 });
    // The footnote is about those who bought again after a DISCOUNTED first purchase only.
    assert.equal(report.repeat.secondPriceKnown, 4);
    assert.equal(report.repeat.secondFullPrice, 3);
    assert.equal(report.repeat.afterDays, DISCOUNT_REPEAT_AFTER_DAYS);
  });

  it('reads a pg numeric sum that arrives as text', () => {
    const report = assembleDiscounts(window, [purchases('b10', 2, '31.0000000000000000' as unknown as number)]);
    assert.equal(report.averageDiscount, 15.5);
  });
});

describe('value by month of first payment (assembly)', () => {
  const NOW = at('2026-10-14T09:00:00Z');
  const ROUBLES = { currency: 'RUB', converted: false, rates: [], unconverted: [] } as const;

  it('lists the last twelve months, oldest first, with no figures for a month nobody first paid in', () => {
    const report = assembleFirstPaymentLtv(NOW, UTC_ZONE, ROUBLES, [
      { cohort: '2026-08', clients: 4, mean: '340.5', median: 250 },
      { cohort: 'all', clients: 4, mean: '340.5', median: 250 },
    ]);
    assert.equal(report.rows.length, 12);
    assert.equal(report.rows[0]?.cohort, '2025-11');
    assert.equal(report.rows[11]?.cohort, '2026-10');
    const august = report.rows.find((row) => row.cohort === '2026-08');
    assert.deepEqual(august, { cohort: '2026-08', clients: 4, mean: 340.5, median: 250 });
    assert.deepEqual(report.rows[11], { cohort: '2026-10', clients: 0, mean: null, median: null });
  });

  it('takes the header from the row over all clients, not from the months', () => {
    const report = assembleFirstPaymentLtv(NOW, UTC_ZONE, ROUBLES, [
      { cohort: '2026-07', clients: 1, mean: 100, median: 100 },
      { cohort: '2026-08', clients: 3, mean: 300, median: 200 },
      { cohort: 'all', clients: 4, mean: 250, median: 150 },
    ]);
    assert.deepEqual([report.clients, report.mean, report.median], [4, 250, 150]);
    assert.equal(report.money.currency, 'RUB');
  });

  it('has an empty header when nobody paid', () => {
    const report = assembleFirstPaymentLtv(NOW, UTC_ZONE, ROUBLES, [{ cohort: 'all', clients: 0, mean: null, median: null }]);
    assert.deepEqual([report.clients, report.mean, report.median], [0, null, null]);
    assert.equal(report.timeZone, 'UTC');
  });
});
