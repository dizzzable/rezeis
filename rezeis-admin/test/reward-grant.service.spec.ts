import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PointsLedgerSource, Prisma, PromocodeRewardType } from '@prisma/client';

import { MAX_DISCOUNT_PERCENT } from '../src/common/utils/discount.util';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import type { RewardGrant, RewardOrigin } from '../src/modules/rewards/reward-grant.types';
import { resolveInheritedPlanLimitUpdate } from '../src/modules/subscriptions/services/plan-inherited-limits.util';

/**
 * The one reward applier, tested where it now lives.
 *
 * Quests reached these rules through their own spec before the move; the wheel
 * will reach them without a quest anywhere in sight. So the rules are pinned
 * here, on the applier, and the quest spec keeps only what is a quest's own
 * business — the claim, the budget, the snapshot, the trial fallback.
 */
interface World {
  readonly user: { personalDiscount: number; points: number; telegramId: bigint | null };
  readonly subscriptions: Array<{ id: string; expiresAt: Date | null; trafficLimit: number | null; planSnapshot: unknown }>;
  readonly writes: Array<{ op: string; args: Record<string, unknown> }>;
}

function makeTx(world: World) {
  const record = (op: string, args: Record<string, unknown>) => world.writes.push({ op, args });
  const tx = {
    user: {
      findUnique: async (args: { select?: Record<string, boolean> }) => {
        if (args.select?.['points']) return { points: world.user.points };
        if (args.select?.['telegramId']) return { telegramId: world.user.telegramId };
        return { personalDiscount: world.user.personalDiscount };
      },
      update: async (args: { data: { personalDiscount?: number } }) => {
        record('user.update', args);
        if (args.data.personalDiscount !== undefined) world.user.personalDiscount = args.data.personalDiscount;
        return {};
      },
      updateMany: async (args: { data: { points?: { increment?: number } } }) => {
        record('user.updateMany', args);
        world.user.points += args.data.points?.increment ?? 0;
        return { count: 1 };
      },
    },
    pointsLedgerEntry: {
      findUnique: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        record('pointsLedgerEntry.create', args);
        return { id: 'ledger-1' };
      },
    },
    subscription: {
      findFirst: async (args: { where: { expiresAt?: unknown } }) => {
        // The bounded resolver asks for `expiresAt: { not: null }`; the active
        // one does not. Same discrimination the real query makes.
        const bounded = args.where.expiresAt !== undefined;
        const match = world.subscriptions.find((sub) => (bounded ? sub.expiresAt !== null : true));
        return match === undefined ? null : { id: match.id };
      },
      findUnique: async (args: { where: { id: string } }) => {
        const sub = world.subscriptions.find((row) => row.id === args.where.id);
        return sub === undefined ? null : { expiresAt: sub.expiresAt, trafficLimit: sub.trafficLimit, planSnapshot: sub.planSnapshot };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        record('subscription.update', args);
        return {};
      },
    },
    plan: {
      findUnique: async () => ({
        id: 'plan-1', name: 'Plan', tag: null, type: 'STANDARD', icon: null, trafficLimit: 100,
        deviceLimit: 3, trafficLimitStrategy: 'NO_RESET', internalSquads: [], externalSquad: null,
      }),
    },
    promocode: {
      // The applier asks whether a freshly generated code is already taken
      // before it writes one. Nothing is, in this world.
      findUnique: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        record('promocode.create', args);
        return {};
      },
    },
    $queryRaw: async (args: unknown) => {
      record('subscription.lock', { args });
      return [];
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}

function world(overrides: Partial<World> = {}): World {
  return {
    user: { personalDiscount: 0, points: 0, telegramId: 100n },
    subscriptions: [],
    writes: [],
    ...overrides,
  };
}

const ORIGIN: RewardOrigin = {
  pointsSource: PointsLedgerSource.QUEST_REWARD,
  referenceKey: 'completion-1',
  details: { questId: 'q1' },
  codePrefix: 'QUEST-',
};

const service = new RewardGrantService(new PointsWalletService());

function grant(kind: RewardGrant['kind'], amount: number, planId: string | null = null): RewardGrant {
  return { kind, amount, planId };
}

describe('RewardGrantService — points', () => {
  it('credits through the wallet, keyed on the caller handle', async () => {
    const state = world();

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('POINTS', 30),
      origin: ORIGIN,
    });

    assert.deepEqual(applied, { kind: 'POINTS', points: 30, syncSubscriptionId: null });
    assert.equal(state.user.points, 30);
    const row = state.writes.find((write) => write.op === 'pointsLedgerEntry.create')!.args as {
      data: Record<string, unknown>;
    };
    assert.equal(row.data['source'], 'QUEST_REWARD');
    assert.equal(row.data['referenceKey'], 'completion-1');
    assert.deepEqual(row.data['details'], { questId: 'q1' });
  });

  it('writes nothing at all for a zero-point reward', async () => {
    const state = world();

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('POINTS', 0),
      origin: ORIGIN,
    });

    assert.deepEqual(applied, { kind: 'POINTS', points: 0, syncSubscriptionId: null });
    assert.deepEqual(state.writes, [], 'the wallet refuses a movement of zero, so nothing is journaled');
  });
});

describe('RewardGrantService — the permanent discount', () => {
  it('adds to what the person already has', async () => {
    const state = world({ user: { personalDiscount: 10, points: 0, telegramId: 100n } });

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('DISCOUNT', 15),
      origin: ORIGIN,
    });

    assert.equal(applied.discountPercent, 25);
    assert.equal(state.user.personalDiscount, 25);
  });

  it('stops at the shared ceiling, not at a hundred', async () => {
    // THE ONE BEHAVIOUR THIS MOVE CHANGED. The quest branch clamped at 100
    // while pricing has applied at most the shared ceiling since the promocode
    // work, so a stored 100 was a number no checkout could ever spend: the
    // column said one thing and every purchase did another. The customer is
    // unaffected — only the stored figure stops lying.
    const state = world({ user: { personalDiscount: 80, points: 0, telegramId: 100n } });

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('DISCOUNT', 50),
      origin: ORIGIN,
    });

    assert.equal(applied.discountPercent, MAX_DISCOUNT_PERCENT);
    assert.equal(state.user.personalDiscount, MAX_DISCOUNT_PERCENT);
    assert.ok(MAX_DISCOUNT_PERCENT < 100, 'and the ceiling really is below a hundred');
  });
});

describe('RewardGrantService — traffic', () => {
  it('raises the column AND its snapshot, so the next renewal takes it back', async () => {
    const state = world({
      subscriptions: [
        { id: 'sub-1', expiresAt: new Date('2026-10-01T00:00:00Z'), trafficLimit: 100, planSnapshot: { trafficLimit: 100, deviceLimit: 3, internalSquads: [], externalSquad: null } },
      ],
    });

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('TRAFFIC', 50),
      origin: ORIGIN,
    });

    assert.deepEqual(applied, {
      kind: 'TRAFFIC',
      trafficGb: 50,
      subscriptionId: 'sub-1',
      syncSubscriptionId: 'sub-1',
    });
    const write = state.writes.find((entry) => entry.op === 'subscription.update')!.args as {
      data: { trafficLimit: number; planSnapshot: Record<string, unknown> };
    };
    assert.equal(write.data.trafficLimit, 150);
    // The load-bearing half: the snapshot moves with the column, so the
    // subscription still reads as tracking its plan rather than as an operator
    // override that would outlive every renewal.
    assert.equal(write.data.planSnapshot['trafficLimit'], 150);
    assert.equal(
      resolveInheritedPlanLimitUpdate({
        current: { trafficLimit: 150, deviceLimit: 3, internalSquads: [], externalSquad: null },
        planSnapshot: write.data.planSnapshot,
        plan: { trafficLimit: 200, deviceLimit: 3, internalSquads: [], externalSquad: null },
      }).trafficLimit,
      200,
      'a renewal onto the plan resets the bonus instead of keeping it forever',
    );
  });

  it('takes the row lock before it reads, because the write is absolute', async () => {
    const state = world({
      subscriptions: [
        { id: 'sub-1', expiresAt: null, trafficLimit: 100, planSnapshot: {} },
      ],
    });

    await service.apply(makeTx(state), { userId: 'u1', grant: grant('TRAFFIC', 10), origin: ORIGIN });

    assert.deepEqual(
      state.writes.map((entry) => entry.op),
      ['subscription.lock', 'subscription.update'],
    );
  });

  it('leaves an unlimited subscription unlimited rather than making it finite', async () => {
    const state = world({
      subscriptions: [{ id: 'sub-1', expiresAt: null, trafficLimit: null, planSnapshot: {} }],
    });

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('TRAFFIC', 10),
      origin: ORIGIN,
    });

    assert.equal(applied.syncSubscriptionId, null);
    assert.equal(state.writes.some((entry) => entry.op === 'subscription.update'), false);
  });

  it('earns nothing when there is no subscription to top up', async () => {
    const state = world();

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('TRAFFIC', 10),
      origin: ORIGIN,
    });

    assert.deepEqual(applied, { kind: 'TRAFFIC', trafficGb: 10, syncSubscriptionId: null });
  });
});

describe('RewardGrantService — days', () => {
  it('extends from the current expiry when it is still ahead', async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const state = world({
      subscriptions: [{ id: 'sub-1', expiresAt: future, trafficLimit: 100, planSnapshot: {} }],
    });

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('DAYS', 7),
      origin: ORIGIN,
    });

    assert.equal(applied.syncSubscriptionId, 'sub-1');
    const write = state.writes.find((entry) => entry.op === 'subscription.update')!.args as {
      data: { expiresAt: Date };
    };
    assert.equal(
      write.data.expiresAt.getTime(),
      future.getTime() + 7 * 24 * 60 * 60 * 1000,
      'seven days on top of what was left',
    );
  });

  it('extends from now when the subscription has already run out', async () => {
    // Extending an expired subscription from its OLD date would hand somebody
    // days that already passed.
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const state = world({
      subscriptions: [{ id: 'sub-1', expiresAt: past, trafficLimit: 100, planSnapshot: {} }],
    });

    await service.apply(makeTx(state), { userId: 'u1', grant: grant('DAYS', 7), origin: ORIGIN });

    const write = state.writes.find((entry) => entry.op === 'subscription.update')!.args as {
      data: { expiresAt: Date; status: string };
    };
    assert.ok(write.data.expiresAt.getTime() > Date.now(), 'the new expiry is in the future');
    assert.equal(write.data.status, 'ACTIVE');
  });

  it('mints a code when there is nothing to extend, so the days are not lost', async () => {
    const state = world();

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('DAYS', 7),
      origin: ORIGIN,
    });

    assert.equal(applied.days, 7);
    assert.match(applied.promoCode ?? '', /^QUEST-[A-Z2-9]{8}$/);
    const minted = state.writes.find((entry) => entry.op === 'promocode.create')!.args as {
      data: Record<string, unknown>;
    };
    assert.equal(minted.data['rewardType'], 'DURATION');
    assert.equal(minted.data['reward'], 7);
    assert.equal(minted.data['maxActivations'], 1, 'personal and single-use');
  });
});

describe('RewardGrantService — minted codes', () => {
  it('mints a subscription code with the plan snapshot frozen into it', async () => {
    const state = world();

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('PROMOCODE', 30, 'plan-1'),
      origin: ORIGIN,
    });

    const minted = state.writes.find((entry) => entry.op === 'promocode.create')!.args as {
      data: { rewardType: string; plan: Record<string, unknown>; maxActivations: number };
    };
    assert.equal(minted.data.rewardType, 'SUBSCRIPTION');
    assert.equal(minted.data.plan['duration'], 30);
    assert.equal(minted.data.plan['trafficLimit'], 100, 'the plan is frozen, not referenced');
    assert.equal(minted.data.maxActivations, 1);
    assert.equal(applied.syncSubscriptionId, null);
  });

  it('carries the caller prefix, so a person can see where a code came from', async () => {
    const state = world();

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('PROMOCODE', 30),
      origin: { ...ORIGIN, codePrefix: 'WHEEL-' },
    });

    assert.match(applied.promoCode ?? '', /^WHEEL-[A-Z2-9]{8}$/);
  });

  it('never puts a lookalike character in a code somebody has to retype', async () => {
    const state = world();
    const codes: string[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const applied = await service.apply(makeTx(state), {
        userId: 'u1',
        grant: grant('PROMOCODE', 30),
        origin: ORIGIN,
      });
      codes.push(applied.promoCode ?? '');
    }

    for (const code of codes) {
      assert.doesNotMatch(code.slice('QUEST-'.length), /[IO01]/, code);
    }
    assert.ok(new Set(codes).size > 1, 'and they are not all the same code');
  });
});

describe('RewardGrantService — a minted code belongs to the person who won it', () => {
  it('binds the code to the winner, so a screenshot of it is not a coupon', () => {
    // The doc comment on the minter has said "personal" since it was written;
    // the row did not. A code minted `availability: ALL` is spendable by the
    // first person to read it off a screenshot, and single-use only decides
    // WHO gets there first.
    const state = world({ user: { personalDiscount: 0, points: 0, telegramId: 4242n } });

    return service
      .apply(makeTx(state), { userId: 'u1', grant: grant('PROMOCODE', 30), origin: ORIGIN })
      .then(() => {
        const minted = state.writes.find((entry) => entry.op === 'promocode.create')!.args as {
          data: { availability: string; allowedTelegramIds: bigint[]; maxActivations: number };
        };
        assert.equal(minted.data.availability, 'ALLOWED');
        assert.deepEqual(minted.data.allowedTelegramIds, [4242n]);
        assert.equal(minted.data.maxActivations, 1, 'and still once, so the winner cannot re-spend it');
      });
  });

  it('leaves a code open when there is no telegram id to bind it to', async () => {
    // A web-only account has nothing for the availability check to compare,
    // and a bound code would refuse the winner their own prize.
    const state = world({ user: { personalDiscount: 0, points: 0, telegramId: null } });

    await service.apply(makeTx(state), {
      userId: 'u1',
      grant: grant('PROMOCODE', 30),
      origin: ORIGIN,
    });

    const minted = state.writes.find((entry) => entry.op === 'promocode.create')!.args as {
      data: { availability: string; allowedTelegramIds?: bigint[] };
    };
    assert.equal(minted.data.availability, 'ALL');
    assert.equal(minted.data.allowedTelegramIds, undefined);
  });
});

describe('RewardGrantService — a code the caller spells out', () => {
  it('mints the discount the wheel asked for, on the plans it named, for as long as it said', async () => {
    const state = world();

    const applied = await service.apply(makeTx(state), {
      userId: 'u1',
      grant: {
        kind: 'PROMOCODE',
        amount: 20,
        planId: null,
        promo: {
          rewardType: PromocodeRewardType.PURCHASE_DISCOUNT,
          allowedPlanIds: ['plan-a', 'plan-b'],
          lifetimeDays: 14,
        },
      },
      origin: { ...ORIGIN, codePrefix: 'WHEEL-' },
    });

    const minted = state.writes.find((entry) => entry.op === 'promocode.create')!.args as {
      data: { rewardType: string; reward: number; allowedPlanIds: string[]; lifetime: number };
    };
    assert.equal(minted.data.rewardType, 'PURCHASE_DISCOUNT');
    assert.equal(minted.data.reward, 20);
    assert.deepEqual(minted.data.allowedPlanIds, ['plan-a', 'plan-b']);
    assert.equal(minted.data.lifetime, 14);
    assert.match(applied.promoCode ?? '', /^WHEEL-/);
  });

  it('omits the filter and the deadline rather than writing an empty one', async () => {
    // An empty `allowedPlanIds` means "any plan" to the validator, and a
    // `lifetime` of null means "never expires" — but writing either explicitly
    // would overwrite a column default with the same value for no reason, and
    // the absence is what the legacy path has always produced.
    const state = world();

    await service.apply(makeTx(state), {
      userId: 'u1',
      grant: {
        kind: 'PROMOCODE',
        amount: 7,
        planId: null,
        promo: {
          rewardType: PromocodeRewardType.DURATION,
          allowedPlanIds: [],
          lifetimeDays: null,
        },
      },
      origin: ORIGIN,
    });

    const minted = state.writes.find((entry) => entry.op === 'promocode.create')!.args as {
      data: Record<string, unknown>;
    };
    assert.equal('allowedPlanIds' in minted.data, false);
    assert.equal('lifetime' in minted.data, false);
  });

  it('refuses a subscription code with no plan instead of minting a code for nothing', async () => {
    const state = world();

    await assert.rejects(
      () =>
        service.apply(makeTx(state), {
          userId: 'u1',
          grant: {
            kind: 'PROMOCODE',
            amount: 30,
            planId: null,
            promo: {
              rewardType: PromocodeRewardType.SUBSCRIPTION,
              allowedPlanIds: [],
              lifetimeDays: null,
            },
          },
          origin: ORIGIN,
        }),
      /plan/i,
    );
    assert.equal(state.writes.some((entry) => entry.op === 'promocode.create'), false);
  });
});
