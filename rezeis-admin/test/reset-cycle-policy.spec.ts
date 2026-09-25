import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getResetCapability,
  provisionalResetAnchor,
  ResetCyclePolicyError,
  planResetEpoch,
  remnawaveResetsBetween,
  saleResetAnchor,
} from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';

const at = (value: string) => new Date(value);
const enabled = 'ENABLED' as const;

// The instants are Remnawave's own (`test/reset-schedule-parity.spec.ts` holds
// them against its sources): DAY 00:05, WEEK Monday 00:15, MONTH the 1st 00:20,
// MONTH_ROLLING 00:10 on the UTC anniversary; the add-on comes off 30 minutes
// after the reset.
describe('reset cycle policy', () => {
  it('withholds a provisional MONTH_ROLLING anchor until panel createdAt is known', () => {
    const startsAt = at('2026-07-15T12:30:00.000Z');
    assert.equal(provisionalResetAnchor('MONTH_ROLLING', startsAt), null);
    assert.equal(provisionalResetAnchor('MONTH', startsAt), startsAt);
    assert.equal(provisionalResetAnchor('DAY', startsAt), startsAt);
  });

  it('mints a MONTH_ROLLING term at the profile createdAt once it is known (P2); calendar terms keep their start', () => {
    const startsAt = at('2026-07-15T12:30:00.000Z');
    const createdAt = at('2025-11-03T08:00:00.000Z');
    assert.equal(provisionalResetAnchor('MONTH_ROLLING', startsAt, createdAt), createdAt);
    assert.equal(provisionalResetAnchor('MONTH', startsAt, createdAt), startsAt);
    assert.equal(provisionalResetAnchor('NO_RESET', startsAt, createdAt), startsAt);
  });

  it('a sale counts from the term anchor, else — rolling only — from the stored profile createdAt (P2)', () => {
    const termAnchor = at('2026-07-15T12:30:00.000Z');
    const createdAt = at('2025-11-03T08:00:00.000Z');
    assert.equal(saleResetAnchor('MONTH_ROLLING', termAnchor, createdAt), termAnchor);
    assert.equal(saleResetAnchor('MONTH_ROLLING', null, createdAt), createdAt);
    assert.equal(saleResetAnchor('MONTH_ROLLING', null, null), null);
    assert.equal(saleResetAnchor('MONTH', null, createdAt), null);
    assert.equal(saleResetAnchor('WEEK', termAnchor, createdAt), termAnchor);
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

  it('plans a DAY epoch between two 00:05 resets', () => {
    const result = planResetEpoch({
      strategy: 'DAY',
      capability: enabled,
      anchorAt: at('2026-01-15T12:34:56.000Z'),
      referenceAt: at('2026-07-12T15:30:00.000Z'),
    });

    assert.deepEqual(result, {
      epochId: 'DAY:2026-07-13T00:05:00.000Z',
      startsAt: at('2026-07-12T00:05:00.000Z'),
      plannedEndsAt: at('2026-07-13T00:05:00.000Z'),
      expiresAt: at('2026-07-13T00:35:00.000Z'),
    });
  });

  it('plans WEEK between Monday 00:15 resets and MONTH between the 1st 00:20 resets', () => {
    assert.deepEqual(
      planResetEpoch({
        strategy: 'WEEK',
        capability: enabled,
        anchorAt: at('2026-01-15T12:34:56.000Z'),
        referenceAt: at('2026-07-12T15:30:00.000Z'),
      }),
      {
        epochId: 'WEEK:2026-07-13T00:15:00.000Z',
        startsAt: at('2026-07-06T00:15:00.000Z'),
        plannedEndsAt: at('2026-07-13T00:15:00.000Z'),
        expiresAt: at('2026-07-13T00:45:00.000Z'),
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
        epochId: 'MONTH:2026-03-01T00:20:00.000Z',
        startsAt: at('2026-02-01T00:20:00.000Z'),
        plannedEndsAt: at('2026-03-01T00:20:00.000Z'),
        expiresAt: at('2026-03-01T00:50:00.000Z'),
      },
    );
  });

  it('clamps rolling-month anniversaries to the last valid day, at 00:10 whatever the anchor\'s time', () => {
    assert.deepEqual(
      planResetEpoch({
        strategy: 'MONTH_ROLLING',
        capability: enabled,
        anchorAt: at('2024-02-29T08:00:00.000Z'),
        referenceAt: at('2025-02-28T12:00:00.000Z'),
      }),
      {
        epochId: 'MONTH_ROLLING:2025-03-29T00:10:00.000Z',
        startsAt: at('2025-02-28T00:10:00.000Z'),
        plannedEndsAt: at('2025-03-29T00:10:00.000Z'),
        expiresAt: at('2025-03-29T00:40:00.000Z'),
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
        epochId: 'MONTH_ROLLING:2024-05-31T00:10:00.000Z',
        startsAt: at('2024-04-30T00:10:00.000Z'),
        plannedEndsAt: at('2024-05-31T00:10:00.000Z'),
        expiresAt: at('2024-05-31T00:40:00.000Z'),
      },
    );
  });

  it('treats an exact reset instant as the beginning of the next epoch', () => {
    assert.deepEqual(
      planResetEpoch({
        strategy: 'DAY',
        capability: enabled,
        anchorAt: at('2026-01-01T00:00:00.000Z'),
        referenceAt: at('2026-07-13T00:05:00.000Z'),
      }),
      {
        epochId: 'DAY:2026-07-14T00:05:00.000Z',
        startsAt: at('2026-07-13T00:05:00.000Z'),
        plannedEndsAt: at('2026-07-14T00:05:00.000Z'),
        expiresAt: at('2026-07-14T00:35:00.000Z'),
      },
    );
    assert.deepEqual(
      planResetEpoch({
        strategy: 'MONTH_ROLLING',
        capability: enabled,
        anchorAt: at('2024-01-31T08:00:00.000Z'),
        referenceAt: at('2024-05-31T00:10:00.000Z'),
      }),
      {
        epochId: 'MONTH_ROLLING:2024-06-30T00:10:00.000Z',
        startsAt: at('2024-05-31T00:10:00.000Z'),
        plannedEndsAt: at('2024-06-30T00:10:00.000Z'),
        expiresAt: at('2024-06-30T00:40:00.000Z'),
      },
    );
  });

  it('takes Remnawave\'s zone: 00:05 in Moscow is 21:05 UTC the evening before', () => {
    assert.deepEqual(
      planResetEpoch({
        strategy: 'DAY',
        capability: enabled,
        anchorAt: at('2026-01-01T00:00:00.000Z'),
        referenceAt: at('2026-07-12T21:00:00.000Z'),
        timeZone: 'Europe/Moscow',
      }),
      {
        epochId: 'DAY:2026-07-12T21:05:00.000Z',
        startsAt: at('2026-07-11T21:05:00.000Z'),
        plannedEndsAt: at('2026-07-12T21:05:00.000Z'),
        expiresAt: at('2026-07-12T21:35:00.000Z'),
      },
    );
  });

  // Zones that move their clocks AT midnight are the only ones whose 00:05 can
  // be skipped or doubled. Remnawave's cron library was not observed on such a
  // day; these pin the panel's own choice, documented on `zonedMidnightPlus`.
  it('moves a skipped 00:05 forward by the jump and takes the first of a doubled one', () => {
    assert.deepEqual(
      remnawaveResetsBetween(
        { strategy: 'DAY', anchorAt: null, timeZone: 'America/Santiago' },
        at('2026-09-05T00:00:00.000Z'),
        at('2026-09-07T12:00:00.000Z'),
      ).map((value) => value.toISOString()),
      // 06.09.2026 00:00 → 01:00: 00:05 does not exist, 01:05 (UTC−3) is 04:05 UTC.
      ['2026-09-05T04:05:00.000Z', '2026-09-06T04:05:00.000Z', '2026-09-07T03:05:00.000Z'],
    );
    assert.deepEqual(
      remnawaveResetsBetween(
        { strategy: 'DAY', anchorAt: null, timeZone: 'America/Havana' },
        at('2026-10-31T00:00:00.000Z'),
        at('2026-11-02T12:00:00.000Z'),
      ).map((value) => value.toISOString()),
      // 01.11.2026 01:00 → 00:00: 00:05 happens at 04:05 and at 05:05 UTC.
      ['2026-10-31T04:05:00.000Z', '2026-11-01T04:05:00.000Z', '2026-11-02T05:05:00.000Z'],
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
