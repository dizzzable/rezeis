import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  SubscriptionTermStatus,
  type Transaction,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';
import { buildPlanSnapshot } from '../src/modules/users/utils/plan-snapshot.util';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * THE PAYMENT PATHS IN THE DURABLE ADD-ON MODEL, on PostgreSQL,
 * through the real fulfilment, the real term and projection services, the
 * real boundary sweep and the real quote — every case with the rollout flags
 * OFF (what ships today must not change) and ON.
 *
 *  1. A purchase creates its subscription IN the model (stage 1).
 *  2. A LIMITED subscription's add-on is ledgered, and a marker drafted by
 *     the previous checkout is ledgered with the v2 defaults.
 *  3. The ledger brings a subscription into the model and aligns a drifted
 *     term before it reads its window.
 *  4. Renewal, combined renewal and upgrade follow the term ROW, not the
 *     flag.
 *  5. A lifetime subscription's renewal changes nothing in the model (the
 *     whole rule: `lifetime-renewal-postgres.spec.ts`).
 *  6. A paid upgrade on the durable path carries what sat above the old plan
 *     (the snapshot and the carry are written BEFORE the recompute).
 *  7. Live add-ons keep their own end across a paid upgrade, clamped to the
 *     new end, re-bound to the new term (owner, 24.09.2026).
 *  8. A queued term carrying a renewal add-on left by the deleted stage 5
 *     is cancelled by an upgrade like any other; the add-on stays inert.
 *  9. A renewal drafted before «Назначить план» keeps the operator's plan.
 * 10. A renewal that buys no day renews nothing.
 * 11. The upgrade quote tells what carries and which add-ons stay, until when.
 * 12. A renewal aligns the tail with the expiry before it appends.
 *
 * Every instant is anchored to now. Skipped without TEST_DATABASE_URL; list it
 * in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `d3pay-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const GIB = 1024n * 1024n * 1024n;
const FLAGS = {
  shadow: 'ADDON_ENTITLEMENT_SHADOW',
  direct: 'ADDON_ENTITLEMENT_DIRECT_PURCHASE',
} as const;

interface Emitted {
  readonly severity: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

interface Limits {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
}

interface Owner {
  readonly userId: string;
  readonly subscriptionId: string;
}

let prisma: PrismaService;
let fulfilment: PaymentSubscriptionMutationService;
let cutover: EntitlementCutoverService;
let terms: SubscriptionTermService;
let projection: EffectiveProjectionService;
let boundary: EntitlementBoundaryService;
let quotes: SubscriptionQuoteService;
const emitted: Emitted[] = [];
const created = { plans: [] as string[], users: [] as string[], addOns: [] as string[] };
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

// ── Fixtures ───────────────────────────────────────────────────────────────

async function createPlan(
  limits: Limits,
  options: {
    readonly durations?: ReadonlyArray<{ readonly days: number; readonly currency: 'RUB' | 'USD'; readonly price: string }>;
    readonly upgradeToPlanIds?: readonly string[];
    readonly availability?: 'ALL' | 'TRIAL';
    readonly internalSquads?: readonly string[];
  } = {},
): Promise<string> {
  const id = `${prefix}-plan-${next()}`;
  const durations = options.durations ?? [{ days: 30, currency: 'RUB', price: '299' }];
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 900_000 + next(),
      trafficLimit: limits.trafficLimit,
      deviceLimit: limits.deviceLimit,
      internalSquads: [...(options.internalSquads ?? [])],
      externalSquad: null,
      trafficLimitStrategy: 'NO_RESET',
      availability: options.availability ?? 'ALL',
      upgradeToPlanIds: [...(options.upgradeToPlanIds ?? [])],
      durations: {
        create: durations.map((duration) => ({
          days: duration.days,
          prices: { create: [{ currency: duration.currency, price: duration.price }] },
        })),
      },
    },
  });
  created.plans.push(id);
  return id;
}

async function newUser(): Promise<string> {
  const id = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: id } });
  created.users.push(id);
  return id;
}

/** A subscription on `planId` whose snapshot records the plan's limits and whose COLUMNS are `columns`. */
async function subscriptionOn(
  planId: string,
  plan: Limits,
  options: {
    readonly columns?: Limits;
    readonly userId?: string;
    readonly status?: SubscriptionStatus;
    readonly expiresAt?: Date | null;
    readonly startedAt?: Date;
    readonly squads?: readonly string[];
  } = {},
): Promise<Owner> {
  const userId = options.userId ?? (await newUser());
  const panelId = 830_000 + next();
  const columns = options.columns ?? plan;
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: options.status ?? SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: planId,
        name: planId,
        trafficLimit: plan.trafficLimit,
        deviceLimit: plan.deviceLimit,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [...(options.squads ?? [])],
        externalSquad: null,
        selectedDurationDays: 30,
      } as Prisma.InputJsonValue,
      trafficLimit: columns.trafficLimit,
      deviceLimit: columns.deviceLimit,
      internalSquads: [...(options.squads ?? [])],
      externalSquad: null,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: inDays(-10),
      startedAt: options.startedAt ?? inDays(-10),
      expiresAt: options.expiresAt === undefined ? inDays(20) : options.expiresAt,
    },
    select: { id: true },
  });
  return { userId, subscriptionId: subscription.id };
}

/** Into the term model the way the background cutover brings it: a generation-1 term from its columns. */
async function enter(subscriptionId: string): Promise<void> {
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscriptionId));
  assert.equal(entered.outcome, 'CREATED', 'fixture: entered the model');
}

/** A payment the provider confirmed, fulfilled the way the webhook does it. */
async function pay(
  owner: { readonly userId: string; readonly subscriptionId: string | null },
  purchaseType: PurchaseType,
  planId: string,
  options: {
    readonly amount?: string;
    readonly currency?: 'RUB' | 'USD';
    readonly days?: number;
    readonly createdAt?: Date;
  } = {},
): Promise<Transaction> {
  const row = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType,
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: options.currency ?? 'RUB',
      amount: new Prisma.Decimal(options.amount ?? '299'),
      planSnapshot: { id: planId, selectedDurationDays: options.days ?? 30 } as Prisma.InputJsonValue,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    },
  });
  await fulfilment.applyCompletedTransaction(row);
  return prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
}

/**
 * An add-on bought through the checkout: its catalog row and a paid draft
 * carrying the marker, fulfilled the way the webhook does it. `markerless`
 * drafts it as the v1 checkout did — no `lifetime`, no `sourceLineKey`.
 */
async function buyAddOn(
  owner: Owner,
  type: AddOnType,
  value: number,
  options: { readonly markerless?: boolean } = {},
): Promise<{ readonly transactionId: string; readonly addOnId: string }> {
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
      gatewayType: 'YOOKASSA',
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
        gatewayType: 'YOOKASSA',
        amount: '99',
        currency: 'RUB',
        ...(options.markerless === true
          ? {}
          : { contractVersion: 2, addOnRevision: 1, lifetime: 'UNTIL_SUBSCRIPTION_END', sourceLineKey: addOnId }),
      } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(transaction);
  return { transactionId: transaction.id, addOnId };
}

/** A live add-on row as the ledger leaves it, bound to `termId`. */
async function addOnRow(
  owner: Owner,
  termId: string,
  options: {
    readonly type: AddOnType;
    readonly value: number;
    readonly expiresAt: Date | null;
    readonly state?: AddOnEntitlementState;
    readonly scheduledActivationAt?: Date;
  },
): Promise<string> {
  const payment = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('99'),
      planSnapshot: { snapshotSource: 'ADDON_PURCHASE' } as Prisma.InputJsonValue,
      fulfilledAt: inDays(-2),
    },
  });
  const state = options.state ?? AddOnEntitlementState.ACTIVE;
  const activation = options.scheduledActivationAt ?? inDays(-2);
  const row = await prisma.addOnEntitlement.create({
    data: {
      subscriptionId: owner.subscriptionId,
      termId,
      sourceTransactionId: payment.id,
      sourceLineKey: 'line',
      catalogRevision: 1,
      receiptName: `${options.type} +${options.value}`,
      type: options.type,
      valuePerUnit: options.value,
      totalValue: options.type === AddOnType.EXTRA_TRAFFIC ? BigInt(options.value) * GIB : BigInt(options.value),
      lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
      unitAmount: new Prisma.Decimal('99'),
      totalAmount: new Prisma.Decimal('99'),
      currency: 'RUB',
      purchasedAt: activation,
      scheduledActivationAt: activation,
      activatedAt: state === AddOnEntitlementState.ACTIVE ? activation : null,
      expiresAt: options.expiresAt,
      state,
    },
  });
  return row.id;
}

/** Recomputes the projection over the live add-ons and mirrors it, as the ledger leaves a subscription. */
async function mirror(subscriptionId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const result = await projection.recomputeInTransaction(tx, { subscriptionId, mode: 'ACTIVE' });
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        trafficLimit: result.desiredTrafficLimitBytes === null ? null : Number(result.desiredTrafficLimitBytes / GIB),
        deviceLimit: result.desiredDeviceLimit ?? 0,
      },
    });
  });
}

async function subscriptionOf(subscriptionId: string) {
  return prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
}

async function termsOf(subscriptionId: string) {
  return prisma.subscriptionTerm.findMany({ where: { subscriptionId }, orderBy: { generation: 'asc' } });
}

async function activeTermOf(subscriptionId: string) {
  return prisma.subscriptionTerm.findFirstOrThrow({
    where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), JSON.stringify(value));
  return value as Record<string, unknown>;
}

function eventsOf(type: string, where: (metadata: Record<string, unknown>) => boolean): Emitted[] {
  return emitted.filter((event) => event.type === type && where(event.metadata));
}

async function withFlags<T>(
  flags: { readonly shadow?: boolean; readonly direct?: boolean },
  body: () => Promise<T>,
): Promise<T> {
  const previous = Object.values(FLAGS).map((name) => [name, process.env[name]] as const);
  // A flag not asked for is OFF, spelled out: unset is ON since the
  // 24.09.2026 flip.
  for (const [key, name] of Object.entries(FLAGS)) {
    process.env[name] = flags[key as keyof typeof flags] === true ? 'true' : 'false';
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The subscription's newest PENDING sync job, through the real processor: the body the panel receives. */
async function push(subscriptionId: string): Promise<{ body: Record<string, unknown>; resets: number }> {
  const job = await prisma.profileSyncJob.findFirstOrThrow({
    where: { subscriptionId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  const subscription = await subscriptionOf(subscriptionId);
  const panelId = subscription.remnawavePanelId!;
  const sent: Array<Record<string, unknown>> = [];
  let resets = 0;
  const profile = { id: panelId, username: `${prefix}-profile-${panelId}`, subscriptionUrl: `https://sub.example/${panelId}` };
  const processor = new ProfileSyncProcessor(
    prisma,
    {
      updateUser: async (body: Record<string, unknown>) => {
        sent.push(body);
        return { kind: 'ok' as const, data: { response: profile } };
      },
      getUserById: async () => ({ kind: 'ok' as const, data: { response: profile } }),
      resetTraffic: async () => {
        resets += 1;
        return { kind: 'ok' as const, data: { response: profile } };
      },
    } as never,
    {
      generateProfileName: async () => ({ username: profile.username, description: 'd3' }),
      getContactInfo: async () => ({ email: null, telegramId: null }),
    } as never,
    { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
  );
  await processor.process({ data: { syncJobId: job.id } } as never);
  assert.equal(sent.length, 1, 'the job pushed the profile exactly once');
  return { body: sent[0]!, resets };
}

/** The card an operator reads for `metadata`, through the real formatter. */
async function card(type: string, message: string, metadata: Record<string, unknown>): Promise<string> {
  let text: string | null = null;
  const capture = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') text = (meta['text'] as string | undefined) ?? null;
  };
  const renderer = new SystemEventsService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: { telegram: { enabled: false, chatId: null, devChatId: null } },
          platformPolicy: {},
        }),
      },
      adminAuditLog: { create: async () => ({}) },
    } as never,
    { enabled: false, urls: [] } as never,
    {
      post: () => {
        throw new Error('no Bot API in this spec');
      },
    } as never,
    {
      get: (token: unknown) => {
        if (token === BotNotifierClient) {
          return {
            deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
            },
          };
        }
        if (token === ReiwaRelayQueueService) {
          return {
            enqueue: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return true;
            },
          };
        }
        throw new Error('not registered');
      },
    } as never,
  );
  const savedToken = process.env.BOT_TOKEN;
  delete process.env.BOT_TOKEN;
  try {
    renderer.warn(type, 'PAYMENT', message, metadata);
    for (let attempt = 0; attempt < 40 && text === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    if (savedToken !== undefined) process.env.BOT_TOKEN = savedToken;
  }
  assert.ok(text !== null, 'the card was rendered');
  return text;
}

// ── The spec ───────────────────────────────────────────────────────────────

run('the payment paths in the durable add-on model (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    for (const name of Object.values(FLAGS)) process.env[name] = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    const record =
      (severity: string) =>
      (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
        emitted.push({ severity, type, message, metadata });
      };
    const events = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR'), emit: () => undefined };
    terms = new SubscriptionTermService();
    projection = new EffectiveProjectionService();
    const entitlements = new AddOnEntitlementService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    fulfilment = new PaymentSubscriptionMutationService(prisma, events as never, entitlements, projection, terms, {} as never, cutover);
    boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projection);
    const catalog = new PlanCatalogService(prisma, new PricingService(), {
      loadConfig: async () => ({ enabled: false, percent: 0, defaultCurrency: 'RUB' }),
    } as never);
    quotes = new SubscriptionQuoteService(prisma, catalog, new PricingService());
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = { in: created.users };
    await prisma.trialClaim.deleteMany({ where: { userId: users } }).catch(() => undefined);
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('durable payment paths cleanup failed', error);
    });
    await prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  // ── 1 ─────────────────────────────────────────────────────────────────────

  describe('a paid purchase creates its subscription IN the model (stage 1)', () => {
    it('NEW, ADDITIONAL and a paid trial: one ACTIVE generation-1 term to the expiry, a SHADOW projection equal to the columns — and an add-on bought a minute later is an entitlement ending with the subscription', async () => {
      await withFlags({ shadow: true, direct: true }, async () => {
        const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
        const trialPlan = await createPlan({ trafficLimit: 10, deviceLimit: 1 }, { availability: 'TRIAL' });
        const userId = await newUser();
        const bought = [
          await pay({ userId, subscriptionId: null }, PurchaseType.NEW, plan),
          await pay({ userId, subscriptionId: null }, PurchaseType.ADDITIONAL, plan),
          await pay({ userId: await newUser(), subscriptionId: null }, PurchaseType.NEW, trialPlan, { days: 3 }),
        ];
        for (const payment of bought) {
          const subscription = await subscriptionOf(payment.subscriptionId!);
          const rows = await termsOf(subscription.id);
          assert.deepEqual(rows.map((term) => [term.generation, term.status]), [[1, 'ACTIVE']]);
          assert.equal(rows[0]!.endsAt?.getTime(), subscription.expiresAt?.getTime(), 'the term ends with the subscription');
          const shadow = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
            where: { subscriptionId: subscription.id },
          });
          assert.equal(shadow.state, 'SHADOW');
          assert.equal(shadow.desiredTrafficLimitBytes, BigInt(subscription.trafficLimit!) * GIB);
          assert.equal(shadow.desiredDeviceLimit, subscription.deviceLimit);
        }

        const owner = { userId, subscriptionId: bought[0]!.subscriptionId! };
        await buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2);
        const addOn = await prisma.addOnEntitlement.findFirstOrThrow({ where: { subscriptionId: owner.subscriptionId } });
        assert.equal(addOn.state, 'ACTIVE');
        assert.equal(addOn.expiresAt?.getTime(), (await subscriptionOf(owner.subscriptionId)).expiresAt?.getTime());
        assert.equal((await subscriptionOf(owner.subscriptionId)).deviceLimit, 5);
      });
    });

    it('with every flag off: no term, no projection — and the add-on is the legacy increment, as before', async () => {
      await withFlags({}, async () => {
        const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
        const userId = await newUser();
        const payment = await pay({ userId, subscriptionId: null }, PurchaseType.NEW, plan);
        const subscriptionId = payment.subscriptionId!;
        assert.equal((await termsOf(subscriptionId)).length, 0);
        assert.equal(await prisma.subscriptionEffectiveProjection.count({ where: { subscriptionId } }), 0);

        await buyAddOn({ userId, subscriptionId }, AddOnType.EXTRA_DEVICES, 2);
        assert.equal(await prisma.addOnEntitlement.count({ where: { subscriptionId } }), 0);
        assert.equal((await subscriptionOf(subscriptionId)).deviceLimit, 5);
      });
    });
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────

  describe('an add-on bought by a LIMITED subscription', () => {
    it('is ledgered: an entitlement that ends with the subscription, not a permanent increment', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, { status: SubscriptionStatus.LIMITED });
      await enter(owner.subscriptionId);

      await withFlags({ direct: true }, () => buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 50));

      const addOn = await prisma.addOnEntitlement.findFirstOrThrow({ where: { subscriptionId: owner.subscriptionId } });
      assert.equal(addOn.state, 'ACTIVE');
      assert.equal(addOn.expiresAt?.getTime(), (await subscriptionOf(owner.subscriptionId)).expiresAt?.getTime());
      assert.equal((await subscriptionOf(owner.subscriptionId)).trafficLimit, 150);
    });

    it('with the ledger off is the legacy increment, unchanged', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, { status: SubscriptionStatus.LIMITED });
      await enter(owner.subscriptionId);

      await withFlags({}, () => buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 50));

      assert.equal(await prisma.addOnEntitlement.count({ where: { subscriptionId: owner.subscriptionId } }), 0);
      assert.equal((await subscriptionOf(owner.subscriptionId)).trafficLimit, 150);
    });

    it('drafted by the previous checkout — no lifetime, no line key — is ledgered with the checkout’s own defaults', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });
      await enter(owner.subscriptionId);

      const { addOnId } = await withFlags({ direct: true }, () =>
        buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2, { markerless: true }),
      );

      const addOn = await prisma.addOnEntitlement.findFirstOrThrow({ where: { subscriptionId: owner.subscriptionId } });
      assert.equal(addOn.lifetime, AddOnLifetime.UNTIL_SUBSCRIPTION_END);
      assert.equal(addOn.sourceLineKey, addOnId);
      assert.equal(addOn.expiresAt?.getTime(), (await subscriptionOf(owner.subscriptionId)).expiresAt?.getTime());
    });
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────

  describe('the add-on ledger enters the model and aligns the term first', () => {
    it('brings a subscription the cutover has not reached into the model (stages 1 and 2 on)', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });

      await withFlags({ shadow: true, direct: true }, () => buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2));

      assert.deepEqual((await termsOf(owner.subscriptionId)).map((term) => term.status), ['ACTIVE']);
      assert.equal(await prisma.addOnEntitlement.count({ where: { subscriptionId: owner.subscriptionId } }), 1);
    });

    it('leaves it out with stage 1 off: the legacy increment', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });

      await withFlags({ direct: true }, () => buyAddOn(owner, AddOnType.EXTRA_DEVICES, 2));

      assert.equal((await termsOf(owner.subscriptionId)).length, 0);
      assert.equal(await prisma.addOnEntitlement.count({ where: { subscriptionId: owner.subscriptionId } }), 0);
      assert.equal((await subscriptionOf(owner.subscriptionId)).deviceLimit, 5);
    });

    it('aligns a drifted term — its end already gone, bonus days moved the expiry on — and ledgers to the real end', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, { expiresAt: inDays(-1) });
      await enter(owner.subscriptionId);
      // Bonus days, written the way every such writer writes them: the expiry
      // only. The term still ends a day ago.
      const bonusEnd = inDays(30);
      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: bonusEnd } });
      assert.ok((await activeTermOf(owner.subscriptionId)).endsAt!.getTime() < Date.now(), 'fixture: a stale term');

      await withFlags({ direct: true }, () => buyAddOn(owner, AddOnType.EXTRA_TRAFFIC, 50));

      const addOn = await prisma.addOnEntitlement.findFirstOrThrow({ where: { subscriptionId: owner.subscriptionId } });
      assert.equal(addOn.expiresAt?.getTime(), bonusEnd.getTime(), 'until the subscription’s real end, not permanent');
      assert.equal((await activeTermOf(owner.subscriptionId)).endsAt?.getTime(), bonusEnd.getTime());
    });
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────

  describe('renewal, combined renewal and upgrade follow the term ROW', () => {
    it('a renewal with every flag off still appends its term to a subscription in the model', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });
      await enter(owner.subscriptionId);
      const endsAt = (await activeTermOf(owner.subscriptionId)).endsAt!;

      await withFlags({}, () => pay(owner, PurchaseType.RENEW, plan));

      const rows = await termsOf(owner.subscriptionId);
      assert.deepEqual(rows.map((term) => [term.generation, term.status]), [[1, 'ACTIVE'], [2, 'SCHEDULED']]);
      assert.equal(rows[1]!.startsAt.getTime(), endsAt.getTime());
      assert.equal(rows[1]!.endsAt?.getTime(), (await subscriptionOf(owner.subscriptionId)).expiresAt?.getTime());
    });

    it('a renewal with stage 1 on brings a subscription with no term in, then appends its term', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });

      await withFlags({ shadow: true }, () => pay(owner, PurchaseType.RENEW, plan));

      assert.deepEqual(
        (await termsOf(owner.subscriptionId)).map((term) => [term.generation, term.status]),
        [[1, 'ACTIVE'], [2, 'SCHEDULED']],
      );
    });

    it('a combined renewal with every flag off: the line in the model gets its term, the other stays on the columns', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const inModel = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });
      await enter(inModel.subscriptionId);
      const outside = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, { userId: inModel.userId });
      const parent = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId: inModel.userId,
          subscriptionId: null,
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: new Prisma.Decimal('598'),
          planSnapshot: { combinedRenewal: true, snapshotVersion: 1 } as Prisma.InputJsonValue,
        },
      });
      await prisma.transactionItem.createMany({
        data: [inModel, outside].map((owner) => ({
          transactionId: parent.id,
          subscriptionId: owner.subscriptionId,
          planId: plan,
          planSnapshot: { id: plan, selectedDurationDays: 30 },
          durationDays: 30,
          amount: new Prisma.Decimal('299'),
          currency: 'RUB' as const,
        })),
      });

      await withFlags({}, () => fulfilment.applyCompletedTransaction(parent));

      assert.deepEqual((await termsOf(inModel.subscriptionId)).map((term) => term.status), ['ACTIVE', 'SCHEDULED']);
      assert.equal((await termsOf(outside.subscriptionId)).length, 0);
    });

    it('a combined renewal whose line still carries PAID add-on lines is refused whole: no term, no entitlement, nothing applied', async () => {
      // Sold under the renewal add-ons (stage 5), deleted with their code on
      // 24.09.2026. Renewing the line would take the add-ons' money and deliver
      // none of them, so the payment is not fulfilled at all and the operator
      // refunds by hand. It used to bring the subscription into the model to
      // give the lines a term to live on; now nothing of it is written.
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });
      const addOnId = `${prefix}-addon-${next()}`;
      await prisma.addOn.create({
        data: { id: addOnId, name: addOnId, type: AddOnType.EXTRA_TRAFFIC, value: 50, lifetime: 'UNTIL_SUBSCRIPTION_END' },
      });
      created.addOns.push(addOnId);
      const parent = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId: owner.userId,
          subscriptionId: null,
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: new Prisma.Decimal('398'),
          planSnapshot: { combinedRenewal: true, snapshotVersion: 1 } as Prisma.InputJsonValue,
        },
      });
      await prisma.transactionItem.create({
        data: {
          transactionId: parent.id,
          subscriptionId: owner.subscriptionId,
          planId: plan,
          planSnapshot: { id: plan, selectedDurationDays: 30 },
          durationDays: 30,
          amount: new Prisma.Decimal('398'),
          currency: 'RUB',
          // Sold while the renewal add-ons were on, paid after the upgrade.
          addOnLines: [
            {
              addOnId,
              catalogRevision: 1,
              type: 'EXTRA_TRAFFIC',
              value: 50,
              lifetime: 'UNTIL_SUBSCRIPTION_END',
              activation: 'TERM_START',
              sourceLineKey: `renew:${owner.subscriptionId}:${addOnId}`,
              unitAmount: '99',
              receiptName: 'Extra 50 GB',
            },
          ] as Prisma.InputJsonValue,
        },
      });

      const before = await subscriptionOf(owner.subscriptionId);

      await assert.rejects(
        withFlags({ shadow: true, direct: true }, () => fulfilment.applyCompletedTransaction(parent)),
        /RENEWAL_ADDON_LINES_NOT_SUPPORTED/,
      );

      assert.deepEqual(await termsOf(owner.subscriptionId), [], 'no term was created for it');
      assert.equal(await prisma.addOnEntitlement.count({ where: { sourceTransactionId: parent.id } }), 0);
      const item = await prisma.transactionItem.findFirstOrThrow({ where: { transactionId: parent.id } });
      assert.equal(item.appliedAt, null, 'the line stays unapplied for the operator');
      assert.equal((await subscriptionOf(owner.subscriptionId)).expiresAt?.getTime(), before.expiresAt?.getTime());
    });

    it('an upgrade with every flag off rotates the term onto the new plan, and the next add-on expiry keeps the new plan', async () => {
      const target = await createPlan({ trafficLimit: 500, deviceLimit: 5 });
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, { upgradeToPlanIds: [target] });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });
      await enter(owner.subscriptionId);
      const oldTerm = await activeTermOf(owner.subscriptionId);
      const addOnEnds = inDays(5);
      await addOnRow(owner, oldTerm.id, { type: AddOnType.EXTRA_DEVICES, value: 2, expiresAt: addOnEnds });
      await mirror(owner.subscriptionId);

      await withFlags({}, () => pay(owner, PurchaseType.UPGRADE, target));

      const active = await activeTermOf(owner.subscriptionId);
      assert.notEqual(active.id, oldTerm.id, 'a new term');
      assert.equal(active.baseDeviceLimit, 5);
      assert.equal((await subscriptionOf(owner.subscriptionId)).deviceLimit, 7);
      // The add-on ends: the recompute stands on the NEW plan's base.
      await boundary.expireDueForSubscription(owner.subscriptionId, new Date(addOnEnds.getTime() + 1000));
      assert.equal((await subscriptionOf(owner.subscriptionId)).deviceLimit, 5, 'not the old plan’s 3');
    });
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────

  describe('a lifetime subscription renewed', () => {
    // The owner, 24.09.2026: a subscription with no end date stays without one.
    // The renewal used to close its open-ended term at the payment, append its
    // own after it and end the add-ons with no end at the renewal's end.
    it('changes nothing: the open-ended term stays open, nothing is appended, and the add-on keeps no end', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, { expiresAt: null });
      await enter(owner.subscriptionId);
      const open = await activeTermOf(owner.subscriptionId);
      assert.equal(open.endsAt, null, 'fixture: a lifetime term');
      const addOnId = await addOnRow(owner, open.id, { type: AddOnType.EXTRA_DEVICES, value: 2, expiresAt: null });

      await withFlags({}, () => pay(owner, PurchaseType.RENEW, plan));

      const rows = await termsOf(owner.subscriptionId);
      assert.deepEqual(rows.map((term) => [term.generation, term.status, term.endsAt]), [[1, 'ACTIVE', null]]);
      const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      assert.equal(addOn.expiresAt, null);
      assert.equal(await prisma.addOnEntitlementEvent.count({ where: { entitlementId: addOnId } }), 0);
      assert.equal((await subscriptionOf(owner.subscriptionId)).expiresAt, null);
    });
  });

  // ── 6 ─────────────────────────────────────────────────────────────────────

  describe('a paid upgrade on the durable path carries what sat above the old plan', () => {
    /**
     * A subscription on a plan of 100 GB / 3 devices, in the model, upgraded to
     * `target`; returns its columns after the upgrade.
     */
    async function upgradeDurably(input: {
      readonly columns: Limits;
      readonly target: Limits;
      readonly addOns?: { readonly trafficGb?: number; readonly devices?: number };
      readonly flags?: { readonly shadow?: boolean; readonly direct?: boolean };
    }): Promise<{ readonly owner: Owner; readonly after: Limits }> {
      const target = await createPlan(input.target);
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, { upgradeToPlanIds: [target] });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, { columns: input.columns });
      await enter(owner.subscriptionId);
      if (input.addOns !== undefined) {
        const term = await activeTermOf(owner.subscriptionId);
        if (input.addOns.trafficGb !== undefined) {
          await addOnRow(owner, term.id, { type: AddOnType.EXTRA_TRAFFIC, value: input.addOns.trafficGb, expiresAt: term.endsAt });
        }
        if (input.addOns.devices !== undefined) {
          await addOnRow(owner, term.id, { type: AddOnType.EXTRA_DEVICES, value: input.addOns.devices, expiresAt: term.endsAt });
        }
        await mirror(owner.subscriptionId);
      }
      await withFlags(input.flags ?? { shadow: true, direct: true }, () => pay(owner, PurchaseType.UPGRADE, target));
      const row = await subscriptionOf(owner.subscriptionId);
      return { owner, after: { trafficLimit: row.trafficLimit, deviceLimit: row.deviceLimit } };
    }

    it('an operator’s 6 on a 3-device plan, onto 10: 13 — as the column path gives', async () => {
      const { after } = await upgradeDurably({ columns: { trafficLimit: 100, deviceLimit: 6 }, target: { trafficLimit: 500, deviceLimit: 10 } });
      assert.equal(after.deviceLimit, 13);
      assert.equal(after.trafficLimit, 500);
    });

    it('an operator’s cut to 2, onto 10: 10 — a lowered limit does not carry', async () => {
      const { after } = await upgradeDurably({ columns: { trafficLimit: 100, deviceLimit: 2 }, target: { trafficLimit: 500, deviceLimit: 10 } });
      assert.equal(after.deviceLimit, 10);
    });

    it('an operator’s unlimited over the finite plan stays unlimited', async () => {
      const { after } = await upgradeDurably({ columns: { trafficLimit: null, deviceLimit: 0 }, target: { trafficLimit: 500, deviceLimit: 10 } });
      assert.deepEqual(after, { trafficLimit: null, deviceLimit: 0 });
    });

    it('an unlimited target plan is unlimited', async () => {
      const { after } = await upgradeDurably({ columns: { trafficLimit: 100, deviceLimit: 5 }, target: { trafficLimit: null, deviceLimit: 0 } });
      assert.deepEqual(after, { trafficLimit: null, deviceLimit: 0 });
    });

    it('live add-ons count once: 550 / 7, not 600 / 9', async () => {
      const { after } = await upgradeDurably({
        columns: { trafficLimit: 100, deviceLimit: 3 },
        target: { trafficLimit: 500, deviceLimit: 5 },
        addOns: { trafficGb: 50, devices: 2 },
      });
      assert.deepEqual(after, { trafficLimit: 550, deviceLimit: 7 });
    });

    it('a grandfathered legacy +2 onto a 10-device plan: 12, not 5 — and 12 is what the panel receives', async () => {
      const { owner, after } = await upgradeDurably({ columns: { trafficLimit: 100, deviceLimit: 5 }, target: { trafficLimit: 500, deviceLimit: 10 } });
      assert.equal(after.deviceLimit, 12);
      const projected = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId: owner.subscriptionId } });
      assert.equal(projected.desiredDeviceLimit, 12);
      assert.equal((await push(owner.subscriptionId)).body.hwidDeviceLimit, 12);
    });

    it('the same with every flag off, for a subscription already in the model: 12', async () => {
      const { after } = await upgradeDurably({
        columns: { trafficLimit: 100, deviceLimit: 5 },
        target: { trafficLimit: 500, deviceLimit: 10 },
        flags: {},
      });
      assert.equal(after.deviceLimit, 12);
    });
  });

  // ── 7 ─────────────────────────────────────────────────────────────────────

  describe('live add-ons across a paid upgrade (owner, 24.09.2026)', () => {
    it('each keeps its own end, clamped to the new end, moved onto the new term — and the sweep ends each on its own date', async () => {
      const target = await createPlan({ trafficLimit: 500, deviceLimit: 5 });
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, { upgradeToPlanIds: [target] });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, { expiresAt: inDays(60) });
      await enter(owner.subscriptionId);
      const oldTerm = await activeTermOf(owner.subscriptionId);
      const ownEnd = inDays(10);
      const early = await addOnRow(owner, oldTerm.id, { type: AddOnType.EXTRA_DEVICES, value: 2, expiresAt: ownEnd });
      const late = await addOnRow(owner, oldTerm.id, { type: AddOnType.EXTRA_TRAFFIC, value: 50, expiresAt: oldTerm.endsAt });
      await mirror(owner.subscriptionId);

      await withFlags({ shadow: true, direct: true }, () => pay(owner, PurchaseType.UPGRADE, target));

      const newEnd = (await subscriptionOf(owner.subscriptionId)).expiresAt!;
      assert.ok(newEnd.getTime() < oldTerm.endsAt!.getTime(), 'fixture: the upgrade ends earlier than the old period');
      const newTerm = await activeTermOf(owner.subscriptionId);
      const earlyRow = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: early } });
      const lateRow = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: late } });
      assert.equal(earlyRow.expiresAt?.getTime(), ownEnd.getTime(), 'its own, earlier date');
      assert.equal(lateRow.expiresAt?.getTime(), newEnd.getTime(), 'never later than the subscription');
      assert.deepEqual([earlyRow.termId, lateRow.termId], [newTerm.id, newTerm.id], 're-bound to the new term');
      assert.equal(
        await prisma.addOnEntitlementEvent.count({
          where: { entitlementId: { in: [early, late] }, reason: 'UPGRADE_KEPT_OWN_END' },
        }),
        2,
      );
      assert.deepEqual(
        [(await subscriptionOf(owner.subscriptionId)).trafficLimit, (await subscriptionOf(owner.subscriptionId)).deviceLimit],
        [550, 7],
      );

      await boundary.expireDueForSubscription(owner.subscriptionId, new Date(ownEnd.getTime() + 1000));
      assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: early } })).state, 'EXPIRING');
      assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: late } })).state, 'ACTIVE');
      await boundary.expireDueForSubscription(owner.subscriptionId, new Date(newEnd.getTime() + 1000));
      assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: late } })).state, 'EXPIRED');
    });

    it('an add-on bonus days left behind first catches up with the subscription, then keeps that date', async () => {
      const target = await createPlan({ trafficLimit: 500, deviceLimit: 5 });
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, { upgradeToPlanIds: [target] });
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, { expiresAt: inDays(10) });
      await enter(owner.subscriptionId);
      const term = await activeTermOf(owner.subscriptionId);
      const addOnId = await addOnRow(owner, term.id, { type: AddOnType.EXTRA_DEVICES, value: 2, expiresAt: term.endsAt });
      await mirror(owner.subscriptionId);
      // Bonus days: the expiry moves, the term and the add-on do not.
      const bonusEnd = inDays(20);
      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: bonusEnd } });

      await withFlags({ shadow: true, direct: true }, () => pay(owner, PurchaseType.UPGRADE, target));

      const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      assert.ok(bonusEnd.getTime() < (await subscriptionOf(owner.subscriptionId)).expiresAt!.getTime(), 'fixture');
      assert.equal(addOn.expiresAt?.getTime(), bonusEnd.getTime(), 'the end it had caught up to — not the stale one');
    });
  });

  // ── 8 ─────────────────────────────────────────────────────────────────────

  describe('a queued term carrying a renewal add-on left by stage 5, under an upgrade', () => {
    // Renewal add-ons (stage 5) were deleted on 24.09.2026, with the code that
    // re-based such a queued term above the upgrade's own. An install that had
    // them on may still hold one: the upgrade treats the term like any queued
    // term, and the add-on is left as it was — PENDING, counting for nothing.

    /** A subscription in the model with a queued renewal term that carries a paid add-on. */
    async function withPaidQueuedTerm(input: {
      readonly plan: string;
      readonly remainingDays: number;
    }): Promise<{ readonly owner: Owner; readonly queuedId: string; readonly addOnId: string }> {
      const owner = await subscriptionOn(input.plan, { trafficLimit: 100, deviceLimit: 3 }, {
        expiresAt: inDays(input.remainingDays),
        squads: ['squad-old'],
      });
      await enter(owner.subscriptionId);
      await withFlags({ shadow: true }, () => pay(owner, PurchaseType.RENEW, input.plan));
      const queued = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      });
      const addOnId = await addOnRow(owner, queued.id, {
        type: AddOnType.EXTRA_DEVICES,
        value: 2,
        expiresAt: queued.endsAt,
        state: AddOnEntitlementState.PENDING_ACTIVATION,
        scheduledActivationAt: queued.startsAt,
      });
      return { owner, queuedId: queued.id, addOnId };
    }

    it('cancels the term; the add-on stays PENDING and counts for nothing, and the new plan stays', async () => {
      const target = await createPlan({ trafficLimit: 500, deviceLimit: 5 }, { internalSquads: ['squad-new'] });
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, { upgradeToPlanIds: [target], internalSquads: ['squad-old'] });
      const { owner, queuedId, addOnId } = await withPaidQueuedTerm({ plan, remainingDays: 20 });

      await withFlags({ shadow: true, direct: true }, () => pay(owner, PurchaseType.UPGRADE, target));

      const after = await subscriptionOf(owner.subscriptionId);
      const active = await activeTermOf(owner.subscriptionId);
      assert.equal(active.planId, target);
      assert.equal(active.endsAt?.getTime(), after.expiresAt?.getTime(), 'the new term runs to the subscription’s end');
      assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: queuedId } })).status, 'CANCELED');
      const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      assert.equal(addOn.state, AddOnEntitlementState.PENDING_ACTIVATION);
      assert.equal(addOn.termId, queuedId);
      assert.equal(after.deviceLimit, 5, 'the new plan alone: the pending +2 is no share of it');
      assert.deepEqual(after.internalSquads, ['squad-new']);

      // Nothing is queued any more: past the old period's end the sweep
      // activates nothing, and the old plan does not come back.
      const swept = await boundary.activateDueScheduledTerm(owner.subscriptionId, inDays(25));
      assert.equal(swept.activated, false);
      assert.equal(asRecord((await subscriptionOf(owner.subscriptionId)).planSnapshot)['id'], target);
    });
  });

  // ── 9 ─────────────────────────────────────────────────────────────────────

  describe('a renewal drafted before «Назначить план»', () => {
    /** Базовый 200 ₽ / 30 days and Премиум 650 ₽ / 30 days: Премиум's dearest day is 21.67 ₽. */
    async function plans(): Promise<{ basic: string; premium: string }> {
      const premium = await createPlan({ trafficLimit: 500, deviceLimit: 5 }, {
        durations: [{ days: 30, currency: 'RUB', price: '650' }],
      });
      const basic = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, {
        durations: [{ days: 30, currency: 'RUB', price: '200' }],
        upgradeToPlanIds: [premium],
      });
      return { basic, premium };
    }

    /** What «Назначить план» leaves: the plan's snapshot and limits — and, in the model, a rotated term. */
    async function assign(subscriptionId: string, planId: string): Promise<void> {
      const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            planSnapshot: buildPlanSnapshot(plan),
            trafficLimit: plan.trafficLimit,
            deviceLimit: plan.deviceLimit,
            internalSquads: plan.internalSquads,
            externalSquad: plan.externalSquad,
          },
        });
        await terms.rotateForPlanChangeInTransaction(tx, {
          subscriptionId,
          plan,
          snapshotSource: 'ADMIN_PLAN_ASSIGNMENT_TERM',
          scheduledTerms: 'CANCEL_UNBOUND',
        });
      });
    }

    async function renewalDraftedEarlier(owner: Owner, planId: string, currency: 'RUB' | 'USD' = 'RUB') {
      return prisma.transaction.create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId: owner.userId,
          subscriptionId: owner.subscriptionId,
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency,
          amount: new Prisma.Decimal(currency === 'RUB' ? '200' : '5'),
          planSnapshot: { id: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
          createdAt: new Date(Date.now() - 3 * HOUR_MS),
        },
      });
    }

    it('keeps the operator’s plan: the money buys days of it — 9, not 30 — and the operator is told (every flag off)', async () => {
      const { basic, premium } = await plans();
      const owner = await subscriptionOn(basic, { trafficLimit: 100, deviceLimit: 3 });
      const renewal = await renewalDraftedEarlier(owner, basic);
      await assign(owner.subscriptionId, premium);
      const before = await subscriptionOf(owner.subscriptionId);

      await withFlags({}, () => fulfilment.applyCompletedTransaction(renewal));

      const after = await subscriptionOf(owner.subscriptionId);
      assert.equal(asRecord(after.planSnapshot)['id'], premium, 'the operator’s assignment stands');
      assert.equal((after.expiresAt!.getTime() - before.expiresAt!.getTime()) / DAY_MS, 9);
      assert.equal(after.deviceLimit, 5);
      const provenance = asRecord(asRecord((await prisma.transaction.findUniqueOrThrow({ where: { id: renewal.id } })).gatewayData)['renewalPricedBeforeUpgrade']);
      const line = asRecord((provenance['lines'] as unknown[])[0]);
      assert.deepEqual([line['currentPlanId'], line['days'], line['cause']], [premium, 9, 'PLAN_CHANGE']);
      const completion = eventsOf(EVENT_TYPES.PAYMENT_COMPLETED, (metadata) => metadata['paymentId'] === renewal.paymentId);
      assert.equal(completion.length, 1);
      assert.equal(completion[0]!.severity, 'WARNING');
      assert.equal(completion[0]!.metadata['code'], 'RENEWAL_PRICED_BEFORE_PLAN_CHANGE');
      assert.match(String(completion[0]!.metadata['note']), /уже перевели на/);
    });

    it('in the model, the renewal’s term is on the operator’s plan for the converted days', async () => {
      const { basic, premium } = await plans();
      const owner = await subscriptionOn(basic, { trafficLimit: 100, deviceLimit: 3 });
      await enter(owner.subscriptionId);
      const renewal = await renewalDraftedEarlier(owner, basic);
      await assign(owner.subscriptionId, premium);

      await withFlags({ shadow: true, direct: true }, () => fulfilment.applyCompletedTransaction(renewal));

      const queued = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      });
      assert.equal(queued.planId, premium, 'a term of the paid plan would put it back when it begins');
      assert.equal((queued.endsAt!.getTime() - queued.startsAt.getTime()) / DAY_MS, 9);
      assert.equal(queued.endsAt?.getTime(), (await subscriptionOf(owner.subscriptionId)).expiresAt?.getTime());
    });

    it('leaves a renewal onto the plan the current one is REPLACED by on renewal as it always was', async () => {
      const { basic, premium } = await plans();
      const owner = await subscriptionOn(basic, { trafficLimit: 100, deviceLimit: 3 });
      const renewal = await renewalDraftedEarlier(owner, basic);
      await assign(owner.subscriptionId, premium);
      await prisma.plan.update({
        where: { id: premium },
        data: { isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: [basic] },
      });
      const before = await subscriptionOf(owner.subscriptionId);

      await withFlags({}, () => fulfilment.applyCompletedTransaction(renewal));

      const after = await subscriptionOf(owner.subscriptionId);
      assert.equal(asRecord(after.planSnapshot)['id'], basic);
      assert.equal((after.expiresAt!.getTime() - before.expiresAt!.getTime()) / DAY_MS, 30);
    });
  });

  // ── 10 ────────────────────────────────────────────────────────────────────

  describe('a renewal that buys no day renews nothing', () => {
    it('single: an EXPIRED subscription stays EXPIRED at its expiry — no reset, no «Подписка продлена», and the card asks for the money back', async () => {
      const premium = await createPlan({ trafficLimit: 500, deviceLimit: 5 }, {
        durations: [{ days: 30, currency: 'RUB', price: '650' }],
      });
      const basic = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      // Upgraded to Премиум 40 days ago, expired 10 days ago; the Базовый
      // renewal was drafted before the upgrade and is paid now, in dollars —
      // a currency Премиум has no price in.
      const expiredAt = inDays(-10);
      const owner = await subscriptionOn(premium, { trafficLimit: 500, deviceLimit: 5 }, {
        status: SubscriptionStatus.EXPIRED,
        expiresAt: expiredAt,
        startedAt: inDays(-40),
      });
      const renewal = await pay(owner, PurchaseType.RENEW, basic, { currency: 'USD', amount: '5', createdAt: inDays(-41) });

      const after = await subscriptionOf(owner.subscriptionId);
      assert.equal(after.status, SubscriptionStatus.EXPIRED, 'not revived');
      assert.equal(after.expiresAt?.getTime(), expiredAt.getTime(), 'not moved to now');
      const job = await prisma.profileSyncJob.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId },
        orderBy: { createdAt: 'desc' },
      });
      assert.equal(asRecord(job.payload)['resetTraffic'], undefined);
      assert.equal(
        eventsOf(EVENT_TYPES.SUBSCRIPTION_RENEWED, (metadata) => metadata['paymentId'] === renewal.paymentId).length,
        0,
      );
      const completion = eventsOf(EVENT_TYPES.PAYMENT_COMPLETED, (metadata) => metadata['paymentId'] === renewal.paymentId)[0]!;
      assert.equal(completion.severity, 'WARNING');
      assert.match(String(completion.metadata['note']), /Верните деньги или продлите подписку вручную\./);
      const text = await card(EVENT_TYPES.PAYMENT_COMPLETED, completion.message, completion.metadata);
      assert.match(text, /на этом тарифе это 0 дн\.: срок не продлён, деньги нужно вернуть\./);
    });

    it('combined: its LIMITED line stays LIMITED with no reset, while the other line renews', async () => {
      const premium = await createPlan({ trafficLimit: 500, deviceLimit: 5 }, {
        durations: [{ days: 30, currency: 'RUB', price: '650' }],
      });
      const basic = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, {
        durations: [{ days: 30, currency: 'USD', price: '5' }],
      });
      // Put on Премиум by the operator after the Базовый renewal was drafted.
      const moved = await subscriptionOn(premium, { trafficLimit: 500, deviceLimit: 5 }, { status: SubscriptionStatus.LIMITED });
      const other = await subscriptionOn(basic, { trafficLimit: 100, deviceLimit: 3 }, { userId: moved.userId });
      const limitedUntil = (await subscriptionOf(moved.subscriptionId)).expiresAt!;
      const parent = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId: moved.userId,
          subscriptionId: null,
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'USD',
          amount: new Prisma.Decimal('10'),
          planSnapshot: { combinedRenewal: true, snapshotVersion: 1 } as Prisma.InputJsonValue,
          createdAt: new Date(Date.now() - 3 * HOUR_MS),
        },
      });
      await prisma.transactionItem.createMany({
        data: [moved, other].map((owner) => ({
          transactionId: parent.id,
          subscriptionId: owner.subscriptionId,
          planId: basic,
          planSnapshot: { id: basic, selectedDurationDays: 30 },
          durationDays: 30,
          amount: new Prisma.Decimal('5'),
          currency: 'USD' as const,
        })),
      });

      await withFlags({}, () => fulfilment.applyCompletedTransaction(parent));

      const movedAfter = await subscriptionOf(moved.subscriptionId);
      assert.equal(movedAfter.status, SubscriptionStatus.LIMITED, 'not lifted without a reset');
      assert.equal(movedAfter.expiresAt?.getTime(), limitedUntil.getTime());
      const movedJob = await prisma.profileSyncJob.findFirstOrThrow({
        where: { subscriptionId: moved.subscriptionId },
        orderBy: { createdAt: 'desc' },
      });
      assert.equal(asRecord(movedJob.payload)['resetTraffic'], undefined);
      const otherAfter = await subscriptionOf(other.subscriptionId);
      assert.equal(otherAfter.status, SubscriptionStatus.ACTIVE);
      const otherJob = await prisma.profileSyncJob.findFirstOrThrow({
        where: { subscriptionId: other.subscriptionId },
        orderBy: { createdAt: 'desc' },
      });
      assert.equal(asRecord(otherJob.payload)['resetTraffic'], true);
      assert.deepEqual(
        eventsOf(EVENT_TYPES.SUBSCRIPTION_RENEWED, (metadata) => metadata['paymentId'] === parent.paymentId).map(
          (event) => event.metadata['subscriptionId'],
        ),
        [other.subscriptionId],
      );
    });
  });

  // ── 11 ────────────────────────────────────────────────────────────────────

  describe('the upgrade quote on the durable path', () => {
    it('names what carries above the old plan, and lists the live add-ons with the ends they will have — each told once', async () => {
      const target = await createPlan({ trafficLimit: 500, deviceLimit: 10 });
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 }, { upgradeToPlanIds: [target] });
      // An operator's +1 device above the plan, cut over into the term's base.
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 }, {
        columns: { trafficLimit: 100, deviceLimit: 4 },
        expiresAt: inDays(60),
      });
      await enter(owner.subscriptionId);
      const term = await activeTermOf(owner.subscriptionId);
      const ownEnd = inDays(10);
      await addOnRow(owner, term.id, { type: AddOnType.EXTRA_DEVICES, value: 2, expiresAt: ownEnd });
      await addOnRow(owner, term.id, { type: AddOnType.EXTRA_TRAFFIC, value: 50, expiresAt: term.endsAt });
      await mirror(owner.subscriptionId);

      const before = Date.now();
      const quote = await withFlags({ shadow: true, direct: true }, () =>
        quotes.getQuote({
          userId: owner.userId,
          purchaseType: PurchaseType.UPGRADE,
          planId: target,
          durationDays: 30,
          subscriptionId: owner.subscriptionId,
          channel: PurchaseChannel.WEB,
        }),
      );
      const after = Date.now();

      assert.deepEqual(quote.carriedAbovePlan, {
        deviceLimit: 1,
        trafficLimitGb: 0,
        unlimitedDevices: false,
        unlimitedTraffic: false,
      });
      const [devices, traffic] = quote.activeAddOns ?? [];
      assert.deepEqual(devices, { type: 'EXTRA_DEVICES', value: 2, expiresAt: ownEnd.toISOString() });
      assert.equal(traffic?.type, 'EXTRA_TRAFFIC');
      assert.equal(traffic?.value, 50);
      const clamped = Date.parse(traffic?.expiresAt ?? '');
      assert.ok(clamped >= before + 30 * DAY_MS && clamped <= after + 30 * DAY_MS, 'clamped to the new end');
    });
  });

  // ── 12 ────────────────────────────────────────────────────────────────────

  describe('a renewal first aligns the tail with the expiry', () => {
    /**
     * In the model with an add-on sold "until the end", then five bonus days
     * from a writer that leaves the term to the hourly drift sweep (referral
     * days, bulk «Продлить подписку»), and the sweep has not run yet.
     */
    async function drifted(plan: string): Promise<{
      readonly owner: Owner;
      readonly oldEnd: Date;
      readonly newEnd: Date;
      readonly addOnId: string;
    }> {
      const owner = await subscriptionOn(plan, { trafficLimit: 100, deviceLimit: 3 });
      await enter(owner.subscriptionId);
      const term = await activeTermOf(owner.subscriptionId);
      const oldEnd = term.endsAt!;
      const addOnId = await addOnRow(owner, term.id, { type: AddOnType.EXTRA_DEVICES, value: 2, expiresAt: oldEnd });
      await mirror(owner.subscriptionId);
      const newEnd = new Date(oldEnd.getTime() + 5 * DAY_MS);
      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: newEnd } });
      return { owner, oldEnd, newEnd, addOnId };
    }

    async function assertAlignedBeforeTheRenewal(subscriptionId: string, newEnd: Date, addOnId: string): Promise<void> {
      const rows = await termsOf(subscriptionId);
      assert.deepEqual(rows.map((term) => [term.generation, term.status]), [[1, 'ACTIVE'], [2, 'SCHEDULED']]);
      assert.equal(rows[0]!.endsAt?.getTime(), newEnd.getTime(), 'the ACTIVE term caught up with the bonus days');
      assert.equal(rows[1]!.startsAt.getTime(), newEnd.getTime(), 'the renewal follows the real end');
      const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnId } });
      assert.equal(addOn.expiresAt?.getTime(), newEnd.getTime(), 'the add-on "until the end" moved with it');
      assert.equal(
        rows[1]!.endsAt?.getTime(),
        (await subscriptionOf(subscriptionId)).expiresAt?.getTime(),
        'the chain ends where the subscription does',
      );
    }

    it('single: the ACTIVE term, its add-on and the renewal all follow the bonus days (every flag off)', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const { owner, newEnd, addOnId } = await drifted(plan);

      const renewal = await withFlags({}, () => pay(owner, PurchaseType.RENEW, plan));

      await assertAlignedBeforeTheRenewal(owner.subscriptionId, newEnd, addOnId);
      // The add-on's move is audited under the payment that caused it.
      const moved = await prisma.addOnEntitlementEvent.findFirstOrThrow({
        where: { entitlementId: addOnId, reason: 'TERM_WINDOW_ALIGNED' },
      });
      assert.equal(moved.correlationId, `payment:${renewal.paymentId}`);
    });

    it('combined: the line aligns its own subscription before its term is appended', async () => {
      const plan = await createPlan({ trafficLimit: 100, deviceLimit: 3 });
      const { owner, newEnd, addOnId } = await drifted(plan);
      const parent = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId: owner.userId,
          subscriptionId: null,
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: new Prisma.Decimal('299'),
          planSnapshot: { combinedRenewal: true, snapshotVersion: 1 } as Prisma.InputJsonValue,
        },
      });
      await prisma.transactionItem.create({
        data: {
          transactionId: parent.id,
          subscriptionId: owner.subscriptionId,
          planId: plan,
          planSnapshot: { id: plan, selectedDurationDays: 30 },
          durationDays: 30,
          amount: new Prisma.Decimal('299'),
          currency: 'RUB',
        },
      });

      await withFlags({}, () => fulfilment.applyCompletedTransaction(parent));

      await assertAlignedBeforeTheRenewal(owner.subscriptionId, newEnd, addOnId);
    });
  });
});
