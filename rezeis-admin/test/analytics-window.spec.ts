import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bucketIndexOf,
  bucketLabels,
  describePeriod,
  granularityFor,
  planAnalyticsWindow,
} from '../src/modules/business-analytics/utils/analytics-window.util';
import { type AnalyticsZone, UTC_ZONE, wallClockOf } from '../src/modules/business-analytics/utils/analytics-zone.util';

/** The last bar (the backend targets ES2021: no `Array.prototype.at`). */
function lastOf<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1];
}

/**
 * The window a report covers, the one it is compared with, and its bars — in
 * the operator's time zone, whatever clock the server runs on.
 *
 * The first rewrite counted UTC days so that SQL and the labels agreed on a
 * host whose clock was not UTC. The review of 2026-09 moved both to the
 * operator's zone: a payment at 01:30 MSK belongs to the Moscow day, and a
 * Moscow window opens at Moscow midnight. Every expectation here is computed
 * from fixed instants and named zones, so the file passes or fails the same
 * under any TZ.
 */

const at = (iso: string): Date => new Date(iso);
const MOSCOW: AnalyticsZone = { name: 'Europe/Moscow', fallback: false };
const NEW_YORK: AnalyticsZone = { name: 'America/New_York', fallback: false };

describe('the window and the previous window', () => {
  it('ends now, starts at a midnight, and compares with a window of the same days ending at the same time of day', () => {
    const now = at('2026-09-18T12:30:00.000Z');
    const window = planAnalyticsWindow(30, now, UTC_ZONE);

    assert.equal(window.start.toISOString(), '2026-08-20T00:00:00.000Z');
    assert.equal(window.previousStart.toISOString(), '2026-07-21T00:00:00.000Z');
    // Not the midnight before `start`: the previous window stops at the same
    // time of day as this one, so half a day is compared with half a day.
    assert.equal(window.previousEnd.toISOString(), '2026-08-19T12:30:00.000Z');
    assert.equal(
      now.getTime() - window.start.getTime(),
      window.previousEnd.getTime() - window.previousStart.getTime(),
      'both windows are equally long',
    );
  });

  it('opens a Moscow window at Moscow midnight and ends it on the Moscow day', () => {
    // 00:30 in Moscow on the 18th is still the 17th in UTC.
    const now = at('2026-09-17T21:30:00.000Z');
    const period = describePeriod(planAnalyticsWindow(7, now, MOSCOW));
    assert.deepEqual(lastOf(period.buckets), { from: '2026-09-18', to: '2026-09-18' });
    assert.equal(period.buckets.length, 7);
    assert.equal(period.start, '2026-09-11T21:00:00.000Z');
    assert.equal(period.previousEnd, '2026-09-10T21:30:00.000Z');
    assert.deepEqual([period.timeZone, period.timeZoneFallback], ['Europe/Moscow', false]);
  });

  it('keeps every local day once across a daylight-saving switch, and both windows the same days long', () => {
    // New York leaves daylight time on 2 November 2025: that day is 25 hours long.
    const now = at('2025-11-10T17:00:00.000Z');
    const window = planAnalyticsWindow(30, now, NEW_YORK);
    const period = describePeriod(window);
    const days = period.buckets.map((bucket) => bucket.from);
    assert.equal(days.length, 30);
    assert.equal(new Set(days).size, 30, 'no day doubled');
    assert.deepEqual([days[0], days[21], lastOf(days)], ['2025-10-12', '2025-11-02', '2025-11-10']);
    assert.ok(period.buckets.every((bucket) => bucket.from === bucket.to));
    for (let index = 1; index < days.length; index++) {
      assert.equal(Date.parse(days[index]!) - Date.parse(days[index - 1]!), 86_400_000, `no day lost after ${days[index - 1]}`);
    }
    // Local midnight on 12 October (EDT, UTC−4) and on 12 September; the previous
    // window ends at the same wall-clock time as now, 30 days before.
    assert.equal(period.start, '2025-10-12T04:00:00.000Z');
    assert.equal(period.previousStart, '2025-09-12T04:00:00.000Z');
    assert.equal(period.previousEnd, '2025-10-11T16:00:00.000Z');
    assert.equal(period.previousBuckets.length, 30);
    const wall = (instant: Date): number => wallClockOf(instant, NEW_YORK.name);
    assert.equal(
      wall(window.now) - wall(window.start),
      wall(window.previousEnd) - wall(window.previousStart),
      'both windows are the same span of local time',
    );
  });

  it('opens a day whose midnight the clocks skip at its first real instant', () => {
    // Chile jumps from 00:00 to 01:00 on 7 September 2025.
    const window = planAnalyticsWindow(1, at('2025-09-07T15:00:00.000Z'), { name: 'America/Santiago', fallback: false });
    assert.equal(window.start.toISOString(), '2025-09-07T04:00:00.000Z');
    assert.equal(describePeriod(window).buckets[0]?.from, '2025-09-07');
  });

  it('cuts a month into days, a quarter into weeks from its first day, and a year into calendar months', () => {
    assert.equal(granularityFor(7), 'day');
    assert.equal(granularityFor(30), 'day');
    assert.equal(granularityFor(90), 'week');
    assert.equal(granularityFor(365), 'month');
  });
});

describe('the bars', () => {
  const now = at('2026-09-18T12:30:00.000Z');

  it('90 days: thirteen bars of seven days from the window’s first day, the last one short', () => {
    const period = describePeriod(planAnalyticsWindow(90, now, UTC_ZONE));
    assert.equal(period.granularity, 'week');
    assert.equal(period.buckets.length, 13);
    assert.deepEqual(period.buckets[0], { from: '2026-06-21', to: '2026-06-27' });
    assert.deepEqual(lastOf(period.buckets), { from: '2026-09-13', to: '2026-09-18' });
    // The previous window's bars line up one for one, from ITS first day.
    assert.equal(period.previousBuckets.length, 13);
    assert.deepEqual(period.previousBuckets[0], { from: '2026-03-23', to: '2026-03-29' });
    assert.deepEqual(lastOf(period.previousBuckets), { from: '2026-06-15', to: '2026-06-20' });
  });

  it('365 days: calendar months, the first and the last partial', () => {
    const period = describePeriod(planAnalyticsWindow(365, now, UTC_ZONE));
    assert.equal(period.granularity, 'month');
    assert.equal(period.buckets.length, 13);
    assert.deepEqual(period.buckets[0], { from: '2025-09-19', to: '2025-09-30' });
    assert.deepEqual(period.buckets[5], { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(lastOf(period.buckets), { from: '2026-09-01', to: '2026-09-18' });
  });

  it('files a local day into the same bar SQL does, counted from its window’s first day', () => {
    const window = planAnalyticsWindow(90, now, UTC_ZONE);
    assert.equal(bucketIndexOf('week', window.startDay, '2026-06-27'), 0);
    assert.equal(bucketIndexOf('week', window.startDay, '2026-06-28'), 1);
    assert.equal(bucketIndexOf('month', '2025-09-19', '2026-02-28'), 5);
    assert.equal(bucketIndexOf('day', window.startDay, window.lastDay), 89);
  });

  it('never inverts a bar when the window is read at exactly midnight', () => {
    const midnight = at('2026-09-18T00:00:00.000Z');
    const window = planAnalyticsWindow(7, midnight, UTC_ZONE);
    const labels = bucketLabels('day', window.previousStartDay, window.previousLastDay, 7);
    for (const label of labels) assert.ok(label.from <= label.to, `${label.from} > ${label.to}`);
  });
});
