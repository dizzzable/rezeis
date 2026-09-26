import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AddOnType, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { InternalAddOnsController } from '../src/modules/add-ons/controllers/internal-add-ons.controller';
import { AddOnEligibilityService } from '../src/modules/add-ons/services/add-on-eligibility.service';
import { InternalAddOnsPurchaseController } from '../src/modules/payments/controllers/internal-addons-purchase.controller';
import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { capabilityRowsHostedBy } from '../src/modules/reiwa-peers/cabinet-capabilities';
import { ReiwaPeerRegistry } from '../src/modules/reiwa-peers/reiwa-peer-registry.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { memoryRawCache } from './helpers/memory-raw-cache';

/**
 * «ДО СБРОСА» THROUGH THE CABINET ROUTES, AGAINST POSTGRESQL (pair reliability, 26.09.2026)
 *
 * The real listing and the real checkout, reached through the two internal
 * controllers the cabinet calls, with the caller's headers deciding the
 * audience (`ReiwaPeerRegistry.viewOfRequest`), on a subscription in the term
 * model on a monthly-reset plan with stage 4 on:
 *
 *  - without the headers and without any evidence of a 0.9.7.53 cabinet, the
 *    checkout answers 400 `ADDON_LIFETIME_UNAVAILABLE` and `transactions`
 *    gets no row — no draft, no invoice, no money;
 *  - with the headers of a cabinet that declares `web.addon-reset-end`, the
 *    draft is written «до сброса»;
 *  - a silent caller whose 0.9.7.53 poll is live is served as before;
 *  - devices are sold to any cabinet.
 *
 * The registry's store is in memory: this job has PostgreSQL and no Redis, and
 * the store is not what is under test here. Skipped without TEST_DATABASE_URL;
 * listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `capgate-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;

const DECLARED = {
  'x-reiwa-client': 'surface=api; version=0.9.7.54; commit=0123456789ab; instance=reiwa',
  'x-reiwa-capabilities': capabilityRowsHostedBy('api').map((row) => row.id).join(','),
};

let prisma: PrismaService;
let offers: AddOnEligibilityService;
let checkout: AddOnPurchaseService;
let cutover: EntitlementCutoverService;
const createdUsers: string[] = [];
const createdAddOns: string[] = [];
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

interface Owner {
  readonly userId: string;
  readonly subscriptionId: string;
}

/** A subscriber on a 100 GB / 3-device plan that resets MONTH, in the term model, ending in 20 days. */
async function subscriber(): Promise<Owner> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  createdUsers.push(userId);
  const panelId = 880_000 + next();
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: `${prefix}-plan`,
        name: 'Pro',
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'MONTH',
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
    },
    select: { id: true },
  });
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.id));
  assert.equal(entered.outcome, 'CREATED', 'fixture: in the term model');
  return { userId, subscriptionId: row.id };
}

/** A catalogue add-on for every plan, at 99 RUB. */
async function catalogAddOn(type: AddOnType): Promise<string> {
  const id = `${prefix}-addon-${next()}`;
  await prisma.addOn.create({
    data: { id, name: id, type, value: type === AddOnType.EXTRA_DEVICES ? 1 : 50, prices: { create: [{ currency: 'RUB', price: '99' }] } },
  });
  createdAddOns.push(id);
  return id;
}

/** The two cabinet routes over one registry, as the API container wires them. */
function routes() {
  const peers = new ReiwaPeerRegistry(memoryRawCache().store);
  const describeAllowance = async () => ({ freeUsesPerTerm: 0, freeRemaining: 0, isFree: false });
  return {
    peers,
    listing: new InternalAddOnsController({} as never, offers, { describeAllowance } as never, peers),
    purchase: new InternalAddOnsPurchaseController(checkout, peers),
  };
}

function purchaseOf(owner: Owner, addOnId: string) {
  return {
    userId: owner.userId,
    addOnId,
    subscriptionId: owner.subscriptionId,
    gatewayType: 'YOOKASSA',
    contractVersion: 2,
  } as never;
}

function codeOf(error: unknown): string | null {
  const body = (error as { getResponse?: () => unknown }).getResponse?.();
  return typeof body === 'object' && body !== null && 'code' in body ? String((body as Record<string, unknown>)['code']) : null;
}

run('«до сброса» through the cabinet routes (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    const terms = new SubscriptionTermService();
    cutover = new EntitlementCutoverService(prisma, terms, new EffectiveProjectionService());
    const switches = {
      flags: async () => resolveAddOnRolloutFlags({ durableAccounting: true, trafficResetExpiry: true }, {}),
    };
    const events = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
    offers = new AddOnEligibilityService(prisma, {} as never, switches as never);
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
      {} as never,
      { enqueue: async () => undefined } as never,
      { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
      { evaluate: () => null } as never,
      events as never,
      terms,
      switches as never,
    );
    await prisma.paymentGateway.upsert({
      where: { type: 'YOOKASSA' },
      update: { isActive: true, currency: 'RUB', settings: { shopId: 's', apiKey: 'k' } },
      create: { type: 'YOOKASSA', isActive: true, currency: 'RUB', settings: { shopId: 's', apiKey: 'k' } },
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, createdUsers).catch((error: unknown) => {
      console.error('capability gate cleanup failed', error);
    });
    await prisma.addOn.deleteMany({ where: { id: { in: createdAddOns } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('without the headers and without evidence: 400, and `transactions` gets no row', async () => {
    const owner = await subscriber();
    const traffic = await catalogAddOn(AddOnType.EXTRA_TRAFFIC);
    const { listing, purchase } = routes();

    const offered = await listing.listForSubscription(owner.subscriptionId, owner.userId, undefined, {});
    assert.equal(offered.addOns.some((addOn) => addOn.id === traffic), false, 'not offered');
    await assert.rejects(
      () => purchase.purchase(purchaseOf(owner, traffic), {}),
      (error: unknown) => codeOf(error) === 'ADDON_LIFETIME_UNAVAILABLE',
    );
    assert.equal(await prisma.transaction.count({ where: { userId: owner.userId } }), 0);
  });

  it('with the headers of a cabinet that declares it: offered and drafted «до сброса»', async () => {
    const owner = await subscriber();
    const traffic = await catalogAddOn(AddOnType.EXTRA_TRAFFIC);
    const { listing, purchase } = routes();

    const offered = await listing.listForSubscription(owner.subscriptionId, owner.userId, undefined, DECLARED);
    assert.equal(offered.addOns.find((addOn) => addOn.id === traffic)?.lifetime, 'UNTIL_NEXT_RESET');
    const answer = await purchase.purchase(purchaseOf(owner, traffic), DECLARED);
    const draft = await prisma.transaction.findUniqueOrThrow({ where: { paymentId: answer.paymentId } });
    assert.equal(draft.userId, owner.userId);
    assert.equal((draft.planSnapshot as Record<string, unknown>)['lifetime'], 'UNTIL_NEXT_RESET');
  });

  it('a silent caller whose 0.9.7.53 poll is live is served as before', async () => {
    const owner = await subscriber();
    const traffic = await catalogAddOn(AddOnType.EXTRA_TRAFFIC);
    const { listing, purchase, peers } = routes();
    await peers.observePoll('api', {});

    const offered = await listing.listForSubscription(owner.subscriptionId, owner.userId, undefined, {});
    assert.equal(offered.addOns.find((addOn) => addOn.id === traffic)?.lifetime, 'UNTIL_NEXT_RESET');
    await purchase.purchase(purchaseOf(owner, traffic), {});
    assert.equal(await prisma.transaction.count({ where: { userId: owner.userId } }), 1);
  });

  it('devices are sold to any cabinet', async () => {
    const owner = await subscriber();
    const devices = await catalogAddOn(AddOnType.EXTRA_DEVICES);
    const { purchase } = routes();
    await purchase.purchase(purchaseOf(owner, devices), {});
    assert.equal(await prisma.transaction.count({ where: { userId: owner.userId } }), 1);
  });
});
