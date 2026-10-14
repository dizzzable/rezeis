import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assemblePaidCohorts,
  PAID_COHORT_OFFSETS,
} from '../src/modules/business-analytics/utils/analytics-first-payment-cohort.util';
import { PAID_COVERAGE_GRACE_DAYS } from '../src/modules/business-analytics/utils/analytics-paid-coverage.util';
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
