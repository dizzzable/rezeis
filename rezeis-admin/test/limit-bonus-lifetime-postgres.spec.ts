import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AddOnType,
  PointsLedgerSource,
  Prisma,
  PromocodeAvailability,
  PromocodeRewardType,
  SubscriptionStatus,
  SubscriptionTermStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { TERM_LIMIT_BONUSES_KEY } from '../src/modules/add-on-entitlements/domain/term-limit-bonus';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import type { SubscriptionTermHooksService } from '../src/modules/add-on-entitlements/services/subscription-term-hooks.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import type { PromocodeInterface } from '../src/modules/promocodes/interfaces/promocode.interface';
import { PromocodeRewardsService } from '../src/modules/promocodes/services/promocode-rewards.service';
import { ReferralPointsExchangeService } from '../src/modules/referrals/services/referral-points-exchange.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import {
  activeTerm,
  at,
  buyAddOns,
  createPlan,
  GIB,
  newUser,
  subscriptionInModel,
  termModelFixtures,
  type Limits,
  type TermModelFixtures,
} from './helpers/term-model-fixtures';

/**
 * FREE LIMIT BONUSES — a promo code's traffic or devices, a points exchange's
 * traffic, a quest's or a wheel prize's traffic — and how long they last, on
 * PostgreSQL through the real writers, the real renewal and the real boundary.
 *
 * The rule (owner, 24.09.2026): a bonus behaves in the term model exactly as it
 * does outside it. The first block proves what that is today, with every flag
 * off: the next renewal puts the plan's own limit back, so a bonus lasts until
 * the next renewal — and a paid upgrade ends it too. The ad signup bonus is not
 * among them: it GRANTS a trial (`grantTrial`), it raises no limit.
 *
 * One deliberate difference: in the model a PAID UPGRADE keeps a bonus to its
 * own end, clamped to the new one — the owner's rule for a live add-on across
 * a paid upgrade, which a bonus now follows.
 *
 * The defect: in the term model the same write lasted only until the next
 * projection recompute. `+50 GB` from a promo code followed by `+10 GB` bought
 * left 110 GB — the bonus had raised the snapshot with the column, so the
 * recompute read the field as the plan's and took the term's base.
 *
 * Skipped without TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const ROLLOUT_FLAGS = [
  'ADDON_ENTITLEMENT_SHADOW',
  'ADDON_ENTITLEMENT_DIRECT_PURCHASE',
  'ADDON_DEVICE_CLEANUP_AUTO',
] as const;
const PLAN: Limits = { trafficLimit: 100, deviceLimit: 3 };
const REQUEST = { headers: {}, ip: '10.0.0.9', socket: { remoteAddress: null } } as never;

let prisma: PrismaService;
let fx: TermModelFixtures;
let hooks: SubscriptionTermHooksService;
let fulfilment: PaymentSubscriptionMutationService;
let boundary: EntitlementBoundaryService;
let scheduler: EntitlementBoundarySchedulerService;
let editor: AdminUserSubscriptionsController;
let adminId = '';
let settingsExisted = false;
let originalReferralSettings: Prisma.JsonValue | undefined;
const addOnCatalog: string[] = [];

type Owner = { readonly userId: string; readonly subscriptionId: string };

/** A subscription OUTSIDE the term model: columns and snapshot are the plan's, no term. */
async function legacySubscription(planId: string, userId?: string): Promise<Owner> {
  const owner = userId ?? (await newUser(fx, { points: 10_000 }));
  const panelId = 830_000 + fx.next();
  const subscription = await prisma.subscription.create({
    data: {
      userId: owner,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: planId,
        name: planId,
        trafficLimit: PLAN.trafficLimit,
        deviceLimit: PLAN.deviceLimit,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
      } as Prisma.InputJsonValue,
      trafficLimit: PLAN.trafficLimit,
      deviceLimit: PLAN.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: at(-10),
      startedAt: at(-10),
      expiresAt: at(20),
    },
    select: { id: true },
  });
  return { userId: owner, subscriptionId: subscription.id };
}

async function modelSubscription(planId: string): Promise<Owner> {
  const userId = await newUser(fx, { points: 10_000 });
  return subscriptionInModel(fx, { planId, plan: PLAN, userId });
}

function promocode(type: PromocodeRewardType): PromocodeInterface {
  return {
    id: `${fx.prefix}-promo-${fx.next()}`,
    code: `${fx.prefix}-CODE`,
    isActive: true,
    availability: PromocodeAvailability.ALL,
    rewardType: type,
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
  };
}

async function promoBonus(owner: Owner, type: 'TRAFFIC' | 'DEVICES', value: number): Promise<void> {
  const rewardType = type === 'TRAFFIC' ? PromocodeRewardType.TRAFFIC : PromocodeRewardType.DEVICES;
  const result = await prisma.$transaction((tx) =>
    new PromocodeRewardsService(hooks).applyAction({
      transactionClient: tx,
      promocode: promocode(rewardType),
      userId: owner.userId,
      targetSubscriptionId: owner.subscriptionId,
      action: { type: rewardType, value, plan: null, discountAllowedPlanIds: [], discountValidForDays: null },
    }),
  );
  assert.equal(result.applied, true, 'the promo code applied');
}

async function exchangeTraffic(owner: Owner, gigabytes: number): Promise<void> {
  const exchange = new ReferralPointsExchangeService(
    prisma,
    { enqueue: async () => undefined } as never,
    new PointsWalletService(),
    hooks,
  );
  const result = await exchange.executeExchange({
    userId: owner.userId,
    type: 'TRAFFIC',
    points: gigabytes * 10,
    subscriptionId: owner.subscriptionId,
  });
  assert.equal(result.success, true, result.message);
  assert.equal(result.value, gigabytes);
}

async function prizeTraffic(owner: Owner, gigabytes: number): Promise<void> {
  const applied = await prisma.$transaction((tx) =>
    new RewardGrantService(new PointsWalletService()).apply(tx, {
      userId: owner.userId,
      grant: { kind: 'TRAFFIC', amount: gigabytes, planId: null },
      origin: {
        pointsSource: PointsLedgerSource.WHEEL_PRIZE,
        referenceKey: `${fx.prefix}-spin-${fx.next()}`,
        details: {},
        codePrefix: 'WHEEL-',
      },
    }),
  );
  assert.equal(applied.syncSubscriptionId, owner.subscriptionId, 'the prize went to this subscription');
}

/** A paid renewal of `planId`, fulfilled the way the webhook does it. */
async function renew(owner: Owner, planId: string): Promise<void> {
  await pay(owner, 'RENEW', planId);
}

async function pay(owner: Owner, purchaseType: 'RENEW' | 'UPGRADE', planId: string): Promise<void> {
  const transaction = await prisma.transaction.create({
    data: {
      paymentId: `${fx.prefix}-pay-${fx.next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType,
      channel: 'WEB',
      gatewayType: 'PLATEGA',
      currency: 'RUB',
      amount: new Prisma.Decimal('299'),
      planSnapshot: { id: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(transaction);
}

/** A paid «+N GB until the end of the term», through the real checkout fulfilment (the ledger). */
async function buyTraffic(owner: Owner, gigabytes: number): Promise<void> {
  const addOnId = `${fx.prefix}-addon-${fx.next()}`;
  await prisma.addOn.create({
    data: { id: addOnId, name: addOnId, type: AddOnType.EXTRA_TRAFFIC, value: gigabytes, lifetime: 'UNTIL_SUBSCRIPTION_END' },
  });
  addOnCatalog.push(addOnId);
  const transaction = await prisma.transaction.create({
    data: {
      paymentId: `${fx.prefix}-pay-${fx.next()}`,
      userId: owner.userId,
      subscriptionId: null,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'PLATEGA',
      currency: 'RUB',
      amount: new Prisma.Decimal('99'),
      planSnapshot: {
        snapshotSource: 'ADDON_PURCHASE',
        addOnId,
        addOnType: AddOnType.EXTRA_TRAFFIC,
        addOnValue: gigabytes,
        name: addOnId,
        targetSubscriptionId: owner.subscriptionId,
        purchaseType: 'ADDITIONAL',
        gatewayType: 'PLATEGA',
        amount: '99',
        currency: 'RUB',
        contractVersion: 1,
        addOnRevision: 1,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        sourceLineKey: addOnId,
      } as Prisma.InputJsonValue,
    },
  });
  await withFlags(['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'], () =>
    fulfilment.applyCompletedTransaction(transaction),
  );
}

async function withFlags<T>(flags: readonly string[], body: () => Promise<T>): Promise<T> {
  const previous = flags.map((flag) => [flag, process.env[flag]] as const);
  for (const flag of flags) process.env[flag] = 'true';
  try {
    return await body();
  } finally {
    for (const [flag, value] of previous) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
  }
}

async function limits(subscriptionId: string) {
  const row = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: { trafficLimit: true, deviceLimit: true, planSnapshot: true },
  });
  const snapshot = row.planSnapshot as Record<string, unknown>;
  return {
    trafficLimit: row.trafficLimit,
    deviceLimit: row.deviceLimit,
    snapshot: { trafficLimit: snapshot['trafficLimit'], deviceLimit: snapshot['deviceLimit'] },
    snapshotCarriesBonuses: TERM_LIMIT_BONUSES_KEY in snapshot,
  };
}

/** Starts the queued renewal term at its own start, as the boundary sweep does. */
async function startQueuedTerm(subscriptionId: string): Promise<void> {
  const queued = await prisma.subscriptionTerm.findFirstOrThrow({
    where: { subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
    orderBy: { generation: 'asc' },
  });
  const result = await boundary.activateDueScheduledTerm(subscriptionId, new Date(queued.startsAt.getTime() + 1_000));
  assert.equal(result.termId, queued.id, 'the queued term started');
}

function bonusesOn(term: { readonly planSnapshot: Prisma.JsonValue }): unknown[] {
  const raw = (term.planSnapshot as Record<string, unknown>)[TERM_LIMIT_BONUSES_KEY];
  return Array.isArray(raw) ? raw : [];
}

run('free limit bonuses last until the next renewal — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    // Every stage explicitly OFF unless a case turns it on: unset is ON for
    // stages 1, 2 and 6 since the 24.09.2026 flip.
    for (const flag of ROLLOUT_FLAGS) process.env[flag] = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `d2bonus-${process.pid}-${Date.now()}`);
    hooks = realTermHooks(prisma);
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    const terms = new SubscriptionTermService();
    const projections = new EffectiveProjectionService();
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      new AddOnEntitlementService(),
      projections,
      terms,
      {} as never,
    );
    boundary = new EntitlementBoundaryService(prisma, new AddOnEntitlementService(), terms, projections);
    // The regular sweep. No panel: nothing here reduces a device.
    scheduler = new EntitlementBoundarySchedulerService(
      prisma,
      boundary,
      { enqueue: async () => undefined } as never,
      new DeviceReductionPlanService(prisma, {} as never),
      {} as never,
      terms,
    );
    editor = new AdminUserSubscriptionsController(
      prisma,
      {} as never,
      { enqueue: async () => undefined } as never,
      events as never,
      {} as never,
      {} as never,
      hooks,
    );
    const admin = await prisma.adminUser.create({
      data: { login: `${fx.prefix}-admin`, loginNormalized: `${fx.prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
    const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { referralSettings: true } });
    settingsExisted = settings !== null;
    originalReferralSettings = settings?.referralSettings;
    await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: {} });
    await prisma.settings.update({
      where: { id: 1 },
      data: {
        referralSettings: {
          points_exchange: {
            exchange_enabled: true,
            traffic: { enabled: true, points_cost: 10, min_points: 10, max_points: -1, max_traffic_gb: 500 },
          },
        },
      },
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await prisma.user
      .updateMany({ where: { id: { in: fx.users } }, data: { currentSubscriptionId: null } })
      .catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.addOn.deleteMany({ where: { id: { in: addOnCatalog } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
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

  describe('outside the term model, every flag off — what a bonus does today', () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly give: (owner: Owner) => Promise<void>;
      readonly raised: Limits;
    }> = [
      { name: "a promo code's traffic", give: (owner) => promoBonus(owner, 'TRAFFIC', 50), raised: { trafficLimit: 150, deviceLimit: 3 } },
      { name: "a promo code's devices", give: (owner) => promoBonus(owner, 'DEVICES', 2), raised: { trafficLimit: 100, deviceLimit: 5 } },
      { name: "a points exchange's traffic", give: (owner) => exchangeTraffic(owner, 50), raised: { trafficLimit: 150, deviceLimit: 3 } },
      { name: "a quest's or a wheel prize's traffic", give: (owner) => prizeTraffic(owner, 50), raised: { trafficLimit: 150, deviceLimit: 3 } },
    ];
    for (const entry of cases) {
      it(`${entry.name} lasts until the next renewal, which puts the plan's limit back`, async () => {
        // (A paid upgrade ends it too: see the last case of this block.)
        const plan = await createPlan(fx, PLAN);
        const owner = await legacySubscription(plan);

        await entry.give(owner);
        const given = await limits(owner.subscriptionId);
        assert.deepEqual([given.trafficLimit, given.deviceLimit], [entry.raised.trafficLimit, entry.raised.deviceLimit]);
        assert.deepEqual(given.snapshot, entry.raised, 'the snapshot moves with the column: the field still reads as the plan’s');

        await renew(owner, plan);
        const renewed = await limits(owner.subscriptionId);
        assert.deepEqual([renewed.trafficLimit, renewed.deviceLimit], [100, 3], 'the renewal ended the bonus');
        assert.deepEqual(renewed.snapshot, PLAN);
        assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: owner.subscriptionId } }), 0, 'still outside the model');
      });
    }

    it('a paid upgrade ends a bonus as well: the rewritten snapshot reads it as the old plan’s', async () => {
      const a = await createPlan(fx, PLAN);
      const b = await createPlan(fx, { trafficLimit: 200, deviceLimit: 4 });
      const owner = await legacySubscription(a);
      await promoBonus(owner, 'TRAFFIC', 50);

      await pay(owner, 'UPGRADE', b);

      const upgraded = await limits(owner.subscriptionId);
      assert.deepEqual([upgraded.trafficLimit, upgraded.deviceLimit], [200, 4], 'the new plan, and no bonus carried');
      assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: owner.subscriptionId } }), 0, 'still outside the model');
    });
  });

  describe('in the term model', () => {
    it('a paid upgrade keeps a bonus to its own end, like a live add-on, and the sweep takes it off then', async () => {
      const a = await createPlan(fx, PLAN);
      const b = await createPlan(fx, { trafficLimit: 200, deviceLimit: 4 });
      const owner = await modelSubscription(a);
      const periodEnd = (await activeTerm(prisma, owner.subscriptionId)).endsAt!;
      await promoBonus(owner, 'TRAFFIC', 50);

      await pay(owner, 'UPGRADE', b);

      const upgraded = await limits(owner.subscriptionId);
      assert.deepEqual([upgraded.trafficLimit, upgraded.deviceLimit], [250, 4], 'the new plan and the bonus on top');
      assert.deepEqual(upgraded.snapshot, { trafficLimit: 200, deviceLimit: 4 });
      const term = await activeTerm(prisma, owner.subscriptionId);
      const expiresAt = (await prisma.subscription.findUniqueOrThrow({ where: { id: owner.subscriptionId } })).expiresAt!;
      assert.ok(expiresAt.getTime() > periodEnd.getTime(), 'the upgrade bought a later end than the bonus has');
      const [carried] = bonusesOn(term) as Array<{ readonly until?: string }>;
      assert.equal(carried?.until, periodEnd.toISOString(), 'its own end: the end of the period it was given in');

      // The sweep leaves it until that end…
      await scheduler.runDueBoundaries(new Date(periodEnd.getTime() - 60_000));
      assert.equal((await limits(owner.subscriptionId)).trafficLimit, 250);
      // …and takes it off once the end has passed, pushing the lower limit.
      await scheduler.runDueBoundaries(new Date(periodEnd.getTime() + 1_000));
      assert.equal((await limits(owner.subscriptionId)).trafficLimit, 200, 'the bonus outlived its own end');
      assert.equal(bonusesOn(await activeTerm(prisma, owner.subscriptionId)).length, 0);
      const push = await prisma.profileSyncJob.findFirst({
        where: { subscriptionId: owner.subscriptionId, cause: 'BOUNDARY_EXPIRY' },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(push !== null, 'the lower limit is never pushed');
    });

    it('a bonus and a paid add-on add up: +50 GB, then +10 GB bought, is 160 GB', async () => {
      const plan = await createPlan(fx, PLAN);
      const owner = await modelSubscription(plan);

      await promoBonus(owner, 'TRAFFIC', 50);
      const given = await limits(owner.subscriptionId);
      assert.equal(given.trafficLimit, 150);
      assert.deepEqual(given.snapshot, PLAN, 'the snapshot stays the plan’s: the bonus is a recorded contribution');

      await buyTraffic(owner, 10);
      const bought = await limits(owner.subscriptionId);
      assert.equal(bought.trafficLimit, 160, '110 is the bonus lost to the recompute');
      const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
        where: { subscriptionId: owner.subscriptionId },
      });
      assert.equal(projection.desiredTrafficLimitBytes, 160n * GIB, 'the panel is sent 160 GB');
      assert.equal(projection.activeTrafficContributionBytes, 60n * GIB, 'the bonus and the add-on, both recorded');
    });

    it('a bonus lasts to the end of the current term: the renewal’s own term ends it — and no device is removed', async () => {
      const plan = await createPlan(fx, PLAN);
      const owner = await modelSubscription(plan);
      await promoBonus(owner, 'TRAFFIC', 50);
      await promoBonus(owner, 'DEVICES', 2);
      const given = await limits(owner.subscriptionId);
      assert.deepEqual([given.trafficLimit, given.deviceLimit], [150, 5]);
      assert.deepEqual(given.snapshot, PLAN, 'neither bonus rewrote the snapshot');

      await renew(owner, plan);
      const paid = await limits(owner.subscriptionId);
      assert.deepEqual([paid.trafficLimit, paid.deviceLimit], [150, 5], 'the period already paid for keeps it');
      const queued = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      });
      assert.equal(bonusesOn(queued).length, 0, 'the renewal’s term was minted after the bonus and does not carry it');

      await startQueuedTerm(owner.subscriptionId);
      const next = await limits(owner.subscriptionId);
      assert.deepEqual([next.trafficLimit, next.deviceLimit], [100, 3], 'the renewed period is the plan’s');
      assert.equal(next.snapshotCarriesBonuses, false, 'the bonuses stay on the term; the row never carries them');
      assert.equal(await prisma.addOnEntitlement.count({ where: { subscriptionId: owner.subscriptionId } }), 0, 'no add-on was minted');
      assert.equal(await prisma.deviceReductionPlan.count({ where: { subscriptionId: owner.subscriptionId } }), 0, 'no device cleanup');
    });

    it('a bonus given after the renewal was paid lasts through the period that renewal bought', async () => {
      const plan = await createPlan(fx, PLAN);
      const owner = await modelSubscription(plan);
      await renew(owner, plan);

      await promoBonus(owner, 'TRAFFIC', 50);
      const queued = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      });
      assert.equal(bonusesOn(queued).length, 1, 'the queued term carries it');
      await startQueuedTerm(owner.subscriptionId);
      const renewed = await limits(owner.subscriptionId);
      assert.equal(renewed.trafficLimit, 150, 'the renewed period keeps it');
      assert.equal(renewed.snapshotCarriesBonuses, false, 'the activation copied the plan, not the term’s bonuses');

      await renew(owner, plan);
      await startQueuedTerm(owner.subscriptionId);
      assert.equal((await limits(owner.subscriptionId)).trafficLimit, 100, 'the next renewal ends it');
    });

    it('a points exchange and a prize record the bonus on the term and leave the snapshot the plan’s', async () => {
      for (const give of [(owner: Owner) => exchangeTraffic(owner, 50), (owner: Owner) => prizeTraffic(owner, 50)]) {
        const plan = await createPlan(fx, PLAN);
        const owner = await modelSubscription(plan);

        await give(owner);
        const given = await limits(owner.subscriptionId);
        assert.equal(given.trafficLimit, 150);
        assert.deepEqual(given.snapshot, PLAN);
        assert.equal(bonusesOn(await activeTerm(prisma, owner.subscriptionId)).length, 1);

        // Any later recompute keeps it: a ledgered add-on.
        await buyAddOns(fx, owner, { trafficGb: 10 });
        assert.equal((await limits(owner.subscriptionId)).trafficLimit, 160);
      }
    });

    it('«Назначить план» ends a bonus, as it does outside the model', async () => {
      const a = await createPlan(fx, PLAN);
      const b = await createPlan(fx, { trafficLimit: 200, deviceLimit: 4 });
      const owner = await modelSubscription(a);
      await promoBonus(owner, 'TRAFFIC', 50);

      await editor.updateSubscription(owner.subscriptionId, { planId: b }, { id: adminId } as never, REQUEST);

      const moved = await limits(owner.subscriptionId);
      assert.deepEqual([moved.trafficLimit, moved.deviceLimit], [200, 4], 'the new plan, and no bonus carried onto it');
    });
  });
});
