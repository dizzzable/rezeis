import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import {
  nextRemnawaveReset,
  planResetEpoch,
  previousRemnawaveReset,
} from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';

const strategyArb = fc.constantFrom<'DAY' | 'WEEK' | 'MONTH' | 'MONTH_ROLLING'>(
  'DAY',
  'WEEK',
  'MONTH',
  'MONTH_ROLLING',
);
const instantArb = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 11, 31, 23, 59, 59) })
  .map((timestamp) => new Date(timestamp));
// Zones on both sides of UTC, with and without a daylight hour, a quarter-hour
// offset and the farthest one from UTC: whatever zone Remnawave runs in, a
// cycle must be well formed.
const zoneArb = fc.constantFrom(
  'UTC',
  'Europe/Moscow',
  'Europe/Berlin',
  'America/New_York',
  'America/Santiago',
  'Asia/Kathmandu',
  'Pacific/Kiritimati',
);

describe('reset cycle policy properties', () => {
  it('is deterministic, contains every reference instant, and spans exactly one reset step', () => {
    fc.assert(
      fc.property(strategyArb, instantArb, instantArb, zoneArb, (strategy, anchorAt, referenceAt, timeZone) => {
        const input = { strategy, capability: 'ENABLED' as const, anchorAt, referenceAt, timeZone };
        const result = planResetEpoch(input);
        const repeated = planResetEpoch(input);

        // `planResetEpoch` returns null for exactly one strategy — NO_RESET —
        // and that one is deliberately outside the generated domain. Anything
        // else planning no epoch is a failure of the property, not a skip.
        assert.ok(result, `${strategy} must plan an epoch`);
        assert.deepEqual(result, repeated);
        assert.ok(result.startsAt.getTime() <= referenceAt.getTime());
        assert.ok(referenceAt.getTime() < result.plannedEndsAt.getTime());
        assert.equal(result.expiresAt.getTime() - result.plannedEndsAt.getTime(), 30 * 60 * 1000);
        assert.equal(result.epochId.includes('undefined'), false);

        // No reset falls strictly inside the cycle: the reset that opened it
        // is followed directly by the one that closes it.
        const schedule = { strategy, anchorAt, timeZone };
        const opened = previousRemnawaveReset(schedule, referenceAt);
        if (opened !== null) {
          assert.equal(opened.getTime(), result.startsAt.getTime());
          assert.equal(nextRemnawaveReset(schedule, opened)?.getTime(), result.plannedEndsAt.getTime());
        }
      }),
      { numRuns: 300 },
    );
  });
});
