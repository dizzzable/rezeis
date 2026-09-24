import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AddOnEntitlementActorType,
  Prisma,
  PromocodeAvailability,
  PromocodeRewardType,
  SubscriptionTermStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import type { SubscriptionTermHooksService } from '../src/modules/add-on-entitlements/services/subscription-term-hooks.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import type {
  PromocodeActionInput,
  PromocodeInterface,
  PromocodePlanSnapshotInterface,
} from '../src/modules/promocodes/interfaces/promocode.interface';
import { PromocodeRewardsService } from '../src/modules/promocodes/services/promocode-rewards.service';
import { ReferralPointsExchangeService } from '../src/modules/referrals/services/referral-points-exchange.service';
import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import {
  activeTerm,
  assertFollowsExpiry,
  buyAddOns,
  createPlan,
  GIB,
  newUser,
  subscriptionInModel,
  termModelFixtures,
  withStage1,
  type TermModelFixtures,
} from './helpers/term-model-fixtures';

/**
 * EVERY PATH THAT CREATES A SUBSCRIPTION OR MOVES ITS EXPIRY, AND THE TERM
 * MODEL — on PostgreSQL, through the real services.
 *
 * Creation: a free trial and a promo code's subscription get their first term
 * inside the transaction that creates them — while stage 1 is on, and only
 * then. Without it an add-on bought on them a minute later is the PERMANENT
 * legacy increment, because the ledger needs a term.
 *
 * Expiry: extend, a promo code's days, a promo code's subscription on an
 * existing one and a points exchange for days each move the tail term with the
 * expiry, in their own transaction — and the add-on sold "until the end of the
 * subscription" with it. Without it that add-on ended on the OLD date, days
 * before the subscription it was bought for, until the hourly drift sweep
 * caught up. (A quest or wheel prize of days is left to that sweep on purpose:
 * `RewardsModule` stays a leaf — see `wheel-settings.util.spec.ts`.)
 *
 * Skipped without TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

let prisma: PrismaService;
let fx: TermModelFixtures;
let hooks: SubscriptionTermHooksService;
let settingsExisted = false;
let originalReferralSettings: Prisma.JsonValue | undefined;

function promocode(overrides: Partial<PromocodeInterface> = {}): PromocodeInterface {
  return {
    id: `${fx.prefix}-promo`,
    code: `${fx.prefix}-CODE`,
    isActive: true,
    availability: PromocodeAvailability.ALL,
    rewardType: PromocodeRewardType.DURATION,
    actions: [],
    reward: null,
    plan: null,
    lifetime: null,
    expiresAt: null,
    maxActivations: null,
    allowedTelegramIds: [],
    allowedPlanIds: [],
    activationsCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function planSnapshot(planId: string, duration: number): PromocodePlanSnapshotInterface {
  return {
    id: planId,
    name: planId,
    type: 'BOTH',
    trafficLimit: 90,
    deviceLimit: 2,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    duration,
  };
}

function applyPromo(
  userId: string,
  targetSubscriptionId: string | null,
  action: PromocodeActionInput,
) {
  return prisma.$transaction((tx) =>
    new PromocodeRewardsService(hooks).applyAction({
      transactionClient: tx,
      promocode: promocode({ rewardType: action.type }),
      userId,
      targetSubscriptionId,
      action,
    }),
  );
}

/** A subscription in the model with one live add-on ending with it. */
async function withLiveAddOn(userId?: string) {
  const plan = await createPlan(fx, { trafficLimit: 100, deviceLimit: 3 });
  const owner = await subscriptionInModel(fx, {
    planId: plan,
    plan: { trafficLimit: 100, deviceLimit: 3 },
    ...(userId === undefined ? {} : { userId }),
  });
  const [addOnId] = await buyAddOns(fx, owner, { devices: 1 });
  const oldEnd = (await activeTerm(prisma, owner.subscriptionId)).endsAt!;
  return { owner, addOnId: addOnId!, oldEnd };
}

async function assertEnteredModel(subscriptionId: string, expected: { traffic: bigint | null; devices: number | null }) {
  const created = await prisma.subscriptionTerm.findMany({ where: { subscriptionId } });
  assert.equal(created.length, 1, 'one term');
  assert.equal(created[0]!.status, SubscriptionTermStatus.ACTIVE);
  const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, select: { expiresAt: true } });
  assert.equal(created[0]!.endsAt?.getTime() ?? null, row.expiresAt?.getTime() ?? null, 'it runs to the expiry');
  const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId } });
  assert.equal(projection.state, 'SHADOW');
  assert.equal(projection.desiredTrafficLimitBytes, expected.traffic);
  assert.equal(projection.desiredDeviceLimit, expected.devices);
}

run('subscription writers keep the term model in step — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    // Stage 1 explicitly OFF unless a case turns it on: unset is ON since the
    // 24.09.2026 flip.
    process.env.ADDON_ENTITLEMENT_SHADOW = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `d2writers-${process.pid}-${Date.now()}`);
    hooks = realTermHooks(prisma);
    const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { referralSettings: true } });
    settingsExisted = settings !== null;
    originalReferralSettings = settings?.referralSettings;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.user
      .updateMany({ where: { id: { in: fx.users } }, data: { currentSubscriptionId: null } })
      .catch(() => undefined);
    await prisma.trialClaim.deleteMany({ where: { userId: { in: fx.users } } }).catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    if (settingsExisted) {
      await prisma.settings.update({
        where: { id: 1 },
        data: { referralSettings: (originalReferralSettings ?? {}) as Prisma.InputJsonValue },
      });
    } else {
      await prisma.settings.deleteMany({ where: { id: 1 } });
    }
    await prisma.$disconnect();
  });

  it('a free trial enters the model with stage 1 on — and not with it off', async () => {
    const mutations = new SubscriptionMutationsService(prisma, { enqueue: async () => undefined } as never, hooks);
    const plan = await createPlan(fx, { trafficLimit: 15, deviceLimit: 1 });

    const on = await withStage1('true', async () =>
      mutations.grantTrial({ userId: await newUser(fx), planId: plan, durationDays: 3 }),
    );
    await assertEnteredModel(on.subscriptionId, { traffic: 15n * GIB, devices: 1 });

    // OFF spelled out: unset is ON since the 24.09.2026 flip.
    const off = await withStage1('false', async () =>
      mutations.grantTrial({ userId: await newUser(fx), planId: plan, durationDays: 3 }),
    );
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: off.subscriptionId } }), 0);
  });

  it("a promo code's subscription enters the model with stage 1 on — and not with it off", async () => {
    const plan = await createPlan(fx, { trafficLimit: 90, deviceLimit: 2 });
    const action = {
      type: PromocodeRewardType.SUBSCRIPTION,
      value: null,
      plan: planSnapshot(plan, 14),
      discountAllowedPlanIds: [],
      discountValidForDays: null,
    };

    const on = await withStage1('true', async () => applyPromo(await newUser(fx), null, action));
    assert.equal(on.applied, true);
    await assertEnteredModel(on.createdSubscriptionId!, { traffic: 90n * GIB, devices: 2 });

    const off = await withStage1('false', async () => applyPromo(await newUser(fx), null, action));
    assert.equal(off.applied, true);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: off.createdSubscriptionId! } }), 0);
  });

  it('extend moves the tail term and the add-on with the expiry', async () => {
    const { owner, addOnId, oldEnd } = await withLiveAddOn();
    const mutations = new SubscriptionMutationsService(prisma, { enqueue: async () => undefined } as never, hooks);

    await mutations.extend({ subscriptionId: owner.subscriptionId, additionalDays: 6 });

    await assertFollowsExpiry(prisma, owner.subscriptionId, [addOnId], oldEnd);
  });

  it("a promo code's days move the tail term and the add-on with the expiry", async () => {
    const { owner, addOnId, oldEnd } = await withLiveAddOn();

    const result = await applyPromo(owner.userId, owner.subscriptionId, {
      type: PromocodeRewardType.DURATION,
      value: 11,
      plan: null,
      discountAllowedPlanIds: [],
      discountValidForDays: null,
    });

    assert.equal(result.applied, true);
    await assertFollowsExpiry(prisma, owner.subscriptionId, [addOnId], oldEnd);
    const event = await prisma.addOnEntitlementEvent.findFirstOrThrow({
      where: { entitlementId: addOnId, reason: 'TERM_WINDOW_ALIGNED' },
    });
    assert.equal(event.actorType, AddOnEntitlementActorType.USER, 'the customer who activated the code');
    assert.equal(event.actorId, owner.userId);
  });

  it("a promo code's subscription on an existing one moves the tail term and the add-on with the expiry", async () => {
    const { owner, addOnId, oldEnd } = await withLiveAddOn();
    const plan = await createPlan(fx, { trafficLimit: 90, deviceLimit: 2 });

    const result = await applyPromo(owner.userId, owner.subscriptionId, {
      type: PromocodeRewardType.SUBSCRIPTION,
      value: null,
      plan: planSnapshot(plan, 13),
      discountAllowedPlanIds: [],
      discountValidForDays: null,
    });

    assert.equal(result.applied, true);
    await assertFollowsExpiry(prisma, owner.subscriptionId, [addOnId], oldEnd);
  });

  it('a points exchange for days moves the tail term and the add-on with the expiry', async () => {
    await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: {} });
    await prisma.settings.update({
      where: { id: 1 },
      data: {
        referralSettings: {
          points_exchange: {
            exchange_enabled: true,
            subscription_days: { enabled: true, points_cost: 100, min_points: 100, max_points: -1 },
          },
        },
      },
    });
    const userId = await newUser(fx, { points: 1_000 });
    const { owner, addOnId, oldEnd } = await withLiveAddOn(userId);
    const exchange = new ReferralPointsExchangeService(
      prisma,
      { enqueue: async () => undefined } as never,
      new PointsWalletService(),
      hooks,
    );

    const result = await exchange.executeExchange({
      userId,
      type: 'SUBSCRIPTION_DAYS',
      points: 400,
      subscriptionId: owner.subscriptionId,
    });

    assert.equal(result.success, true);
    assert.equal(result.value, 4);
    await assertFollowsExpiry(prisma, owner.subscriptionId, [addOnId], oldEnd);
  });

});
