import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { Prisma, PurchaseChannel, PurchaseType } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AdSignupBonusService } from '../src/modules/advertising/services/ad-signup-bonus.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PlanDeletionService } from '../src/modules/plans/services/plan-deletion.service';
import { PlanReferenceGuardService } from '../src/modules/plans/services/plan-reference-guard.service';
import { PlanSquadPropagationService } from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { RetiredPlanSweeperService } from '../src/modules/plans/services/retired-plan-sweeper.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { RewardGrantService } from '../src/modules/rewards/reward-grant.service';
import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';
import { SubscriptionRenewalService } from '../src/modules/subscriptions/services/subscription-renewal.service';

/**
 * DELETING A PLAN, against a real PostgreSQL (plan-deletion contract v2).
 *
 * The unit specs evaluate the guard's `where` in memory. What only an engine
 * can prove is here: that the Prisma JSON-path filters and relation filters
 * mean on PostgreSQL what the double says they mean, for EVERY reference kind,
 * with rows that must be ignored beside the rows that must be counted; that a
 * removed plan takes its durations and prices with it (the FK cascade); that
 * `array_remove` strips transitions; that the kept row still resolves where
 * money depends on it — a paid invoice is FULFILLED from it — and in the grant
 * paths the delete dialog promises; that the renewal asks for a choice; that
 * the unique name index lets a new plan take a deleted plan's name, which the
 * plan is still given away under; that an edit racing the delete on another
 * connection is refused instead of putting the plan back on sale; and that
 * the nightly sweep removes the row the night after its last use and not before.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it (`.github/workflows/ci.yml`). Every row carries this run's prefix and
 * is removed in `after`; the one shared row — the settings singleton — is
 * restored to what it held.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `pdel-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;

let prisma: PrismaService;
let guard: PlanReferenceGuardService;
let deletion: PlanDeletionService;
let plansAdmin: PlansAdminService;
let sweeper: RetiredPlanSweeperService;
let adminId: string;
let originalReferralSettings: Prisma.JsonValue | undefined;
let settingsExisted = false;

const created = {
  plans: [] as string[],
  users: [] as string[],
  promocodes: [] as string[],
  mintedCodes: [] as string[],
  quests: [] as string[],
  contests: [] as string[],
  sectors: [] as string[],
  addOns: [] as string[],
  campaigns: [] as string[],
};

let counter = 0;
const next = (): number => ++counter;

async function createPlan(label: string, data: Partial<Prisma.PlanUncheckedCreateInput> = {}): Promise<string> {
  const id = `${prefix}-plan-${label}`;
  await prisma.plan.create({
    data: {
      id,
      name: `${prefix} ${label}`,
      orderIndex: 100_000 + next(),
      durations: {
        create: [
          { days: 30, prices: { create: [{ currency: 'RUB', price: '199' }, { currency: 'USD', price: '3' }] } },
          { days: 90, prices: { create: [{ currency: 'RUB', price: '499' }] } },
        ],
      },
      ...data,
    },
  });
  created.plans.push(id);
  return id;
}

async function createUser(label: string): Promise<string> {
  const id = `${prefix}-user-${label}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: label } });
  created.users.push(id);
  return id;
}

async function createSubscription(userId: string, planSnapshot: Prisma.InputJsonValue, status = 'ACTIVE'): Promise<string> {
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: status as never,
      planSnapshot,
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
    },
    select: { id: true },
  });
  return subscription.id;
}

async function createTransaction(
  userId: string,
  data: {
    readonly status: string;
    readonly planSnapshot: Prisma.InputJsonValue;
    readonly fulfilledAt?: Date | null;
    readonly createdAt?: Date;
    readonly purchaseType?: PurchaseType;
  },
): Promise<string> {
  const transaction = await prisma.transaction.create({
    data: {
      userId,
      status: data.status as never,
      purchaseType: data.purchaseType ?? PurchaseType.NEW,
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('199'),
      planSnapshot: data.planSnapshot,
      fulfilledAt: data.fulfilledAt ?? null,
      ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
    },
    select: { id: true },
  });
  return transaction.id;
}

const CONTEXT = () => ({
  currentAdmin: { id: adminId } as never,
  requestMetadata: { requestId: `${prefix}-req`, remoteAddress: '203.0.113.9', userAgent: 'plan-delete-postgres' },
});

run('plan deletion on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();

    guard = new PlanReferenceGuardService(prisma);
    deletion = new PlanDeletionService(prisma, guard);
    const remnawave = { getInternalSquadOptions: async () => [], getExternalSquadOptions: async () => [] };
    plansAdmin = new PlansAdminService(
      prisma,
      remnawave as never,
      { syncPlanSnapshotMetadata: async () => 0 } as never,
      new PlansAdminValidators(prisma, remnawave as never),
      new PlanSquadPropagationService(prisma, { enqueue: async () => undefined } as never),
    );
    sweeper = new RetiredPlanSweeperService(prisma, guard, { warn: () => undefined } as never);

    const admin = await prisma.adminUser.create({
      data: { login: `${prefix}-admin`, loginNormalized: `${prefix}-admin`, passwordHash: 'not-a-real-hash' },
      select: { id: true },
    });
    adminId = admin.id;

    const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { referralSettings: true } });
    settingsExisted = settings !== null;
    originalReferralSettings = settings?.referralSettings;
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = created.users;
    await prisma.trialClaim.deleteMany({ where: { userId: { in: users } } });
    await prisma.subscriptionTerm.deleteMany({ where: { subscription: { userId: { in: users } } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: users } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: users } } });
    await prisma.promocode.deleteMany({
      where: { OR: [{ id: { in: created.promocodes } }, { code: { in: created.mintedCodes } }] },
    });
    await prisma.contest.deleteMany({ where: { id: { in: created.contests } } });
    await prisma.wheelSector.deleteMany({ where: { id: { in: created.sectors } } });
    await prisma.quest.deleteMany({ where: { id: { in: created.quests } } });
    await prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } });
    await prisma.adCampaign.deleteMany({ where: { id: { in: created.campaigns } } });
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } });
    for (const planId of created.plans) {
      await prisma.adminAuditLog.deleteMany({
        where: { action: 'plans.deleted', metadata: { path: ['planId'], equals: planId } },
      });
    }
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
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

  it('counts every reference kind exactly, and ignores every row a condition narrows out', async () => {
    const X = await createPlan('guard-x');
    const O = await createPlan('guard-o');
    const user = await createUser('guard');
    const now = Date.now();

    // subscriptions: 2 (the `id` and the re-import `planId` spellings); a
    // DELETED one and one on another plan do not count.
    await createSubscription(user, { id: X, selectedDurationDays: 30 });
    await createSubscription(user, { planId: X }, 'EXPIRED');
    await createSubscription(user, { id: X }, 'DELETED');
    await createSubscription(user, { id: O });
    // A plan-less subscription to hang terms and renewal lines on.
    const host = await createSubscription(user, {});

    // scheduledTerms: 1; an ENDED term does not count.
    await prisma.subscriptionTerm.create({ data: { subscriptionId: host, generation: 1, planId: X, status: 'SCHEDULED', startsAt: new Date(now + DAY_MS) } });
    await prisma.subscriptionTerm.create({ data: { subscriptionId: host, generation: 2, planId: X, status: 'ENDED', startsAt: new Date(now - 30 * DAY_MS) } });

    // unsettledPayments: 2; fulfilled and refunded do not count.
    await createTransaction(user, { status: 'PENDING', planSnapshot: { id: X } });
    await createTransaction(user, { status: 'COMPLETED', planSnapshot: { id: X }, fulfilledAt: null });
    await createTransaction(user, { status: 'COMPLETED', planSnapshot: { id: X }, fulfilledAt: new Date(now - DAY_MS) });
    await createTransaction(user, { status: 'REFUNDED', planSnapshot: { id: X } });

    // recentCheckouts: 2; a cancelled checkout from eight days ago does not count.
    await createTransaction(user, { status: 'CANCELED', planSnapshot: { id: X }, createdAt: new Date(now - DAY_MS) });
    await createTransaction(user, { status: 'FAILED', planSnapshot: { id: X }, createdAt: new Date(now - 2 * DAY_MS) });
    await createTransaction(user, { status: 'CANCELED', planSnapshot: { id: X }, createdAt: new Date(now - 8 * DAY_MS) });

    // renewalItems: 2; an applied line and a line of a cancelled payment do not count.
    const combined = { combinedRenewal: true, snapshotVersion: 1 };
    for (const [status, appliedAt] of [
      ['PENDING', null],
      ['COMPLETED', null],
      ['COMPLETED', new Date(now - DAY_MS)],
      ['CANCELED', null],
    ] as const) {
      const transactionId = await createTransaction(user, { status, planSnapshot: combined, purchaseType: PurchaseType.RENEW });
      await prisma.transactionItem.create({
        data: { transactionId, subscriptionId: host, planId: X, durationDays: 30, amount: new Prisma.Decimal('199'), currency: 'RUB', appliedAt },
      });
    }

    // trialReservations: 1; a consumed claim does not count.
    await prisma.trialClaim.create({ data: { userId: user, planId: X, source: 'PAID', status: 'RESERVED' } });
    await prisma.trialClaim.create({ data: { userId: user, planId: X, source: 'FREE', status: 'CONSUMED' } });

    // promocodes: 2 (legacy column, SUBSCRIPTION action); archived and a
    // DURATION action carrying a plan do not count.
    const promo = async (label: string, data: Partial<Prisma.PromocodeUncheckedCreateInput>): Promise<string> => {
      const row = await prisma.promocode.create({
        data: { code: `${prefix}-${label}`.toUpperCase(), rewardType: 'SUBSCRIPTION', ...data },
        select: { id: true },
      });
      created.promocodes.push(row.id);
      return row.id;
    };
    await promo('legacy', { plan: { id: X, duration: 30 } });
    const withAction = await promo('action', {});
    await prisma.promocodeAction.create({ data: { promocodeId: withAction, type: 'SUBSCRIPTION', payload: { plan: { id: X } } } });
    await promo('archived', { plan: { id: X }, archivedAt: new Date(now - DAY_MS) });
    const durationAction = await promo('duration', { rewardType: 'DURATION' });
    await prisma.promocodeAction.create({ data: { promocodeId: durationAction, type: 'DURATION', payload: { plan: { id: X } } } });

    // quests: 2; a POINTS reward naming the plan does not count.
    for (const rewardType of ['DAYS', 'PROMOCODE', 'POINTS'] as const) {
      const quest = await prisma.quest.create({ data: { type: 'CUSTOM', rewardType, rewardPlanId: X }, select: { id: true } });
      created.quests.push(quest.id);
    }

    // contests: 1 (two prizes in one ACTIVE contest); a DRAWN contest and a
    // POINTS prize do not count.
    const contest = async (status: string, prizes: Array<{ kind: string; promoRewardType: string | null }>): Promise<void> => {
      const row = await prisma.contest.create({
        data: {
          status: status as never,
          startAt: new Date(now - DAY_MS),
          endAt: new Date(now + DAY_MS),
          prizes: {
            create: prizes.map((prize, index) => ({
              place: index + 1,
              kind: prize.kind as never,
              promoPlanId: X,
              promoRewardType: prize.promoRewardType as never,
            })),
          },
        },
        select: { id: true },
      });
      created.contests.push(row.id);
    };
    await contest('ACTIVE', [
      { kind: 'PROMOCODE', promoRewardType: 'SUBSCRIPTION' },
      { kind: 'PROMOCODE', promoRewardType: null },
    ]);
    await contest('DRAWN', [{ kind: 'PROMOCODE', promoRewardType: 'SUBSCRIPTION' }]);
    await contest('ACTIVE', [{ kind: 'POINTS', promoRewardType: null }]);

    // wheelSectors: 2; a DURATION code sector does not count.
    for (const promoRewardType of ['SUBSCRIPTION', null, 'DURATION'] as const) {
      const sector = await prisma.wheelSector.create({
        data: { kind: 'PROMOCODE', promoPlanId: X, promoRewardType },
        select: { id: true },
      });
      created.sectors.push(sector.id);
    }

    // addOns: 1; an add-on sold against another plan only does not count.
    for (const applicablePlanIds of [[O, X], [O]]) {
      const addOn = await prisma.addOn.create({
        data: { name: `${prefix} add-on`, type: 'EXTRA_TRAFFIC', value: 10, applicablePlanIds },
        select: { id: true },
      });
      created.addOns.push(addOn.id);
    }

    // adPlacements: 1; archived, and a TRIAL bonus with a stale tariff id, do not count.
    const campaign = await prisma.adCampaign.create({ data: { name: `${prefix} campaign` }, select: { id: true } });
    created.campaigns.push(campaign.id);
    for (const [signupBonusType, status] of [
      ['TARIFF', 'ACTIVE'],
      ['TARIFF', 'ARCHIVED'],
      ['TRIAL', 'ACTIVE'],
    ] as const) {
      await prisma.adPlacement.create({
        data: {
          campaignId: campaign.id,
          platform: 'TELEGRAM',
          trackingCode: `${prefix}-tc-${next()}`,
          signupBonusType,
          signupBonus: { tariffPlanId: X, tariffDurationDays: 14 },
          status,
        },
      });
    }

    // referralGift: 1 and referralEligibility: 1 (the other listed id is dead).
    await prisma.settings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        referralSettings: { eligiblePlanIds: [X, `${prefix}-long-gone`], pointsExchange: { giftSubscription: { giftPlanId: X } } },
      },
      update: {
        referralSettings: { eligiblePlanIds: [X, `${prefix}-long-gone`], pointsExchange: { giftSubscription: { giftPlanId: X } } },
      },
    });

    // transitions: 2 plans name it.
    await createPlan('guard-upgrader', { upgradeToPlanIds: [X] });
    await createPlan('guard-replacer', { replacementPlanIds: [X] });

    assert.deepEqual(await guard.listReferences(X), [
      { kind: 'subscriptions', count: 2 },
      { kind: 'scheduledTerms', count: 1 },
      { kind: 'unsettledPayments', count: 2 },
      { kind: 'recentCheckouts', count: 2 },
      { kind: 'renewalItems', count: 2 },
      { kind: 'trialReservations', count: 1 },
      { kind: 'promocodes', count: 2 },
      { kind: 'quests', count: 2 },
      { kind: 'contests', count: 1 },
      { kind: 'wheelSectors', count: 2 },
      { kind: 'addOns', count: 1 },
      { kind: 'adPlacements', count: 1 },
      { kind: 'referralGift', count: 1 },
      { kind: 'referralEligibility', count: 1 },
      { kind: 'transitions', count: 2 },
    ]);
    // And the counts stay per plan: the other plan is used by exactly its own rows.
    assert.deepEqual(await guard.listReferences(O), [
      { kind: 'subscriptions', count: 1 },
      { kind: 'addOns', count: 2 },
    ]);

    // Restored straight away, so no later case inherits a gift or eligibility pin.
    await prisma.settings.update({
      where: { id: 1 },
      data: { referralSettings: (originalReferralSettings ?? {}) as Prisma.InputJsonValue },
    });
  });

  it('removes a plan nothing uses, with its durations and prices', async () => {
    // Off sale already: an unused plan still on sale is only hidden (next case).
    const plan = await createPlan('unused', { isArchived: true });
    const durations = await prisma.planDuration.findMany({ where: { planId: plan }, select: { id: true } });
    assert.equal(durations.length, 2, 'fixture: two durations');
    assert.equal(await prisma.planPrice.count({ where: { planDurationId: { in: durations.map((d) => d.id) } } }), 3);

    const result = await deletion.deletePlan(plan, CONTEXT());

    assert.deepEqual(result, { deleted: true, removed: true });
    assert.equal(await prisma.plan.findUnique({ where: { id: plan } }), null);
    assert.equal(await prisma.planDuration.count({ where: { planId: plan } }), 0);
    assert.equal(await prisma.planPrice.count({ where: { planDurationId: { in: durations.map((d) => d.id) } } }), 0);
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'plans.deleted', adminUserId: adminId, metadata: { path: ['planId'], equals: plan } },
      select: { metadata: true },
    });
    assert.equal((audit?.metadata as Record<string, unknown> | undefined)?.removed, true);
  });

  it('hides an unused plan that is still on sale, and the nightly sweep removes it', async () => {
    const plan = await createPlan('selling');

    const result = await deletion.deletePlan(plan, CONTEXT());

    // Checkout does not lock the plan row, so an invoice for it may be mid-insert
    // at this very moment; the row stays until nothing can still be using it.
    assert.deepEqual(result, { deleted: true, removed: false });
    const hidden = await prisma.plan.findUniqueOrThrow({
      where: { id: plan },
      select: { deletedAt: true, isActive: true, isArchived: true },
    });
    assert.ok(hidden.deletedAt instanceof Date);
    assert.equal(hidden.isActive, false);
    assert.equal(hidden.isArchived, true);

    const swept = await sweeper.sweep();

    assert.ok(swept.some((p) => p.id === plan && p.wasDeleted), 'the sweep did not remove the hidden unused plan');
    assert.equal(await prisma.plan.findUnique({ where: { id: plan } }), null);
  });

  it('strips the plan from other plans’ transitions, and a transition alone does not keep it', async () => {
    const target = await createPlan('transition-target', { isArchived: true });
    const keep = await createPlan('transition-keep');
    const upgrader = await createPlan('transition-upgrader', { upgradeToPlanIds: [target, keep] });
    const replacer = await createPlan('transition-replacer', { replacementPlanIds: [target] });

    const result = await deletion.deletePlan(target, CONTEXT());

    assert.equal(result.removed, true);
    const rows = await prisma.plan.findMany({
      where: { id: { in: [upgrader, replacer] } },
      select: { id: true, upgradeToPlanIds: true, replacementPlanIds: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.deepEqual(byId.get(upgrader)?.upgradeToPlanIds, [keep]);
    assert.deepEqual(byId.get(replacer)?.replacementPlanIds, []);
  });

  it('hides a plan a payment still needs — and the payment is still fulfilled from it', async () => {
    const plan = await createPlan('paid');
    const user = await createUser('paid');
    const transactionId = await createTransaction(user, {
      status: 'PENDING',
      planSnapshot: { id: plan, selectedDurationDays: 30, availability: 'ALL' },
    });

    const result = await deletion.deletePlan(plan, CONTEXT());

    assert.deepEqual(result, { deleted: true, removed: false });
    const row = await prisma.plan.findUnique({ where: { id: plan }, select: { deletedAt: true, isActive: true, isArchived: true } });
    assert.ok(row !== null, 'the plan a pending invoice needs was removed');
    assert.ok(row.deletedAt instanceof Date);
    assert.equal(row.isActive, false);
    assert.equal(row.isArchived, true);

    // Gone for the operator…
    const listed = await plansAdmin.listPlans();
    assert.equal(listed.some((p) => p.id === plan), false, 'the deleted plan is still listed');
    assert.deepEqual(
      listed.map((p) => p.orderIndex),
      listed.map((_p, index) => index),
      'the visible order has a hole or a duplicate',
    );
    await assert.rejects(() => deletion.getReferences(plan), NotFoundException);
    await assert.rejects(() => deletion.deletePlan(plan, CONTEXT()), NotFoundException);

    // …gone for a buyer: not in the catalogue, not quotable.
    const catalog = new PlanCatalogService(prisma, new PricingService(), {
      loadConfig: async () => ({ enabled: false, percent: 0, defaultCurrency: 'RUB' }),
    } as never);
    assert.equal((await catalog.getCatalogPlans({ channel: PurchaseChannel.WEB })).some((p) => p.id === plan), false);
    const quote = await new SubscriptionQuoteService(prisma, catalog, new PricingService()).getQuote({
      userId: user,
      purchaseType: PurchaseType.NEW,
      planId: plan,
      durationDays: 30,
      channel: PurchaseChannel.WEB,
    });
    assert.equal(quote.isEligible, false);
    assert.ok(quote.warnings.some((warning) => warning.code === 'PLAN_NOT_AVAILABLE'));

    // …and still there for the money already taken: fulfilment resolves it by id.
    const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    const fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await fulfilment.applyCompletedTransaction(transaction);

    const settled = await prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      select: { status: true, fulfilledAt: true, subscriptionId: true },
    });
    assert.equal(settled.status, 'COMPLETED');
    assert.ok(settled.fulfilledAt instanceof Date, 'the paid invoice was not fulfilled');
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { id: settled.subscriptionId ?? '' },
      select: { planSnapshot: true },
    });
    assert.equal((subscription.planSnapshot as Record<string, unknown>).id, plan);
  });

  it('asks the subscriber to choose when renewing onto a deleted or missing plan', async () => {
    const hidden = await createPlan('renew-hidden');
    const live = await createPlan('renew-live');
    const user = await createUser('renew');
    const onHidden = await createSubscription(user, { id: hidden, selectedDurationDays: 30 });
    const onMissing = await createSubscription(user, { id: `${prefix}-never-existed`, selectedDurationDays: 30 });
    const onLive = await createSubscription(user, { id: live, selectedDurationDays: 30 });
    // Referenced by that subscription, so the delete hides it rather than removing it.
    assert.equal((await deletion.deletePlan(hidden, CONTEXT())).removed, false);

    const catalog = new PlanCatalogService(prisma, new PricingService(), {
      loadConfig: async () => ({ enabled: false, percent: 0, defaultCurrency: 'RUB' }),
    } as never);
    const renewal = new SubscriptionRenewalService(
      prisma,
      new SubscriptionQuoteService(prisma, catalog, new PricingService()),
      {} as never,
    );

    assert.equal(await renewal.requiresPlanSelection(onHidden), true);
    assert.equal(await renewal.requiresPlanSelection(onMissing), true);
    assert.equal(await renewal.requiresPlanSelection(onLive), false);

    const options = await renewal.getRenewalOptions({ identity: { userId: user }, subscriptionIds: [onHidden, onMissing] });
    for (const item of options.items) {
      assert.equal(item.requiresPlanSelection, true, `${item.subscriptionId} was not asked to choose`);
      assert.equal(item.planId, null, `${item.subscriptionId} was renewed onto ${String(item.planId)} unasked`);
      assert.equal(item.renewable, true, 'the active catalogue was not offered to choose from');
    }

    const chosen = await renewal.getRenewalOptions({
      identity: { userId: user },
      subscriptionIds: [onHidden],
      plans: new Map([[onHidden, live]]),
    });
    assert.equal(chosen.items[0]?.planId, live);
  });

  it('keeps granting a deleted plan from the grant paths that promise it', async () => {
    const plan = await createPlan('grants');
    const quest = await prisma.quest.create({ data: { type: 'CUSTOM', rewardType: 'DAYS', rewardPlanId: plan }, select: { id: true } });
    created.quests.push(quest.id);
    assert.equal((await deletion.deletePlan(plan, CONTEXT())).removed, false);

    const planOf = async (userId: string): Promise<unknown> => {
      const subscription = await prisma.subscription.findFirst({ where: { userId }, select: { planSnapshot: true } });
      return (subscription?.planSnapshot as Record<string, unknown> | undefined)?.id;
    };
    const mutations = new SubscriptionMutationsService(prisma, { enqueue: async () => undefined } as never);

    // A quest's DAYS → GRANT_TRIAL fallback, and any admin-free trial grant.
    const trialUser = await createUser('grant-trial');
    await mutations.grantTrial({ userId: trialUser, planId: plan, durationDays: 7 });
    assert.equal(await planOf(trialUser), plan);

    // A quest / wheel / contest subscription code.
    const codeUser = await createUser('grant-code');
    const minted = await prisma.$transaction((tx) =>
      new RewardGrantService(new PointsWalletService()).apply(tx, {
        userId: codeUser,
        grant: { kind: 'PROMOCODE', amount: 30, planId: plan },
        origin: { pointsSource: 'QUEST_REWARD', referenceKey: `${prefix}-quest`, details: {}, codePrefix: 'QUEST-' },
      }),
    );
    assert.ok(minted.promoCode !== undefined);
    created.mintedCodes.push(minted.promoCode);
    const code = await prisma.promocode.findUniqueOrThrow({ where: { code: minted.promoCode }, select: { plan: true } });
    assert.equal((code.plan as Record<string, unknown>).id, plan);

    // An ad placement's TARIFF signup bonus.
    const adUser = await createUser('grant-ad');
    await new AdSignupBonusService(prisma, mutations).grantIfEligible({
      userId: adUser,
      bonusType: 'TARIFF',
      bonusJson: { tariffPlanId: plan, tariffDurationDays: 14 },
    });
    assert.equal(await planOf(adUser), plan, 'the ad bonus skipped a deleted plan it grants');
    const stamped = await prisma.plan.findUniqueOrThrow({ where: { id: plan }, select: { deletedWhileOnSale: true } });
    assert.equal(stamped.deletedWhileOnSale, true, 'a plan deleted on sale was not recorded as such');
  });

  it('does not resume an ad bonus an archived plan had stopped, once that plan is deleted', async () => {
    const plan = await createPlan('grants-archived', { isArchived: true });
    const quest = await prisma.quest.create({ data: { type: 'CUSTOM', rewardType: 'DAYS', rewardPlanId: plan }, select: { id: true } });
    created.quests.push(quest.id);
    assert.equal((await deletion.deletePlan(plan, CONTEXT())).removed, false);
    const stamped = await prisma.plan.findUniqueOrThrow({ where: { id: plan }, select: { deletedWhileOnSale: true } });
    assert.equal(stamped.deletedWhileOnSale, false);

    const adUser = await createUser('grant-ad-archived');
    await new AdSignupBonusService(prisma, new SubscriptionMutationsService(prisma, { enqueue: async () => undefined } as never)).grantIfEligible({
      userId: adUser,
      bonusType: 'TARIFF',
      bonusJson: { tariffPlanId: plan, tariffDurationDays: 14 },
    });

    assert.equal(
      await prisma.subscription.count({ where: { userId: adUser } }),
      0,
      'deleting an archived plan turned its stopped signup bonus back on',
    );
  });

  it('lets an off-sale plan an active placement names go, and keeps one deleted on sale while the placement grants it', async () => {
    const campaign = await prisma.adCampaign.create({ data: { name: `${prefix} placement-hold` }, select: { id: true } });
    created.campaigns.push(campaign.id);
    const placementOn = async (planId: string): Promise<string> => {
      const row = await prisma.adPlacement.create({
        data: {
          campaignId: campaign.id,
          platform: 'TELEGRAM',
          trackingCode: `${prefix}-tc-${next()}`,
          signupBonusType: 'TARIFF',
          signupBonus: { tariffPlanId: planId, tariffDurationDays: 14 },
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      return row.id;
    };

    // Archived: its bonus has stopped, so the placement holds nothing — the
    // dialog lists nothing and the row goes for good.
    const archived = await createPlan('placement-archived', { isArchived: true });
    await placementOn(archived);
    assert.deepEqual(await guard.listReferences(archived), []);
    assert.deepEqual(await deletion.deletePlan(archived, CONTEXT()), { deleted: true, removed: true });

    // On sale: the placement still pays it out after the delete, so it keeps the
    // row — until the placement is archived.
    const selling = await createPlan('placement-selling');
    const sellingPlacement = await placementOn(selling);
    assert.deepEqual(await guard.listReferences(selling), [{ kind: 'adPlacements', count: 1 }]);
    assert.equal((await deletion.deletePlan(selling, CONTEXT())).removed, false);
    await sweeper.sweep();
    assert.ok((await prisma.plan.findUnique({ where: { id: selling } })) !== null, 'swept while its placement still granted it');

    await prisma.adPlacement.update({ where: { id: sellingPlacement }, data: { status: 'ARCHIVED' } });
    const removed = await sweeper.sweep();
    assert.ok(removed.some((plan) => plan.id === selling), 'the plan outlived the placement that held it');
  });

  it('refuses an edit that was validating while the plan was deleted, and leaves it off sale', async () => {
    const plan = await createPlan('race-validating', { internalSquads: ['squad-core'] });
    let markAsked!: () => void;
    const asked = new Promise<void>((resolve) => (markAsked = resolve));
    let release!: () => void;
    const remnawave = {
      getInternalSquadOptions: () =>
        new Promise((resolve) => {
          release = () => resolve([{ uuid: 'squad-core', name: 'Core' }]);
          markAsked();
        }),
      getExternalSquadOptions: async () => [],
    };
    const slowEditor = new PlansAdminService(
      prisma,
      remnawave as never,
      { syncPlanSnapshotMetadata: async () => 0 } as never,
      new PlansAdminValidators(prisma, remnawave as never),
      new PlanSquadPropagationService(prisma, { enqueue: async () => undefined } as never),
    );

    const editing = slowEditor.updatePlan(plan, { isActive: true, description: 'edited while deleting' }, CONTEXT());
    await asked;
    assert.equal((await deletion.deletePlan(plan, CONTEXT())).removed, false);
    release();

    await assert.rejects(editing, NotFoundException);
    const row = await prisma.plan.findUniqueOrThrow({
      where: { id: plan },
      select: { deletedAt: true, isActive: true, isArchived: true, description: true },
    });
    assert.ok(row.deletedAt instanceof Date);
    assert.equal(row.isActive, false, 'the deleted plan was put back on sale');
    assert.equal(row.isArchived, true);
    assert.notEqual(row.description, 'edited while deleting');
  });

  it('queues an edit behind a delete that holds the row, on two connections, and refuses it once the delete commits', async () => {
    const plan = await createPlan('race-locked');
    let markCounting!: () => void;
    const counting = new Promise<void>((resolve) => (markCounting = resolve));
    let releaseCount!: () => void;
    const countGate = new Promise<void>((resolve) => (releaseCount = resolve));
    // The real guard, entered only once the test lets it: the delete has taken
    // `FOR UPDATE` on the plan and stripped transitions by then, and holds both
    // until it commits.
    const heldGuard = {
      countReferences: async (...args: Parameters<PlanReferenceGuardService['countReferences']>) => {
        markCounting();
        await countGate;
        return guard.countReferences(...args);
      },
    } as unknown as PlanReferenceGuardService;

    const deleting = new PlanDeletionService(prisma, heldGuard).deletePlan(plan, CONTEXT());
    await counting;
    const editing = plansAdmin.updatePlan(plan, { isActive: true, description: 'edited while deleting' }, CONTEXT());
    // Long enough for the edit to reach its own lock and wait on the delete's.
    await new Promise((resolve) => setTimeout(resolve, 500));
    releaseCount();

    assert.equal((await deleting).removed, false);
    await assert.rejects(editing, NotFoundException);
    const row = await prisma.plan.findUniqueOrThrow({
      where: { id: plan },
      select: { deletedAt: true, isActive: true, isArchived: true, description: true },
    });
    assert.ok(row.deletedAt instanceof Date);
    assert.equal(row.isActive, false, 'the queued edit put the deleted plan back on sale');
    assert.equal(row.isArchived, true);
    assert.notEqual(row.description, 'edited while deleting');
  });

  it('reports an archived plan the delete leaves with no replacement on sale, and keeps nothing for it', async () => {
    const target = await createPlan('orphan-target');
    const other = await createPlan('orphan-other');
    await createPlan('orphan-legacy', {
      isActive: false,
      isArchived: true,
      archivedRenewMode: 'REPLACE_ON_RENEW',
      replacementPlanIds: [target],
    });
    await createPlan('orphan-covered', {
      isActive: false,
      isArchived: true,
      archivedRenewMode: 'REPLACE_ON_RENEW',
      replacementPlanIds: [target, other],
    });

    assert.deepEqual(await guard.listReferences(target), [
      { kind: 'transitions', count: 2 },
      { kind: 'replacementOrphans', count: 1 },
    ]);
    // The delete strips the replacement lists first, so nothing is left to hold
    // the plan; it is hidden only because it was on sale.
    const result = await deletion.deletePlan(target, CONTEXT());
    assert.deepEqual(result, { deleted: true, removed: false });
  });

  it('lets a new plan take a deleted plan’s name, renaming the hidden one', async () => {
    const hidden = await createPlan('reuse');
    const name = `${prefix} reuse`;
    const quest = await prisma.quest.create({ data: { type: 'CUSTOM', rewardType: 'DAYS', rewardPlanId: hidden }, select: { id: true } });
    created.quests.push(quest.id);
    assert.equal((await deletion.deletePlan(hidden, CONTEXT())).removed, false);

    const fresh = await plansAdmin.createPlan(
      {
        name,
        type: 'BOTH',
        availability: 'ALL',
        deviceLimit: 1,
        durations: [{ days: 30, prices: [{ currency: 'RUB', price: '199' }] }],
      },
      CONTEXT(),
    );
    created.plans.push(fresh.id);

    assert.equal(fresh.name, name);
    const renamed = await prisma.plan.findUniqueOrThrow({ where: { id: hidden }, select: { name: true, deletedAt: true } });
    assert.notEqual(renamed.name, name);
    assert.match(renamed.name, /\(deleted [a-z0-9-]+\)$/);
    assert.ok(renamed.deletedAt instanceof Date, 'the rename touched something other than the hidden plan');

    // The hidden plan is still given away — and under the name it was given as.
    const codeUser = await createUser('reuse-code');
    const minted = await prisma.$transaction((tx) =>
      new RewardGrantService(new PointsWalletService()).apply(tx, {
        userId: codeUser,
        grant: { kind: 'PROMOCODE', amount: 30, planId: hidden },
        origin: { pointsSource: 'QUEST_REWARD', referenceKey: `${prefix}-reuse-quest`, details: {}, codePrefix: 'QUEST-' },
      }),
    );
    assert.ok(minted.promoCode !== undefined);
    created.mintedCodes.push(minted.promoCode);
    const code = await prisma.promocode.findUniqueOrThrow({ where: { code: minted.promoCode }, select: { plan: true } });
    assert.equal((code.plan as Record<string, unknown>).name, name, 'the code carries the "(deleted …)" name');
  });

  it('sweeps a deleted plan the night after its last use ends, and not before', async () => {
    const plan = await createPlan('sweep');
    const quest = await prisma.quest.create({ data: { type: 'CUSTOM', rewardType: 'PROMOCODE', rewardPlanId: plan }, select: { id: true } });
    created.quests.push(quest.id);
    assert.equal((await deletion.deletePlan(plan, CONTEXT())).removed, false);

    await sweeper.sweep();
    assert.ok((await prisma.plan.findUnique({ where: { id: plan } })) !== null, 'swept while a quest still gave it away');

    await prisma.quest.delete({ where: { id: quest.id } });
    const removed = await sweeper.sweep();

    assert.ok(removed.some((p) => p.id === plan && p.wasDeleted), 'the sweep did not report the deleted plan');
    assert.equal(await prisma.plan.findUnique({ where: { id: plan } }), null);
    assert.equal(await prisma.planDuration.count({ where: { planId: plan } }), 0);
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'plans.deleted', adminUserId: null, metadata: { path: ['planId'], equals: plan } },
      select: { metadata: true },
    });
    assert.equal((audit?.metadata as Record<string, unknown> | undefined)?.reason, 'deleted-plan-sweep');
  });
});
