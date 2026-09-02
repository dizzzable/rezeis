import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PlanAvailability, PlanType, PointsCashbackMode, Prisma } from '@prisma/client';

import { mapAdminPlan, PlanRecord } from '../src/modules/plans/utils/plan-record.util';

/**
 * `mapAdminPlan` whitelists columns, so a column the schema gains stays
 * invisible to the panel until someone names it here: the cashback rule would
 * save fine and come back as INHERIT on every reload of the editor. These pin
 * the three cashback columns coming through — two on the plan, one on each
 * DURATION, because FIXED pays the purchased duration and a year may differ
 * from a month.
 */
describe('mapAdminPlan — points cashback', () => {
  it('carries the plan rule and the points of each duration', () => {
    const plan = mapAdminPlan(
      planRecord({
        cashbackMode: PointsCashbackMode.FIXED,
        cashbackPercent: null,
        durations: [
          durationRecord({ id: 'duration-30', days: 30, cashbackPoints: 40 }),
          durationRecord({ id: 'duration-365', days: 365, cashbackPoints: null }),
        ],
      }),
    );

    assert.deepStrictEqual(
      {
        cashbackMode: plan.cashbackMode,
        cashbackPercent: plan.cashbackPercent,
        points: plan.durations.map((duration) => [duration.days, duration.cashbackPoints]),
      },
      {
        cashbackMode: PointsCashbackMode.FIXED,
        cashbackPercent: null,
        points: [
          [30, 40],
          [365, null],
        ],
      },
    );
  });

  it('carries the own percent of a PERCENT plan', () => {
    const plan = mapAdminPlan(
      planRecord({ cashbackMode: PointsCashbackMode.PERCENT, cashbackPercent: 12 }),
    );

    assert.equal(plan.cashbackMode, PointsCashbackMode.PERCENT);
    assert.equal(plan.cashbackPercent, 12);
    assert.deepStrictEqual(
      plan.durations.map((duration) => duration.cashbackPoints),
      [null],
    );
  });

  it('carries INHERIT with nothing else set, the shape of every plan saved before the columns', () => {
    const plan = mapAdminPlan(planRecord());

    assert.equal(plan.cashbackMode, PointsCashbackMode.INHERIT);
    assert.equal(plan.cashbackPercent, null);
    assert.deepStrictEqual(
      plan.durations.map((duration) => duration.cashbackPoints),
      [null],
    );
  });
});

type PlanDurationRecord = PlanRecord['durations'][number];

function durationRecord(overrides: Partial<PlanDurationRecord> = {}): PlanDurationRecord {
  return {
    id: 'duration-30',
    planId: 'plan-1',
    days: 30,
    isActive: true,
    cashbackPoints: null,
    prices: [
      {
        id: 'price-1',
        planDurationId: 'duration-30',
        currency: Currency.RUB,
        price: new Prisma.Decimal('299'),
      },
    ],
    ...overrides,
  };
}

/** A full row, typed as the one Prisma returns, so a renamed column fails here at compile time. */
function planRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'plan-1',
    orderIndex: 1,
    isActive: true,
    isArchived: false,
    type: PlanType.BOTH,
    availability: PlanAvailability.ALL,
    archivedRenewMode: 'SELF_RENEW',
    name: 'Premium',
    description: null,
    tag: null,
    icon: null,
    trafficLimit: null,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    upgradeToPlanIds: [],
    replacementPlanIds: [],
    allowedUserIds: [],
    trialSettings: {},
    internalSquads: [],
    externalSquad: null,
    cashbackMode: PointsCashbackMode.INHERIT,
    cashbackPercent: null,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
    durations: [durationRecord()],
    ...overrides,
  };
}
