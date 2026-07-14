import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getResetCapability,
  provisionalResetAnchor,
  ResetCyclePolicyError,
  planResetEpoch,
} from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';

const at = (value: string) => new Date(value);
const enabled = 'ENABLED' as const;

describe('reset cycle policy', () => {
  it('withholds a provisional MONTH_ROLLING anchor until panel createdAt is known', () => {
    const startsAt = at('2026-07-15T12:30:00.000Z');
    assert.equal(provisionalResetAnchor('MONTH_ROLLING', startsAt), null);
    assert.equal(provisionalResetAnchor('MONTH', startsAt), startsAt);
    assert.equal(provisionalResetAnchor('DAY', startsAt), startsAt);
  });

  it('returns no epoch for NO_RESET', () => {
    assert.equal(
      planResetEpoch({
        strategy: 'NO_RESET',
        capability: 'DISABLED',
        anchorAt: null,
        referenceAt: at('2026-01-20T12:34:56.000Z'),
      }),
      null,
    );
  });

  it('defaults missing strategy capabilities to disabled', () => {
    assert.equal(getResetCapability('MONTH', {}), 'DISABLED');
    assert.equal(getResetCapability('MONTH', { MONTH: 'SHADOW_VERIFIED' }), 'SHADOW_VERIFIED');
    assert.equal(getResetCapability('MONTH', { MONTH: 'ENABLED' }), 'ENABLED');
  });

  it('plans a DAY epoch at the UTC calendar boundary', () => {
    const result = planResetEpoch({
      strategy: 'DAY',
      capability: enabled,
      anchorAt: at('2026-01-15T12:34:56.000Z'),
      referenceAt: at('2026-07-12T15:30:00.000Z'),
    });

    assert.deepEqual(result, {
      epochId: 'DAY:2026-07-12',
      startsAt: at('2026-07-12T00:00:00.000Z'),
      plannedEndsAt: at('2026-07-13T00:00:00.000Z'),
    });
  });

  it('plans WEEK from Monday UTC and MONTH from the first UTC day', () => {
    assert.deepEqual(
      planResetEpoch({
        strategy: 'WEEK',
        capability: enabled,
        anchorAt: at('2026-01-15T12:34:56.000Z'),
        referenceAt: at('2026-07-12T15:30:00.000Z'),
      }),
      {
        epochId: 'WEEK:2026-07-06',
        startsAt: at('2026-07-06T00:00:00.000Z'),
        plannedEndsAt: at('2026-07-13T00:00:00.000Z'),
      },
    );

    assert.deepEqual(
      planResetEpoch({
        strategy: 'MONTH',
        capability: enabled,
        anchorAt: at('2026-01-15T12:34:56.000Z'),
        referenceAt: at('2026-02-28T23:59:59.999Z'),
      }),
      {
        epochId: 'MONTH:2026-02',
        startsAt: at('2026-02-01T00:00:00.000Z'),
        plannedEndsAt: at('2026-03-01T00:00:00.000Z'),
      },
    );
  });

  it('clamps rolling-month anniversaries to the last valid day', () => {
    assert.deepEqual(
      planResetEpoch({
        strategy: 'MONTH_ROLLING',
        capability: enabled,
        anchorAt: at('2024-02-29T08:00:00.000Z'),
        referenceAt: at('2025-02-28T12:00:00.000Z'),
      }),
      {
        epochId: 'MONTH_ROLLING:2025-02-28',
        startsAt: at('2025-02-28T08:00:00.000Z'),
        plannedEndsAt: at('2025-03-29T08:00:00.000Z'),
      },
    );
  });

  it('preserves a day-31 anniversary after a short month clamp', () => {
    assert.deepEqual(
      planResetEpoch({
        strategy: 'MONTH_ROLLING',
        capability: enabled,
        anchorAt: at('2024-01-31T08:00:00.000Z'),
        referenceAt: at('2024-04-30T12:00:00.000Z'),
      }),
      {
        epochId: 'MONTH_ROLLING:2024-04-30',
        startsAt: at('2024-04-30T08:00:00.000Z'),
        plannedEndsAt: at('2024-05-31T08:00:00.000Z'),
      },
    );
  });

  it('treats exact UTC boundaries as the beginning of the next epoch', () => {
    assert.deepEqual(
      planResetEpoch({
        strategy: 'DAY',
        capability: enabled,
        anchorAt: at('2026-01-01T00:00:00.000Z'),
        referenceAt: at('2026-07-13T00:00:00.000Z'),
      }),
      {
        epochId: 'DAY:2026-07-13',
        startsAt: at('2026-07-13T00:00:00.000Z'),
        plannedEndsAt: at('2026-07-14T00:00:00.000Z'),
      },
    );
    assert.deepEqual(
      planResetEpoch({
        strategy: 'MONTH_ROLLING',
        capability: enabled,
        anchorAt: at('2024-01-31T08:00:00.000Z'),
        referenceAt: at('2024-05-31T08:00:00.000Z'),
      }),
      {
        epochId: 'MONTH_ROLLING:2024-05-31',
        startsAt: at('2024-05-31T08:00:00.000Z'),
        plannedEndsAt: at('2024-06-30T08:00:00.000Z'),
      },
    );
  });

  it('does not enable a strategy before staging parity is verified', () => {
    assert.throws(
      () =>
        planResetEpoch({
          strategy: 'MONTH',
          capability: 'DISABLED',
          anchorAt: at('2026-01-01T00:00:00.000Z'),
          referenceAt: at('2026-02-01T00:00:00.000Z'),
        }),
      (error: unknown) =>
        error instanceof ResetCyclePolicyError && error.code === 'RESET_CAPABILITY_DISABLED',
    );
  });

  it('rejects invalid anchors instead of guessing', () => {
    assert.throws(
      () =>
        planResetEpoch({
          strategy: 'MONTH_ROLLING',
          capability: enabled,
          anchorAt: new Date(Number.NaN),
          referenceAt: at('2026-02-01T00:00:00.000Z'),
        }),
      (error: unknown) => error instanceof ResetCyclePolicyError && error.code === 'INVALID_ANCHOR',
    );
  });
});
