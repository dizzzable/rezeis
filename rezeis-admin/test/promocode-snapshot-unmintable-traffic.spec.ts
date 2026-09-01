import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PromocodeAvailability,
  PromocodeRewardType,
  SubscriptionStatus,
} from '@prisma/client';

import { PromocodeInterface } from '../src/modules/promocodes/interfaces/promocode.interface';
import { PromocodeRewardsService } from '../src/modules/promocodes/services/promocode-rewards.service';
import {
  isUnmintableSnapshotTrafficLimit,
  parsePromocodePlanSnapshot,
} from '../src/modules/promocodes/utils/promocode-mappers.util';

/**
 * THE READ SIDE OF THE ZERO-GIGABYTE PROBLEM, AND THE DECISION TAKEN ABOUT IT.
 *
 * `promocode-plan-snapshot.dto.ts` now carries `@Min(1)`, which closes the
 * WRITE side. It does not close this one. That decorator was `@Min(0)` until it
 * was raised, and `promocode-lifecycle.service.ts` writes `dto.plan` into the
 * JSON column VERBATIM, so every promocode authored before the raise can still
 * be carrying a `trafficLimit: 0` today. The column is JSON, the schema is
 * frozen, and there is no migration sweeping them — so the read side needs an
 * answer of its own.
 *
 * There were only three answers and none of them is free:
 *
 *   `0` → `null`   hands the customer UNLIMITED traffic, the most expensive
 *                  product we sell, because a number looked wrong.
 *   `0` → `1`      invents a cap the operator never chose and no plan offers.
 *   REFUSE         costs a redemption, but says so.
 *
 * THE CHOICE IS TO REFUSE, and these specs exist to name it so it can be
 * reversed deliberately rather than drifted into. A promocode that errors gets
 * reported; a wrong traffic limit does not. Both rewrites are guesses that
 * SUCCEED, which is what makes them worse than the failure.
 *
 * The refusal is soft and non-destructive: `applied: false` makes
 * `promocode-lifecycle.service.ts` roll the activation row back, so the
 * customer keeps the code and it works the moment an operator fixes the
 * snapshot. It is made loud by a `logger.error` naming the promocode, the plan
 * and the value — `REWARD_NOT_APPLICABLE` alone is shared with half a dozen
 * ordinary outcomes and would say nothing.
 *
 * To reverse: delete the `isUnmintableSnapshotTrafficLimit` branch in
 * `promocode-rewards.service.ts#applySubscription`. These specs will say which
 * of the three answers replaced it.
 */

// ── 1. The predicate itself ───────────────────────────────────────────────

describe('isUnmintableSnapshotTrafficLimit', () => {
  it('passes an ordinary cap, so the refusals below are not a blanket veto', () => {
    // THE ANCHOR. A predicate that answered `true` for everything would satisfy
    // every rejection assertion in this file.
    assert.equal(isUnmintableSnapshotTrafficLimit(50), false);
    assert.equal(isUnmintableSnapshotTrafficLimit(1), false);
  });

  it('passes unlimited, as null and as absence', () => {
    // The one thing it must NOT catch. `null` IS unlimited, and catching it
    // would refuse every unlimited promocode in the catalogue.
    assert.equal(isUnmintableSnapshotTrafficLimit(null), false);
    assert.equal(isUnmintableSnapshotTrafficLimit(undefined), false);
  });

  it('catches the zero that Remnawave cannot express', () => {
    assert.equal(isUnmintableSnapshotTrafficLimit(0), true);
  });

  it('catches negatives and fractions for the same reason', () => {
    assert.equal(isUnmintableSnapshotTrafficLimit(-5), true);
    assert.equal(isUnmintableSnapshotTrafficLimit(0.5), true);
  });
});

// ── 2. The parser keeps showing the bad row ───────────────────────────────

describe('the stored snapshot is still readable when it carries a zero', () => {
  it('carries the 0 through to the admin list rather than hiding or rewriting it', () => {
    // DELIBERATE, and the reason the refusal lives at the mint and not here.
    // `parsePromocodePlanSnapshot` also feeds the admin promocode LIST, which
    // is the operator's only view of the offending row. A parser that threw
    // would take down the list; one that normalised would erase the evidence
    // needed to fix the promocode.
    const parsed = parsePromocodePlanSnapshot({
      id: 'plan-1',
      name: 'Broken',
      type: 'BOTH',
      trafficLimit: 0,
      deviceLimit: 5,
    });

    assert.notEqual(parsed, null, 'the list view lost the row entirely');
    assert.equal(parsed?.trafficLimit, 0);
  });
});

// ── 3. What the mint does with it ─────────────────────────────────────────

function buildPromocode(plan: PromocodeInterface['plan']): PromocodeInterface {
  return {
    id: 'promo-1',
    code: 'PROMO',
    isActive: true,
    availability: PromocodeAvailability.ALL,
    rewardType: PromocodeRewardType.SUBSCRIPTION,
    // Mirrors the legacy reward, which is exactly what the mapper produces
    // for a code with no rows in `promocode_actions` — every code written by
    // an older panel, and everything a donor import writes.
    actions: [
      {
        type: PromocodeRewardType.SUBSCRIPTION,
        value: null,
        plan: null,
        discountAllowedPlanIds: [],
        discountValidForDays: null,
      },
    ],
    reward: null,
    plan,
    lifetime: null,
    expiresAt: null,
    maxActivations: null,
    allowedTelegramIds: [],
    allowedPlanIds: [],
    activationsCount: 0,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
  };
}

function snapshot(overrides: Record<string, unknown> = {}): PromocodeInterface['plan'] {
  return {
    id: 'plan-1',
    name: 'Premium',
    type: 'BOTH',
    trafficLimit: 100,
    deviceLimit: 5,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: ['squad-a'],
    externalSquad: null,
    duration: 30,
    ...overrides,
  } as PromocodeInterface['plan'];
}

interface MintOutcome {
  readonly applied: boolean;
  readonly rewardValue: number;
  readonly createdTrafficLimit: number | null | undefined;
  readonly createCallCount: number;
  readonly updateCallCount: number;
  readonly errorLogs: readonly string[];
}

/**
 * Runs `applyReward` against an in-memory transaction client.
 *
 * `targetSubscriptionId` picks the branch: `null` MINTS a new subscription
 * (the path that copies `trafficLimit` into the column), a string EXTENDS an
 * existing one (a path that only moves `expiresAt`).
 */
async function mint(
  plan: PromocodeInterface['plan'],
  targetSubscriptionId: string | null = null,
): Promise<MintOutcome> {
  const createCalls: Array<{ data: { trafficLimit?: number | null } }> = [];
  const updateCalls: Array<unknown> = [];
  const errorLogs: string[] = [];
  const service = new PromocodeRewardsService();
  // The loudness of the refusal is part of the decision, so it is asserted.
  // `REWARD_NOT_APPLICABLE` on its own is shared with several ordinary
  // outcomes; without this line an operator has nothing to act on.
  (service as unknown as { logger: { error: (m: string) => void; warn: (m: string) => void } })
    .logger = {
      error: (message: string) => errorLogs.push(message),
      warn: () => undefined,
    };

  const result = await service.applyReward({
    transactionClient: {
      $queryRaw: async () => [],
      subscription: {
        create: async (args: { data: { trafficLimit?: number | null } }) => {
          createCalls.push(args);
          return { id: 'new-sub-1' };
        },
        update: async (args: unknown) => {
          updateCalls.push(args);
          return { id: targetSubscriptionId };
        },
        findUnique: async () => ({
          id: targetSubscriptionId,
          userId: 'user-1',
          status: SubscriptionStatus.ACTIVE,
          planSnapshot: { id: 'plan-1' },
          remnawaveId: null,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          trafficLimit: 100,
        }),
      },
      user: { updateMany: async () => ({ count: 1 }) },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
    } as never,
    promocode: buildPromocode(plan),
    userId: 'user-1',
    targetSubscriptionId,
  });

  return {
    applied: result.applied,
    rewardValue: result.rewardValue,
    createdTrafficLimit: createCalls[0]?.data.trafficLimit,
    createCallCount: createCalls.length,
    updateCallCount: updateCalls.length,
    errorLogs,
  };
}

describe('minting a subscription from a stored promocode snapshot', () => {
  it('mints an ordinary cap, so the refusals below are not a dead reward path', async () => {
    // THE ANCHOR. A reward that refused everything would satisfy every
    // rejection spec in this block.
    const outcome = await mint(snapshot({ trafficLimit: 50 }));

    assert.equal(outcome.applied, true);
    assert.equal(outcome.createCallCount, 1);
    assert.equal(outcome.createdTrafficLimit, 50);
    assert.deepStrictEqual(outcome.errorLogs, []);
  });

  it('mints unlimited as unlimited', async () => {
    // The refusal must not cost the catalogue its unlimited promocodes.
    const outcome = await mint(snapshot({ trafficLimit: null }));

    assert.equal(outcome.applied, true);
    assert.equal(outcome.createdTrafficLimit, null);
    assert.deepStrictEqual(outcome.errorLogs, []);
  });

  it('REFUSES a stored zero instead of minting it', async () => {
    // THE DECISION. Not "clamped to 1", not "read as unlimited" — refused.
    const outcome = await mint(snapshot({ trafficLimit: 0 }));

    assert.equal(outcome.applied, false, 'the zero-gigabyte snapshot was applied');
    assert.equal(
      outcome.createCallCount,
      0,
      'a subscription row was written despite the refusal',
    );
  });

  it('refuses LOUDLY, naming the promocode, the plan and the value', async () => {
    // The half of the decision that makes it defensible. Without this the
    // refusal is indistinguishable from an ineligible target or a zero-day
    // snapshot, and nobody would ever learn which promocode is broken.
    const outcome = await mint(snapshot({ trafficLimit: 0 }));

    assert.equal(outcome.errorLogs.length, 1, 'the refusal was silent');
    const line = outcome.errorLogs[0] ?? '';
    assert.equal(line.includes('PROMO'), true, `the log does not name the promocode: "${line}"`);
    assert.equal(line.includes('plan-1'), true, `the log does not name the plan: "${line}"`);
    assert.equal(line.includes('trafficLimit=0'), true, `the log does not name the value: "${line}"`);
  });

  it('refuses a negative stored cap for the same reason', async () => {
    const outcome = await mint(snapshot({ trafficLimit: -5 }));

    assert.equal(outcome.applied, false);
    assert.equal(outcome.createCallCount, 0);
  });

  it('leaves deviceLimit: 0 alone, because there 0 IS unlimited', async () => {
    // THE ANTI-HARMONISATION GUARD. `deviceLimit <= 0` is the product's
    // canonical unlimited and matches the panel's own `hwidDeviceLimit: 0`.
    // Extending this refusal to devices would refuse every unlimited-device
    // promocode in the catalogue.
    const outcome = await mint(snapshot({ deviceLimit: 0 }));

    assert.equal(outcome.applied, true);
    assert.equal(outcome.createCallCount, 1);
  });

  it('does not touch the EXTEND path, which never writes a traffic limit', async () => {
    // Scope, asserted. Extending an existing subscription only moves
    // `expiresAt`; refusing it because of a snapshot field it never reads
    // would cost a customer a renewal for nothing.
    const outcome = await mint(snapshot({ trafficLimit: 0 }), 'sub-existing');

    assert.equal(outcome.applied, true, 'a renewal was refused over a field it never writes');
    assert.equal(outcome.updateCallCount, 1);
    assert.deepStrictEqual(outcome.errorLogs, []);
  });
});
