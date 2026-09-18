import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dateKeyOf,
  instantOfWallClock,
  resolveAnalyticsZone,
  startOfZonedDay,
} from '../src/modules/business-analytics/utils/analytics-zone.util';

/**
 * The operator's time zone, as the analytics reports read it from
 * `Settings.platformPolicy.timezone`. It reaches SQL as a bind parameter, and
 * only after passing a shape check and `Intl`; anything else falls back to UTC
 * with `fallback` set, which the page turns into a note.
 */
describe('the time zone the reports count days in', () => {
  it('takes an IANA zone the panel names, spelled as Intl spells it', () => {
    assert.deepEqual(resolveAnalyticsZone('Europe/Moscow'), { name: 'Europe/Moscow', fallback: false });
    assert.deepEqual(resolveAnalyticsZone('  europe/moscow '), { name: 'Europe/Moscow', fallback: false });
    // Three parts, and an alias Intl canonicalises (`America/Buenos_Aires`); PostgreSQL knows both spellings.
    assert.equal(resolveAnalyticsZone('America/Argentina/Buenos_Aires').fallback, false);
    assert.deepEqual(resolveAnalyticsZone('UTC'), { name: 'UTC', fallback: false });
    assert.deepEqual(resolveAnalyticsZone('Etc/UTC'), { name: 'UTC', fallback: false });
  });

  it('falls back to UTC, and says so, for an empty setting or one that is not a zone', () => {
    for (const setting of [null, undefined, '', '   ', 'Mars/Olympus_Mons', 'MSK', '+03:00', 'UTC+3', "UTC'; DROP TABLE users; --"]) {
      assert.deepEqual(resolveAnalyticsZone(setting), { name: 'UTC', fallback: true }, JSON.stringify(setting));
    }
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
