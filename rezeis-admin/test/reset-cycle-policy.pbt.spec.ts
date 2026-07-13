import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { planResetEpoch } from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';

const strategyArb = fc.constantFrom<'DAY' | 'WEEK' | 'MONTH' | 'MONTH_ROLLING'>(
  'DAY',
  'WEEK',
  'MONTH',
  'MONTH_ROLLING',
);
const instantArb = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 11, 31, 23, 59, 59) })
  .map((timestamp) => new Date(timestamp));

describe('reset cycle policy properties', () => {
  it('is deterministic and contains every reference instant in the planned epoch', () => {
    fc.assert(
      fc.property(strategyArb, instantArb, instantArb, (strategy, anchorAt, referenceAt) => {
        const result = planResetEpoch({
          strategy,
          capability: 'ENABLED',
          anchorAt,
          referenceAt,
        });
        const repeated = planResetEpoch({
          strategy,
          capability: 'ENABLED',
          anchorAt,
          referenceAt,
        });

        assert.deepEqual(result, repeated);
        assert.ok(result.startsAt.getTime() <= referenceAt.getTime());
        assert.ok(referenceAt.getTime() < result.plannedEndsAt.getTime());
        assert.equal(result.epochId.includes('undefined'), false);
      }),
      { numRuns: 200 },
    );
  });
});
