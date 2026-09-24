import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, PurchaseType } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';

/**
 * A RENEW drafted on the old plan and paid after the subscription was
 * UPGRADED, on PostgreSQL, through the real fulfilment, the real durable
 * terms, the real profile sync and the real card formatter.
 *
 * Before: the renewal put the old plan's snapshot, limits and squads back —
 * the upgrade the customer paid for undone by a cheaper payment — or, on a
 * durable term, sold 30 days of the dearer plan at the old plan's price. Now
 * the subscription keeps the plan it is on, and the payment buys what its
 * money buys there: 200 ₽ ÷ Премиум's dearest day (650 ₽ / 30) = 9.23 → 9.
 * The rule: `paid-remainder-conversion.util.ts`
 * (`readRenewalPricedBeforeUpgrade`, `convertRenewalPricedBeforeUpgrade`).
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `rpu-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DURABLE_FLAGS = ['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'] as const;

interface Emitted {
  readonly severity: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

let prisma: PrismaService;
let fulfilment: PaymentSubscriptionMutationService;
let cutover: EntitlementCutoverService;
const emitted: Emitted[] = [];
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
      orderIndex: 600_000 + next(),
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
      orderIndex: 600_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      trafficLimitStrategy: 'NO_RESET',
      upgradeToPlanIds: [premium],
      durations: {
        create: [
          { days: 30, prices: { create: [{ currency: 'RUB', price: '200' }, { currency: 'USD', price: '3' }] } },
        ],
      },
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
 * A subscription on Базовый, provisioned on the panel, bought ten days ago
 * with 200 ₽ for 30 days — twenty left.
 */
async function paidSubscription(userId: string, planId: string): Promise<string> {
  const panelId = 810_000 + next();
  const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: 'ACTIVE',
      isTrial: false,
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
      expiresAt: new Date(tenDaysAgo.getTime() + 30 * DAY_MS),
    },
    select: { id: true },
  });
  await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId,
      subscriptionId: subscription.id,
      status: 'COMPLETED',
      purchaseType: 'NEW',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('200'),
      planSnapshot: { id: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
      fulfilledAt: tenDaysAgo,
      createdAt: tenDaysAgo,
    },
  });
  return subscription.id;
}

/** A renewal checkout on `planId`, drafted an hour ago and not paid yet. */
async function draftRenewal(input: {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly planId: string;
  readonly currency?: 'RUB' | 'USD';
  readonly amount?: string;
  readonly draftedAt?: Date;
}): Promise<string> {
  const row = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      status: 'PENDING',
      purchaseType: 'RENEW',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: input.currency ?? 'RUB',
      amount: new Prisma.Decimal(input.amount ?? '200'),
      planSnapshot: { id: input.planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
      createdAt: input.draftedAt ?? new Date(Date.now() - HOUR_MS),
    },
    select: { id: true },
  });
  return row.id;
}

/** The provider's word arrives: COMPLETED, fulfilled the way the webhook does it. */
async function complete(transactionId: string): Promise<void> {
  const row = await prisma.transaction.update({ where: { id: transactionId }, data: { status: 'COMPLETED' } });
  await fulfilment.applyCompletedTransaction(row);
}

/** Базовый → Премиум, 650 ₽ for 30 days, paid and fulfilled now. */
async function upgrade(userId: string, subscriptionId: string, premium: string): Promise<void> {
  const row = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId,
      subscriptionId,
      status: 'COMPLETED',
      purchaseType: PurchaseType.UPGRADE,
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('650'),
      planSnapshot: { id: premium, selectedDurationDays: 30 } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(row);
}

async function subscriptionOf(subscriptionId: string) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: {
      startedAt: true,
      expiresAt: true,
      planSnapshot: true,
      trafficLimit: true,
      deviceLimit: true,
    },
  });
}

function daysBetween(from: Date | null, to: Date | null): number {
  assert.ok(from !== null && to !== null);
  return (to.getTime() - from.getTime()) / DAY_MS;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), JSON.stringify(value));
  return value as Record<string, unknown>;
}

function eventOf(type: string, where: (metadata: Record<string, unknown>) => boolean): Emitted {
  const found = emitted.filter((event) => event.type === type && where(event.metadata));
  assert.equal(found.length, 1, `${type}: ${JSON.stringify(found.map((event) => event.metadata))}`);
  return found[0]!;
}

/** The newest sync job of the subscription, as fulfilment queued it. */
async function lastJobPayload(subscriptionId: string): Promise<Record<string, unknown>> {
  const job = await prisma.profileSyncJob.findFirstOrThrow({
    where: { subscriptionId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  return asRecord(job.payload);
}

/**
 * Runs the subscription's newest PENDING sync job through the real processor
 * and returns the `updateUser` body the panel would have received, and whether
 * the traffic counter was reset.
 */
async function push(subscriptionId: string): Promise<{ body: Record<string, unknown>; resets: number }> {
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
      generateProfileName: async () => ({ username: profile.username, description: 'renewal' }),
      getContactInfo: async () => ({ email: null, telegramId: null }),
    } as never,
    { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
  );
  await processor.process({ data: { syncJobId: job.id } } as never);
  assert.equal(sent.length, 1, 'the job pushed the profile exactly once');
  return { body: sent[0]!, resets };
}

/** The card an operator would read for `metadata`, through the real formatter. */
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
    renderer.info(type, 'SUBSCRIPTION', message, metadata);
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

run('a renewal priced for the plan an upgrade has since left (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    // Written against the legacy renewal; the durable cases turn stages 1 and
    // 2 on themselves (`withDurableModel`). OFF spelled out: they default ON
    // since the 24.09.2026 flip.
    for (const flag of DURABLE_FLAGS) process.env[flag] = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    const record =
      (severity: string) =>
      (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
        emitted.push({ severity, type, message, metadata });
      };
    const events = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR'), emit: () => undefined };
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
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = { in: created.users };
    const steps: Array<() => Promise<unknown>> = [
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

  it('200 ₽ for Базовый, paid after the upgrade to Премиум: +9 days of Премиум, and the upgrade stays', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const subscriptionId = await paidSubscription(userId, plans.basic);
    const renewalId = await draftRenewal({ userId, subscriptionId, planId: plans.basic });
    await upgrade(userId, subscriptionId, plans.premium);
    const upgraded = await subscriptionOf(subscriptionId);
    assert.equal(daysBetween(upgraded.startedAt, upgraded.expiresAt), 36, 'fixture: the upgrade, 30 + 6 converted');

    await complete(renewalId);

    const renewed = await subscriptionOf(subscriptionId);
    assert.equal(daysBetween(upgraded.expiresAt, renewed.expiresAt), 9, '200 ₽ at 21.67 ₽ a day of Премиум');
    assert.equal(asRecord(renewed.planSnapshot)['id'], plans.premium, 'still on the plan the upgrade bought');
    assert.deepEqual(renewed.planSnapshot, upgraded.planSnapshot, 'the snapshot is not touched at all');
    assert.deepEqual([renewed.trafficLimit, renewed.deviceLimit], [500, 5], 'Премиум’s limits, not Базовый’s');
    assert.equal(renewed.startedAt?.getTime(), upgraded.startedAt?.getTime());

    // What it bought, on the payment's own row.
    const payment = await prisma.transaction.findUniqueOrThrow({ where: { id: renewalId } });
    assert.equal(payment.status, 'COMPLETED');
    assert.ok(payment.fulfilledAt !== null);
    assert.deepEqual(asRecord(asRecord(payment.gatewayData)['renewalPricedBeforeUpgrade'])['lines'], [
      {
        subscriptionId,
        paidPlanId: plans.basic,
        currentPlanId: plans.premium,
        days: 9,
        fractionalDays: '9.2308',
        paidDays: 30,
        amount: '200.00',
        currency: 'RUB',
        dearestDay: { price: '650', days: 30 },
      },
    ]);

    // One «Платёж получен», raised as WARNING with the note; «Подписка продлена» on Премиум for 9.
    const completed = eventOf(EVENT_TYPES.PAYMENT_COMPLETED, (metadata) => metadata['paymentId'] === payment.paymentId);
    assert.equal(completed.severity, 'WARNING');
    assert.equal(completed.metadata['code'], 'RENEWAL_PRICED_BEFORE_UPGRADE');
    assert.equal(completed.metadata['planName'], plans.basic, 'what was bought');
    assert.match(String(completed.metadata['note']), /оплата пересчитана по самому дорогому дню нового тарифа: \+9 дн\. вместо 30\./);
    const renewedEvent = eventOf(EVENT_TYPES.SUBSCRIPTION_RENEWED, (metadata) => metadata['subscriptionId'] === subscriptionId);
    assert.equal(renewedEvent.metadata['planName'], plans.premium);
    assert.equal(renewedEvent.metadata['durationDays'], 9);
    const text = await card(EVENT_TYPES.SUBSCRIPTION_RENEWED, 'Подписка продлена', renewedEvent.metadata);
    assert.ok(text.includes(`📥 Оплачено по цене «${plans.basic}» за 30 дн. — на этом тарифе это +9 дн.`), text);

    // Remnawave gets the 9 days, and the new period's traffic.
    const pushed = await push(subscriptionId);
    assert.equal(pushed.body['expireAt'], renewed.expiresAt?.toISOString());
    assert.equal(pushed.resets, 1);
  });

  it('adds no day and starts no period in a currency Премиум has no price in — and asks for a refund', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const subscriptionId = await paidSubscription(userId, plans.basic);
    const renewalId = await draftRenewal({ userId, subscriptionId, planId: plans.basic, currency: 'USD', amount: '3' });
    await upgrade(userId, subscriptionId, plans.premium);
    const upgraded = await subscriptionOf(subscriptionId);

    await complete(renewalId);

    const renewed = await subscriptionOf(subscriptionId);
    assert.equal(renewed.expiresAt?.getTime(), upgraded.expiresAt?.getTime());
    assert.equal(asRecord(renewed.planSnapshot)['id'], plans.premium);
    assert.equal((await lastJobPayload(subscriptionId))['resetTraffic'], undefined, 'no period was bought');
    const payment = await prisma.transaction.findUniqueOrThrow({ where: { id: renewalId } });
    const completed = eventOf(EVENT_TYPES.PAYMENT_COMPLETED, (metadata) => metadata['paymentId'] === payment.paymentId);
    assert.equal(completed.severity, 'WARNING');
    assert.match(String(completed.metadata['note']), /нет цены в USD: дни не добавлены\. Верните деньги или продлите подписку вручную\./);
  });

  it('a renewal of two subscriptions, one of them upgraded since: that line buys 9 days of Премиум, the other its 30', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const upgradedId = await paidSubscription(userId, plans.basic);
    const otherId = await paidSubscription(userId, plans.basic);
    const combined = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId,
        subscriptionId: null,
        status: 'PENDING',
        purchaseType: 'RENEW',
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'RUB',
        amount: new Prisma.Decimal('400'),
        planSnapshot: { combinedRenewal: true, snapshotVersion: 1, itemCount: 2 } as Prisma.InputJsonValue,
        createdAt: new Date(Date.now() - HOUR_MS),
        items: {
          create: [upgradedId, otherId].map((subscriptionId) => ({
            subscriptionId,
            planId: plans.basic,
            planSnapshot: {},
            durationDays: 30,
            amount: new Prisma.Decimal('200'),
            currency: 'RUB' as const,
          })),
        },
      },
      select: { id: true, paymentId: true },
    });
    await upgrade(userId, upgradedId, plans.premium);
    const before = { upgraded: await subscriptionOf(upgradedId), other: await subscriptionOf(otherId) };

    await complete(combined.id);

    const upgradedNow = await subscriptionOf(upgradedId);
    const otherNow = await subscriptionOf(otherId);
    assert.equal(daysBetween(before.upgraded.expiresAt, upgradedNow.expiresAt), 9);
    assert.equal(asRecord(upgradedNow.planSnapshot)['id'], plans.premium);
    assert.equal(daysBetween(before.other.expiresAt, otherNow.expiresAt), 30, 'the other line renews as it always did');
    assert.equal(asRecord(otherNow.planSnapshot)['id'], plans.basic);

    const payment = await prisma.transaction.findUniqueOrThrow({ where: { id: combined.id } });
    const lines = asRecord(asRecord(payment.gatewayData)['renewalPricedBeforeUpgrade'])['lines'] as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(
      lines.map((line) => [line['subscriptionId'], line['currentPlanId'], line['paidDays'], line['days']]),
      [[upgradedId, plans.premium, 30, 9]],
    );
    const completed = eventOf(EVENT_TYPES.PAYMENT_COMPLETED, (metadata) => metadata['paymentId'] === combined.paymentId);
    assert.equal(completed.severity, 'WARNING');
    assert.equal(completed.metadata['code'], 'RENEWAL_PRICED_BEFORE_UPGRADE');
    assert.match(String(completed.metadata['note']), new RegExp(`подписку ${upgradedId} уже улучшили`));
    const upgradedCard = eventOf(EVENT_TYPES.SUBSCRIPTION_RENEWED, (metadata) => metadata['subscriptionId'] === upgradedId);
    assert.deepEqual(
      [upgradedCard.metadata['planName'], upgradedCard.metadata['durationDays'], upgradedCard.metadata['renewalPricedForPlan']],
      [plans.premium, 9, plans.basic],
    );
    const otherCard = eventOf(EVENT_TYPES.SUBSCRIPTION_RENEWED, (metadata) => metadata['subscriptionId'] === otherId);
    assert.deepEqual(
      [otherCard.metadata['planName'], otherCard.metadata['durationDays'], otherCard.metadata['renewalPricedForPlan']],
      [plans.basic, 30, undefined],
    );
  });

  it('durable model: the renewal appends a term of Премиум for the 9 days, ending where the subscription does', async () => {
    await withDurableModel(async () => {
      const plans = await createPlans();
      const userId = await createUser();
      const subscriptionId = await paidSubscription(userId, plans.basic);
      await prisma.$transaction((tx) => cutover.cutoverSubscriptionInTransaction(tx, { id: subscriptionId } as never));
      const renewalId = await draftRenewal({ userId, subscriptionId, planId: plans.basic });
      await upgrade(userId, subscriptionId, plans.premium);

      await complete(renewalId);

      const scheduled = await prisma.subscriptionTerm.findMany({
        where: { subscriptionId, status: 'SCHEDULED' },
      });
      assert.equal(scheduled.length, 1);
      const term = scheduled[0]!;
      assert.equal(term.planId, plans.premium, 'a term of the old plan would put it back when it starts');
      assert.equal(daysBetween(term.startsAt, term.endsAt), 9);
      assert.equal(term.endsAt?.getTime(), (await subscriptionOf(subscriptionId)).expiresAt?.getTime());
    });
  });

  it('leaves a renewal drafted after the upgrade as it always was: onto the plan it paid for, for its whole period', async () => {
    const plans = await createPlans();
    const userId = await createUser();
    const subscriptionId = await paidSubscription(userId, plans.basic);
    await upgrade(userId, subscriptionId, plans.premium);
    // Drafted after the last start: a renewal onto another plan on purpose —
    // Премиум is archived and renews onto Базовый. (Onto a plan that renews as
    // itself, a renewal for another plan was drafted before a plan change, and
    // is converted: `readRenewalPricedBeforePlanChange`.)
    await prisma.plan.update({
      where: { id: plans.premium },
      data: { isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: [plans.basic] },
    });
    const renewalId = await draftRenewal({ userId, subscriptionId, planId: plans.basic, draftedAt: new Date() });
    const upgraded = await subscriptionOf(subscriptionId);

    await complete(renewalId);

    const renewed = await subscriptionOf(subscriptionId);
    assert.equal(daysBetween(upgraded.expiresAt, renewed.expiresAt), 30);
    assert.equal(asRecord(renewed.planSnapshot)['id'], plans.basic);
    const payment = await prisma.transaction.findUniqueOrThrow({ where: { id: renewalId } });
    assert.equal(asRecord(payment.gatewayData ?? {})['renewalPricedBeforeUpgrade'], undefined);
    assert.equal(
      eventOf(EVENT_TYPES.PAYMENT_COMPLETED, (metadata) => metadata['paymentId'] === payment.paymentId).severity,
      'INFO',
    );
  });
});
