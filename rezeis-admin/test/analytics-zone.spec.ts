import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chooseAnalyticsZone,
  dateKeyOf,
  instantOfWallClock,
  readZoneSetting,
  startOfZonedDay,
  UTC_ZONE,
} from '../src/modules/business-analytics/utils/analytics-zone.util';

/**
 * The operator's time zone, as the analytics reports read it from
 * `Settings.platformPolicy.timezone`: taken when BOTH `Intl` (what Telegram
 * cards and notifications format with) and PostgreSQL (what the statements
 * count days with) know it — no stricter check of its own. Anything else falls
 * back to UTC with `fallback` set, which the page turns into a note. The
 * PostgreSQL half runs in `analytics-reports-postgres.spec.ts`.
 */
describe('the time zone the reports count days in', () => {
  it('reads whatever Intl reads, as the operator typed it and as Intl names it', () => {
    assert.deepEqual(readZoneSetting('Europe/Moscow'), { typed: 'Europe/Moscow', canonical: 'Europe/Moscow' });
    assert.deepEqual(readZoneSetting('  europe/moscow '), { typed: 'europe/moscow', canonical: 'Europe/Moscow' });
    // No slash, no area — and zones all the same: the old shape check turned both away.
    assert.equal(readZoneSetting('GMT')?.canonical, 'UTC');
    assert.equal(readZoneSetting('EST5EDT')?.typed, 'EST5EDT');
    // Intl takes an offset; whether the reports may is PostgreSQL's half of the question.
    assert.equal(readZoneSetting('+03:00')?.typed, '+03:00');
  });

  it('reads nothing from an empty setting or one Intl does not know', () => {
    for (const setting of [null, undefined, '', '   ', 'Mars/Olympus_Mons', 'MSK', 'UTC+3', "UTC'; DROP TABLE users; --"]) {
      assert.equal(readZoneSetting(setting), null, JSON.stringify(setting));
    }
  });

  it('counts in UTC for UTC under any name, without asking PostgreSQL', () => {
    for (const setting of ['UTC', 'Etc/UTC', 'GMT', 'Zulu']) {
      assert.deepEqual(chooseAnalyticsZone(readZoneSetting(setting), null), UTC_ZONE, setting);
    }
  });

  it('gives PostgreSQL the name it reads as that zone: Intl’s own, else the one typed, else nothing', () => {
    const cet = { typed: 'CET', canonical: 'Europe/Brussels' };
    // PostgreSQL reads `CET` as its fixed UTC+1 abbreviation, so only Intl's name will do.
    assert.deepEqual(chooseAnalyticsZone(cet, { canonical: true, typed: false }), { name: 'Europe/Brussels', fallback: false });
    // An install whose zone files lack Intl's older spelling still knows the one typed.
    assert.deepEqual(chooseAnalyticsZone({ typed: 'Asia/Kolkata', canonical: 'Asia/Calcutta' }, { canonical: false, typed: true }), {
      name: 'Asia/Kolkata',
      fallback: false,
    });
    assert.deepEqual(chooseAnalyticsZone({ typed: '+03:00', canonical: '+03:00' }, { canonical: false, typed: false }), { name: 'UTC', fallback: true });
    assert.deepEqual(chooseAnalyticsZone(null, null), { name: 'UTC', fallback: true });
  });
});

describe('local days of an instant', () => {
  it('names the local day, not the UTC one', () => {
    assert.equal(dateKeyOf(new Date('2026-09-17T22:30:00Z'), 'Europe/Moscow'), '2026-09-18');
    assert.equal(dateKeyOf(new Date('2026-09-18T02:30:00Z'), 'America/Los_Angeles'), '2026-09-17');
  });

  it('starts a day at local midnight, or at the first instant after a midnight the clocks skip', () => {
    assert.equal(startOfZonedDay('2026-09-18', 'Europe/Moscow').toISOString(), '2026-09-17T21:00:00.000Z');
    assert.equal(startOfZonedDay('2025-11-02', 'America/New_York').toISOString(), '2025-11-02T04:00:00.000Z');
    assert.equal(startOfZonedDay('2025-11-03', 'America/New_York').toISOString(), '2025-11-03T05:00:00.000Z');
    assert.equal(startOfZonedDay('2025-09-07', 'America/Santiago').toISOString(), '2025-09-07T04:00:00.000Z');
  });

  it('reads a skipped wall-clock time as the moment after the jump, and a repeated one as the earlier', () => {
    // 02:30 does not exist in New York on 9 March 2025; 01:30 happens twice on 2 November.
    assert.equal(instantOfWallClock(Date.UTC(2025, 2, 9, 2, 30), 'America/New_York').toISOString(), '2025-03-09T07:30:00.000Z');
    assert.equal(instantOfWallClock(Date.UTC(2025, 10, 2, 1, 30), 'America/New_York').toISOString(), '2025-11-02T05:30:00.000Z');
  });
});
