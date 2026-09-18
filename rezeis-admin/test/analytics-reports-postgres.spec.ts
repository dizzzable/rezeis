import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';
import { BusinessAnalyticsService } from '../src/modules/business-analytics/services/business-analytics.service';
import { bucketIndexSql, describePeriod, planAnalyticsWindow } from '../src/modules/business-analytics/utils/analytics-window.util';
import type { FxRateService } from '../src/modules/fx/fx-rate.service';
import type { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';
import { SavedPaymentMethodService } from '../src/modules/payments/services/saved-payment-method.service';
import type { SettingsService } from '../src/modules/settings/services/settings.service';
import { readPlatformBranding } from '../src/modules/settings/utils/platform-branding.util';
import { SubscriptionRenewalService } from '../src/modules/subscriptions/services/subscription-renewal.service';

Logger.overrideLogger(false);

/**
 * «Бизнес-аналитика» against a real PostgreSQL: every report's statements, and
 * the decisions only an engine can prove.
 *
 * Each test runs in a transaction that is rolled back, and first TRUNCATEs
 * `users` (cascading to payments, subscriptions, trial grants and saved cards)
 * and `fx_rates` inside it — so it reads exactly the rows it seeded, whatever
 * other specs of the job left behind, and leaves the database as it found it.
 *
 * What was wrong before, measured on the HEAD service against this database:
 *   - 1 000 RUB and 10 USDT read as revenue «1010», in no currency;
 *   - a payment imported today with its original date 200 days back
 *     (`created_at`; `updated_at` is the import) counted as today's revenue,
 *     and as the top payer's «last payment»;
 *   - on a host whose clock is not UTC the daily series was keyed a day off
 *     and drew zeroes (`analytics-window.spec.ts` holds that one).
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const DAY_MS = 86_400_000;
let prisma: PrismaService;

const REPORTING_IN_RUB = ({ getBaseCurrency: () => 'RUB' } satisfies Pick<FxRateService, 'getBaseCurrency'>) as unknown as FxRateService;

/** The operator's time zone as the panel's settings reader hands it over (`Settings.platformPolicy.timezone`). */
function zoneSetting(timezone: string | null): SettingsService {
  return ({ getPlatformBranding: async () => readPlatformBranding({ timezone }) } satisfies Pick<
    SettingsService,
    'getPlatformBranding'
  >) as unknown as SettingsService;
}

class RolledBack extends Error {}

/** Run `body` on a clean slate in a transaction that never commits, and hand back what it observed. */
async function onCleanSlate<T>(
  body: (tx: Prisma.TransactionClient, service: BusinessAnalyticsService) => Promise<T>,
  options: { readonly timezone?: string | null } = {},
): Promise<T> {
  let observed: { value: T } | null = null;
  await assert.rejects(
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('TRUNCATE "users", "fx_rates" CASCADE');
        const settings = zoneSetting(options.timezone === undefined ? 'UTC' : options.timezone);
        observed = { value: await body(tx, new BusinessAnalyticsService(tx as never, REPORTING_IN_RUB, settings)) };
        throw new RolledBack();
      },
      { maxWait: 15_000, timeout: 120_000 },
    ),
    RolledBack,
  );
  assert.ok(observed !== null, 'the transaction never reached its observations');
  return (observed as { value: T }).value;
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);
const daysAhead = (days: number): Date => new Date(Date.now() + days * DAY_MS);

async function customer(tx: Prisma.TransactionClient, id: string, extra: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  return tx.user.create({ data: { id, referralCode: `${id}-ref`, name: id, ...extra } });
}

type Payment = Partial<Prisma.TransactionUncheckedCreateInput> & { readonly userId: string };

async function pay(tx: Prisma.TransactionClient, payment: Payment) {
  return tx.transaction.create({
    data: {
      status: 'COMPLETED',
      purchaseType: 'NEW',
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: '100',
      ...payment,
    },
  });
}

async function rate(tx: Prisma.TransactionClient, quote: string, value: string) {
  await tx.fxRate.create({ data: { base: 'RUB', quote, rate: value, source: 'TEST', fetchedAt: daysAgo(0.5) } });
}

/**
 * A subscription the panel soft-deleted at `at`: `status` DELETED, and
 * `updated_at` its last write — the deletion itself (`SubscriptionDeletionService`).
 * Raw, because Prisma stamps `updatedAt` on every write it makes.
 */
async function deletedAt(tx: Prisma.TransactionClient, subscriptionId: string, at: Date) {
  await tx.$executeRaw`UPDATE "subscriptions" SET "status" = 'DELETED', "updated_at" = ${at} WHERE "id" = ${subscriptionId}`;
}

/** The ledger row every trial subscription gets (`SubscriptionMutationsService` for a free trial). */
async function trialClaim(tx: Prisma.TransactionClient, userId: string, subscriptionId: string, at: Date) {
  await tx.trialClaim.create({
    data: { userId, subscriptionId, source: 'FREE', status: 'CONSUMED', units: 1, consumedAt: at, createdAt: at },
  });
}

run('business analytics on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.$disconnect();
  });

  it('files a payment under the day it was made, not the day its row was last written', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'importer');
      // Imported today: its original date lives in `created_at` only.
      await pay(tx, { userId: 'importer', amount: '5000', createdAt: daysAgo(200) });
      await pay(tx, { userId: 'importer', amount: '700', createdAt: daysAgo(2) });
      const overview = await service.getAdvancedReport(30);
      const revenue = await service.getRevenueReport(30);
      const top = await service.getTopPayers(5);
      return {
        current: overview.metrics.revenue.current.value,
        previous: overview.metrics.revenue.previous.value,
        revenueTotal: revenue.total.value,
        bar: overview.series.revenue[overview.series.revenue.length - 3],
        lifetime: top.payers[0]?.totalSpent,
        lastPaymentDaysAgo: Math.round((Date.now() - new Date(top.payers[0]!.lastPaymentAt!).getTime()) / DAY_MS),
      };
    });
    assert.deepEqual(observed, { current: 700, previous: 0, revenueTotal: 700, bar: 700, lifetime: 5700, lastPaymentDaysAgo: 2 });
  });

  it('states money in two currencies in the base at the panel’s rate, and leaves a currency without a rate out, by name', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      await rate(tx, 'USDT', '80');
      await customer(tx, 'rouble');
      await customer(tx, 'crypto');
      await customer(tx, 'stars');
      await pay(tx, { userId: 'rouble', amount: '1000', createdAt: daysAgo(3) });
      await pay(tx, { userId: 'crypto', currency: 'USDT', amount: '10', gatewayType: 'CRYPTOPAY', createdAt: daysAgo(3) });
      await pay(tx, { userId: 'stars', currency: 'XTR', amount: '500', gatewayType: 'TELEGRAM_STARS', createdAt: daysAgo(3) });
      const overview = await service.getAdvancedReport(30);
      const revenue = await service.getRevenueReport(30);
      const top = await service.getTopPayers(5);
      const ltv = await service.getLtvDistribution();
      return {
        money: { currency: overview.money.currency, rates: overview.money.rates.map((r) => [r.currency, r.rate]), unconverted: overview.money.unconverted },
        revenue: overview.metrics.revenue.current,
        legacyTotal: overview.kpis.totalRevenue,
        arppu: overview.metrics.arppu.current,
        slices: revenue.byCurrency.map((slice) => [slice.currency, slice.amount, slice.value]),
        providers: overview.providers.map((p) => [p.gatewayType, p.revenue]),
        top: top.payers.map((payer) => [payer.userId, payer.totalSpent]),
        ltvPayers: ltv.stats.payers,
      };
    });
    assert.deepEqual(observed, {
      money: { currency: 'RUB', rates: [['USDT', 80]], unconverted: ['XTR'] },
      revenue: {
        value: 1800,
        byCurrency: [
          { currency: 'RUB', amount: 1000 },
          { currency: 'USDT', amount: 10 },
          { currency: 'XTR', amount: 500 },
        ],
      },
      legacyTotal: 1800,
      // Withheld: the Stars payer is a payer, and their money is in no rouble figure.
      arppu: null,
      slices: [
        ['RUB', 1000, 1000],
        ['USDT', 10, 800],
        ['XTR', 500, null],
      ],
      providers: [
        ['YOOKASSA', 1000],
        ['CRYPTOPAY', 800],
        ['TELEGRAM_STARS', 0],
      ],
      // Ranked by the rouble value: 10 USDT is worth 800 ₽. Stars have no rate, so
      // their payer has no rouble value at all — not a value of 0 ₽ — and comes last.
      top: [
        ['rouble', 1000],
        ['crypto', 800],
        ['stars', null],
      ],
      ltvPayers: 2,
    });
  });

  it('states money in one currency natively, whatever the base is', async () => {
    const view = await onCleanSlate(async (tx, service) => {
      await rate(tx, 'USDT', '80');
      await customer(tx, 'crypto');
      await pay(tx, { userId: 'crypto', currency: 'USDT', amount: '12.5', createdAt: daysAgo(1) });
      const overview = await service.getAdvancedReport(7);
      return { money: overview.money, value: overview.metrics.revenue.current.value };
    });
    assert.deepEqual(view, { money: { currency: 'USDT', converted: false, rates: [], unconverted: [] }, value: 12.5 });
  });

  it('compares with a previous window of the same length that ends at the same time of day', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'buyer');
      // An hour after the previous window closed: never the previous window's. Unless the
      // day is nearly over, it is also before this window opened, and then in neither.
      await pay(tx, { userId: 'buyer', amount: '111', createdAt: new Date(Date.now() - 30 * DAY_MS + 3_600_000) });
      await pay(tx, { userId: 'buyer', amount: '222', createdAt: new Date(Date.now() - 30 * DAY_MS - 3_600_000) });
      await pay(tx, { userId: 'buyer', amount: '333', createdAt: daysAgo(45) });
      const overview = await service.getAdvancedReport(30);
      return {
        previous: overview.metrics.revenue.previous.value,
        previousBars: overview.previousSeries.revenue.reduce((sum, value) => sum + value, 0),
        current: overview.metrics.revenue.current.value,
      };
    });
    assert.equal(observed.previous, 555);
    assert.equal(observed.previousBars, 555);
    assert.ok(observed.current === 0 || observed.current === 111, `current ${observed.current}`);
  });

  it('counts payers once per window, new subscriptions by what was bought, and the average check per payer', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'twice', { createdAt: daysAgo(40) });
      await customer(tx, 'fresh', { createdAt: daysAgo(4) });
      await pay(tx, { userId: 'twice', amount: '300', purchaseType: 'RENEW', createdAt: daysAgo(10) });
      await pay(tx, { userId: 'twice', amount: '100', purchaseType: 'ADDITIONAL', createdAt: daysAgo(5), planSnapshot: { snapshotSource: 'ADDON_PURCHASE', addOnId: 'gb', name: '+50 GB' } });
      await pay(tx, { userId: 'fresh', amount: '200', purchaseType: 'NEW', createdAt: daysAgo(3), planSnapshot: { id: 'p1', name: 'Pro' } });
      await pay(tx, { userId: 'fresh', amount: '200', purchaseType: 'ADDITIONAL', createdAt: daysAgo(2), planSnapshot: { id: 'p1', name: 'Pro' } });
      const overview = await service.getAdvancedReport(30);
      return {
        payments: overview.metrics.payments.current,
        payers: overview.metrics.payingCustomers.current,
        newSubscriptions: overview.metrics.newSubscriptions.current,
        newUsers: overview.metrics.newUsers.current,
        arppu: overview.metrics.arppu.current,
        payerBars: overview.series.payingCustomers.reduce((sum, value) => sum + value, 0),
      };
    });
    assert.deepEqual(observed, {
      payments: 4,
      payers: 2,
      // NEW, and an ADDITIONAL that bought another subscription — not the add-on.
      newSubscriptions: 2,
      newUsers: 1,
      arppu: 400,
      payerBars: 4,
    });
  });

  it('measures paid subscriptions in force and churn by their terms, and the series ends where the count does', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'owner');
      const sub = (data: Partial<Prisma.SubscriptionUncheckedCreateInput>) =>
        tx.subscription.create({ data: { userId: 'owner', planSnapshot: {}, ...data } });
      await sub({ createdAt: daysAgo(90), expiresAt: daysAgo(20), status: 'EXPIRED' }); // lapsed inside the window: churned
      await sub({ createdAt: daysAgo(90), expiresAt: daysAhead(10) }); // renewed past now: kept
      await sub({ createdAt: daysAgo(90), expiresAt: daysAgo(45), status: 'EXPIRED' }); // lapsed in the previous window
      await sub({ createdAt: daysAgo(5), expiresAt: daysAhead(25) }); // new in the window
      const gone = await sub({ createdAt: daysAgo(90), expiresAt: daysAhead(10) });
      await deletedAt(tx, gone.id, daysAgo(80)); // deleted before both windows: nowhere
      await sub({ createdAt: daysAgo(90), expiresAt: daysAhead(10), isTrial: true }); // trial: not paid
      const overview = await service.getAdvancedReport(30);
      return {
        active: overview.metrics.activeSubscriptions,
        trials: overview.metrics.trialSubscriptions,
        churn: overview.metrics.churn,
        seriesEnd: overview.series.activeSubscriptions[overview.series.activeSubscriptions.length - 1],
        seriesStart: overview.series.activeSubscriptions[0],
      };
    });
    assert.deepEqual(observed.active, { current: 2, previous: 2 });
    assert.equal(observed.trials, 1);
    assert.deepEqual(observed.churn.current, { base: 2, churned: 1, rate: 0.5 });
    assert.deepEqual(observed.churn.previous, { base: 3, churned: 1, rate: 1 / 3 });
    assert.equal(observed.seriesEnd, observed.active.current, 'the series ends at the count it is drawn for');
    assert.equal(observed.seriesStart, 2);
  });

  it('follows the customers who registered in the window through the funnel, each step inside the one before', async () => {
    const funnel = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'looker', { createdAt: daysAgo(5) });
      await customer(tx, 'trialist', { createdAt: daysAgo(5) });
      await tx.trialGrant.create({ data: { userId: 'trialist', grantedAt: daysAgo(5) } });
      await customer(tx, 'buyer', { createdAt: daysAgo(5) });
      await pay(tx, { userId: 'buyer', createdAt: daysAgo(4) });
      await customer(tx, 'loyal', { createdAt: daysAgo(5) });
      await pay(tx, { userId: 'loyal', createdAt: daysAgo(4) });
      await pay(tx, { userId: 'loyal', createdAt: daysAgo(1) });
      // Registered long ago and paid in the window: a payer of the window, not a step of its funnel.
      await customer(tx, 'veteran', { createdAt: daysAgo(300) });
      await pay(tx, { userId: 'veteran', createdAt: daysAgo(2) });
      const overview = await service.getAdvancedReport(30);
      return overview.funnel.map((step) => [step.key, step.count, Math.round(step.pctOfPrev * 100)]);
    });
    assert.deepEqual(funnel, [
      ['registered', 4, 100],
      ['activated', 3, 75],
      ['paid', 2, 67],
      ['repeat', 1, 50],
    ]);
  });

  it('rates a payment system on the attempts that have an outcome, and counts its revenue from completed ones only', async () => {
    const provider = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'payer');
      for (const status of ['COMPLETED', 'COMPLETED', 'FAILED', 'CANCELED', 'PENDING'] as const) {
        await pay(tx, { userId: 'payer', status, amount: '100', createdAt: daysAgo(2) });
      }
      // A full refund as reconciliation writes it: CANCELED, stamped `refundReversedAt`.
      await pay(tx, {
        userId: 'payer',
        status: 'CANCELED',
        amount: '100',
        createdAt: daysAgo(2),
        fulfilledAt: daysAgo(2),
        gatewayData: { providerStatus: 'refund.succeeded', refundReversedAt: daysAgo(1).toISOString(), subscriptionRevoked: true },
      });
      // A 100 % promo code: completed at 0 without reaching the payment system.
      await pay(tx, { userId: 'payer', amount: '0', createdAt: daysAgo(2) });
      const overview = await service.getAdvancedReport(7);
      return overview.providers[0];
    });
    assert.equal(provider?.gatewayType, 'YOOKASSA');
    assert.deepEqual(
      {
        total: provider?.total,
        paid: provider?.paid,
        completed: provider?.completed,
        refunded: provider?.refunded,
        failed: provider?.failed,
        canceled: provider?.canceled,
        pending: provider?.pending,
      },
      { total: 6, paid: 3, completed: 2, refunded: 1, failed: 1, canceled: 1, pending: 1 },
    );
    assert.equal(provider?.successRate, 3 / 5);
    assert.equal(provider?.revenue, 200);
  });

  it('breaks revenue down by kind, plan and payment system so every breakdown adds up to the total', async () => {
    const report = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'buyer');
      await pay(tx, { userId: 'buyer', amount: '100', purchaseType: 'NEW', createdAt: daysAgo(3), planSnapshot: { id: 'p1', name: 'Pro' } });
      await pay(tx, { userId: 'buyer', amount: '40', purchaseType: 'UPGRADE', createdAt: daysAgo(3), planSnapshot: { id: 'p2', name: 'Max' } });
      await pay(tx, { userId: 'buyer', amount: '50', purchaseType: 'ADDITIONAL', createdAt: daysAgo(3), planSnapshot: { snapshotSource: 'ADDON_PURCHASE', addOnId: 'gb', name: '+50 GB' } });
      await pay(tx, { userId: 'buyer', amount: '70', purchaseType: 'NEW', createdAt: daysAgo(3), planSnapshot: { importedFrom: 'bedolaga' } });
      // A combined renewal: 600 + 400 at list price, paid 900 — shared 540 / 360.
      const subA = await tx.subscription.create({ data: { userId: 'buyer', planSnapshot: { id: 'p1', name: 'Pro' } } });
      const subB = await tx.subscription.create({ data: { userId: 'buyer', planSnapshot: { id: 'p2', name: 'Max' } } });
      const combined = await pay(tx, { userId: 'buyer', amount: '900', purchaseType: 'RENEW', createdAt: daysAgo(2), planSnapshot: { combinedRenewal: true, snapshotSource: 'RENEWAL_DRAFT' } });
      await tx.transactionItem.createMany({
        data: [
          { transactionId: combined.id, subscriptionId: subA.id, planId: 'p1', planSnapshot: { id: 'p1', name: 'Pro' }, durationDays: 30, amount: '600', currency: 'RUB' },
          { transactionId: combined.id, subscriptionId: subB.id, planId: 'p2', planSnapshot: { id: 'p2', name: 'Max (renamed)' }, durationDays: 30, amount: '400', currency: 'RUB' },
        ],
      });
      await pay(tx, { userId: 'buyer', amount: '10', gatewayType: 'PLATEGA', createdAt: daysAgo(1), planSnapshot: { id: 'p1', name: 'Pro' } });
      return service.getRevenueReport(30);
    });
    assert.equal(report.total.value, 1170);
    assert.deepEqual(
      report.byKind.map((kind) => [kind.kind, kind.figure.value, kind.payments]),
      [
        ['new', 180, 3],
        ['renewal', 900, 1],
        ['change', 40, 1],
        ['addon', 50, 1],
      ],
    );
    assert.deepEqual(
      report.byPlan.map((plan) => [plan.key, plan.name, plan.figure.value, plan.payments]),
      [
        ['plan:p1', 'Pro', 650, 3],
        ['plan:p2', 'Max (renamed)', 400, 2],
        ['none', null, 70, 1],
        ['addon', '+50 GB', 50, 1],
      ],
    );
    assert.equal(report.byPlan.reduce((sum, plan) => sum + plan.figure.value, 0), report.total.value);
    assert.deepEqual(
      report.byGateway.map((gateway) => [gateway.gatewayType, gateway.figure.value]),
      [
        ['YOOKASSA', 1160],
        ['PLATEGA', 10],
      ],
    );
    assert.equal(report.series.reduce((sum, point) => sum + point.total, 0), report.total.value);
    const lastBar = report.series[report.series.length - 2];
    assert.deepEqual(lastBar?.byKind, { new: 10, renewal: 0, change: 0, addon: 0 });
  });

  it('converts a trial only by a payment made after it, and counts the days from the grant', async () => {
    const report = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'converted');
      await tx.trialGrant.create({ data: { userId: 'converted', grantedAt: daysAgo(10) } });
      await pay(tx, { userId: 'converted', amount: '999', createdAt: daysAgo(12), planSnapshot: { id: 'old', name: 'Old' } });
      await pay(tx, { userId: 'converted', amount: '300', createdAt: daysAgo(3), planSnapshot: { id: 'p1', name: 'Pro' } });
      await pay(tx, { userId: 'converted', amount: '300', createdAt: daysAgo(1), purchaseType: 'RENEW', planSnapshot: { id: 'p1', name: 'Pro' } });
      await customer(tx, 'paidBefore');
      await tx.trialGrant.create({ data: { userId: 'paidBefore', grantedAt: daysAgo(6) } });
      await pay(tx, { userId: 'paidBefore', amount: '500', createdAt: daysAgo(8) });
      await customer(tx, 'stillTrying');
      await tx.trialGrant.create({ data: { userId: 'stillTrying', grantedAt: daysAgo(2) } });
      return service.getTrialConversion(30);
    });
    assert.equal(report.totalTrialUsers, 3);
    assert.equal(report.convertedUsers, 1);
    assert.equal(report.conversionRate, 1 / 3);
    assert.deepEqual(
      report.daysToConvert.map((bucket) => [bucket.key, bucket.users]),
      [['d0', 0], ['d1_3', 0], ['d4_7', 1], ['d8_14', 0], ['d15_30', 0], ['d31_plus', 0]],
    );
    assert.ok(Math.abs((report.medianDaysToConvert ?? 0) - 7) < 0.01, `median ${report.medianDaysToConvert}`);
    // Everything paid from the trial on — not the 999 before it.
    assert.equal(report.revenueFromConverted, 600);
    assert.deepEqual(report.topConvertedPlans.map((plan) => [plan.plan, plan.planId, plan.count]), [['Pro', 'p1', 1]]);
  });

  it('times the first payment from registration, for customers whose first payment ever is in the window', async () => {
    const first = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'slow', { createdAt: daysAgo(45) });
      await pay(tx, { userId: 'slow', createdAt: daysAgo(5) });
      await customer(tx, 'quick', { createdAt: new Date(Date.now() - 5 * 3_600_000) });
      await pay(tx, { userId: 'quick', createdAt: new Date(Date.now() - 3_600_000) });
      await customer(tx, 'returning', { createdAt: daysAgo(100) });
      await pay(tx, { userId: 'returning', createdAt: daysAgo(80) });
      await pay(tx, { userId: 'returning', createdAt: daysAgo(3) });
      return (await service.getTrialConversion(30)).firstPayment;
    });
    assert.equal(first.payers, 2);
    assert.deepEqual(
      first.buckets.map((bucket) => [bucket.key, bucket.users]),
      [['d0', 1], ['d1_3', 0], ['d4_7', 0], ['d8_14', 0], ['d15_30', 0], ['d31_plus', 1]],
    );
  });

  it('builds the cohort matrix from signup months and payment months, in UTC', async () => {
    const cohorts = await onCleanSlate(async (tx, service) => {
      const now = new Date();
      const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12));
      const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
      await customer(tx, 'april', { createdAt: lastMonth });
      await customer(tx, 'may', { createdAt: thisMonth });
      await customer(tx, 'idle', { createdAt: thisMonth });
      await pay(tx, { userId: 'april', createdAt: thisMonth });
      await pay(tx, { userId: 'may', createdAt: thisMonth });
      return (await service.getCohortRetention()).slice(-2);
    });
    assert.deepEqual(
      cohorts.map((row) => [row.cohortSize, row.retentionByMonth]),
      [
        [1, [0, 1]],
        [2, [0.5]],
      ],
    );
  });

  it('splits the subscriptions ending in the coming month by whether autopay will try', async () => {
    const report = await onCleanSlate(async (tx, service) => {
      const owner = async (id: string, method?: Partial<Prisma.SavedPaymentMethodUncheckedCreateInput>, blocked = false) => {
        await customer(tx, id, { isBlocked: blocked });
        if (method !== undefined) {
          await tx.savedPaymentMethod.create({
            data: { userId: id, gatewayType: 'YOOKASSA', providerMethodId: `pm-${id}`, methodType: 'bank_card', ...method },
          });
        }
      };
      // A plan still on sale, so a renewal needs nobody's choice.
      const plan = await tx.plan.create({ data: { name: `expiring-spec-${Date.now()}` } });
      const ending = (userId: string, days: number, extra: Partial<Prisma.SubscriptionUncheckedCreateInput> = {}) =>
        tx.subscription.create({ data: { userId, planSnapshot: { id: plan.id, name: plan.name }, expiresAt: daysAhead(days), ...extra } });
      await owner('card', {});
      await ending('card', 3);
      // LIMITED: auto-renew charges ACTIVE subscriptions only, so nothing will be charged.
      await owner('limitedCard', {});
      await ending('limitedCard', 3, { status: 'LIMITED' });
      await owner('cardOff', { autopayEnabled: false });
      await ending('cardOff', 3);
      await owner('demoCard', { providerMethodId: 'demo_pm_1' });
      await ending('demoCard', 3);
      await owner('unbound', { isActive: false });
      await ending('unbound', 3);
      await owner('none');
      await ending('none', 5, { status: 'LIMITED' });
      await ending('none', 5, { isTrial: true });
      await ending('none', 5, { status: 'DISABLED' });
      await ending('none', 40);
      await owner('blocked', {}, true);
      await ending('blocked', 3);
      return service.getExpiring();
    });
    assert.deepEqual(report.totals, { autopay: 1, manual: 5, trial: 1 });
    assert.equal(report.days.length, 30);
    assert.deepEqual(report.days[3], { date: report.days[3]!.date, autopay: 1, manual: 4, trial: 0 });
    assert.deepEqual(report.days[5], { date: report.days[5]!.date, autopay: 0, manual: 1, trial: 1 });
  });

  it('counts live subscriptions per plan by its id, under its latest name', async () => {
    const plans = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'owner');
      const sub = (planSnapshot: Prisma.InputJsonValue, extra: Partial<Prisma.SubscriptionUncheckedCreateInput> = {}) =>
        tx.subscription.create({ data: { userId: 'owner', planSnapshot, ...extra } });
      const renamedLater = await sub({ id: 'p1', name: 'Pro+' }, { status: 'LIMITED' });
      const older = await sub({ id: 'p1', name: 'Pro' });
      // Raw, because Prisma stamps `updatedAt` itself: the renamed row is the newer one.
      await tx.$executeRaw`UPDATE "subscriptions" SET "updated_at" = ${daysAgo(3)} WHERE "id" = ${older.id}`;
      await tx.$executeRaw`UPDATE "subscriptions" SET "updated_at" = ${daysAgo(1)} WHERE "id" = ${renamedLater.id}`;
      await sub({ id: 't', name: 'Trial' }, { isTrial: true });
      await sub({ id: 'p1', name: 'Pro' }, { status: 'EXPIRED' });
      return service.getSubscriptionsByPlan();
    });
    assert.deepEqual(
      plans.map((plan) => [plan.planId, plan.plan, plan.active, plan.limited, plan.trial, plan.total]),
      [
        ['p1', 'Pro+', 1, 1, 0, 2],
        ['t', 'Trial', 1, 0, 1, 1],
      ],
    );
  });

  it('bins lifetime value in the view currency, with the tail in an open last bin', async () => {
    const ltv = await onCleanSlate(async (tx, service) => {
      await rate(tx, 'USDT', '100');
      for (let index = 0; index < 20; index++) {
        await customer(tx, `c${index}`);
        // 99 … 1 999 ₽: the 95th percentile stays below the round 2 000 the bins end at.
        await pay(tx, { userId: `c${index}`, amount: String(100 * (index + 1) - 1), createdAt: daysAgo(10) });
      }
      await customer(tx, 'whale');
      await pay(tx, { userId: 'whale', currency: 'USDT', amount: '1000', createdAt: daysAgo(10) });
      return service.getLtvDistribution();
    });
    assert.equal(ltv.money.currency, 'RUB');
    assert.equal(ltv.stats.payers, 21);
    assert.equal(ltv.buckets.reduce((sum, bucket) => sum + bucket.users, 0), 21);
    const tail = ltv.buckets[ltv.buckets.length - 1];
    assert.equal(tail?.to, null, 'the last bin is open');
    assert.equal(tail?.users, 1, 'the 100 000 ₽ whale alone in the tail');
    assert.ok(ltv.buckets.slice(0, -1).every((bucket) => bucket.to !== null && bucket.to - bucket.from === ltv.buckets[0]!.to), 'equal widths');
  });

  // ── Review, round 2: the rows production writes ───────────────────────────

  it('counts churn and paid subscriptions in force with deleted rows — the default cleanup deletes a lapsed subscription 3 days after it ends', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'owner');
      const sub = (data: Partial<Prisma.SubscriptionUncheckedCreateInput>) =>
        tx.subscription.create({ data: { userId: 'owner', planSnapshot: {}, createdAt: daysAgo(100), ...data } });
      /** Ended `days` ago; the expired-profile cleanup deleted it three days later. */
      const lapsedAndCleaned = async (days: number) => {
        const row = await sub({ expiresAt: daysAgo(days), status: 'EXPIRED' });
        await deletedAt(tx, row.id, daysAgo(days - 3));
      };
      for (let index = 0; index < 7; index++) await sub({ expiresAt: daysAhead(20) }); // kept
      await lapsedAndCleaned(20);
      await lapsedAndCleaned(10);
      await sub({ expiresAt: daysAgo(1), status: 'EXPIRED' }); // ended yesterday, not cleaned yet
      for (let index = 0; index < 2; index++) await sub({ createdAt: daysAgo(5), expiresAt: daysAhead(25) }); // new in the window
      // The previous window: three more in force at its start that ended inside it, cleaned long ago.
      for (const days of [55, 45, 35]) await lapsedAndCleaned(days);
      const overview = await service.getAdvancedReport(30);
      return { churn: overview.metrics.churn, active: overview.metrics.activeSubscriptions };
    });
    assert.deepEqual(observed.churn.current, { base: 10, churned: 3, rate: 0.3 });
    assert.deepEqual(observed.churn.previous, { base: 13, churned: 3, rate: 3 / 13 });
    assert.deepEqual(observed.active, { current: 9, previous: 10 });
  });

  it('dates a paid term from when it became paid: a trial from its payment, an import from its original start, a changed plan from the first plan', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      // A trial granted before the window and upgraded in place inside it: the row keeps the trial's `created_at`.
      await customer(tx, 'late', { createdAt: daysAgo(40) });
      const trial = await tx.subscription.create({
        data: { userId: 'late', planSnapshot: { id: 'pro', name: 'Pro' }, createdAt: daysAgo(31), startedAt: daysAgo(26), expiresAt: daysAhead(4) },
      });
      await trialClaim(tx, 'late', trial.id, daysAgo(31));
      await pay(tx, { userId: 'late', subscriptionId: trial.id, purchaseType: 'UPGRADE', amount: '300', createdAt: daysAgo(26), planSnapshot: { id: 'pro', name: 'Pro' } });
      // Paid long ago, moved to another plan inside the window: every upgrade resets `started_at`.
      await customer(tx, 'upgrader', { createdAt: daysAgo(100) });
      const paid = await tx.subscription.create({
        data: { userId: 'upgrader', planSnapshot: { id: 'max', name: 'Max' }, createdAt: daysAgo(100), startedAt: daysAgo(5), expiresAt: daysAhead(25) },
      });
      await pay(tx, { userId: 'upgrader', subscriptionId: paid.id, amount: '500', createdAt: daysAgo(100) });
      await pay(tx, { userId: 'upgrader', subscriptionId: paid.id, purchaseType: 'UPGRADE', amount: '200', createdAt: daysAgo(5) });
      // Imported yesterday: `created_at` is the import, `started_at` the donor's start date.
      await customer(tx, 'imported', { createdAt: daysAgo(1) });
      await tx.subscription.create({
        data: { userId: 'imported', planSnapshot: { importedFrom: 'bedolaga' }, createdAt: daysAgo(1), startedAt: daysAgo(200), expiresAt: daysAhead(10) },
      });
      // Deleted by an operator while its term still ran: it ended when it was deleted.
      await customer(tx, 'removed', { createdAt: daysAgo(100) });
      const removed = await tx.subscription.create({ data: { userId: 'removed', planSnapshot: {}, createdAt: daysAgo(100), expiresAt: daysAhead(20) } });
      await deletedAt(tx, removed.id, daysAgo(2));
      const overview = await service.getAdvancedReport(30);
      const series = overview.series.activeSubscriptions;
      return {
        active: overview.metrics.activeSubscriptions,
        churn: overview.metrics.churn.current,
        seriesStart: series[0],
        seriesEnd: series[series.length - 1],
      };
    });
    // Now: the converted trial, the changed plan, the import. When the window opened: the changed plan, the import, the deleted one.
    assert.deepEqual(observed.active, { current: 3, previous: 3 });
    assert.deepEqual(observed.churn, { base: 3, churned: 1, rate: 1 / 3 });
    assert.equal(observed.seriesStart, 3);
    assert.equal(observed.seriesEnd, 3);
  });

  it('files a trial turned paid as a new subscription, and only a change of a subscription that was already paid for as a change', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      // The panel converts a trial by upgrading the trial row: a customer with an active trial cannot buy NEW.
      await customer(tx, 'trialist', { createdAt: daysAgo(10) });
      await tx.trialGrant.create({ data: { userId: 'trialist', grantedAt: daysAgo(10) } });
      const trial = await tx.subscription.create({
        data: { userId: 'trialist', planSnapshot: { id: 'pro', name: 'Pro' }, createdAt: daysAgo(10), startedAt: daysAgo(5), expiresAt: daysAhead(25) },
      });
      await trialClaim(tx, 'trialist', trial.id, daysAgo(10));
      await pay(tx, { userId: 'trialist', subscriptionId: trial.id, purchaseType: 'UPGRADE', amount: '300', createdAt: daysAgo(5), planSnapshot: { id: 'pro', name: 'Pro' } });
      // Bought directly.
      await customer(tx, 'direct', { createdAt: daysAgo(4) });
      const bought = await tx.subscription.create({
        data: { userId: 'direct', planSnapshot: { id: 'pro', name: 'Pro' }, createdAt: daysAgo(3), startedAt: daysAgo(3), expiresAt: daysAhead(27) },
      });
      await pay(tx, { userId: 'direct', subscriptionId: bought.id, amount: '300', createdAt: daysAgo(3), planSnapshot: { id: 'pro', name: 'Pro' } });
      // Paid for, then moved to a bigger plan: a change.
      await customer(tx, 'upgrader', { createdAt: daysAgo(100) });
      const paid = await tx.subscription.create({
        data: { userId: 'upgrader', planSnapshot: { id: 'max', name: 'Max' }, createdAt: daysAgo(100), startedAt: daysAgo(2), expiresAt: daysAhead(28) },
      });
      await pay(tx, { userId: 'upgrader', subscriptionId: paid.id, amount: '500', createdAt: daysAgo(100), planSnapshot: { id: 'pro', name: 'Pro' } });
      await pay(tx, { userId: 'upgrader', subscriptionId: paid.id, purchaseType: 'UPGRADE', amount: '200', createdAt: daysAgo(2), planSnapshot: { id: 'max', name: 'Max' } });
      // Imported: the donor's payments are linked to no subscription. The first change in the panel is still a change.
      await customer(tx, 'imported', { createdAt: daysAgo(1) });
      await pay(tx, {
        userId: 'imported',
        paymentId: 'bedolaga:1',
        amount: '1000',
        channel: 'TELEGRAM',
        createdAt: daysAgo(200),
        fulfilledAt: daysAgo(200),
        planSnapshot: { importedFrom: 'bedolaga', sourceTransactionId: 1, sourceType: 'deposit' },
      });
      const migrated = await tx.subscription.create({
        data: { userId: 'imported', planSnapshot: { id: 'max', name: 'Max' }, createdAt: daysAgo(1), startedAt: daysAgo(1), expiresAt: daysAhead(29) },
      });
      await pay(tx, { userId: 'imported', subscriptionId: migrated.id, purchaseType: 'UPGRADE', amount: '150', createdAt: daysAgo(1), planSnapshot: { id: 'max', name: 'Max' } });
      const overview = await service.getAdvancedReport(30);
      const revenue = await service.getRevenueReport(30);
      return {
        newSubscriptions: overview.metrics.newSubscriptions.current,
        kinds: revenue.byKind.map((kind) => [kind.kind, kind.figure.value, kind.payments]),
      };
    });
    assert.equal(observed.newSubscriptions, 2);
    assert.deepEqual(observed.kinds, [
      ['new', 600, 2],
      ['renewal', 0, 0],
      ['change', 350, 2],
      ['addon', 0, 0],
    ]);
  });

  it('leaves a spend of a partner’s balance out of revenue, payers and payment systems, and states it apart', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'referred', { createdAt: daysAgo(5) });
      await customer(tx, 'partner', { createdAt: daysAgo(5) });
      await pay(tx, { userId: 'referred', amount: '1000', createdAt: daysAgo(3) });
      // Paid from the balance the referral's payment earned: money already counted once.
      await pay(tx, { userId: 'partner', amount: '300', gatewayType: 'PARTNER_BALANCE', createdAt: daysAgo(2), fulfilledAt: daysAgo(2) });
      const overview = await service.getAdvancedReport(30);
      const revenue = await service.getRevenueReport(30);
      const top = await service.getTopPayers(5);
      const ltv = await service.getLtvDistribution();
      return {
        revenue: overview.metrics.revenue.current.value,
        payers: overview.metrics.payingCustomers.current,
        funnelPaid: overview.funnel.find((step) => step.key === 'paid')?.count,
        providers: overview.providers.map((provider) => provider.gatewayType),
        partnerBalance: overview.partnerBalance,
        revenueTotal: revenue.total.value,
        kinds: revenue.byKind.reduce((sum, kind) => sum + kind.figure.value, 0),
        gateways: revenue.byGateway.map((gateway) => gateway.gatewayType),
        revenuePartnerBalance: revenue.partnerBalance,
        top: top.payers.map((payer) => payer.userId),
        ltvPayers: ltv.stats.payers,
      };
    });
    const spent = { figure: { value: 300, byCurrency: [{ currency: 'RUB', amount: 300 }] }, payments: 1 };
    assert.deepEqual(observed, {
      revenue: 1000,
      payers: 1,
      funnelPaid: 1,
      providers: ['YOOKASSA'],
      partnerBalance: spent,
      revenueTotal: 1000,
      kinds: 1000,
      gateways: ['YOOKASSA'],
      revenuePartnerBalance: spent,
      top: ['referred'],
      ltvPayers: 1,
    });
  });

  it('counts a refunded payment as a checkout that went through, and nets refunds out of every money figure', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      await customer(tx, 'buyer');
      for (let index = 0; index < 8; index++) await pay(tx, { userId: 'buyer', amount: '1000', createdAt: daysAgo(3), fulfilledAt: daysAgo(3) });
      // Refunded in full: reconciliation marks the payment CANCELED and stamps the reversal on it.
      for (let index = 0; index < 2; index++) {
        await pay(tx, {
          userId: 'buyer',
          amount: '1000',
          status: 'CANCELED',
          createdAt: daysAgo(3),
          fulfilledAt: daysAgo(3),
          gatewayData: { providerStatus: 'refund.succeeded', refundReversedAt: daysAgo(1).toISOString(), subscriptionRevoked: true },
        });
      }
      // Refunded in part: the payment stays COMPLETED at its full amount, with the total returned on it.
      await pay(tx, {
        userId: 'buyer',
        amount: '1000',
        createdAt: daysAgo(3),
        fulfilledAt: daysAgo(3),
        gatewayData: {
          providerStatus: 'refund.succeeded',
          refundedAmountTotal: '400.00',
          refunds: [{ refundId: 'refund-1', amount: '400.00', at: daysAgo(1).toISOString() }],
          partialRefundAt: daysAgo(1).toISOString(),
          refundNeedsManualReview: true,
        },
      });
      const overview = await service.getAdvancedReport(7);
      const revenue = await service.getRevenueReport(7);
      const top = await service.getTopPayers(5);
      const ltv = await service.getLtvDistribution();
      const provider = overview.providers[0];
      return {
        provider: {
          paid: provider?.paid,
          refunded: provider?.refunded,
          canceled: provider?.canceled,
          successRate: provider?.successRate,
          revenue: provider?.revenue,
        },
        revenue: overview.metrics.revenue.current.value,
        revenueTotal: revenue.total.value,
        top: top.payers[0]?.totalSpent,
        ltvMean: ltv.stats.mean,
      };
    });
    assert.deepEqual(observed, {
      provider: { paid: 11, refunded: 3, canceled: 0, successRate: 1, revenue: 8600 },
      revenue: 8600,
      revenueTotal: 8600,
      top: 8600,
      ltvMean: 8600,
    });
  });

  it('does not take a completion for nothing as money: payers, the average check, trial → paid and the funnel', async () => {
    const observed = await onCleanSlate(async (tx, service) => {
      for (const id of ['p1', 'p2']) {
        await customer(tx, id, { createdAt: daysAgo(5) });
        await pay(tx, { userId: id, amount: '500', createdAt: daysAgo(3) });
      }
      // A 100 % promo code: the checkout completes at 0.
      for (const id of ['f1', 'f2']) {
        await customer(tx, id, { createdAt: daysAgo(6) });
        await tx.trialGrant.create({ data: { userId: id, grantedAt: daysAgo(6) } });
        await pay(tx, { userId: id, amount: '0', createdAt: daysAgo(3) });
      }
      const overview = await service.getAdvancedReport(30);
      const trial = await service.getTrialConversion(30);
      return {
        payers: overview.metrics.payingCustomers.current,
        arppu: overview.metrics.arppu.current,
        trial: [trial.convertedUsers, trial.totalTrialUsers],
        funnelPaid: overview.funnel.find((step) => step.key === 'paid')?.count,
      };
    });
    assert.deepEqual(observed, { payers: 2, arppu: 500, trial: [0, 2], funnelPaid: 2 });
  });

  it('builds a cohort from its signup month and counts only payments made after the signup — in the cohorts and in the funnel', async () => {
    const signedUp = new Date(Date.now() - 3_600_000);
    const month = signedUp.toISOString().slice(0, 7);
    const observed = await onCleanSlate(async (tx, service) => {
      // Imported an hour ago: an importer stamps `created_at` with the import; the donor's payments keep their dates.
      for (let index = 0; index < 10; index++) await customer(tx, `imp${index}`, { createdAt: signedUp });
      await pay(tx, { userId: 'imp0', createdAt: daysAgo(40), planSnapshot: { importedFrom: 'bedolaga' } });
      await pay(tx, { userId: 'imp1', createdAt: daysAgo(70), planSnapshot: { importedFrom: 'bedolaga' } });
      // Earlier the same month, minutes before the import stamped the customer.
      await pay(tx, { userId: 'imp3', createdAt: new Date(signedUp.getTime() - 600_000), planSnapshot: { importedFrom: 'bedolaga' } });
      await pay(tx, { userId: 'imp2', createdAt: new Date(Date.now() - 1_800_000) });
      const cohorts = await service.getCohortRetention();
      const overview = await service.getAdvancedReport(30);
      return {
        cohort: cohorts.find((row) => row.cohort === month),
        funnel: overview.funnel.map((step) => [step.key, step.count]),
      };
    });
    assert.equal(observed.cohort?.cohortSize, 10);
    assert.equal(observed.cohort?.retentionByMonth[0], 0.1);
    assert.ok(observed.cohort?.retentionByMonth.slice(1).every((share) => share === 0), 'nobody paid in a later month');
    assert.deepEqual(observed.funnel, [
      ['registered', 10],
      ['activated', 1],
      ['paid', 1],
      ['repeat', 0],
    ]);
  });

  it('counts days in the operator’s time zone: the window opens at local midnight, and 01:30 MSK is in that day’s bar', async () => {
    const MSK_MS = 3 * 3_600_000;
    const now = Date.now();
    const mskToday = new Date(now + MSK_MS).toISOString().slice(0, 10);
    let paidAt = Date.parse(`${mskToday}T01:30:00+03:00`);
    if (paidAt > now) paidAt -= DAY_MS;
    const mskDay = new Date(paidAt + MSK_MS).toISOString().slice(0, 10);
    const overview = await onCleanSlate(
      async (tx, service) => {
        await customer(tx, 'night');
        await pay(tx, { userId: 'night', amount: '777', createdAt: new Date(paidAt) });
        return service.getAdvancedReport(7);
      },
      { timezone: 'Europe/Moscow' },
    );
    const bar = overview.series.revenue.indexOf(777);
    assert.equal(overview.period.buckets[bar]?.from, mskDay, 'the Moscow day, not the UTC day before it');
    assert.equal(overview.period.start, new Date(Date.parse(`${mskToday}T00:00:00+03:00`) - 6 * DAY_MS).toISOString());
    assert.deepEqual([overview.period.timeZone, overview.period.timeZoneFallback], ['Europe/Moscow', false]);
  });

  it('falls back to UTC days when the panel’s time zone is empty or not a zone, and says so', async () => {
    const periods: unknown[] = [];
    for (const timezone of ['Mars/Olympus_Mons', '', null, "UTC'; DROP TABLE users; --"]) {
      const overview = await onCleanSlate((_tx, service) => service.getAdvancedReport(7), { timezone });
      periods.push([overview.period.timeZone, overview.period.timeZoneFallback]);
    }
    assert.deepEqual(periods, [
      ['UTC', true],
      ['UTC', true],
      ['UTC', true],
      ['UTC', true],
    ]);
  });

  it('files instants into the local days of a zone across a DST switch — SQL and labels agree, no day doubled or lost', async () => {
    const window = planAnalyticsWindow(30, new Date('2025-11-10T17:00:00Z'), { name: 'America/New_York', fallback: false });
    const labels = describePeriod(window).buckets.map((bucket) => bucket.from);
    const days: unknown[] = [];
    // 23:30 EDT on 1 Nov; 00:30 EDT, 01:30 EDT, 01:30 EST (the hour repeats) and 23:30 EST on 2 Nov; 00:30 EST on 3 Nov.
    for (const iso of ['2025-11-02T03:30:00Z', '2025-11-02T04:30:00Z', '2025-11-02T05:30:00Z', '2025-11-02T06:30:00Z', '2025-11-03T04:30:00Z', '2025-11-03T05:30:00Z']) {
      const [row] = await prisma.$queryRaw<Array<{ bucket: number }>>(
        Prisma.sql`SELECT ${bucketIndexSql(Prisma.sql`${new Date(iso)}::timestamptz`, window)} AS "bucket"`,
      );
      days.push(labels[row!.bucket]);
    }
    assert.deepEqual(days, ['2025-11-01', '2025-11-02', '2025-11-02', '2025-11-02', '2025-11-02', '2025-11-03']);
  });

  it('says «С автоплатежом» for exactly the subscriptions auto-renew will charge', async () => {
    const refuse = (what: string): never =>
      new Proxy({}, { get: (_target, property) => { throw new Error(`${what}.${String(property)} has no part in choosing whom to charge`); } }) as never;
    const unique = (name: string): string => `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    type Seed = (tx: Prisma.TransactionClient) => Promise<void>;
    const card = (tx: Prisma.TransactionClient, extra: Partial<Prisma.SavedPaymentMethodUncheckedCreateInput> = {}) =>
      tx.savedPaymentMethod.create({ data: { userId: 'owner', gatewayType: 'YOOKASSA', providerMethodId: unique('pm'), methodType: 'bank_card', ...extra } });
    const ending = async (tx: Prisma.TransactionClient, planSnapshot: Prisma.InputJsonValue, extra: Partial<Prisma.SubscriptionUncheckedCreateInput> = {}) => {
      await tx.subscription.create({ data: { userId: 'owner', planSnapshot, expiresAt: new Date(Date.now() + 120_000), ...extra } });
    };
    const onSale = async (tx: Prisma.TransactionClient, extra: Partial<Prisma.PlanUncheckedCreateInput> = {}) =>
      tx.plan.create({ data: { name: unique('plan'), ...extra } });
    const cases: ReadonlyArray<readonly [string, Seed]> = [
      ['active, a plan on sale and a card', async (tx) => { await card(tx); await ending(tx, { id: (await onSale(tx)).id }); }],
      ['LIMITED', async (tx) => { await card(tx); await ending(tx, { id: (await onSale(tx)).id }, { status: 'LIMITED' }); }],
      ['a trial', async (tx) => { await card(tx); await ending(tx, { id: (await onSale(tx)).id }, { isTrial: true }); }],
      ['no card', async (tx) => { await ending(tx, { id: (await onSale(tx)).id }); }],
      ['autopay switched off on the card', async (tx) => { await card(tx, { autopayEnabled: false }); await ending(tx, { id: (await onSale(tx)).id }); }],
      ['the newest card is a demo one', async (tx) => {
        await card(tx, { createdAt: daysAgo(2) });
        await card(tx, { providerMethodId: unique('demo_pm_'), createdAt: daysAgo(1) });
        await ending(tx, { id: (await onSale(tx)).id });
      }],
      ['its plan was deleted', async (tx) => { await card(tx); await ending(tx, { id: (await onSale(tx, { deletedAt: daysAgo(1) })).id }); }],
      ['no plan recorded', async (tx) => { await card(tx); await ending(tx, {}); }],
      ['archived, renews onto replacements, none on sale', async (tx) => {
        await card(tx);
        const retired = await onSale(tx, { isActive: false });
        await ending(tx, { id: (await onSale(tx, { isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: [retired.id] })).id });
      }],
      ['archived, renews onto a replacement on sale', async (tx) => {
        await card(tx);
        const replacement = await onSale(tx);
        await ending(tx, { id: (await onSale(tx, { isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: [replacement.id] })).id });
      }],
      ['archived, renews itself', async (tx) => { await card(tx); await ending(tx, { id: (await onSale(tx, { isArchived: true })).id }); }],
    ];
    const results: unknown[] = [];
    for (const [name, seed] of cases) {
      const outcome = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'owner');
        await seed(tx);
        const charged: string[] = [];
        const autoRenew = new AutoRenewService(
          tx as never,
          refuse('userNotifications'),
          {
            renewalCheckout: async (input: Parameters<PaymentsRenewalCheckoutService['renewalCheckout']>[0]) => {
              charged.push(...input.subscriptionIds);
              return { transactionStatus: 'PENDING', paymentId: 'parity-probe', checkoutUrl: null };
            },
          } as never,
          new SavedPaymentMethodService(tx as never, refuse('systemEvents')),
          refuse('noticePayload'),
          new SubscriptionRenewalService(tx as never, refuse('subscriptionQuoteService'), refuse('addOnEligibilityService')),
        );
        await autoRenew.processAutopayCharges();
        const report = await service.getExpiring();
        return { charged: charged.length, autopay: report.totals.autopay };
      });
      results.push([name, outcome.charged, outcome.autopay]);
    }
    assert.deepEqual(results, [
      ['active, a plan on sale and a card', 1, 1],
      ['LIMITED', 0, 0],
      ['a trial', 0, 0],
      ['no card', 0, 0],
      ['autopay switched off on the card', 0, 0],
      ['the newest card is a demo one', 0, 0],
      ['its plan was deleted', 0, 0],
      ['no plan recorded', 0, 0],
      ['archived, renews onto replacements, none on sale', 0, 0],
      ['archived, renews onto a replacement on sale', 1, 1],
      ['archived, renews itself', 1, 1],
    ]);
  });
});
