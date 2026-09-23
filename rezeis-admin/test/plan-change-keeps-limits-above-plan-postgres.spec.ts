import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AddOnType, Prisma, PurchaseChannel, PurchaseType } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';

/**
 * A plan change keeps what the subscription held ABOVE its old plan, on
 * PostgreSQL, through the real fulfilment, the real Users-page route, the real
 * quote and the real profile sync — whose `updateUser` body is what the panel
 * would have received.
 *
 * The defect: with the durable add-on model off (the shipped default) a paid
 * add-on is only a raw increment on the limit columns, and an UPGRADE wrote the
 * new plan's values over them. A customer who had paid for "+2 devices until
 * the end of the term" lost them the moment they paid for the upgrade, and the
 * push took them off the panel too. Nobody was told.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `pck-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 * 1024 * 1024;
const DURABLE_FLAGS = ['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'] as const;

let prisma: PrismaService;
let fulfilment: PaymentSubscriptionMutationService;
let cutover: EntitlementCutoverService;
let quotes: SubscriptionQuoteService;
let editor: AdminUserSubscriptionsController;
const created = { plans: [] as string[], users: [] as string[], addOns: [] as string[], admins: [] as string[] };
let counter = 0;
const next = (): number => ++counter;

interface Limits {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
}

async function createPlan(limits: Limits, upgradeToPlanIds: readonly string[] = []): Promise<string> {
  const id = `${prefix}-plan-${next()}`;
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 400_000 + next(),
      trafficLimit: limits.trafficLimit,
      deviceLimit: limits.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      trafficLimitStrategy: 'NO_RESET',
      upgradeToPlanIds: [...upgradeToPlanIds],
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
    },
  });
  created.plans.push(id);
  return id;
}

/** Plan A (100 GB, 3 devices) that upgrades to plan B (500 GB, 5 devices). */
async function createPlans(target: Limits = { trafficLimit: 500, deviceLimit: 5 }): Promise<{ a: string; b: string }> {
  const b = await createPlan(target);
  const a = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, [b]);
  return { a, b };
}

/**
 * A subscription on `planId` whose snapshot records the plan's own limits —
 * the shape every snapshot writer produces — and whose COLUMNS are `columns`.
 */
async function createSubscription(input: {
  readonly planId: string;
  readonly plan: Limits;
  readonly columns?: Limits;
  readonly isTrial?: boolean;
}): Promise<{ userId: string; subscriptionId: string }> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  created.users.push(userId);
  const panelId = 700_000 + next();
  const columns = input.columns ?? input.plan;
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: 'ACTIVE',
      isTrial: input.isTrial ?? false,
      planSnapshot: {
        id: input.planId,
        name: input.planId,
        trafficLimit: input.plan.trafficLimit,
        deviceLimit: input.plan.deviceLimit,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
      } as Prisma.InputJsonValue,
      trafficLimit: columns.trafficLimit,
      deviceLimit: columns.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: new Date(Date.now() - 10 * DAY_MS),
      startedAt: new Date(Date.now() - 10 * DAY_MS),
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
    },
    select: { id: true },
  });
  return { userId, subscriptionId: subscription.id };
}

/** A paid «until the end of the term» add-on, fulfilled the way the webhook does it. */
async function buyAddOn(owner: { userId: string; subscriptionId: string }, type: AddOnType, value: number): Promise<void> {
  const addOnId = `${prefix}-addon-${next()}`;
  await prisma.addOn.create({ data: { id: addOnId, name: addOnId, type, value, lifetime: 'UNTIL_SUBSCRIPTION_END' } });
  created.addOns.push(addOnId);
  const transaction = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
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
        addOnType: type,
        addOnValue: value,
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
  await fulfilment.applyCompletedTransaction(transaction);
}

async function pay(
  owner: { userId: string; subscriptionId: string },
  purchaseType: 'UPGRADE' | 'RENEW',
  planId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const transaction = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType,
      channel: 'WEB',
      gatewayType: 'PLATEGA',
      currency: 'RUB',
      amount: new Prisma.Decimal('299'),
      planSnapshot: { id: planId, selectedDurationDays: 30, ...extra } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(transaction);
}

async function columns(subscriptionId: string): Promise<Limits & { readonly isTrial: boolean; readonly snapshot: Limits }> {
  const row = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: { trafficLimit: true, deviceLimit: true, isTrial: true, planSnapshot: true },
  });
  const snapshot = row.planSnapshot as unknown as Limits;
  return {
    trafficLimit: row.trafficLimit,
    deviceLimit: row.deviceLimit,
    isTrial: row.isTrial,
    snapshot: { trafficLimit: snapshot.trafficLimit, deviceLimit: snapshot.deviceLimit },
  };
}

/**
 * Runs the subscription's newest PENDING sync job through the real processor
 * and returns the `updateUser` body the panel would have received.
 */
async function push(subscriptionId: string): Promise<Record<string, unknown>> {
  const job = await prisma.profileSyncJob.findFirstOrThrow({
    where: { subscriptionId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: { remnawavePanelId: true },
  });
  const panelId = subscription.remnawavePanelId!;
  const sent: Array<Record<string, unknown>> = [];
  const profile = { id: panelId, username: `${prefix}-profile-${panelId}`, subscriptionUrl: `https://sub.example/${panelId}` };
  const processor = new ProfileSyncProcessor(
    prisma,
    {
      updateUser: async (body: Record<string, unknown>) => {
        sent.push(body);
        return { kind: 'ok' as const, data: { response: profile } };
      },
      getUserById: async () => ({ kind: 'ok' as const, data: { response: profile } }),
    } as never,
    {
      generateProfileName: async () => ({ username: profile.username, description: 'plan change' }),
      getContactInfo: async () => ({ email: null, telegramId: null }),
    } as never,
    { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
  );
  await processor.process({ data: { syncJobId: job.id } } as never);
  assert.equal(sent.length, 1, 'the job pushed the profile exactly once');
  return sent[0]!;
}

async function withDurableModel<T>(body: () => Promise<T>): Promise<T> {
  const previous = DURABLE_FLAGS.map((flag) => [flag, process.env[flag]] as const);
  for (const flag of DURABLE_FLAGS) process.env[flag] = 'true';
  try {
    return await body();
  } finally {
    for (const [flag, value] of previous) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
  }
}

run('a plan change keeps what the subscription held above its old plan (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    for (const flag of DURABLE_FLAGS) delete process.env[flag];
    prisma = new PrismaService();
    await prisma.$connect();
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    const terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      new AddOnEntitlementService(),
      projection,
      terms,
      {} as never,
    );
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    const catalog = new PlanCatalogService(prisma, new PricingService(), {
      loadConfig: async () => ({ enabled: false, percent: 0, defaultCurrency: 'RUB' }),
    } as never);
    quotes = new SubscriptionQuoteService(prisma, catalog, new PricingService());
    editor = new AdminUserSubscriptionsController(
      prisma,
      {} as never,
      { enqueue: async () => undefined } as never,
      events as never,
      {} as never,
      {} as never,
    );
  });

  after(async () => {
    if (prisma === undefined) return;
    // Best effort: entitlement events are an append-only ledger, and a row
    // left behind by a failed run must not fail the next one.
    const users = { in: created.users };
    const steps: Array<() => Promise<unknown>> = [
      () => prisma.adminAuditLog.deleteMany({ where: { adminUserId: { in: created.admins } } }),
      () => prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } }),
      () => prisma.addOnEntitlementEvent.deleteMany({ where: { entitlement: { subscription: { userId: users } } } }),
      () => prisma.addOnEntitlement.deleteMany({ where: { subscription: { userId: users } } }),
      () => prisma.subscriptionEffectiveProjection.deleteMany({ where: { subscription: { userId: users } } }),
      () => prisma.profileSyncJob.deleteMany({ where: { subscription: { userId: users } } }),
      () => prisma.subscriptionTerm.deleteMany({ where: { subscription: { userId: users } } }),
      () => prisma.transaction.deleteMany({ where: { userId: users } }),
      () => prisma.subscription.deleteMany({ where: { userId: users } }),
      () => prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } }),
      () => prisma.plan.deleteMany({ where: { id: { in: created.plans } } }),
      () => prisma.user.deleteMany({ where: { id: users } }),
    ];
    for (const step of steps) await step().catch(() => undefined);
    await prisma.$disconnect();
  });

  it('a paid upgrade carries a bought add-on onto the new plan, and the push carries it too', async () => {
    const plans = await createPlans();
    const owner = await createSubscription({ planId: plans.a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);
    await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 50);
    const before = await columns(owner.subscriptionId);
    // Self-check: with the durable model off the add-on is a raw increment.
    assert.deepEqual([before.trafficLimit, before.deviceLimit], [150, 5]);
    assert.equal(await prisma.addOnEntitlement.count({ where: { subscriptionId: owner.subscriptionId } }), 0);

    await pay(owner, 'UPGRADE', plans.b);

    const after = await columns(owner.subscriptionId);
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [550, 7], 'the new plan plus what was bought');
    // The snapshot is the new plan's OWN values, so the carried part keeps
    // reading as the subscription's own on the next renewal or plan change.
    assert.deepEqual(after.snapshot, { trafficLimit: 500, deviceLimit: 5 });
    const body = await push(owner.subscriptionId);
    assert.equal(body.hwidDeviceLimit, 7);
    assert.equal(body.trafficLimitBytes, 550 * GIB);
  });

  it('a trial conversion carries the add-on bought during the trial', async () => {
    const target = await createPlan({ trafficLimit: 500, deviceLimit: 5 });
    const trialPlan = await createPlan({ trafficLimit: 10, deviceLimit: 1 }, [target]);
    const owner = await createSubscription({
      planId: trialPlan,
      plan: { trafficLimit: 10, deviceLimit: 1 },
      isTrial: true,
    });
    await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);

    await pay(owner, 'UPGRADE', target, { convertsTrial: true });

    const after = await columns(owner.subscriptionId);
    assert.equal(after.isTrial, false, 'the trial was converted');
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [500, 7]);
    const body = await push(owner.subscriptionId);
    assert.equal(body.hwidDeviceLimit, 7);
  });

  it('an unlimited target plan stays unlimited: nothing is added to it', async () => {
    const plans = await createPlans({ trafficLimit: null, deviceLimit: -1 });
    const owner = await createSubscription({ planId: plans.a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);
    await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 50);
    const quote = await quoteUpgrade(owner, plans.b);
    assert.equal(quote.carriedAbovePlan, null, 'no line promises «+2» on top of unlimited');

    await pay(owner, 'UPGRADE', plans.b);

    const after = await columns(owner.subscriptionId);
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [null, -1]);
    const body = await push(owner.subscriptionId);
    assert.equal(body.hwidDeviceLimit, 0, 'unlimited on the wire');
    assert.equal(body.trafficLimitBytes, 0, 'unlimited on the wire');
  });

  it('a limit lowered below the old plan does not carry', async () => {
    const plans = await createPlans();
    const owner = await createSubscription({
      planId: plans.a,
      plan: { trafficLimit: 100, deviceLimit: 3 },
      columns: { trafficLimit: 60, deviceLimit: 2 },
    });

    await pay(owner, 'UPGRADE', plans.b);

    const after = await columns(owner.subscriptionId);
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [500, 5], 'the new plan, not the new plan minus');
  });

  it("an operator's unlimited setting over a finite plan stays unlimited, as a renewal leaves it", async () => {
    const plans = await createPlans();
    const owner = await createSubscription({
      planId: plans.a,
      plan: { trafficLimit: 100, deviceLimit: 3 },
      columns: { trafficLimit: null, deviceLimit: 0 },
    });
    const quote = await quoteUpgrade(owner, plans.b);
    assert.deepEqual(quote.carriedAbovePlan, {
      deviceLimit: 0,
      trafficLimitGb: 0,
      unlimitedDevices: true,
      unlimitedTraffic: true,
    });

    await pay(owner, 'UPGRADE', plans.b);

    const after = await columns(owner.subscriptionId);
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [null, 0]);
  });

  it('a renewal is unchanged: it already left what is above the plan alone', async () => {
    const plans = await createPlans();
    const owner = await createSubscription({ planId: plans.a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);

    await pay(owner, 'RENEW', plans.a);

    const after = await columns(owner.subscriptionId);
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [100, 5]);
    assert.deepEqual(after.snapshot, { trafficLimit: 100, deviceLimit: 3 });
  });

  it('the operator assigning a plan on the Users page carries it the same way, audit and push included', async () => {
    const plans = await createPlans();
    const owner = await createSubscription({ planId: plans.a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);
    await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 50);
    const admin = await prisma.adminUser.create({
      data: { login: `${prefix}-admin`, loginNormalized: `${prefix}-admin`, passwordHash: 'not-a-hash' },
    });
    created.admins.push(admin.id);

    await editor.updateSubscription(
      owner.subscriptionId,
      { planId: plans.b },
      { id: admin.id } as never,
      { headers: {}, ip: '10.0.0.7', socket: { remoteAddress: null } } as never,
    );

    const after = await columns(owner.subscriptionId);
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [550, 7]);
    assert.deepEqual(after.snapshot, { trafficLimit: 500, deviceLimit: 5 });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { adminUserId: admin.id } });
    const changes = (audit.metadata as { changes: Record<string, unknown> }).changes;
    assert.deepEqual(changes.trafficLimit, { from: 150, to: 550 }, 'the audit describes what reached the row');
    assert.deepEqual(changes.deviceLimit, { from: 5, to: 7 });
    const body = await push(owner.subscriptionId);
    assert.equal(body.hwidDeviceLimit, 7);
    assert.equal(body.trafficLimitBytes, 550 * GIB);
  });

  it('the upgrade quote names what carries before the customer pays', async () => {
    const plans = await createPlans();
    const owner = await createSubscription({ planId: plans.a, plan: { trafficLimit: 100, deviceLimit: 3 } });
    await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);
    await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 50);

    const quote = await quoteUpgrade(owner, plans.b);

    assert.ok(quote.warnings.some((warning) => warning.code === 'UPGRADE_RESETS_EXPIRY'));
    assert.deepEqual(quote.carriedAbovePlan, {
      deviceLimit: 2,
      trafficLimitGb: 50,
      unlimitedDevices: false,
      unlimitedTraffic: false,
    });
  });

  it('with a durable term the add-on is carried once, by its entitlement — never twice', async () => {
    await withDurableModel(async () => {
      const plans = await createPlans();
      const owner = await createSubscription({ planId: plans.a, plan: { trafficLimit: 100, deviceLimit: 3 } });
      await prisma.$transaction((tx) => cutover.cutoverSubscriptionInTransaction(tx, { id: owner.subscriptionId } as never));
      await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);
      await buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 50);
      assert.equal(
        await prisma.addOnEntitlement.count({ where: { subscriptionId: owner.subscriptionId, state: 'ACTIVE' } }),
        2,
        'the add-ons were recorded as entitlements, not as a raw increment',
      );
      const quote = await quoteUpgrade(owner, plans.b);
      assert.equal(quote.carriedAbovePlan, null, 'the durable model promises nothing it does not deliver');

      await pay(owner, 'UPGRADE', plans.b);

      const after = await columns(owner.subscriptionId);
      assert.deepEqual([after.trafficLimit, after.deviceLimit], [550, 7], 'carried once — 600 / 9 would be twice');
      const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
        where: { subscriptionId: owner.subscriptionId },
      });
      assert.equal(projection.desiredDeviceLimit, 7);
      assert.equal(projection.desiredTrafficLimitBytes, 550n * BigInt(GIB));
      const job = await prisma.profileSyncJob.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });
      assert.equal(job.cause, 'PLAN_CHANGE', 'the projection branch ran, not the column carry');
      const body = await push(owner.subscriptionId);
      assert.equal(body.hwidDeviceLimit, 7);
      assert.equal(body.trafficLimitBytes, 550 * GIB);
    });
  });
});

async function quoteUpgrade(owner: { userId: string; subscriptionId: string }, planId: string) {
  return quotes.getQuote({
    userId: owner.userId,
    purchaseType: PurchaseType.UPGRADE,
    planId,
    durationDays: 30,
    subscriptionId: owner.subscriptionId,
    channel: PurchaseChannel.WEB,
  });
}
