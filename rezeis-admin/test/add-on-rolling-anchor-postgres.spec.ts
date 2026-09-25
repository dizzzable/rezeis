import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  AddOnType,
  Prisma,
  PurchaseType,
  SubscriptionStatus,
  SubscriptionTermStatus,
  type Transaction,
  type TrafficLimitStrategy,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  resolveAddOnRolloutFlags,
  type StoredAddOnSwitches,
} from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { planResetEpoch } from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * P2, THE TERM SIDE — MONTH_ROLLING COUNTS FROM THE PROFILE (stage 4,
 * 25.09.2026), against PostgreSQL.
 *
 * Remnawave resets a MONTH_ROLLING profile on the day of the month it was
 * CREATED. The panel stores that `createdAt` on the subscription
 * (`remnawave_profile_created_at`, S4-sync). Every term minted from here on —
 * by the cutover, a paid renewal, a paid upgrade, a plan change, a changed
 * reset rule — takes it as its anchor instead of NULL, falling back to the
 * rolling anchor a term of the subscription already carries; the checkout
 * reads it for a term minted before it was known. Unknown stays unknown:
 * nothing is guessed from the term's start.
 *
 * Skipped without TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `s4anchor-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;

interface Owner {
  readonly userId: string;
  readonly subscriptionId: string;
}

let prisma: PrismaService;
let checkout: AddOnPurchaseService;
let fulfilment: PaymentSubscriptionMutationService;
let cutover: EntitlementCutoverService;
let terms: SubscriptionTermService;
const created = { users: [] as string[], addOns: [] as string[], plans: [] as string[] };
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

const switches = { stored: {} as StoredAddOnSwitches };
const switchReader = { flags: async () => resolveAddOnRolloutFlags(switches.stored, {}) };
const STAGE_4_ON: StoredAddOnSwitches = { durableAccounting: true, trafficResetExpiry: true };

/** A profile created long ago on an ordinary day: the anchor most cases use. */
const PROFILE_CREATED_AT = new Date('2025-06-17T09:30:00.000Z');

/**
 * A profile whose Remnawave reset is TOMORROW, 00:10 UTC: created a year ago
 * on tomorrow's day of the month. Earlier than any MONTH reset (the 1st,
 * 00:20), so a «до сброса» add-on re-dated to it moves visibly.
 */
function profileResettingTomorrow(): Date {
  const tomorrow = inDays(1);
  return new Date(Date.UTC(tomorrow.getUTCFullYear() - 1, tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 12));
}

/** Where Remnawave's next MONTH_ROLLING reset of a profile created at `createdAt` falls. */
function rollingEpoch(createdAt: Date) {
  const epoch = planResetEpoch({
    strategy: 'MONTH_ROLLING',
    capability: 'ENABLED',
    anchorAt: createdAt,
    referenceAt: new Date(),
  });
  assert.ok(epoch !== null, 'fixture: the profile has a next reset');
  return epoch;
}

async function newUser(): Promise<string> {
  const id = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: id } });
  created.users.push(id);
  return id;
}

async function plan(
  strategy: TrafficLimitStrategy,
  options: { readonly upgradeToPlanIds?: readonly string[] } = {},
): Promise<string> {
  const id = `${prefix}-plan-${next()}`;
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 920_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      trafficLimitStrategy: strategy,
      availability: 'ALL',
      upgradeToPlanIds: [...(options.upgradeToPlanIds ?? [])],
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
    },
  });
  created.plans.push(id);
  return id;
}

/**
 * A subscription on a 100 GB / 3-device plan that resets by `strategy`, ending
 * in 20 days, brought into the term model by the cutover — with the profile's
 * `createdAt` stored when `profileCreatedAt` is given.
 */
async function subscription(options: {
  readonly strategy: TrafficLimitStrategy;
  readonly planId?: string;
  readonly profileCreatedAt?: Date;
}): Promise<Owner> {
  const userId = await newUser();
  const panelId = 880_000 + next();
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: options.planId ?? `${prefix}-plan`,
        name: 'Pro',
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: options.strategy,
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
      } as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      createdAt: inDays(-10),
      startedAt: inDays(-10),
      expiresAt: inDays(20),
      remnawaveProfileCreatedAt: options.profileCreatedAt ?? null,
    },
    select: { id: true },
  });
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.id));
  assert.equal(entered.outcome, 'CREATED', 'fixture: in the term model');
  return { userId, subscriptionId: row.id };
}

async function termsOf(subscriptionId: string, status: SubscriptionTermStatus) {
  return prisma.subscriptionTerm.findMany({
    where: { subscriptionId, status },
    orderBy: { generation: 'asc' },
  });
}

async function activeTermOf(subscriptionId: string) {
  const [term] = await termsOf(subscriptionId, SubscriptionTermStatus.ACTIVE);
  assert.ok(term, 'an ACTIVE term');
  return term;
}

async function catalogAddOn(): Promise<string> {
  const id = `${prefix}-addon-${next()}`;
  await prisma.addOn.create({
    data: { id, name: id, type: AddOnType.EXTRA_TRAFFIC, value: 50, prices: { create: [{ currency: 'RUB', price: '99' }] } },
  });
  created.addOns.push(id);
  return id;
}

async function checkOut(owner: Owner, addOnId: string): Promise<Transaction> {
  const answer = await checkout.checkout({
    userId: owner.userId,
    addOnId,
    subscriptionId: owner.subscriptionId,
    gatewayType: 'YOOKASSA' as never,
    contractVersion: 2,
  });
  return prisma.transaction.findUniqueOrThrow({ where: { paymentId: answer.paymentId } });
}

async function capture(draft: Transaction): Promise<void> {
  const paid = await prisma.transaction.update({ where: { id: draft.id }, data: { status: 'COMPLETED' } });
  await fulfilment.applyCompletedTransaction(paid);
}

/** A paid plan purchase of `type` for `planId`, fulfilled the way the payment webhook does it. */
async function pay(owner: Owner, type: PurchaseType, planId: string): Promise<void> {
  const row = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: owner.subscriptionId,
      status: 'COMPLETED',
      purchaseType: type,
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('299'),
      planSnapshot: { id: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
    },
  });
  await fulfilment.applyCompletedTransaction(row);
}

async function entitlementOf(transactionId: string) {
  return prisma.addOnEntitlement.findFirst({ where: { sourceTransactionId: transactionId } });
}

run('MONTH_ROLLING counts from the Remnawave profile (P2, PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      new AddOnEntitlementService(),
      projection,
      terms,
      {} as never,
      cutover,
      switchReader as never,
    );
    checkout = new AddOnPurchaseService(
      prisma,
      new PricingService(),
      {
        createCheckout: async () => ({
          gatewayId: 'g',
          gatewayData: {},
          checkoutUrl: 'https://pay.example/x',
          providerMode: 'REDIRECT',
        }),
      } as never,
      fulfilment,
      { enqueue: async () => undefined } as never,
      { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
      { evaluate: () => null } as never,
      events as never,
      terms,
      switchReader as never,
    );
    await prisma.paymentGateway.upsert({
      where: { type: 'YOOKASSA' },
      update: { isActive: true, currency: 'RUB', settings: { shopId: 's', apiKey: 'k' } },
      create: { type: 'YOOKASSA', isActive: true, currency: 'RUB', settings: { shopId: 's', apiKey: 'k' } },
    });
  });

  beforeEach(() => {
    switches.stored = STAGE_4_ON;
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('rolling anchor cleanup failed', error);
    });
    await prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('the cutover mints a rolling term at the stored profile createdAt; unknown stays NULL; calendar keeps its start', async () => {
    const known = await subscription({ strategy: 'MONTH_ROLLING', profileCreatedAt: PROFILE_CREATED_AT });
    assert.equal((await activeTermOf(known.subscriptionId)).resetAnchorAt?.toISOString(), PROFILE_CREATED_AT.toISOString());

    const unknown = await subscription({ strategy: 'MONTH_ROLLING' });
    assert.equal((await activeTermOf(unknown.subscriptionId)).resetAnchorAt, null, 'nothing is guessed');

    const calendar = await subscription({ strategy: 'MONTH', profileCreatedAt: PROFILE_CREATED_AT });
    const term = await activeTermOf(calendar.subscriptionId);
    assert.equal(term.resetAnchorAt?.toISOString(), term.startsAt.toISOString());
  });

  it('a paid renewal queues its rolling term at the profile createdAt — or at the rolling anchor a term already carries', async () => {
    const rolling = await plan('MONTH_ROLLING');

    const stored = await subscription({ strategy: 'MONTH_ROLLING', planId: rolling, profileCreatedAt: PROFILE_CREATED_AT });
    await pay(stored, PurchaseType.RENEW, rolling);
    const [queued] = await termsOf(stored.subscriptionId, SubscriptionTermStatus.SCHEDULED);
    assert.ok(queued, 'fixture: the renewal queued its term');
    assert.equal(queued.resetAnchorAt?.toISOString(), PROFILE_CREATED_AT.toISOString());

    // Nothing stored on the subscription, but the boundary's panel read
    // stamped the ACTIVE term: the renewal's term takes that one.
    const stamped = await subscription({ strategy: 'MONTH_ROLLING', planId: rolling });
    await prisma.subscriptionTerm.updateMany({
      where: { subscriptionId: stamped.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      data: { resetAnchorAt: PROFILE_CREATED_AT },
    });
    await pay(stamped, PurchaseType.RENEW, rolling);
    const [fromTerm] = await termsOf(stamped.subscriptionId, SubscriptionTermStatus.SCHEDULED);
    assert.equal(fromTerm?.resetAnchorAt?.toISOString(), PROFILE_CREATED_AT.toISOString());
  });

  it('a paid upgrade onto a rolling plan starts its term at the profile createdAt, and a «до сброса» add-on ends at the rolling reset', async () => {
    const target = await plan('MONTH_ROLLING');
    const base = await plan('MONTH', { upgradeToPlanIds: [target] });
    const createdAt = profileResettingTomorrow();
    const owner = await subscription({ strategy: 'MONTH', planId: base, profileCreatedAt: createdAt });
    const draft = await checkOut(owner, await catalogAddOn());
    await capture(draft);
    const sold = await entitlementOf(draft.id);
    assert.ok(sold?.expiresAt, 'fixture: sold «до сброса» on the MONTH plan');

    await pay(owner, PurchaseType.UPGRADE, target);

    const term = await activeTermOf(owner.subscriptionId);
    assert.equal(term.planId, target, 'fixture: upgraded');
    assert.equal(term.resetAnchorAt?.toISOString(), createdAt.toISOString());
    const expected = rollingEpoch(createdAt);
    assert.ok(expected.expiresAt.getTime() < sold.expiresAt.getTime(), 'fixture: the rolling reset comes first');
    const after = await entitlementOf(draft.id);
    assert.equal(after?.state, 'ACTIVE');
    assert.equal(after?.expiresAt?.toISOString(), expected.expiresAt.toISOString());
  });

  it('a plan change onto a rolling plan mints its term at the profile createdAt and re-dates the add-on to it', async () => {
    const rolling = await plan('MONTH_ROLLING');
    const createdAt = profileResettingTomorrow();
    const owner = await subscription({ strategy: 'MONTH', profileCreatedAt: createdAt });
    const draft = await checkOut(owner, await catalogAddOn());
    await capture(draft);
    const target = await prisma.plan.findUniqueOrThrow({ where: { id: rolling } });

    const rotated = await prisma.$transaction((tx) =>
      terms.rotateForPlanChangeInTransaction(tx, {
        subscriptionId: owner.subscriptionId,
        plan: target,
        snapshotSource: 'ADMIN_PLAN_ASSIGNMENT_TERM',
        scheduledTerms: 'CANCEL_UNBOUND',
      }),
    );

    assert.equal(rotated.outcome, 'ROTATED');
    assert.equal((await activeTermOf(owner.subscriptionId)).resetAnchorAt?.toISOString(), createdAt.toISOString());
    assert.equal((await entitlementOf(draft.id))?.expiresAt?.toISOString(), rollingEpoch(createdAt).expiresAt.toISOString());

    // Never known: the calendar term's start is not a stand-in for it.
    const unknown = await subscription({ strategy: 'MONTH' });
    await prisma.$transaction((tx) =>
      terms.rotateForPlanChangeInTransaction(tx, {
        subscriptionId: unknown.subscriptionId,
        plan: target,
        snapshotSource: 'ADMIN_PLAN_ASSIGNMENT_TERM',
        scheduledTerms: 'CANCEL_UNBOUND',
      }),
    );
    assert.equal((await activeTermOf(unknown.subscriptionId)).resetAnchorAt, null);
  });

  it('a reset rule turned MONTH_ROLLING anchors the terms at the profile createdAt and re-dates the add-on to it', async () => {
    const createdAt = profileResettingTomorrow();
    const owner = await subscription({ strategy: 'MONTH', profileCreatedAt: createdAt });
    const draft = await checkOut(owner, await catalogAddOn());
    await capture(draft);

    const followed = await prisma.$transaction((tx) =>
      terms.followResetRuleInTransaction(tx, { subscriptionId: owner.subscriptionId, strategy: 'MONTH_ROLLING' }),
    );

    assert.equal(followed.termsUpdated, 1);
    const term = await activeTermOf(owner.subscriptionId);
    assert.equal(term.trafficResetStrategy, 'MONTH_ROLLING');
    assert.equal(term.resetAnchorAt?.toISOString(), createdAt.toISOString());
    assert.deepEqual(followed.redatedEntitlementIds, [(await entitlementOf(draft.id))?.id]);
    assert.equal((await entitlementOf(draft.id))?.expiresAt?.toISOString(), rollingEpoch(createdAt).expiresAt.toISOString());
  });

  it('the checkout sells «до сброса» on a rolling term minted before the createdAt was known, from the stored one', async () => {
    const owner = await subscription({ strategy: 'MONTH_ROLLING', profileCreatedAt: PROFILE_CREATED_AT });
    // As a term minted before P2 stands: no anchor of its own.
    await prisma.subscriptionTerm.updateMany({
      where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      data: { resetAnchorAt: null },
    });

    const draft = await checkOut(owner, await catalogAddOn());

    const marker = draft.planSnapshot as Record<string, unknown>;
    assert.equal(marker['lifetime'], 'UNTIL_NEXT_RESET');
    assert.equal(
      new Date(String(marker['quotedResetAt'])).toISOString(),
      rollingEpoch(PROFILE_CREATED_AT).plannedEndsAt.toISOString(),
    );
  });
});
