import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AddOnType, Prisma, SubscriptionStatus, SubscriptionTermStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { AddOnEligibilityService } from '../src/modules/add-ons/services/add-on-eligibility.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * THE OFFER SAYS «DATED» EXACTLY WHEN THE PURCHASE IS RECORDED WITH AN END —
 * against PostgreSQL, with the real offer and the real fulfilment.
 *
 * `eligibility.dated` is the cabinet's only licence to say «Действует до …».
 * It is computed by `isAddOnPurchaseDated` from the gates the
 * fulfilment passes before it ledgers a purchase, and the fulfilment does not
 * call it — so each case here lists the add-on, buys it through
 * `applyCompletedTransaction` as the payment webhook does, and holds the two
 * together: `dated` is true exactly when an entitlement with an end was
 * recorded, and then its end is the offer's `expiresAt`.
 *
 * Runs only with TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `p10dated-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);
const FLAGS = { shadow: 'ADDON_ENTITLEMENT_SHADOW', direct: 'ADDON_ENTITLEMENT_DIRECT_PURCHASE' } as const;

let prisma: PrismaService;
let offers: AddOnEligibilityService;
let fulfilment: PaymentSubscriptionMutationService;
let cutover: EntitlementCutoverService;
let terms: SubscriptionTermService;
const created = { users: [] as string[], addOns: [] as string[] };
let counter = 0;
const next = (): number => ++counter;

async function withFlags<T>(
  flags: { readonly shadow?: boolean; readonly direct?: boolean },
  body: () => Promise<T>,
): Promise<T> {
  const previous = Object.values(FLAGS).map((name) => [name, process.env[name]] as const);
  for (const [key, name] of Object.entries(FLAGS)) {
    if (flags[key as keyof typeof flags] === true) process.env[name] = 'true';
    else process.env[name] = 'false';
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

/** An ACTIVE subscription on a 100 GB / 3-device plan, ending in 20 days unless said. */
async function subscription(options: { readonly expiresAt?: Date | null } = {}): Promise<{
  readonly userId: string;
  readonly subscriptionId: string;
}> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  created.users.push(userId);
  const planId = `${prefix}-plan`;
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: planId,
        name: 'Pro',
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
      externalSquad: null,
      createdAt: inDays(-10),
      startedAt: inDays(-10),
      expiresAt: options.expiresAt === undefined ? inDays(20) : options.expiresAt,
    },
    select: { id: true },
  });
  return { userId, subscriptionId: row.id };
}

/** Into the term model, as the background cutover brings it. */
async function enter(subscriptionId: string): Promise<void> {
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscriptionId));
  assert.equal(entered.outcome, 'CREATED', 'fixture: entered the model');
}

/** A catalog add-on for every plan: +10 GB until the end of the subscription. */
async function catalogAddOn(): Promise<string> {
  const id = `${prefix}-addon-${next()}`;
  await prisma.addOn.create({
    data: {
      id,
      name: id,
      type: AddOnType.EXTRA_TRAFFIC,
      value: 10,
      lifetime: 'UNTIL_SUBSCRIPTION_END',
      prices: { create: [{ currency: 'RUB', price: '99' }] },
    },
  });
  created.addOns.push(id);
  return id;
}

/** What the offer says of `addOnId` on this subscription. */
async function offerOf(subscriptionId: string, addOnId: string): Promise<{ dated: boolean; expiresAt: string | null }> {
  const listing = await offers.listForSubscription(subscriptionId);
  const offered = listing.addOns.find((addOn) => addOn.id === addOnId);
  assert.ok(offered !== undefined, 'fixture: the add-on is offered');
  return { dated: offered.eligibility.dated, expiresAt: offered.eligibility.expiresAt };
}

/** Bought through the checkout's marker and fulfilled the way the payment webhook does it. */
async function buy(owner: { readonly userId: string; readonly subscriptionId: string }, addOnId: string): Promise<string> {
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
        addOnType: AddOnType.EXTRA_TRAFFIC,
        addOnValue: 10,
        name: addOnId,
        targetSubscriptionId: owner.subscriptionId,
        purchaseType: 'ADDITIONAL',
        gatewayType: 'YOOKASSA',
        amount: '99',
        currency: 'RUB',
        contractVersion: 2,
        addOnRevision: 1,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        sourceLineKey: addOnId,
      } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(transaction);
  return transaction.id;
}

/**
 * The offer before the purchase, and what the purchase recorded: the two must
 * agree — dated exactly when an entitlement with an end exists, at the offer's
 * date.
 */
async function offerThenBuy(owner: { readonly userId: string; readonly subscriptionId: string }): Promise<{
  readonly dated: boolean;
  readonly offeredEnd: string | null;
  readonly recordedEnd: string | null | undefined;
}> {
  const addOnId = await catalogAddOn();
  const offer = await offerOf(owner.subscriptionId, addOnId);
  const transactionId = await buy(owner, addOnId);
  const recorded = await prisma.addOnEntitlement.findFirst({
    where: { subscriptionId: owner.subscriptionId, sourceTransactionId: transactionId },
    select: { expiresAt: true },
  });
  const recordedEnd = recorded === null ? undefined : (recorded.expiresAt?.toISOString() ?? null);
  assert.equal(
    offer.dated,
    typeof recordedEnd === 'string',
    `the offer said dated=${String(offer.dated)}; the purchase recorded ${
      recordedEnd === undefined ? 'no entitlement (the permanent increment)' : `an entitlement ending ${String(recordedEnd)}`
    }`,
  );
  if (offer.dated) assert.equal(recordedEnd, offer.expiresAt, 'the date shown is the date recorded');
  return { dated: offer.dated, offeredEnd: offer.expiresAt, recordedEnd };
}

run('the offer’s «dated» against the real fulfilment — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      new AddOnEntitlementService(),
      projection,
      terms,
      {} as never,
      cutover,
    );
    offers = new AddOnEligibilityService(prisma, {} as never);
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('dated offer cleanup failed', error);
    });
    await prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('stage 2 off, in the model: not dated — and the purchase is the permanent increment', async () => {
    const owner = await subscription();
    await enter(owner.subscriptionId);
    const outcome = await withFlags({ shadow: true }, () => offerThenBuy(owner));
    assert.equal(outcome.dated, false);
    assert.equal(outcome.offeredEnd !== null, true, 'the offer still knows when it would end — and must not say it');
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: owner.subscriptionId } });
    assert.equal(row.trafficLimit, 110, 'the legacy increment');
  });

  it('stage 2 on, in the model: dated — and the purchase ends where the offer said', async () => {
    const owner = await subscription();
    await enter(owner.subscriptionId);
    const outcome = await withFlags({ direct: true }, () => offerThenBuy(owner));
    assert.equal(outcome.dated, true);
  });

  it('stage 2 on, stage 1 off, not in the model: not dated — the purchase cannot bring it in', async () => {
    const owner = await subscription();
    const outcome = await withFlags({ direct: true }, () => offerThenBuy(owner));
    assert.equal(outcome.dated, false);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: owner.subscriptionId } }), 0);
  });

  it('stages 1 and 2 on, not in the model yet: dated — the purchase brings it in and ledgers it', async () => {
    const owner = await subscription();
    const outcome = await withFlags({ shadow: true, direct: true }, () => offerThenBuy(owner));
    assert.equal(outcome.dated, true);
  });

  it('a lifetime subscription whose term still carries an end: not dated — the purchase aligns the term open and falls back', async () => {
    const owner = await subscription();
    await enter(owner.subscriptionId);
    await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: null } });
    const outcome = await withFlags({ direct: true }, () => offerThenBuy(owner));
    assert.equal(outcome.dated, false);
  });

  it('a paid renewal queued after the current period: dated, to the end of the CURRENT period', async () => {
    const owner = await subscription();
    await enter(owner.subscriptionId);
    const active = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    });
    const renewalEnd = new Date(active.endsAt!.getTime() + 30 * DAY_MS);
    await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId: owner.subscriptionId,
        planId: `${prefix}-plan`,
        planSnapshot: {} as Prisma.InputJsonValue,
        startsAt: active.endsAt!,
        endsAt: renewalEnd,
        baseTrafficLimitBytes: active.baseTrafficLimitBytes,
        baseDeviceLimit: active.baseDeviceLimit,
        trafficResetStrategy: active.trafficResetStrategy,
        resetAnchorAt: active.resetAnchorAt,
      }),
    );
    await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: renewalEnd } });

    const outcome = await withFlags({ direct: true }, () => offerThenBuy(owner));
    assert.equal(outcome.dated, true);
    assert.equal(outcome.recordedEnd, active.endsAt!.toISOString());
  });

  it('a queued renewal on a subscription made lifetime since: still dated, to the end of the CURRENT period', async () => {
    // The purchase aligns the queued term open and leaves the current one: its
    // end is what the add-on is recorded with, not the subscription's (none).
    const owner = await subscription();
    await enter(owner.subscriptionId);
    const active = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    });
    await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId: owner.subscriptionId,
        planId: `${prefix}-plan`,
        planSnapshot: {} as Prisma.InputJsonValue,
        startsAt: active.endsAt!,
        endsAt: new Date(active.endsAt!.getTime() + 30 * DAY_MS),
        baseTrafficLimitBytes: active.baseTrafficLimitBytes,
        baseDeviceLimit: active.baseDeviceLimit,
        trafficResetStrategy: active.trafficResetStrategy,
        resetAnchorAt: active.resetAnchorAt,
      }),
    );
    await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: null } });

    const outcome = await withFlags({ direct: true }, () => offerThenBuy(owner));
    assert.equal(outcome.dated, true);
    assert.equal(outcome.recordedEnd, active.endsAt!.toISOString());
  });
});
