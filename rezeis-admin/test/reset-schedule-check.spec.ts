import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeMismatch,
  formatUtcOffset,
  rollingAnchorDays,
} from '../src/modules/add-on-entitlements/services/reset-schedule-check.service';
import {
  impliedUtcOffsetMinutes,
  judgeResetSchedule,
  RESET_SCHEDULE_WINDOW_MS,
  type ResetObservation,
} from '../src/modules/add-on-entitlements/switches/reset-schedule-check';

/**
 * The daily reset-schedule check, as a pure verdict over observed resets.
 *
 * The observed instants are the SHAPE Remnawave writes: one `now` per
 * scheduled run, a few milliseconds after the cron minute on its own clock —
 * e.g. the lab's DAY run under `TZ=Etc/GMT+1` stamped 01:05:00.010 UTC
 * (`test/fixtures/remnawave-reset-lab/*.json`). A manual reset lands on any
 * second and says nothing about the schedule.
 */

const NOW = new Date('2026-09-25T10:00:00.000Z');

function day(observedAt: string): ResetObservation {
  return { strategy: 'DAY', observedAt: new Date(observedAt), createdAt: null };
}

describe('judgeResetSchedule', () => {
  it('agrees when every DAY run landed on 00:05 of the configured zone', () => {
    const verdict = judgeResetSchedule({
      observations: [day('2026-09-25T00:05:00.013Z'), day('2026-09-24T00:05:00.021Z')],
      timeZone: 'UTC',
      resetScoped: true,
      now: NOW,
    });
    assert.equal(verdict.status, 'ok');
    assert.deepEqual(verdict.mismatches, []);
    assert.equal(verdict.timeZone, 'UTC');
  });

  it('flags a DAY run three hours off, naming what was observed and the zone that explains it', () => {
    const verdict = judgeResetSchedule({
      observations: [day('2026-09-25T03:05:00.013Z'), day('2026-09-25T03:05:00.013Z')],
      timeZone: 'UTC',
      resetScoped: true,
      now: NOW,
    });
    assert.equal(verdict.status, 'mismatch');
    assert.deepEqual(verdict.mismatches, [
      {
        strategy: 'DAY',
        observedAt: '2026-09-25T03:05:00.013Z',
        expectedAt: '2026-09-25T00:05:00.000Z',
        impliedUtcOffsetMinutes: -180,
      },
    ]);
    // The same resets, with the zone Remnawave really runs in: agreement.
    const fixed = judgeResetSchedule({
      observations: [day('2026-09-25T03:05:00.013Z')],
      timeZone: 'Etc/GMT+3',
      resetScoped: true,
      now: NOW,
    });
    assert.equal(fixed.status, 'ok');
  });

  it('reads Moscow in a run at 21:05 UTC', () => {
    const verdict = judgeResetSchedule({
      observations: [day('2026-09-24T21:05:00.009Z')],
      timeZone: 'UTC',
      resetScoped: true,
      now: NOW,
    });
    assert.equal(verdict.status, 'mismatch');
    assert.equal(verdict.mismatches[0]!.impliedUtcOffsetMinutes, 180);
    assert.equal(
      judgeResetSchedule({ observations: [day('2026-09-24T21:05:00.009Z')], timeZone: 'Europe/Moscow', resetScoped: true, now: NOW })
        .status,
      'ok',
    );
  });

  it('takes a manual reset for nothing: any second of any minute is not a scheduled run', () => {
    const verdict = judgeResetSchedule({
      observations: [day('2026-09-25T14:23:17.456Z'), day('2026-09-25T03:05:31.000Z')],
      timeZone: 'UTC',
      resetScoped: true,
      now: new Date('2026-09-25T15:00:00.000Z'),
    });
    assert.equal(verdict.status, 'no_data');
  });

  it('lets the LATEST scheduled run decide, so a corrected Remnawave clears the warning at once', () => {
    const verdict = judgeResetSchedule({
      observations: [day('2026-09-24T03:05:00.010Z'), day('2026-09-25T00:05:00.012Z')],
      timeZone: 'UTC',
      resetScoped: true,
      now: NOW,
    });
    assert.equal(verdict.status, 'ok');
  });

  it('judges a rolling profile on its own day, by the UTC date and the zone\'s 00:10', () => {
    const rolling: ResetObservation = {
      strategy: 'MONTH_ROLLING',
      // Created 25.08, reset on the 25th at 00:10 of Remnawave's clock: in UTC−3 that is 03:10 UTC.
      createdAt: new Date('2026-08-25T12:00:00.000Z'),
      observedAt: new Date('2026-09-25T03:10:00.012Z'),
    };
    const utc = judgeResetSchedule({ observations: [rolling], timeZone: 'UTC', resetScoped: true, now: NOW });
    assert.equal(utc.status, 'mismatch');
    assert.equal(utc.mismatches[0]!.expectedAt, '2026-09-25T00:10:00.000Z');
    assert.equal(utc.mismatches[0]!.impliedUtcOffsetMinutes, -180);
    assert.equal(
      judgeResetSchedule({ observations: [rolling], timeZone: 'Etc/GMT+3', resetScoped: true, now: NOW }).status,
      'ok',
    );
    // A rolling profile whose anchor is unknown cannot be judged.
    assert.equal(
      judgeResetSchedule({ observations: [{ ...rolling, createdAt: null }], timeZone: 'UTC', resetScoped: true, now: NOW }).status,
      'no_data',
    );
  });

  it('says nothing while no live subscription resets on a schedule', () => {
    const verdict = judgeResetSchedule({
      observations: [day('2026-09-25T03:05:00.013Z')],
      timeZone: 'UTC',
      resetScoped: false,
      now: NOW,
    });
    assert.equal(verdict.status, 'nothing_to_check');
    assert.deepEqual(verdict.mismatches, []);
  });

  it('looks back a day and a half, no further', () => {
    const old = new Date(NOW.getTime() - RESET_SCHEDULE_WINDOW_MS - 1);
    old.setUTCMinutes(5, 0, 10);
    const verdict = judgeResetSchedule({ observations: [{ strategy: 'DAY', observedAt: old, createdAt: null }], timeZone: 'UTC', resetScoped: true, now: NOW });
    assert.equal(verdict.status, 'no_data');
  });

  it('judges nothing against a zone the runtime does not know', () => {
    const verdict = judgeResetSchedule({
      observations: [day('2026-09-25T03:05:00.013Z')],
      timeZone: 'Mars/Olympus',
      resetScoped: true,
      now: NOW,
    });
    assert.equal(verdict.status, 'no_data');
  });
});

describe('the zone a run implies', () => {
  it('covers the whole range of real offsets, quarter hours included', () => {
    assert.equal(impliedUtcOffsetMinutes('DAY', new Date('2026-09-24T10:05:00.000Z')), 14 * 60, 'Kiribati');
    // Offsets a day apart read the same clock: 12:05 UTC is 00:05 at UTC+12 and
    // at UTC−12, 11:05 UTC at UTC+13 and at UTC−11. The eastern one is named —
    // a hint, the operator knows which side of the date line the server is on.
    assert.equal(impliedUtcOffsetMinutes('DAY', new Date('2026-09-25T12:05:00.000Z')), 12 * 60);
    assert.equal(impliedUtcOffsetMinutes('DAY', new Date('2026-09-25T11:05:00.000Z')), 13 * 60);
    assert.equal(impliedUtcOffsetMinutes('DAY', new Date('2026-09-25T10:05:00.000Z')), 14 * 60);
    assert.equal(impliedUtcOffsetMinutes('DAY', new Date('2026-09-25T09:05:00.000Z')), -9 * 60);
    assert.equal(impliedUtcOffsetMinutes('DAY', new Date('2026-09-24T18:20:00.000Z')), 5 * 60 + 45, 'Nepal');
    assert.equal(impliedUtcOffsetMinutes('MONTH', new Date('2026-09-30T21:20:00.000Z')), 180);
    assert.equal(impliedUtcOffsetMinutes('WEEK', new Date('2026-09-28T00:15:00.000Z')), 0);
  });

  it('spells it the way an operator writes it', () => {
    assert.equal(formatUtcOffset(180), 'UTC+03:00');
    assert.equal(formatUtcOffset(-180), 'UTC−03:00');
    assert.equal(formatUtcOffset(345), 'UTC+05:45');
    assert.equal(formatUtcOffset(0), 'UTC+00:00');
    assert.equal(
      describeMismatch(
        {
          strategy: 'DAY',
          observedAt: '2026-09-25T03:05:00.013Z',
          expectedAt: '2026-09-25T00:05:00.000Z',
          impliedUtcOffsetMinutes: -180,
        },
        'UTC',
      ),
      'сброс «Каждый день» прошёл в 03:05 UTC, а по поясу «UTC» ожидался в 00:05 UTC — так сбрасывает Remnawave в поясе UTC−03:00',
    );
  });
});

describe('which rolling profiles were due today or yesterday', () => {
  it('takes the day itself, and every later day number at a month\'s end', () => {
    assert.deepEqual(rollingAnchorDays(new Date('2026-09-25T10:00:00.000Z')), [24, 25]);
    // 30.09 is September's last day: the 31st's profiles are reset on it.
    assert.deepEqual(rollingAnchorDays(new Date('2026-09-30T10:00:00.000Z')), [29, 30, 31]);
    // 01.10: yesterday was the 30th, the last day of September.
    assert.deepEqual(rollingAnchorDays(new Date('2026-10-01T10:00:00.000Z')), [1, 30, 31]);
    // 01.03.2028: yesterday was 29.02 of a leap year.
    assert.deepEqual(rollingAnchorDays(new Date('2028-03-01T10:00:00.000Z')), [1, 29, 30, 31]);
  });
});
