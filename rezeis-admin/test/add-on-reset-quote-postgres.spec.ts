import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  AddOnLifetime,
  AddOnType,
  Prisma,
  PurchaseType,
  SubscriptionStatus,
  SubscriptionTermStatus,
  type Transaction,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import {
  resolveAddOnRolloutFlags,
  type StoredAddOnSwitches,
} from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { RESET_EXPIRY_MARGIN_MS } from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import { AddOnRefundService } from '../src/modules/payments/services/addon-refund.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * «ДО СБРОСА» ON THE MONEY PATH, against PostgreSQL, through the real
 * checkout and the real fulfilment (stage 4, 25.09.2026).
 *
 *  1. The capture honours the QUOTE the customer paid for, whatever the
 *     switches say by then: stage 4 switched off between checkout and capture
 *     still delivers «до сброса» with the quoted window and end; switched on,
 *     a «до конца подписки» quote stays one.
 *  2. A «до сброса» quote is NEVER the permanent legacy increment: ledgered
 *     even when stage 2 went off, and recorded as not applied — with the
 *     operator's card — when nothing can be delivered.
 *  3. Device add-ons last until the end of the subscription, whatever an old
 *     draft says.
 *  4. The subscription's end caps a reset add-on, and shortening it clamps the
 *     add-on; nothing moves it later.
 *  5. The switches are read ONCE per payment, before any transaction opens
 *     (review R2b-07).
 *
 * The switches are a double over `resolveAddOnRolloutFlags` with no `.env`, so
 * a case flips them the way an operator does on «Доп. услуги» → «Настройки».
 * Every instant is anchored to now. Skipped without TEST_DATABASE_URL; listed
 * in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `s4quote-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const GIB = 1024n * 1024n * 1024n;

interface Emitted {
  readonly severity: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

interface Owner {
  readonly userId: string;
  readonly subscriptionId: string;
}

let prisma: PrismaService;
let checkout: AddOnPurchaseService;
let fulfilment: PaymentSubscriptionMutationService;
let cutover: EntitlementCutoverService;
let terms: SubscriptionTermService;
const emitted: Emitted[] = [];
const created = { users: [] as string[], addOns: [] as string[], plans: [] as string[] };
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

/** What the switch page holds, and every read of it: the transaction depth the read happened at. */
const switches = {
  stored: {} as StoredAddOnSwitches,
  reads: [] as number[],
};
let transactionDepth = 0;
const switchReader = {
  flags: async () => {
    switches.reads.push(transactionDepth);
    return resolveAddOnRolloutFlags(switches.stored, {});
  },
};
const STAGE_4_ON: StoredAddOnSwitches = { durableAccounting: true, trafficResetExpiry: true };
const STAGE_4_OFF: StoredAddOnSwitches = { durableAccounting: true, trafficResetExpiry: false };

async function newUser(): Promise<string> {
  const id = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: id } });
  created.users.push(id);
  return id;
}

/**
 * A subscription on a 100 GB / 3-device plan that resets traffic by
 * `strategy`, already in the term model (as the background cutover brings it),
 * ending in 20 days unless said.
 */
async function subscription(
  options: { readonly strategy?: string; readonly expiresAt?: Date | null; readonly planId?: string } = {},
): Promise<Owner> {
  const userId = await newUser();
  const panelId = 870_000 + next();
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: options.planId ?? `${prefix}-plan`,
        name: 'Pro',
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: options.strategy ?? 'MONTH',
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
      expiresAt: options.expiresAt === undefined ? inDays(20) : options.expiresAt,
    },
    select: { id: true },
  });
  const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.id));
  assert.equal(entered.outcome, 'CREATED', 'fixture: in the term model');
  return { userId, subscriptionId: row.id };
}

/** A catalogue add-on for every plan, at 99 RUB. */
async function catalogAddOn(type: AddOnType = AddOnType.EXTRA_TRAFFIC, value = 50): Promise<string> {
  const id = `${prefix}-addon-${next()}`;
  await prisma.addOn.create({
    data: { id, name: id, type, value, prices: { create: [{ currency: 'RUB', price: '99' }] } },
  });
  created.addOns.push(id);
  return id;
}

/** The real checkout, as the cabinet calls it: the draft it made. */
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

/** The provider confirmed it; fulfilled the way the payment webhook does it. */
async function capture(draft: Transaction): Promise<void> {
  const paid = await prisma.transaction.update({ where: { id: draft.id }, data: { status: 'COMPLETED' } });
  await fulfilment.applyCompletedTransaction(paid);
}

/** A paid draft whose marker is written by hand — for markers a checkout of today no longer writes. */
async function paidDraft(owner: Owner, marker: Record<string, unknown>): Promise<Transaction> {
  return prisma.transaction.create({
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
        targetSubscriptionId: owner.subscriptionId,
        purchaseType: 'ADDITIONAL',
        gatewayType: 'YOOKASSA',
        amount: '99',
        currency: 'RUB',
        contractVersion: 2,
        addOnRevision: 1,
        ...marker,
      } as Prisma.InputJsonValue,
    },
  });
}

async function entitlementOf(transactionId: string) {
  return prisma.addOnEntitlement.findFirst({
    where: { sourceTransactionId: transactionId },
    include: { expiryEpoch: true },
  });
}

async function subscriptionOf(subscriptionId: string) {
  return prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
}

function markerOf(draft: Transaction): Record<string, unknown> {
  return draft.planSnapshot as Record<string, unknown>;
}

/** The completion card of one payment. */
function completionOf(paymentId: string): Emitted {
  const found = emitted.filter(
    (event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED && event.metadata['paymentId'] === paymentId,
  );
  assert.equal(found.length, 1, `exactly one completion card for ${paymentId}`);
  return found[0]!;
}

run('«до сброса» on the money path (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    // Every transaction this spec's services open, counted, so a read of the
    // switches can say whether it happened inside one.
    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    (prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> }).$transaction = async (
      ...args: unknown[]
    ) => {
      transactionDepth += 1;
      try {
        return await original(...args);
      } finally {
        transactionDepth -= 1;
      }
    };
    const record =
      (severity: string) =>
      (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
        emitted.push({ severity, type, message, metadata });
      };
    const events = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR'), emit: () => undefined };
    terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    const entitlements = new AddOnEntitlementService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    fulfilment = new PaymentSubscriptionMutationService(
      prisma,
      events as never,
      entitlements,
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
    switches.reads = [];
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('reset quote cleanup failed', error);
    });
    await prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } }).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  describe('the capture honours the quote, whatever the switches say by then', () => {
    it('stage 4 switched OFF between checkout and capture: still «до сброса», with the quoted window and end', async () => {
      const owner = await subscription();
      const addOnId = await catalogAddOn();
      const draft = await checkOut(owner, addOnId);
      const marker = markerOf(draft);
      assert.equal(marker['lifetime'], 'UNTIL_NEXT_RESET', 'fixture: the checkout quoted «до сброса»');
      const quotedResetAt = new Date(String(marker['quotedResetAt']));
      const quotedExpiresAt = new Date(String(marker['quotedExpiresAt']));

      switches.stored = STAGE_4_OFF;
      await capture(draft);

      const entitlement = await entitlementOf(draft.id);
      assert.ok(entitlement, 'ledgered, not the permanent increment');
      assert.equal(entitlement.lifetime, AddOnLifetime.UNTIL_NEXT_RESET);
      assert.equal(entitlement.state, 'ACTIVE');
      assert.equal(entitlement.expiresAt?.toISOString(), quotedExpiresAt.toISOString());
      assert.equal(entitlement.expiryEpoch?.plannedEndsAt.toISOString(), quotedResetAt.toISOString());
      assert.equal(entitlement.expiryEpoch?.startsAt.toISOString(), String(marker['quotedCycleStartsAt']));
      assert.equal(quotedExpiresAt.getTime() - quotedResetAt.getTime(), RESET_EXPIRY_MARGIN_MS);
      // Remnawave resets MONTH on the 1st at 00:20 (UTC here).
      assert.equal(quotedResetAt.getUTCDate(), 1);
      assert.equal(quotedResetAt.toISOString().slice(11, 16), '00:20');
      const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
        where: { subscriptionId: owner.subscriptionId },
      });
      assert.equal(projection.desiredTrafficLimitBytes, 150n * GIB);
      assert.equal((await subscriptionOf(owner.subscriptionId)).trafficLimit, 150);
      const completion = completionOf(draft.paymentId);
      assert.equal(completion.severity, 'INFO', 'delivered as quoted: no card');
      assert.equal(completion.metadata['userId'], owner.userId, 'pop-ups and automations find the customer');
    });

    it('stage 4 switched ON between checkout and capture: a «до конца подписки» quote stays one', async () => {
      switches.stored = STAGE_4_OFF;
      const owner = await subscription();
      const addOnId = await catalogAddOn();
      const draft = await checkOut(owner, addOnId);
      assert.equal(markerOf(draft)['lifetime'], 'UNTIL_SUBSCRIPTION_END', 'fixture: quoted «до конца подписки»');

      switches.stored = STAGE_4_ON;
      await capture(draft);

      const entitlement = await entitlementOf(draft.id);
      assert.ok(entitlement);
      assert.equal(entitlement.lifetime, AddOnLifetime.UNTIL_SUBSCRIPTION_END);
      assert.equal(entitlement.expiryEpochId, null);
      assert.equal(
        entitlement.expiresAt?.toISOString(),
        (await subscriptionOf(owner.subscriptionId)).expiresAt?.toISOString(),
      );
      const termIds = (await prisma.subscriptionTerm.findMany({ where: { subscriptionId: owner.subscriptionId } })).map(
        (term) => term.id,
      );
      assert.equal(await prisma.subscriptionResetEpoch.count({ where: { termId: { in: termIds } } }), 0);
    });

    it('the subscription shortened between checkout and capture: the add-on ends at the new end, not the quoted reset', async () => {
      const owner = await subscription();
      const addOnId = await catalogAddOn();
      const draft = await checkOut(owner, addOnId);
      const quotedExpiresAt = Date.parse(String(markerOf(draft)['quotedExpiresAt']));
      const shortened = new Date(Math.floor((Date.now() + quotedExpiresAt) / 2));
      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: shortened } });

      await capture(draft);

      const entitlement = await entitlementOf(draft.id);
      assert.equal(entitlement?.expiresAt?.toISOString(), shortened.toISOString());
      assert.notEqual(entitlement?.expiryEpochId, null, 'still bound to the quoted reset window');
    });

    it('the subscription extended between checkout and capture: a quote its end cut short is not stretched to the reset', async () => {
      const endsSoon = new Date(Date.now() + 90 * MINUTE_MS);
      const owner = await subscription({ expiresAt: endsSoon });
      const addOnId = await catalogAddOn();
      const draft = await checkOut(owner, addOnId);
      const marker = markerOf(draft);
      if (marker['quotedEndsBound'] !== 'subscription_end') return; // the last 90 min before a 1st, 00:50
      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: inDays(60) } });

      await capture(draft);

      const entitlement = await entitlementOf(draft.id);
      assert.equal(entitlement?.expiresAt?.toISOString(), endsSoon.toISOString(), 'the promised date, no later');
    });

    it('«Новый учёт докупок» switched off before capture: a «до сброса» quote is still ledgered, never permanent', async () => {
      const owner = await subscription();
      const addOnId = await catalogAddOn();
      const draft = await checkOut(owner, addOnId);

      switches.stored = { durableAccounting: false, trafficResetExpiry: false };
      await capture(draft);

      const entitlement = await entitlementOf(draft.id);
      assert.ok(entitlement, 'the quote is honoured by the ledger');
      assert.equal(entitlement.lifetime, AddOnLifetime.UNTIL_NEXT_RESET);
      assert.equal(entitlement.expiresAt?.toISOString(), String(markerOf(draft)['quotedExpiresAt']));
    });
  });

  describe('a «до сброса» quote that cannot be delivered is not applied, and the operator is told', () => {
    it('the subscription is no longer active at capture: no limit moves, a card asks for the refund', async () => {
      const owner = await subscription();
      const addOnId = await catalogAddOn();
      const draft = await checkOut(owner, addOnId);
      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { status: 'EXPIRED' } });

      await capture(draft);

      assert.equal(await entitlementOf(draft.id), null);
      const after = await subscriptionOf(owner.subscriptionId);
      assert.equal(after.trafficLimit, 100, 'the permanent increment would have made it 150');
      const settled = await prisma.transaction.findUniqueOrThrow({ where: { id: draft.id } });
      assert.notEqual(settled.fulfilledAt, null, 'settled, so it is not retried');
      const card = completionOf(draft.paymentId);
      assert.equal(card.severity, 'WARNING');
      assert.equal(card.metadata['userId'], owner.userId, 'pop-ups and automations still find the customer');
      assert.equal(card.message, 'Докупка оплачена, но не применена');
      assert.match(String(card.metadata['note']), /подписка уже не активна/);
      assert.match(String(card.metadata['note']), /Верните деньги/);
      assert.equal(card.metadata['needsManualReview'], true);
    });

    it('the subscription has no ACTIVE term at capture: not applied, and the card says why', async () => {
      // Out of the model (no term) with «Новый учёт докупок» off, so the
      // capture cannot bring it in: nothing to bind the entitlement to.
      switches.stored = { durableAccounting: false, trafficResetExpiry: false };
      const userId = await newUser();
      const bare = await prisma.subscription.create({
        data: {
          userId,
          status: SubscriptionStatus.ACTIVE,
          planSnapshot: { id: `${prefix}-plan`, trafficLimit: 100, deviceLimit: 3, trafficLimitStrategy: 'MONTH' },
          trafficLimit: 100,
          deviceLimit: 3,
          expiresAt: inDays(20),
        },
        select: { id: true },
      });
      const owner = { userId, subscriptionId: bare.id };
      const addOnId = await catalogAddOn();
      const resetAt = inDays(3);
      const draft = await paidDraft(owner, {
        addOnId,
        addOnType: 'EXTRA_TRAFFIC',
        addOnValue: 50,
        name: 'Extra 50 GB',
        sourceLineKey: addOnId,
        lifetime: 'UNTIL_NEXT_RESET',
        quotedEndsBound: 'reset',
        quotedResetAt: resetAt.toISOString(),
        quotedCycleStartsAt: inDays(-4).toISOString(),
        quotedExpiresAt: new Date(resetAt.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
      });

      await fulfilment.applyCompletedTransaction(draft);

      assert.equal(await entitlementOf(draft.id), null);
      assert.equal((await subscriptionOf(owner.subscriptionId)).trafficLimit, 100);
      assert.match(String(completionOf(draft.paymentId).metadata['note']), /нет действующего срока/);
    });

    it('paid after its quoted end: not applied — an entitlement born expired is not delivered', async () => {
      const owner = await subscription();
      const addOnId = await catalogAddOn();
      const resetAt = new Date(Date.now() - 2 * 60 * MINUTE_MS);
      const draft = await paidDraft(owner, {
        addOnId,
        addOnType: 'EXTRA_TRAFFIC',
        addOnValue: 50,
        name: 'Extra 50 GB',
        sourceLineKey: addOnId,
        lifetime: 'UNTIL_NEXT_RESET',
        quotedEndsBound: 'reset',
        quotedResetAt: resetAt.toISOString(),
        quotedCycleStartsAt: new Date(resetAt.getTime() - DAY_MS).toISOString(),
        quotedExpiresAt: new Date(resetAt.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
      });

      await fulfilment.applyCompletedTransaction(draft);

      assert.equal(await entitlementOf(draft.id), null);
      assert.equal((await subscriptionOf(owner.subscriptionId)).trafficLimit, 100);
      const card = completionOf(draft.paymentId);
      assert.equal(card.message, 'Докупка оплачена, но не применена');
      assert.match(String(card.metadata['note']), /после окончания её срока/);
    });

    it('a draft from before quotes on a rolling term without its anchor: ends with the subscription, and says so', async () => {
      switches.stored = STAGE_4_OFF;
      const owner = await subscription({ strategy: 'MONTH_ROLLING' });
      const addOnId = await catalogAddOn();
      const draft = await paidDraft(owner, {
        addOnId,
        addOnType: 'EXTRA_TRAFFIC',
        addOnValue: 50,
        name: 'Extra 50 GB',
        sourceLineKey: addOnId,
        lifetime: 'UNTIL_NEXT_RESET',
      });

      await fulfilment.applyCompletedTransaction(draft);

      const entitlement = await entitlementOf(draft.id);
      assert.ok(entitlement, 'delivered, not dropped and not permanent');
      assert.equal(entitlement.lifetime, AddOnLifetime.UNTIL_NEXT_RESET);
      assert.equal(entitlement.expiryEpochId, null, 'no window to bind');
      assert.equal(
        entitlement.expiresAt?.toISOString(),
        (await subscriptionOf(owner.subscriptionId)).expiresAt?.toISOString(),
      );
      const card = completionOf(draft.paymentId);
      assert.equal(card.message, 'Докупка применена без привязки к сбросу трафика');
    });
  });

  describe('the catalogue: device rows and traffic resets stored «до следующего сброса» are converted', () => {
    it('the migration converts them, bumps their revision, leaves traffic rows alone, and replays harmlessly', async () => {
      const path = join(__dirname, '..', 'prisma', 'migrations', '20260925090000_add_on_device_lifetime_subscription_end', 'migration.sql');
      const sql = readFileSync(path, 'utf8');
      const ids = { devices: `${prefix}-mig-dev`, reset: `${prefix}-mig-reset`, traffic: `${prefix}-mig-traffic` };
      created.addOns.push(...Object.values(ids));
      await prisma.addOn.createMany({
        data: [
          { id: ids.devices, name: ids.devices, type: 'EXTRA_DEVICES', value: 1, lifetime: 'UNTIL_NEXT_RESET', revision: 4 },
          { id: ids.reset, name: ids.reset, type: 'RESET_TRAFFIC', value: 1, lifetime: 'UNTIL_NEXT_RESET', revision: 1 },
          { id: ids.traffic, name: ids.traffic, type: 'EXTRA_TRAFFIC', value: 50, lifetime: 'UNTIL_NEXT_RESET', revision: 2 },
        ],
      });

      // The file as `migrate deploy` runs it, statement by statement — and then
      // again, as the entrypoint replays a migration that timed out.
      const statements = sql
        .replace(/--.*$/gm, '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      assert.equal(statements.length, 3, 'SET, UPDATE, RESET');
      for (let replay = 0; replay < 2; replay += 1) {
        for (const statement of statements) await prisma.$executeRawUnsafe(statement);
      }

      const rows = new Map(
        (await prisma.addOn.findMany({ where: { id: { in: Object.values(ids) } } })).map((row) => [row.id, row]),
      );
      assert.equal(rows.get(ids.devices)?.lifetime, 'UNTIL_SUBSCRIPTION_END');
      assert.equal(rows.get(ids.devices)?.revision, 5, 'moved once, as a commercial change, whatever the replays');
      assert.equal(rows.get(ids.reset)?.lifetime, 'UNTIL_SUBSCRIPTION_END');
      assert.equal(rows.get(ids.traffic)?.lifetime, 'UNTIL_NEXT_RESET', 'traffic may keep it');
      assert.equal(rows.get(ids.traffic)?.revision, 2);
    });
  });

  describe('devices last until the end of the subscription', () => {
    it('a device draft that says «до следующего сброса» is fulfilled «до конца подписки», with no epoch', async () => {
      const owner = await subscription();
      const addOnId = await catalogAddOn(AddOnType.EXTRA_DEVICES, 2);
      const resetAt = inDays(3);
      const draft = await paidDraft(owner, {
        addOnId,
        addOnType: 'EXTRA_DEVICES',
        addOnValue: 2,
        name: '+2 devices',
        sourceLineKey: addOnId,
        lifetime: 'UNTIL_NEXT_RESET',
        quotedEndsBound: 'reset',
        quotedResetAt: resetAt.toISOString(),
        quotedCycleStartsAt: inDays(-4).toISOString(),
        quotedExpiresAt: new Date(resetAt.getTime() + RESET_EXPIRY_MARGIN_MS).toISOString(),
      });

      await fulfilment.applyCompletedTransaction(draft);

      const entitlement = await entitlementOf(draft.id);
      assert.ok(entitlement);
      assert.equal(entitlement.lifetime, AddOnLifetime.UNTIL_SUBSCRIPTION_END);
      assert.equal(entitlement.expiryEpochId, null);
      assert.equal(
        entitlement.expiresAt?.toISOString(),
        (await subscriptionOf(owner.subscriptionId)).expiresAt?.toISOString(),
      );
      assert.equal((await subscriptionOf(owner.subscriptionId)).deviceLimit, 5);
    });
  });

  describe('the subscription\'s end caps a «до сброса» add-on', () => {
    it('a shortened subscription brings it back to the new end; an extension never moves it later', async () => {
      const owner = await subscription();
      const addOnId = await catalogAddOn();
      const draft = await checkOut(owner, addOnId);
      await capture(draft);
      const sold = await entitlementOf(draft.id);
      assert.ok(sold?.expiresAt);
      const soldUntil = sold.expiresAt.getTime();

      const shortened = new Date(Math.floor((Date.now() + soldUntil) / 2));
      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: shortened } });
      await prisma.$transaction((tx) => terms.alignTailToExpiryInTransaction(tx, owner.subscriptionId));
      assert.equal((await entitlementOf(draft.id))?.expiresAt?.toISOString(), shortened.toISOString());

      await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: inDays(90) } });
      await prisma.$transaction((tx) => terms.alignTailToExpiryInTransaction(tx, owner.subscriptionId));
      assert.equal(
        (await entitlementOf(draft.id))?.expiresAt?.toISOString(),
        shortened.toISOString(),
        'an extension does not give the add-on back its reset date',
      );
      const events = await prisma.addOnEntitlementEvent.findMany({
        where: { entitlementId: sold.id, reason: 'TERM_WINDOW_ALIGNED' },
      });
      assert.equal(events.length, 1, 'one move, recorded');
    });

    it('a subscription ending before the reset is sold until its end, bound to the reset\'s epoch', async () => {
      const endsSoon = new Date(Date.now() + 90 * MINUTE_MS);
      const owner = await subscription({ expiresAt: endsSoon });
      const addOnId = await catalogAddOn();
      const draft = await checkOut(owner, addOnId);
      const marker = markerOf(draft);
      const resetAt = new Date(String(marker['quotedResetAt']));
      await capture(draft);

      const entitlement = await entitlementOf(draft.id);
      assert.ok(entitlement);
      if (resetAt.getTime() + RESET_EXPIRY_MARGIN_MS > endsSoon.getTime()) {
        assert.equal(marker['quotedEndsBound'], 'subscription_end');
        assert.equal(entitlement.expiresAt?.toISOString(), endsSoon.toISOString());
        assert.equal(entitlement.expiryEpoch?.plannedEndsAt.toISOString(), resetAt.toISOString());
      } else {
        // Only within the last hour and a half before a 1st, 00:50.
        assert.equal(marker['quotedEndsBound'], 'reset');
      }
    });
  });

  describe('after the sale (W7 tests 9 and 10)', () => {
    it('a refund of a «до сброса» add-on reverses it and the limit drops back to the plan', async () => {
      const owner = await subscription();
      const draft = await checkOut(owner, await catalogAddOn());
      await capture(draft);
      assert.equal((await subscriptionOf(owner.subscriptionId)).trafficLimit, 150, 'fixture: delivered');

      const refunds = new AddOnRefundService(
        prisma,
        new AddOnEntitlementService(),
        new EffectiveProjectionService(),
        { enqueue: async () => undefined } as never,
      );
      const paid = await prisma.transaction.findUniqueOrThrow({ where: { id: draft.id } });
      const outcome = await refunds.endForRefund(paid, 'REFUND');

      assert.equal(outcome?.ended, true);
      const entitlement = await entitlementOf(draft.id);
      assert.equal(entitlement?.state, 'REVERSED');
      const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({
        where: { subscriptionId: owner.subscriptionId },
      });
      assert.equal(projection.desiredTrafficLimitBytes, 100n * GIB);
      assert.equal((await subscriptionOf(owner.subscriptionId)).trafficLimit, 100);
    });

    it('a renewal does not take a «до сброса» add-on away: it keeps its promised date and keeps counting', async () => {
      const planId = `${prefix}-renew-plan-${next()}`;
      await prisma.plan.create({
        data: {
          id: planId,
          name: planId,
          orderIndex: 915_000 + next(),
          trafficLimit: 100,
          deviceLimit: 3,
          internalSquads: [],
          externalSquad: null,
          trafficLimitStrategy: 'MONTH',
          availability: 'ALL',
          durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
        },
      });
      created.plans.push(planId);
      const owner = await subscription({ planId });
      const draft = await checkOut(owner, await catalogAddOn());
      await capture(draft);
      const sold = await entitlementOf(draft.id);
      assert.ok(sold?.expiresAt);

      const renewal = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId: owner.userId,
          subscriptionId: owner.subscriptionId,
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: new Prisma.Decimal('299'),
          planSnapshot: { id: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
        },
      });
      await fulfilment.applyCompletedTransaction(renewal);

      const after = await entitlementOf(draft.id);
      assert.equal(after?.state, 'ACTIVE');
      assert.equal(after?.expiresAt?.toISOString(), sold.expiresAt.toISOString(), 'the promised date, as sold');
      assert.equal(after?.expiryEpochId, sold.expiryEpochId);
      const queued = await prisma.subscriptionTerm.count({
        where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      });
      assert.equal(queued, 1, 'fixture: the renewal appended its period');
      assert.equal((await subscriptionOf(owner.subscriptionId)).trafficLimit, 150, 'still counting');
    });
  });

  describe('the switches are read once per payment, before any transaction opens (R2b-07)', () => {
    async function plan(options: { readonly upgradeToPlanIds?: readonly string[] } = {}): Promise<string> {
      const id = `${prefix}-plan-${next()}`;
      await prisma.plan.create({
        data: {
          id,
          name: id,
          orderIndex: 910_000 + next(),
          trafficLimit: 100,
          deviceLimit: 3,
          internalSquads: [],
          externalSquad: null,
          trafficLimitStrategy: 'MONTH',
          availability: 'ALL',
          upgradeToPlanIds: [...(options.upgradeToPlanIds ?? [])],
          durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
        },
      });
      created.plans.push(id);
      return id;
    }

    async function pay(owner: { userId: string; subscriptionId: string | null }, type: PurchaseType, planId: string) {
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
      switches.reads = [];
      await fulfilment.applyCompletedTransaction(row);
      return [...switches.reads];
    }

    it('NEW, renewal, upgrade, an add-on and a two-line combined renewal: one read each, at depth 0', async () => {
      const upgradeTarget = await plan();
      const base = await plan({ upgradeToPlanIds: [upgradeTarget] });

      assert.deepEqual(await pay({ userId: await newUser(), subscriptionId: null }, PurchaseType.NEW, base), [0], 'NEW');

      const renewing = await subscription({ planId: base });
      assert.deepEqual(await pay(renewing, PurchaseType.RENEW, base), [0], 'RENEW');

      const upgrading = await subscription({ planId: base });
      assert.deepEqual(await pay(upgrading, PurchaseType.UPGRADE, upgradeTarget), [0], 'UPGRADE');

      const buyer = await subscription();
      const addOnDraft = await checkOut(buyer, await catalogAddOn());
      switches.reads = [];
      await capture(addOnDraft);
      assert.deepEqual(switches.reads, [0], 'ADD-ON');

      const first = await subscription({ planId: base });
      const second = await subscription({ planId: base });
      await prisma.subscription.update({ where: { id: second.subscriptionId }, data: { userId: first.userId } });
      const parent = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-pay-${next()}`,
          userId: first.userId,
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
        data: [first, second].map((owner) => ({
          transactionId: parent.id,
          subscriptionId: owner.subscriptionId,
          planId: base,
          planSnapshot: { id: base, selectedDurationDays: 30 },
          durationDays: 30,
          amount: new Prisma.Decimal('299'),
          currency: 'RUB' as const,
        })),
      });
      switches.reads = [];
      await fulfilment.applyCompletedTransaction(parent);
      assert.deepEqual(switches.reads, [0], 'combined renewal: once for both lines');
      // Non-vacuity: both lines were renewed onto their terms.
      for (const owner of [first, second]) {
        const queued = await prisma.subscriptionTerm.count({
          where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
        });
        assert.equal(queued, 1, 'the renewal appended its term');
      }
    });
  });
});
