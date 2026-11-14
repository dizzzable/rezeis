import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { PaymentGatewayType, Prisma, PurchaseChannel, PurchaseType, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import {
  BUNDLE_GRANT_KEY,
  BUNDLE_RENEWAL_KEY,
  readBundleMarker,
} from '../src/modules/merge-links/utils/bundle-snapshot.util';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PlanCatalogService } from '../src/modules/plans/services/plan-catalog.service';
import { PricingService } from '../src/modules/plans/services/pricing.service';
import { SubscriptionQuoteService } from '../src/modules/subscriptions/services/subscription-quote.service';
import { RefundedDaysWithdrawalService } from '../src/modules/payments/services/refunded-days-withdrawal.service';
import { ADD_ON_ROLLOUT_FLAG_NAMES } from './helpers/rollout-flags';

/**
 * A MERGED TARIFF SOLD, RENEWED AND REFUNDED — against a real PostgreSQL.
 *
 * The owner's decision (14.11.2026, second half): the bundle's own plan row is
 * sold like any other tariff, so ONE payment must mint one subscription per
 * member plan, ONE renewal must extend every one of them, and a refund must take
 * the days back off all of them. None of that can be proved by a unit double:
 * what has to hold is that the subscriptions the sale writes are the ones the
 * merge service, the cabinet and the next renewal then read — the marker in
 * `planSnapshot`, the shared expiry, the one device limit, the transaction's own
 * provenance, and the database constraints around all of it.
 *
 * The collaborators OUTSIDE the payment path (terms, add-ons, projections) run
 * for real; only the event bus is a recorder. Skipped without
 * `TEST_DATABASE_URL`, like every live spec; every row carries this run's prefix
 * and is removed in `after`.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `bts-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAID_DAYS = 30;
const DEVICE_LIMIT = 4;

interface Emitted {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

interface PlanFixture {
  readonly id: string;
  readonly name: string;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly internalSquads: string[];
  readonly externalSquad: string | null;
}

let prisma: PrismaService;
let mutation: PaymentSubscriptionMutationService;
let refunds: RefundedDaysWithdrawalService;
const events: Emitted[] = [];
const created = {
  plans: [] as string[],
  users: [] as string[],
  bundles: [] as string[],
  gatewayId: null as string | null,
};
let counter = 0;
const next = (): number => ++counter;

async function createPlan(
  label: string,
  limits: Pick<PlanFixture, 'trafficLimit' | 'deviceLimit' | 'internalSquads' | 'externalSquad'>,
): Promise<PlanFixture> {
  const id = `${prefix}-plan-${label}`;
  const name = `${prefix} ${label}`;
  await prisma.plan.create({
    data: {
      id,
      name,
      orderIndex: 100_000 + next(),
      trafficLimit: limits.trafficLimit,
      deviceLimit: limits.deviceLimit,
      internalSquads: limits.internalSquads,
      externalSquad: limits.externalSquad,
      trafficLimitStrategy: 'NO_RESET',
      durations: { create: [{ days: PAID_DAYS, prices: { create: [{ currency: 'RUB', price: '349' }] } }] },
    },
  });
  created.plans.push(id);
  return { id, name, ...limits };
}

async function createUser(label: string): Promise<string> {
  const id = `${prefix}-user-${label}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: label } });
  created.users.push(id);
  return id;
}

/** The bundle as the sale reads it: its own plan row plus the plans it delivers. */
async function createBundle(
  face: PlanFixture,
  members: readonly { readonly plan: PlanFixture; readonly isVisibleInApp: boolean }[],
): Promise<string> {
  const id = `${prefix}-bundle`;
  await prisma.planBundle.create({
    data: {
      id,
      name: `${prefix} Объеденёнка`,
      description: 'оба тарифа',
      isActive: true,
      orderIndex: 1,
      planId: face.id,
      members: {
        create: members.map((member) => ({
          planId: member.plan.id,
          isVisibleInApp: member.isVisibleInApp,
        })),
      },
    },
  });
  created.bundles.push(id);
  return id;
}

/** The draft a checkout writes for a NEW purchase of `plan`. */
function purchaseDraft(plan: PlanFixture): Record<string, unknown> {
  return {
    id: plan.id,
    name: plan.name,
    availability: 'ALL',
    tag: null,
    type: 'BOTH',
    trafficLimit: plan.trafficLimit,
    deviceLimit: DEVICE_LIMIT,
    trafficLimitStrategy: 'NO_RESET',
    selectedDurationDays: PAID_DAYS,
    purchaseType: 'NEW',
    snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
  };
}

async function createPayment(input: {
  readonly userId: string;
  readonly purchaseType: PurchaseType;
  readonly planSnapshot: Record<string, unknown>;
  readonly subscriptionId?: string | null;
}): Promise<string> {
  const transaction = await prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: input.userId,
      subscriptionId: input.subscriptionId ?? null,
      status: TransactionStatus.COMPLETED,
      purchaseType: input.purchaseType,
      channel: 'WEB',
      gatewayType: 'PLATEGA',
      currency: 'RUB',
      amount: new Prisma.Decimal('349'),
      planSnapshot: input.planSnapshot as Prisma.InputJsonValue,
    },
    select: { id: true, paymentId: true },
  });
  return transaction.id;
}

async function fulfill(transactionId: string): Promise<readonly string[]> {
  const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
  const { syncJobs } = await mutation.applyCompletedTransaction(transaction);
  return syncJobs.map((job) => job.subscriptionId);
}

function completionsFor(paymentId: string): Emitted[] {
  return events.filter(
    (event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED && event.metadata['paymentId'] === paymentId,
  );
}

async function subscriptionsOf(userId: string) {
  return prisma.subscription.findMany({
    where: { userId, status: { not: 'DELETED' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

run('a merged tariff sold, renewed and refunded, on PostgreSQL', () => {
  let limited: PlanFixture;
  let unlimited: PlanFixture;
  let face: PlanFixture;
  let bundleId: string;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    // Every stage off: this spec proves the RENEWAL AND SALE contract, not the
    // add-on term model. Stages 1, 2 and 6 default ON since 24.09.2026.
    for (const flag of ADD_ON_ROLLOUT_FLAG_NAMES) process.env[flag] = 'false';
    prisma = new PrismaService();
    await prisma.$connect();

    const record =
      (severity: Emitted['severity']) =>
      (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
        events.push({ severity, type, message, metadata });
      };
    const systemEvents = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR'), emit: () => undefined };
    mutation = new PaymentSubscriptionMutationService(
      prisma,
      systemEvents as never,
      new AddOnEntitlementService(),
      new EffectiveProjectionService(),
      new SubscriptionTermService(),
      {} as never,
    );
    refunds = new RefundedDaysWithdrawalService(prisma, { enqueue: async () => undefined } as never);

    limited = await createPlan('limited', {
      trafficLimit: 50,
      deviceLimit: 1,
      internalSquads: [`${prefix}-squad-limited`],
      externalSquad: null,
    });
    unlimited = await createPlan('unlimited', {
      trafficLimit: null,
      deviceLimit: 1,
      internalSquads: [`${prefix}-squad-unlimited`],
      externalSquad: `${prefix}-ext`,
    });
    face = await createPlan('merged', {
      trafficLimit: 50,
      deviceLimit: DEVICE_LIMIT,
      internalSquads: [`${prefix}-squad-limited`],
      externalSquad: null,
    });
    // A gateway gives the catalogue and the quote a currency to price in. The
    // row is created only when the panel has none of this type, and removed only
    // when this run created it — an operator's configured gateway is never
    // touched.
    const existingGateway = await prisma.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.MULENPAY },
      select: { id: true },
    });
    if (existingGateway === null) {
      const gateway = await prisma.paymentGateway.create({
        data: { type: PaymentGatewayType.MULENPAY, currency: 'RUB', isActive: true, settings: {}, orderIndex: 0 },
        select: { id: true },
      });
      created.gatewayId = gateway.id;
    }

    bundleId = await createBundle(face, [
      { plan: unlimited, isVisibleInApp: false },
      { plan: limited, isVisibleInApp: false },
    ]);
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = created.users;
    await prisma.transactionItem.deleteMany({ where: { transaction: { userId: { in: users } } } });
    await prisma.profileSyncJob.deleteMany({ where: { subscription: { userId: { in: users } } } });
    await prisma.subscriptionTerm.deleteMany({ where: { subscription: { userId: { in: users } } } });
    await prisma.subscriptionEffectiveProjection.deleteMany({ where: { subscription: { userId: { in: users } } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: users } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: users } } });
    if (created.gatewayId !== null) {
      await prisma.paymentGateway.deleteMany({ where: { id: created.gatewayId } });
    }
    await prisma.planBundle.deleteMany({ where: { id: { in: created.bundles } } });
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('sells the merged tariff as ONE payment that mints one profile per member plan', async () => {
    const user = await createUser('buyer');
    const transactionId = await createPayment({
      userId: user,
      purchaseType: PurchaseType.NEW,
      planSnapshot: purchaseDraft(face),
    });
    const fulfilledSubscriptionIds = await fulfill(transactionId);

    const subscriptions = await subscriptionsOf(user);
    assert.equal(subscriptions.length, 2, 'one subscription per member plan');
    assert.equal(fulfilledSubscriptionIds.length, 2, 'each new profile gets its own sync job');
    assert.deepEqual(
      fulfilledSubscriptionIds.sort(),
      subscriptions.map((row) => row.id).sort(),
    );

    // THE MARKER: what makes them one product for the renewal, autopay and the
    // refund.
    for (const row of subscriptions) {
      assert.deepEqual(readBundleMarker(row.planSnapshot), { bundleId, bundlePlanId: face.id });
    }

    // EACH ITS OWN MEMBER PLAN — squads and traffic limit are the profile's.
    const bySnapshotPlanId = new Map(
      subscriptions.map((row) => [readBundleMarker(row.planSnapshot), row] as const).map(([, row]) => [
        (row.planSnapshot as Record<string, unknown>)['id'] as string,
        row,
      ]),
    );
    const limitedRow = bySnapshotPlanId.get(limited.id);
    const unlimitedRow = bySnapshotPlanId.get(unlimited.id);
    assert.ok(limitedRow !== undefined && unlimitedRow !== undefined);
    assert.equal(limitedRow.trafficLimit, 50);
    assert.deepEqual(limitedRow.internalSquads, [limited.internalSquads[0]]);
    assert.equal(unlimitedRow.trafficLimit, null);
    assert.deepEqual(unlimitedRow.internalSquads, [unlimited.internalSquads[0]]);
    assert.equal(unlimitedRow.externalSquad, `${prefix}-ext`);

    // ONE DEVICE LIMIT, one period, for the whole product.
    for (const row of subscriptions) {
      assert.equal(row.deviceLimit, DEVICE_LIMIT);
      assert.equal(row.status, 'ACTIVE');
      assert.equal(row.isTrial, false);
    }
    assert.equal(limitedRow.expiresAt?.getTime(), unlimitedRow.expiresAt?.getTime());
    assert.equal(
      Math.round((limitedRow.expiresAt!.getTime() - Date.now()) / DAY_MS),
      PAID_DAYS,
      'both profiles expire together, one paid period from now',
    );

    // THE PAYMENT names the profile the merged link faces — the LIMITED member,
    // the same rule `resolveVisiblePlanId` applies — and records what it created.
    const payment = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    assert.equal(payment.subscriptionId, limitedRow.id);
    const grant = (payment.gatewayData as Record<string, unknown> | null)?.[BUNDLE_GRANT_KEY] as
      | { readonly bundleId: string; readonly subscriptionIds: readonly string[] }
      | undefined;
    assert.equal(grant?.bundleId, bundleId);
    assert.deepEqual([...(grant?.subscriptionIds ?? [])].sort(), subscriptions.map((row) => row.id).sort());

    // And the operator's card says what the customer bought.
    const completions = completionsFor(payment.paymentId);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.metadata['bundleId'], bundleId);
    assert.equal(completions[0]?.metadata['subscriptionCount'], 2);

    await refunds.withdraw(payment);
  });

  it('renews the whole set from ONE line priced as the merged tariff', async () => {
    const user = await createUser('renter');
    const purchaseId = await createPayment({
      userId: user,
      purchaseType: PurchaseType.NEW,
      planSnapshot: purchaseDraft(face),
    });
    await fulfill(purchaseId);
    const before = await subscriptionsOf(user);
    assert.equal(before.length, 2);
    const purchased = await prisma.transaction.findUniqueOrThrow({ where: { id: purchaseId } });
    const primary = before.find((row) => row.id === purchased.subscriptionId);
    assert.ok(primary !== undefined);
    const previousExpiry = before[0]!.expiresAt!.getTime();

    // The renewal line a combined checkout writes: ONE item, priced as the
    // bundle's own plan, naming the profile the cabinet drew.
    const renewalId = await createPayment({
      userId: user,
      purchaseType: PurchaseType.RENEW,
      subscriptionId: primary.id,
      planSnapshot: { combinedRenewal: true },
    });
    await prisma.transactionItem.create({
      data: {
        transactionId: renewalId,
        subscriptionId: primary.id,
        planId: face.id,
        // No snapshotVersion: a legacy-shaped line, fulfilled from the live row.
        planSnapshot: {} as Prisma.InputJsonValue,
        durationDays: PAID_DAYS,
        amount: new Prisma.Decimal('349'),
        currency: 'RUB',
        discountPercent: 0,
      },
    });

    const fulfilledSubscriptionIds = await fulfill(renewalId);
    assert.equal(fulfilledSubscriptionIds.length, 2, 'both profiles of the set are renewed and pushed');

    const after = await subscriptionsOf(user);
    assert.equal(after.length, 2, 'a renewal creates no new profile');
    for (const row of after) {
      assert.equal(row.status, 'ACTIVE');
      assert.equal(row.expiresAt?.getTime(), previousExpiry + PAID_DAYS * DAY_MS, 'every profile got the paid period');
      assert.deepEqual(readBundleMarker(row.planSnapshot), { bundleId, bundlePlanId: face.id });
      // A renewal of the same product changes no plan: limits stay the member's.
      assert.equal(row.deviceLimit, DEVICE_LIMIT);
    }

    const renewed = await prisma.transaction.findUniqueOrThrow({ where: { id: renewalId } });
    const provenance = (renewed.gatewayData as Record<string, unknown> | null)?.[BUNDLE_RENEWAL_KEY] as
      | { readonly lines: readonly { readonly subscriptionIds: readonly string[]; readonly days: number }[] }
      | undefined;
    assert.equal(provenance?.lines.length, 1);
    assert.equal(provenance?.lines[0]?.days, PAID_DAYS);
    assert.deepEqual([...(provenance?.lines[0]?.subscriptionIds ?? [])].sort(), after.map((row) => row.id).sort());

    // ── THE REFUND TAKES THE SAME DAYS OFF BOTH ──────────────────────────
    // What `PaymentReconciliationService` runs for a refunded renewal: the
    // payment's own lines, never the single profile it names.
    const outcome = await refunds.withdraw(renewed);
    assert.equal(outcome.withdrawn, true);
    assert.equal(outcome.needsManualReview, false);
    for (const row of await subscriptionsOf(user)) {
      assert.equal(row.expiresAt?.getTime(), previousExpiry, 'the days the refund took back came off every profile');
    }
  });

  it('prices the merged tariff like any other plan in the shop and in the renewal', async () => {
    // The SALE side: what the catalogue shows and what a renewal quotes. The
    // face plan is a plan row with its own durations, so both readers must find
    // it — and the renewal of a subscription sold as a merged tariff must price
    // THAT row, not the member plan, or the customer would pay one half.
    const user = await createUser('shopper');
    const saleId = await createPayment({
      userId: user,
      purchaseType: PurchaseType.NEW,
      planSnapshot: purchaseDraft(face),
    });
    await fulfill(saleId);

    const catalog = new PlanCatalogService(prisma, new PricingService(), {
      loadConfig: async () => ({ enabled: false, percent: 0, defaultCurrency: 'RUB' }),
    } as never);
    const quotes = new SubscriptionQuoteService(prisma, catalog, new PricingService());

    const purchase = await prisma.transaction.findUniqueOrThrow({ where: { id: saleId } });
    const subscriptions = await subscriptionsOf(user);
    const primary = subscriptions.find((row) => row.id === purchase.subscriptionId);
    assert.ok(primary !== undefined);

    const shop = await catalog.getCatalogPlans({ channel: PurchaseChannel.WEB, userId: user });
    const faceCard = shop.find((plan) => plan.id === face.id);
    assert.ok(faceCard !== undefined, 'the merged tariff is sold in the catalogue');
    assert.equal(faceCard.durations.length, 1);
    assert.equal(faceCard.durations[0]?.days, PAID_DAYS);
    assert.equal(faceCard.durations[0]?.prices[0]?.price, '349');

    // Discovery: the renewal offers the bundle's own row and nothing else.
    const discovery = await quotes.getQuote({
      userId: user,
      purchaseType: PurchaseType.RENEW,
      subscriptionId: primary.id,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.MULENPAY,
    });
    assert.deepEqual(discovery.availablePlans.map((plan) => plan.id), [face.id]);

    // And it prices at the merged tariff's own price.
    const priced = await quotes.getQuote({
      userId: user,
      purchaseType: PurchaseType.RENEW,
      subscriptionId: primary.id,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.MULENPAY,
      planId: face.id,
      durationDays: PAID_DAYS,
    });
    assert.equal(priced.isEligible, true, JSON.stringify(priced.warnings));
    assert.equal(priced.selectedPlan?.id, face.id);
    assert.equal(priced.price?.price, '349');

    // It is never a DESTINATION: «Сменить тариф» lists no merged tariff.
    const upgrade = await quotes.getQuote({
      userId: user,
      purchaseType: PurchaseType.UPGRADE,
      subscriptionId: primary.id,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.MULENPAY,
    });
    assert.equal(upgrade.availablePlans.some((plan) => plan.id === face.id), false);
  });
});
