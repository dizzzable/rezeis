import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Currency, Prisma, PurchaseChannel, PurchaseType } from '@prisma/client';

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
import { findDaysConvertedFromPayment } from '../src/modules/subscriptions/services/paid-remainder-conversion.util';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';

/**
 * An UPGRADE adds what was left of the old plan to the new term, on
 * PostgreSQL, through the real fulfilment, the real quote, the real profile
 * sync (whose `updateUser` body is what the panel would have received), the
 * real durable terms and the real audit row.
 *
 * Before: `expiresAt = now + days`, and whatever the customer had paid for
 * beyond `now` was lost. Now: `expiresAt = now + days + converted`, where the
 * converted days are the unused money of the paid chunks divided by the new
 * plan's most expensive day (`paid-remainder-conversion.util.ts`).
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `prc-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const DURABLE_FLAGS = ['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'] as const;

let prisma: PrismaService;
let fulfilment: PaymentSubscriptionMutationService;
let quotes: SubscriptionQuoteService;
let cutover: EntitlementCutoverService;
let boundary: EntitlementBoundaryService;
let audit: SystemEventsService;
const emitted: Array<{ readonly type: string; readonly metadata: Record<string, unknown> }> = [];
const created = { plans: [] as string[], users: [] as string[] };
let counter = 0;
const next = (): number => ++counter;

/** Базовый: 200 ₽ for 30 days. Премиум: 650 ₽ for 30 days, 3 000 ₽ for 180 — its dearest day is 21.67 ₽. */
async function createPlans(): Promise<{ basic: string; premium: string }> {
  const premium = `${prefix}-premium-${next()}`;
  await prisma.plan.create({
    data: {
      id: premium,
      name: premium,
      orderIndex: 500_000 + next(),
      trafficLimit: 500,
      deviceLimit: 5,
      internalSquads: [],
      trafficLimitStrategy: 'NO_RESET',
      durations: {
        create: [
          { days: 30, prices: { create: [{ currency: 'RUB', price: '650' }] } },
          { days: 180, prices: { create: [{ currency: 'RUB', price: '3000' }] } },
        ],
      },
    },
  });
  const basic = `${prefix}-basic-${next()}`;
  await prisma.plan.create({
    data: {
      id: basic,
      name: basic,
      orderIndex: 500_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      trafficLimitStrategy: 'NO_RESET',
      upgradeToPlanIds: [premium],
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '200' }] } }] },
    },
  });
  created.plans.push(premium, basic);
  return { basic, premium };
}

async function createUser(): Promise<string> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  created.users.push(userId);
  return userId;
}

/**
 * A subscription on `planId`, provisioned on the panel, started ten days ago
 * and expiring in twenty — with the payment that bought it, 200 ₽ for 30 days,
 * fulfilled ten days ago.
 */
async function paidSubscription(
  userId: string,
  planId: string,
  options: {
    readonly isTrial?: boolean;
    readonly paid?: boolean;
    /** Started this many days ago, for a term of 30 days from then (10 unless told). */
    readonly startedDaysAgo?: number;
    /** The payment's `gatewayData`, as reconciliation or a refund may have left it. */
    readonly gatewayData?: Record<string, unknown>;
    readonly amount?: string;
    readonly days?: number;
  } = {},
): Promise<{ subscriptionId: string; paymentId: string | null }> {
  const panelId = 800_000 + next();
  const tenDaysAgo = new Date(Date.now() - (options.startedDaysAgo ?? 10) * DAY_MS);
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: 'ACTIVE',
      isTrial: options.isTrial ?? false,
      planSnapshot: {
        id: planId,
        name: planId,
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
      } as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: tenDaysAgo,
      startedAt: tenDaysAgo,
      expiresAt: new Date(tenDaysAgo.getTime() + (options.days ?? 30) * DAY_MS),
    },
    select: { id: true },
  });
  if (options.paid === false) return { subscriptionId: subscription.id, paymentId: null };
  const paymentRow = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId,
      subscriptionId: subscription.id,
      status: 'COMPLETED',
      purchaseType: 'NEW',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal(options.amount ?? '200'),
      planSnapshot: { id: planId, selectedDurationDays: options.days ?? 30 } as Prisma.InputJsonValue,
      gatewayData: (options.gatewayData ?? {}) as Prisma.InputJsonValue,
      fulfilledAt: tenDaysAgo,
      createdAt: tenDaysAgo,
    },
    select: { id: true },
  });
  return { subscriptionId: subscription.id, paymentId: paymentRow.id };
}

/** A payment, COMPLETED, fulfilled the way the webhook does it. */
async function pay(input: {
  readonly userId: string;
  readonly subscriptionId: string | null;
  readonly purchaseType: PurchaseType;
  readonly planId: string;
  readonly amount: string;
  readonly days?: number;
}): Promise<string> {
  const row = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      status: 'COMPLETED',
      purchaseType: input.purchaseType,
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal(input.amount),
      planSnapshot: { id: input.planId, selectedDurationDays: input.days ?? 30 } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(row);
  return row.id;
}

async function termOf(subscriptionId: string) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: { startedAt: true, expiresAt: true },
  });
}

function daysBetween(from: Date | null, to: Date | null): number {
  assert.ok(from !== null && to !== null);
  return (to.getTime() - from.getTime()) / DAY_MS;
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
      generateProfileName: async () => ({ username: profile.username, description: 'upgrade' }),
      getContactInfo: async () => ({ email: null, telegramId: null }),
    } as never,
    { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
  );
  await processor.process({ data: { syncJobId: job.id } } as never);
  assert.equal(sent.length, 1, 'the job pushed the profile exactly once');
  return sent[0]!;
}

/** The card an operator would read for `metadata`, through the real formatter. */
async function card(type: string, metadata: Record<string, unknown>): Promise<string> {
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
    renderer.info(type, 'SUBSCRIPTION', 'Подписка улучшена', metadata);
    for (let attempt = 0; attempt < 40 && text === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    if (savedToken !== undefined) process.env.BOT_TOKEN = savedToken;
  }
  assert.ok(text !== null, 'the card was rendered');
  return text;
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

function upgradedEventOf(subscriptionId: string): Record<string, unknown> {
  const event = emitted.find(
    (entry) => entry.type === EVENT_TYPES.SUBSCRIPTION_UPGRADED && entry.metadata['subscriptionId'] === subscriptionId,
  );
  assert.ok(event, `no «Подписка улучшена» for ${subscriptionId}`);
  return event.metadata;
}

run('an upgrade adds the old plan’s paid remainder to the new term (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    for (const flag of DURABLE_FLAGS) delete process.env[flag];
    prisma = new PrismaService();
    await prisma.$connect();
    // The real audit pipeline for the card this change adds to: persisted as
    // the system event log persists every event. The rest is recorded only —
    // a `system.error` must not reach the error-report archive from a spec.
    audit = new SystemEventsService(prisma, { enabled: false, urls: [] } as never);
    const record =
      (forward: boolean) =>
      (type: string, category: string, message: string, metadata: Record<string, unknown> = {}) => {
        emitted.push({ type, metadata });
        if (forward && type === EVENT_TYPES.SUBSCRIPTION_UPGRADED) {
          audit.info(type, category as never, message, metadata);
        }
      };
    const events = { info: record(true), warn: record(false), error: record(false), emit: () => undefined };
    const terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    const entitlements = new AddOnEntitlementService();
    fulfilment = new PaymentSubscriptionMutationService(prisma, events as never, entitlements, projection, terms, {} as never);
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projection);
    const catalog = new PlanCatalogService(prisma, new PricingService(), {
      loadConfig: async () => ({ enabled: false, percent: 0, defaultCurrency: 'RUB' }),
    } as never);
    quotes = new SubscriptionQuoteService(prisma, catalog, new PricingService());
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = { in: created.users };
    const steps: Array<() => Promise<unknown>> = [
      ...created.users.map(
        (userId) => () =>
          prisma.adminAuditLog.deleteMany({
            where: { action: { startsWith: 'event.' }, metadata: { path: ['userId'], equals: userId } },
          }),
      ),
      () => prisma.addOnEntitlementEvent.deleteMany({ where: { entitlement: { subscription: { userId: users } } } }),
      () => prisma.addOnEntitlement.deleteMany({ where: { subscription: { userId: users } } }),
      () => prisma.subscriptionEffectiveProjection.deleteMany({ where: { subscription: { userId: users } } }),
      () => prisma.profileSyncJob.deleteMany({ where: { subscription: { userId: users } } }),
      () => prisma.subscriptionTerm.deleteMany({ where: { subscription: { userId: users } } }),
      () => prisma.transaction.deleteMany({ where: { userId: users } }),
      () => prisma.subscription.deleteMany({ where: { userId: users } }),
      () => prisma.plan.deleteMany({ where: { id: { in: created.plans } } }),
      () => prisma.user.deleteMany({ where: { id: users } }),
    ];
    for (const step of steps) await step().catch(() => undefined);
    await prisma.$disconnect();
  });

  it('200 ₽ with 20 days left, upgraded to Премиум: `expiresAt = now + 30 + 6`, quoted before, pushed after', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const owner = await paidSubscription(userId, plans.basic);

    const quote = await quotes.getQuote({
      userId,
      purchaseType: PurchaseType.UPGRADE,
      planId: plans.premium,
      durationDays: 30,
      subscriptionId: owner.subscriptionId,
      channel: PurchaseChannel.WEB,
      // Priced in roubles without a gateway row, as the partner-balance path prices.
      currencyOverride: Currency.RUB,
    });
    assert.equal(quote.paidRemainderDays, 6, 'the review names the days before the customer pays');
    assert.equal(quote.price?.price, '650', 'the price is the plan’s, whatever converts');
    assert.equal(quote.isEligible, true);
    assert.ok(quote.warnings.some((warning) => warning.code === 'UPGRADE_RESETS_EXPIRY'), 'kept for older cabinets');

    const upgradeId = await pay({
      userId,
      subscriptionId: owner.subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      planId: plans.premium,
      amount: '650',
    });

    const term = await termOf(owner.subscriptionId);
    assert.equal(daysBetween(term.startedAt, term.expiresAt), 36, '30 bought + 6 converted, from one `now`');
    const upgrade = await prisma.transaction.findUniqueOrThrow({ where: { id: upgradeId } });
    assert.equal(upgrade.fulfilledAt?.getTime(), term.startedAt?.getTime(), 'the same `now` as the expiry');
    assert.equal(upgrade.amount.toString(), '650', 'the price did not change');

    const body = await push(owner.subscriptionId);
    assert.equal(body.expireAt, term.expiresAt?.toISOString(), 'Remnawave gets the lengthened expiry');
  });

  it('records the provenance on the upgrade, audits it, and puts the line on the operator’s card', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const owner = await paidSubscription(userId, plans.basic);

    const upgradeId = await pay({
      userId,
      subscriptionId: owner.subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      planId: plans.premium,
      amount: '650',
    });

    const upgrade = await prisma.transaction.findUniqueOrThrow({ where: { id: upgradeId } });
    const provenance = (upgrade.gatewayData as Record<string, unknown>)['paidRemainderConversion'] as Record<
      string,
      unknown
    >;
    assert.equal(provenance['days'], 6);
    const sources = provenance['sources'] as Array<Record<string, unknown>>;
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.['transactionId'], owner.paymentId);
    assert.equal(sources[0]?.['overlapDays'], '20.0000');
    assert.equal(sources[0]?.['value'], '133.33');
    assert.equal(sources[0]?.['currency'], 'RUB');

    const metadata = upgradedEventOf(owner.subscriptionId);
    assert.equal(metadata['paidRemainderDays'], 6);
    // The audit row, written by the real event pipeline.
    let row = null;
    for (let attempt = 0; attempt < 40 && row === null; attempt += 1) {
      row = await prisma.adminAuditLog.findFirst({
        where: {
          action: `event.${EVENT_TYPES.SUBSCRIPTION_UPGRADED}`,
          metadata: { path: ['subscriptionId'], equals: owner.subscriptionId },
        },
      });
      if (row === null) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(row, 'the upgrade was audited');
    const audited = row.metadata as Record<string, unknown>;
    assert.equal(audited['paidRemainderDays'], 6);
    assert.equal((audited['paidRemainderSources'] as Array<Record<string, unknown>>)[0]?.['transactionId'], owner.paymentId);

    const text = await card(EVENT_TYPES.SUBSCRIPTION_UPGRADED, metadata);
    assert.ok(text.includes('📥 Остаток прежнего тарифа: +6 дн.'), text);
  });

  it('counts only this subscription’s line of a renewal that paid for two', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const owner = await paidSubscription(userId, plans.basic);
    const other = await paidSubscription(userId, plans.basic, { paid: false });
    const combined = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId,
        subscriptionId: null,
        status: 'COMPLETED',
        purchaseType: 'RENEW',
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal('600'),
        planSnapshot: { combinedRenewal: true, snapshotVersion: 1, itemCount: 2 } as Prisma.InputJsonValue,
        items: {
          create: [
            {
              subscriptionId: owner.subscriptionId,
              planId: plans.basic,
              planSnapshot: {},
              durationDays: 30,
              amount: new Prisma.Decimal('200'),
              currency: 'RUB',
            },
            {
              subscriptionId: other.subscriptionId,
              planId: plans.basic,
              planSnapshot: {},
              durationDays: 30,
              amount: new Prisma.Decimal('400'),
              currency: 'RUB',
            },
          ],
        },
      },
    });
    await fulfilment.applyCompletedTransaction(combined);
    const renewed = await termOf(owner.subscriptionId);
    assert.equal(Math.round(daysBetween(new Date(), renewed.expiresAt)), 50, 'fixture: the line renewed it');

    const upgradeId = await pay({
      userId,
      subscriptionId: owner.subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      planId: plans.premium,
      amount: '650',
    });

    // 133.33 ₽ of the NEW and 200 ₽ of its own line: 15.38 days. With the
    // whole 600 ₽ of the payment it would have been 33.
    const term = await termOf(owner.subscriptionId);
    assert.equal(daysBetween(term.startedAt, term.expiresAt), 45);
    assert.deepEqual(
      (upgradedEventOf(owner.subscriptionId)['paidRemainderSources'] as Array<Record<string, unknown>>).map(
        (source) => [source['transactionId'], source['value']],
      ),
      [
        [owner.paymentId, '133.33'],
        [combined.id, '200.00'],
      ],
    );
    // A refund of the renewal: its line bought 9.23 of those 15 days — 10 named,
    // on the subscription whose upgrade counted it (the other line's never upgraded).
    assert.deepEqual(
      (await findDaysConvertedFromPayment(prisma, combined.id)).map((entry) => [
        entry.upgradeTransactionId,
        entry.subscriptionId,
        entry.days,
        entry.upgradeDays,
      ]),
      [[upgradeId, owner.subscriptionId, 10, 15]],
    );
  });

  it('a free trial’s conversion adds nothing: the term is the one bought', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const trial = await paidSubscription(userId, plans.basic, { isTrial: true, paid: false });

    await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId,
        subscriptionId: trial.subscriptionId,
        status: 'COMPLETED',
        purchaseType: 'UPGRADE',
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal('650'),
        planSnapshot: { id: plans.premium, selectedDurationDays: 30, convertsTrial: true } as Prisma.InputJsonValue,
      },
    }).then((row) => fulfilment.applyCompletedTransaction(row));

    const term = await termOf(trial.subscriptionId);
    assert.equal(daysBetween(term.startedAt, term.expiresAt), 30);
    assert.equal(upgradedEventOf(trial.subscriptionId)['paidRemainderDays'], undefined);
  });

  it('durable model: the renewal’s scheduled term is cancelled, its days converted, and the new term ends with them — once', async () => {
    await withDurableModel(async () => {
      const plans = await createPlans();
      const userId = await createUser();
      const owner = await paidSubscription(userId, plans.basic);
      await prisma.$transaction((tx) => cutover.cutoverSubscriptionInTransaction(tx, { id: owner.subscriptionId } as never));
      await pay({ userId, subscriptionId: owner.subscriptionId, purchaseType: PurchaseType.RENEW, planId: plans.basic, amount: '200' });
      const scheduled = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId, status: 'SCHEDULED' },
      });

      await pay({
        userId,
        subscriptionId: owner.subscriptionId,
        purchaseType: PurchaseType.UPGRADE,
        planId: plans.premium,
        amount: '650',
      });

      const term = await termOf(owner.subscriptionId);
      // 20 days of the NEW and all 30 of the renewal: 333.33 ₽ = 15.38 days.
      assert.equal(daysBetween(term.startedAt, term.expiresAt), 45);
      const active = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId, status: 'ACTIVE' },
      });
      assert.equal(active.startsAt.getTime(), term.startedAt?.getTime());
      assert.equal(active.endsAt?.getTime(), term.expiresAt?.getTime(), 'the term ends where the subscription does');
      assert.equal(
        (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: scheduled.id } })).status,
        'CANCELED',
        'the renewal’s own term is gone — so its days had to be converted',
      );
    });
  });

  it('durable model: a scheduled term carrying a renewal add-on left by stage 5 is cancelled like any, and its renewal converted', async () => {
    // Renewal add-ons (stage 5) were deleted on 24.09.2026, and with them the
    // re-basing that kept such a term alive through an upgrade. A row one left
    // behind no longer shields its term: the upgrade cancels it and converts
    // its days like any queued renewal's, and the row stays PENDING, inert.
    await withDurableModel(async () => {
      const plans = await createPlans();
      const userId = await createUser();
      const owner = await paidSubscription(userId, plans.basic);
      await prisma.$transaction((tx) => cutover.cutoverSubscriptionInTransaction(tx, { id: owner.subscriptionId } as never));
      const renewalId = await pay({
        userId,
        subscriptionId: owner.subscriptionId,
        purchaseType: PurchaseType.RENEW,
        planId: plans.basic,
        amount: '200',
      });
      const scheduled = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: owner.subscriptionId, status: 'SCHEDULED' },
      });
      // A paid add-on bound to that term, as stage 5 sold them.
      const leftover = await prisma.addOnEntitlement.create({
        data: {
          subscriptionId: owner.subscriptionId,
          termId: scheduled.id,
          sourceTransactionId: renewalId,
          sourceLineKey: `${prefix}-line-${next()}`,
          catalogRevision: 1,
          receiptName: '+2 устройства',
          type: 'EXTRA_DEVICES',
          valuePerUnit: 2,
          totalValue: 2n,
          lifetime: 'UNTIL_SUBSCRIPTION_END',
          unitAmount: new Prisma.Decimal('99'),
          totalAmount: new Prisma.Decimal('99'),
          currency: 'RUB',
          purchasedAt: new Date(),
          scheduledActivationAt: scheduled.startsAt,
          expiresAt: scheduled.endsAt,
        },
      });

      await pay({
        userId,
        subscriptionId: owner.subscriptionId,
        purchaseType: PurchaseType.UPGRADE,
        planId: plans.premium,
        amount: '650',
      });

      assert.equal(
        (await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: scheduled.id } })).status,
        'CANCELED',
        'the leftover add-on does not keep the renewal’s term alive',
      );
      const term = await termOf(owner.subscriptionId);
      assert.equal(daysBetween(term.startedAt, term.expiresAt), 45, 'the renewal’s 30 days are converted as well');
      const row = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: leftover.id } });
      assert.equal(row.state, 'PENDING_ACTIVATION');
      assert.equal(row.termId, scheduled.id);

      // Nothing is queued any more: at the old term's start the sweep activates
      // nothing, and the expiry stays where the upgrade put it.
      const swept = await boundary.activateDueScheduledTerm(owner.subscriptionId, new Date(scheduled.startsAt.getTime() + 1000));
      assert.equal(swept.activated, false);
      assert.equal((await termOf(owner.subscriptionId)).expiresAt?.getTime(), term.expiresAt?.getTime());
    });
  });

  /** A payment another worker has claimed — COMPLETED, stamped a second ago — and not applied. */
  async function claimed(input: {
    readonly userId: string;
    readonly subscriptionId: string;
    readonly planId: string;
    readonly amount: string;
    readonly convertsTrial?: boolean;
  }): Promise<void> {
    await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        status: 'COMPLETED',
        purchaseType: 'UPGRADE',
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal(input.amount),
        planSnapshot: {
          id: input.planId,
          selectedDurationDays: 30,
          ...(input.convertsTrial === true ? { convertsTrial: true } : {}),
        } as Prisma.InputJsonValue,
        fulfilledAt: new Date(Date.now() - 1000),
      },
    });
  }

  /**
   * A free minute past `days` from now, so the window these cases measure is
   * whole days to the millisecond fulfilment later runs at: read as applied,
   * the claimed payment would price every one of them at its own money.
   */
  async function expireInDaysAndAMinute(subscriptionId: string, days: number): Promise<void> {
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { expiresAt: new Date(Date.now() + days * DAY_MS + 60_000) },
    });
  }

  it('an upgrade applied beside another only claimed converts 6 days, not 20', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const owner = await paidSubscription(userId, plans.basic);
    await expireInDaysAndAMinute(owner.subscriptionId, 20);
    await claimed({ userId, subscriptionId: owner.subscriptionId, planId: plans.premium, amount: '650' });

    await pay({
      userId,
      subscriptionId: owner.subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      planId: plans.premium,
      amount: '650',
    });

    const term = await termOf(owner.subscriptionId);
    assert.equal(daysBetween(term.startedAt, term.expiresAt), 36, 'the claimed upgrade’s 650 ₽ are not this one’s days');
  });

  it('a trial’s conversion beside a second one only claimed converts 0 days, not 2', async () => {
    // 200 ₽ for 30 days.
    const start = `${prefix}-start-${next()}`;
    await prisma.plan.create({
      data: {
        id: start,
        name: start,
        orderIndex: 500_000 + next(),
        trafficLimit: 100,
        deviceLimit: 3,
        internalSquads: [],
        trafficLimitStrategy: 'NO_RESET',
        durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '200' }] } }] },
      },
    });
    created.plans.push(start);
    const userId = await createUser();
    // A free trial started yesterday, with two days left; the second
    // conversion is claimed and — when it gets the lock — withheld.
    const trial = await paidSubscription(userId, start, { isTrial: true, paid: false, startedDaysAgo: 1, days: 3 });
    await expireInDaysAndAMinute(trial.subscriptionId, 2);
    await claimed({ userId, subscriptionId: trial.subscriptionId, planId: start, amount: '200', convertsTrial: true });

    await prisma.transaction
      .create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId,
          subscriptionId: trial.subscriptionId,
          status: 'COMPLETED',
          purchaseType: 'UPGRADE',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: new Prisma.Decimal('200'),
          planSnapshot: { id: start, selectedDurationDays: 30, convertsTrial: true } as Prisma.InputJsonValue,
        },
      })
      .then((row) => fulfilment.applyCompletedTransaction(row));

    const term = await termOf(trial.subscriptionId);
    assert.equal(daysBetween(term.startedAt, term.expiresAt), 30);
  });

  it('still counts a payment completed before `fulfilled_at` existed, which the backfill stamped after its start', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const owner = await paidSubscription(userId, plans.basic);
    // `20260706130000_add_transaction_fulfilled_at`: `fulfilled_at = updated_at`,
    // here a day after the start the payment made. A claim is minutes old.
    await prisma.transaction.update({
      where: { id: owner.paymentId! },
      data: { fulfilledAt: new Date(Date.now() - 9 * DAY_MS) },
    });

    await pay({
      userId,
      subscriptionId: owner.subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      planId: plans.premium,
      amount: '650',
    });

    const term = await termOf(owner.subscriptionId);
    assert.equal(daysBetween(term.startedAt, term.expiresAt), 36);
  });

  it('counts a payment «Отметить возврат» recorded, and one reported short, at what was kept', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const marked = await paidSubscription(userId, plans.basic, {
      gatewayData: { manualRefundRecordedAt: new Date().toISOString(), manualRefundRecordedBy: 'admin-1' },
    });
    const short = await paidSubscription(userId, plans.basic, {
      gatewayData: { notifiedAmountShortfallAt: new Date().toISOString(), notifiedAmount: '100' },
    });

    for (const owner of [marked, short]) {
      await pay({
        userId,
        subscriptionId: owner.subscriptionId,
        purchaseType: PurchaseType.UPGRADE,
        planId: plans.premium,
        amount: '650',
      });
    }

    // Refunded: nothing. Short: 100 ₽ of it arrived — 3.08 days.
    const refundedTerm = await termOf(marked.subscriptionId);
    const shortTerm = await termOf(short.subscriptionId);
    assert.equal(daysBetween(refundedTerm.startedAt, refundedTerm.expiresAt), 30);
    assert.equal(daysBetween(shortTerm.startedAt, shortTerm.expiresAt), 33);
  });

  it('names, for a refund of a source payment, the days each later upgrade converted from it', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    // Базовый for 180 days at 900 ₽, upgraded ten days later.
    const owner = await paidSubscription(userId, plans.basic, { amount: '900', days: 180 });
    const upgradeId = await pay({
      userId,
      subscriptionId: owner.subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      planId: plans.premium,
      amount: '650',
    });
    const term = await termOf(owner.subscriptionId);
    // 900 × 170 / 180 = 850 ₽ at 21.67 ₽ a day: 39.23.
    assert.equal(daysBetween(term.startedAt, term.expiresAt), 69, 'fixture: 30 + 39');

    const found = await findDaysConvertedFromPayment(prisma, owner.paymentId!);
    const upgrade = await prisma.transaction.findUniqueOrThrow({ where: { id: upgradeId } });
    assert.deepEqual(
      found.map((entry) => [entry.upgradeTransactionId, entry.upgradePaymentId, entry.subscriptionId, entry.days, entry.upgradeDays]),
      [[upgradeId, upgrade.paymentId, owner.subscriptionId, 39, 39]],
    );
    assert.deepEqual(await findDaysConvertedFromPayment(prisma, upgradeId), [], 'the upgrade bought none of its own');
  });
});
