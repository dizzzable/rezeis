import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { BusinessAnalyticsService } from '../src/modules/business-analytics/services/business-analytics.service';
import type { FxRateService } from '../src/modules/fx/fx-rate.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { readPlatformBranding } from '../src/modules/settings/utils/platform-branding.util';

Logger.overrideLogger(false);

/**
 * The newer cards of «Бизнес-аналитика» against a real PostgreSQL: the
 * statements whose result only an engine can prove — recursive chains of paid
 * periods, outcomes of renewals, buckets of discounts.
 *
 * Each test runs in a transaction that is rolled back, after truncating
 * `users` (cascading to payments, subscriptions and saved cards) and
 * `fx_rates` inside it, so it reads exactly the rows it seeded.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const DAY_MS = 86_400_000;
let prisma: PrismaService;

const REPORTING_IN_RUB = ({ getBaseCurrency: () => 'RUB' } satisfies Pick<FxRateService, 'getBaseCurrency'>) as unknown as FxRateService;

function zoneSetting(timezone: string | null): SettingsService {
  return ({ getPlatformBranding: async () => readPlatformBranding({ timezone }) } satisfies Pick<
    SettingsService,
    'getPlatformBranding'
  >) as unknown as SettingsService;
}

class RolledBack extends Error {}

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

/** A customer registered long enough ago for any payment of the specs to follow their registration. */
async function customer(tx: Prisma.TransactionClient, id: string, extra: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  return tx.user.create({ data: { id, referralCode: `${id}-ref`, name: id, createdAt: daysAgo(900), ...extra } });
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

/** A purchase of `days` days of the plan `pro`, as the checkout records it. */
function bought(days: number, extra: Prisma.InputJsonObject = {}): Prisma.InputJsonObject {
  return { id: 'pro', name: 'Pro', availability: 'PUBLIC', selectedDurationDays: days, ...extra };
}

/** The 15th of the month `monthsBack` months before this one, noon UTC. */
function midMonth(monthsBack: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 15, 12, 0, 0));
}

const plusDays = (at: Date, days: number): Date => new Date(at.getTime() + days * DAY_MS);

run('business analytics cards on PostgreSQL', { concurrency: false }, () => {
  before(() => {
    prisma = new PrismaService();
  });
  after(async () => {
    await prisma.$disconnect();
  });

  // ── «Удержание по месяцу первой оплаты» ──────────────────────────────────

  describe('retention by month of first payment', () => {
    it('counts a client covered at a month mark by the chain of their paid periods, grace included', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        const first = midMonth(7);
        // A: a year at once. B: a month, renewed a day late, then gone. C: a month, then gone.
        for (const id of ['a', 'b', 'c']) await customer(tx, id);
        await pay(tx, { userId: 'a', createdAt: first, planSnapshot: bought(360) });
        await pay(tx, { userId: 'b', createdAt: first, planSnapshot: bought(30) });
        await pay(tx, { userId: 'b', purchaseType: 'RENEW', createdAt: plusDays(first, 31), planSnapshot: bought(30) });
        await pay(tx, { userId: 'c', createdAt: first, planSnapshot: bought(30) });
        return service.getPaidCohortRetention();
      });
      const row = report.cohorts.find((cohort) => cohort.cohortSize > 0);
      assert.ok(row !== undefined);
      assert.equal(row.cohortSize, 3);
      assert.equal(report.graceDays, 4);
      const cells = row.retentionByMonth.slice(0, 5);
      assert.deepEqual(
        cells.map((cell) => Math.round((cell ?? -1) * 1000) / 1000),
        [1, 0.667, 0.333, 0.333, 0.333],
      );
    });

    it('stacks an early renewal on the end of the period, not on its own date', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        const first = midMonth(7);
        await customer(tx, 'early');
        await customer(tx, 'late');
        // Two 60-day payments a week apart cover 120 days from the first: month 3 (about 91 days) is covered, month 5 (about 152) is not.
        await pay(tx, { userId: 'early', createdAt: first, planSnapshot: bought(60) });
        await pay(tx, { userId: 'early', purchaseType: 'RENEW', createdAt: plusDays(first, 7), planSnapshot: bought(60) });
        // The same two without stacking would end at day 67; with it, at 120. Month 3 tells them apart.
        await pay(tx, { userId: 'late', createdAt: first, planSnapshot: bought(60) });
        return service.getPaidCohortRetention();
      });
      const row = report.cohorts.find((cohort) => cohort.cohortSize > 0);
      assert.ok(row !== undefined);
      assert.equal(row.cohortSize, 2);
      assert.equal(row.retentionByMonth[2], 0.5, 'month 3: only the stacked client is still covered');
      assert.equal(row.retentionByMonth[4], 0, 'month 5: nobody is');
    });

    it('treats a lifetime payment as covering every mark', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'forever');
        await pay(tx, { userId: 'forever', createdAt: midMonth(7), planSnapshot: bought(-1) });
        return service.getPaidCohortRetention();
      });
      const row = report.cohorts.find((cohort) => cohort.cohortSize > 0);
      assert.ok(row !== undefined);
      assert.deepEqual(row.retentionByMonth.slice(0, 5), [1, 1, 1, 1, 1]);
    });

    it('leaves out what is not a first payment of time: add-ons, free, withheld, refunded, imported, before registration, a partner balance', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        const first = midMonth(7);
        for (const id of ['addon', 'free', 'withheld', 'refunded', 'imported', 'early-bird', 'partner']) await customer(tx, id);
        await pay(tx, { userId: 'addon', purchaseType: 'ADDITIONAL', createdAt: first, planSnapshot: bought(30, { snapshotSource: 'ADDON_PURCHASE' }) });
        await pay(tx, { userId: 'free', amount: '0', createdAt: first, planSnapshot: bought(30) });
        await pay(tx, { userId: 'withheld', createdAt: first, gatewayData: { conversionWithheldAt: first.toISOString() }, planSnapshot: bought(30) });
        await pay(tx, { userId: 'refunded', status: 'CANCELED', createdAt: first, gatewayData: { refundReversedAt: first.toISOString() }, planSnapshot: bought(30) });
        await pay(tx, { userId: 'imported', createdAt: first, planSnapshot: { importedFrom: 'bedolaga' } });
        await pay(tx, { userId: 'partner', gatewayType: 'PARTNER_BALANCE', createdAt: first, planSnapshot: bought(30) });
        // Registered after the payment's date: a donor's payment, moved in.
        await tx.user.update({ where: { id: 'early-bird' }, data: { createdAt: plusDays(first, 10) } });
        await pay(tx, { userId: 'early-bird', createdAt: first, planSnapshot: bought(30) });
        return service.getPaidCohortRetention();
      });
      assert.equal(report.cohorts.every((cohort) => cohort.cohortSize === 0), true);
    });

    it('takes an ADDITIONAL purchase of another subscription for time, even when its snapshot names no source', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'second');
        await pay(tx, { userId: 'second', purchaseType: 'ADDITIONAL', createdAt: midMonth(7), planSnapshot: bought(60) });
        return service.getPaidCohortRetention();
      });
      const row = report.cohorts.find((cohort) => cohort.cohortSize > 0);
      assert.equal(row?.cohortSize, 1);
      assert.equal(row?.retentionByMonth[1], 1, 'month 2 is inside its 60 days');
    });

    it('counts a combined renewal per subscription, from its lines', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        const first = midMonth(7);
        await customer(tx, 'multi');
        const one = await tx.subscription.create({ data: { userId: 'multi', planSnapshot: { id: 'pro', name: 'Pro' } } });
        const two = await tx.subscription.create({ data: { userId: 'multi', planSnapshot: { id: 'pro', name: 'Pro' } } });
        const combined = await pay(tx, { userId: 'multi', purchaseType: 'RENEW', createdAt: first, planSnapshot: { id: 'pro' } });
        await tx.transactionItem.createMany({
          data: [
            { transactionId: combined.id, subscriptionId: one.id, planId: 'pro', durationDays: 30, amount: '50', currency: 'RUB' },
            { transactionId: combined.id, subscriptionId: two.id, planId: 'pro', durationDays: 90, amount: '50', currency: 'RUB' },
          ],
        });
        return service.getPaidCohortRetention();
      });
      const row = report.cohorts.find((cohort) => cohort.cohortSize > 0);
      assert.ok(row !== undefined);
      assert.equal(row.cohortSize, 1);
      assert.equal(row.retentionByMonth[0], 1, 'month 1: both lines cover');
      assert.equal(row.retentionByMonth[2], 1, 'month 3 (about 91 days): the 90-day line plus the grace covers it');
      assert.equal(row.retentionByMonth[3], 0, 'month 4: neither does');
    });

    it('files a first payment in the panel zone: 21:00 UTC on the last day of a month is the next month in Tokyo', async () => {
      const now = new Date();
      const lastDayOfEightMonthsBack = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 7, 0, 21, 0, 0));
      const cohortOf = async (timezone: string): Promise<string | undefined> => {
        const report = await onCleanSlate(
          async (tx, service) => {
            await customer(tx, 'edge');
            await pay(tx, { userId: 'edge', createdAt: lastDayOfEightMonthsBack, planSnapshot: bought(30) });
            return service.getPaidCohortRetention();
          },
          { timezone },
        );
        return report.cohorts.find((cohort) => cohort.cohortSize > 0)?.cohort;
      };
      const utc = await cohortOf('UTC');
      const tokyo = await cohortOf('Asia/Tokyo');
      assert.notEqual(utc, undefined);
      assert.notEqual(tokyo, undefined);
      assert.notEqual(utc, tokyo);
      const [utcYear, utcMonth] = (utc as string).split('-').map(Number) as [number, number];
      const [tokyoYear, tokyoMonth] = (tokyo as string).split('-').map(Number) as [number, number];
      assert.equal((tokyoYear - utcYear) * 12 + tokyoMonth - utcMonth, 1);
    });

    it('shows no cell whose date has not come: the current month has none, and the row says null', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'fresh');
        await pay(tx, { userId: 'fresh', createdAt: new Date(), planSnapshot: bought(30) });
        return service.getPaidCohortRetention();
      });
      const row = report.cohorts[report.cohorts.length - 1];
      assert.ok(row !== undefined);
      assert.equal(row.cohortSize, 1);
      assert.equal(row.retentionByMonth.length, 12);
      assert.equal(row.retentionByMonth.every((cell) => cell === null), true);
    });
  });

  // ── «Автоплатёж» ─────────────────────────────────────────────────────────

  describe('autopay', () => {
    /** A saved ЮKassa method bound `bound` days ago; `updatedAgo` is the day of its last write. */
    async function method(
      tx: Prisma.TransactionClient,
      userId: string,
      id: string,
      options: { readonly bound: number; readonly enabled?: boolean; readonly updatedAgo?: number; readonly unboundAgo?: number },
    ) {
      await tx.savedPaymentMethod.create({
        data: {
          id,
          userId,
          gatewayType: 'YOOKASSA',
          providerMethodId: `pm-${id}`,
          methodType: 'bank_card',
          autopayEnabled: options.enabled ?? true,
          isActive: options.unboundAgo === undefined,
          unboundAt: options.unboundAgo === undefined ? null : daysAgo(options.unboundAgo),
          createdAt: daysAgo(options.bound),
        },
      });
      await tx.$executeRaw`UPDATE "saved_payment_methods" SET "updated_at" = ${daysAgo(options.updatedAgo ?? options.bound)} WHERE "id" = ${id}`;
    }

    async function toggle(tx: Prisma.TransactionClient, methodId: string, enabled: boolean, ago: number) {
      await tx.adminAuditLog.create({
        data: {
          action: 'event.payment.method_autopay_updated',
          metadata: { savedPaymentMethodId: methodId, autopayEnabled: enabled },
          createdAt: daysAgo(ago),
        },
      });
    }

    async function providerSubscription(
      tx: Prisma.TransactionClient,
      userId: string,
      id: string,
      options: { readonly created: number; readonly cancelled?: number; readonly status?: 'ACTIVE' | 'CANCELLED' | 'FAILED' | 'PENDING'; readonly charges?: number },
    ) {
      await tx.providerSubscription.create({
        data: {
          userId,
          gatewayType: 'PLATEGA',
          providerSubscriptionId: id,
          status: options.status ?? (options.cancelled === undefined ? 'ACTIVE' : 'CANCELLED'),
          planId: 'pro',
          durationDays: 30,
          amount: '100',
          currency: 'RUB',
          intervalUnit: 'month',
          intervalCount: 1,
          firstTransactionId: `first-${id}`,
          appliedChargeCount: options.charges ?? 1,
          cancelledAt: options.cancelled === undefined ? null : daysAgo(options.cancelled),
          consentVersion: 'v1',
          createdAt: daysAgo(options.created),
        },
      });
    }

    it('splits ended periods by whether autopay was on at their end, and by what the client did next', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        for (const id of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10']) await customer(tx, id);
        await tx.user.update({ where: { id: 'u8' }, data: { isBlocked: true } });
        // u1: autopay on throughout. Renews 5 days early, then does not come back.
        await method(tx, 'u1', 'm1', { bound: 200 });
        await pay(tx, { userId: 'u1', createdAt: daysAgo(100), planSnapshot: bought(30) });
        await pay(tx, { userId: 'u1', purchaseType: 'RENEW', createdAt: daysAgo(75), planSnapshot: bought(30) });
        // u2: autopay switched off 20 days ago (no audit row left): it was on when the period ended. Back 2 days after.
        await method(tx, 'u2', 'm2', { bound: 200, enabled: false, updatedAgo: 20 });
        await pay(tx, { userId: 'u2', createdAt: daysAgo(90), planSnapshot: bought(30) });
        await pay(tx, { userId: 'u2', purchaseType: 'RENEW', createdAt: daysAgo(58), planSnapshot: bought(30) });
        // u3: no autopay. Back 15 days after.
        await pay(tx, { userId: 'u3', createdAt: daysAgo(100), planSnapshot: bought(30) });
        await pay(tx, { userId: 'u3', purchaseType: 'RENEW', createdAt: daysAgo(55), planSnapshot: bought(30) });
        // u4: no autopay, never back.
        await pay(tx, { userId: 'u4', createdAt: daysAgo(110), planSnapshot: bought(30) });
        // u5: a provider subscription, cancelled after the period ended. Never back.
        await providerSubscription(tx, 'u5', 'ps5', { created: 150, cancelled: 50 });
        await pay(tx, { userId: 'u5', createdAt: daysAgo(100), planSnapshot: bought(30) });
        // u6: a provider subscription cancelled BEFORE the period ended. Back 20 days after.
        await providerSubscription(tx, 'u6', 'ps6', { created: 150, cancelled: 75 });
        await pay(tx, { userId: 'u6', createdAt: daysAgo(100), planSnapshot: bought(30) });
        await pay(tx, { userId: 'u6', purchaseType: 'RENEW', createdAt: daysAgo(50), planSnapshot: bought(30) });
        // u7: the card is on today, but the audit log says it was off from day 95 to day 65 — the period ended at day 70.
        await method(tx, 'u7', 'm7', { bound: 200, enabled: true, updatedAgo: 65 });
        await toggle(tx, 'm7', false, 95);
        await toggle(tx, 'm7', true, 65);
        await pay(tx, { userId: 'u7', createdAt: daysAgo(100), planSnapshot: bought(30) });
        // u8: blocked. u9: periods ended 10 and 150 days ago. u10: a lifetime never ends.
        await pay(tx, { userId: 'u8', createdAt: daysAgo(100), planSnapshot: bought(30) });
        await pay(tx, { userId: 'u9', createdAt: daysAgo(40), planSnapshot: bought(30) });
        await pay(tx, { userId: 'u9', purchaseType: 'RENEW', createdAt: daysAgo(180), planSnapshot: bought(30) });
        await pay(tx, { userId: 'u10', createdAt: daysAgo(100), planSnapshot: bought(-1) });
        return service.getAutopayReport();
      });
      assert.deepEqual(report.withAutopayPeriods, { early: 1, firstDays: 1, later: 0, gone: 2 });
      assert.deepEqual(report.withoutAutopayPeriods, { early: 0, firstDays: 0, later: 2, gone: 2 });
      assert.deepEqual([report.fromDaysAgo, report.toDaysAgo, report.firstDays, report.laterDays], [120, 30, 3, 30]);
    });

    it('counts, for the header, the clients with a paid period in force and how many of them have autopay on now', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        for (const id of ['on', 'off', 'unbound', 'provider', 'lifetime', 'lapsed', 'blocked', 'cancelled']) await customer(tx, id);
        await tx.user.update({ where: { id: 'blocked' }, data: { isBlocked: true } });
        await method(tx, 'on', 'mon', { bound: 100 });
        await method(tx, 'unbound', 'mun', { bound: 100, unboundAgo: 3 });
        await method(tx, 'blocked', 'mbl', { bound: 100 });
        await providerSubscription(tx, 'provider', 'psp', { created: 20 });
        await providerSubscription(tx, 'cancelled', 'psc', { created: 20, cancelled: 2 });
        for (const id of ['on', 'off', 'unbound', 'provider', 'blocked', 'cancelled']) {
          await pay(tx, { userId: id, createdAt: daysAgo(10), planSnapshot: bought(30) });
        }
        await pay(tx, { userId: 'lifetime', createdAt: daysAgo(10), planSnapshot: bought(-1) });
        await pay(tx, { userId: 'lapsed', createdAt: daysAgo(60), planSnapshot: bought(30) });
        return service.getAutopayReport();
      });
      // on, off, unbound, provider, lifetime, cancelled — the blocked and the lapsed are not paying clients.
      assert.equal(report.payingClients, 6);
      // on (a card), provider (a subscription). unbound and cancelled ended theirs.
      assert.equal(report.withAutopay, 2);
    });

    it('answers with zeroes when nobody has paid', async () => {
      const report = await onCleanSlate((_tx, service) => service.getAutopayReport());
      assert.equal(report.payingClients, 0);
      assert.equal(report.withAutopay, 0);
      assert.deepEqual(report.withAutopayPeriods, { early: 0, firstDays: 0, later: 0, gone: 0 });
      assert.deepEqual(report.withoutAutopayPeriods, { early: 0, firstDays: 0, later: 0, gone: 0 });
    });

    it('does not count a provider subscription the payer never confirmed', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'pending');
        await providerSubscription(tx, 'pending', 'psx', { created: 150, status: 'FAILED', charges: 0 });
        await pay(tx, { userId: 'pending', createdAt: daysAgo(100), planSnapshot: bought(30) });
        return service.getAutopayReport();
      });
      assert.deepEqual(report.withoutAutopayPeriods, { early: 0, firstDays: 0, later: 0, gone: 1 });
      assert.deepEqual(report.withAutopayPeriods, { early: 0, firstDays: 0, later: 0, gone: 0 });
    });
  });

  // ── «Промокоды и скидки» ─────────────────────────────────────────────────

  describe('discounts', () => {
    /** The plan `pro` with list prices in roubles: 7 days 30, 30 days 100, 90 days 270. */
    async function catalog(tx: Prisma.TransactionClient) {
      await tx.plan.create({ data: { id: 'pro', name: 'Pro' } });
      for (const [days, price] of [
        [7, '30'],
        [30, '100'],
        [90, '270'],
      ] as const) {
        await tx.planDuration.create({ data: { planId: 'pro', days, prices: { create: [{ currency: 'RUB', price }] } } });
      }
    }

    it('files each purchase of the window under the size of its discount against the list price, and counts the full ones', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await catalog(tx);
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']) await customer(tx, id);
        await pay(tx, { userId: 'a', createdAt: daysAgo(5), amount: '100', planSnapshot: bought(30) });
        await pay(tx, { userId: 'b', createdAt: daysAgo(6), amount: '90', planSnapshot: bought(30) });
        await pay(tx, { userId: 'c', createdAt: daysAgo(7), amount: '189', planSnapshot: bought(90) });
        await pay(tx, { userId: 'd', createdAt: daysAgo(8), amount: '99', planSnapshot: bought(30) });
        await pay(tx, { userId: 'e', createdAt: daysAgo(9), amount: '50', planSnapshot: bought(30) });
        // A price in a currency the plan has no list for: unknown, in neither count.
        await pay(tx, { userId: 'f', createdAt: daysAgo(10), amount: '5', currency: 'USD', planSnapshot: bought(30) });
        // A combined renewal: each line carries the percent the quote applied.
        const combined = await pay(tx, { userId: 'g', purchaseType: 'RENEW', createdAt: daysAgo(11), amount: '180', planSnapshot: { combinedRenewal: true } });
        const one = await tx.subscription.create({ data: { userId: 'g' } });
        const two = await tx.subscription.create({ data: { userId: 'g' } });
        await tx.transactionItem.createMany({
          data: [
            { transactionId: combined.id, subscriptionId: one.id, planId: 'pro', durationDays: 30, amount: '80', currency: 'RUB', discountPercent: 20 },
            { transactionId: combined.id, subscriptionId: two.id, planId: 'pro', durationDays: 30, amount: '100', currency: 'RUB', discountPercent: 0 },
          ],
        });
        // A charge of a provider subscription, at the frozen amount: 20 % off the list of the sign-up (100), though the plan lists 150 now.
        await tx.plan.create({ data: { id: 'legacy', name: 'Legacy' } });
        await tx.planDuration.create({ data: { planId: 'legacy', days: 30, prices: { create: [{ currency: 'RUB', price: '150' }] } } });
        await tx.providerSubscription.create({
          data: {
            userId: 'h', gatewayType: 'PLATEGA', providerSubscriptionId: 'psh', status: 'ACTIVE', planId: 'legacy', durationDays: 30,
            amount: '80', listAmount: '100', currency: 'RUB', intervalUnit: 'month', intervalCount: 1, firstTransactionId: 'first-psh', consentVersion: 'v1',
          },
        });
        const sub = await tx.subscription.create({ data: { userId: 'h' } });
        const charge = await pay(tx, {
          userId: 'h', gatewayType: 'PLATEGA', purchaseType: 'RENEW', createdAt: daysAgo(12), amount: '80',
          planSnapshot: { combinedRenewal: true, snapshotSource: 'PROVIDER_SUBSCRIPTION_CHARGE', providerSubscriptionId: 'psh', chargeNumber: 2 },
        });
        await tx.transactionItem.create({ data: { transactionId: charge.id, subscriptionId: sub.id, planId: 'legacy', durationDays: 30, amount: '80', currency: 'RUB', discountPercent: 0 } });
        // A plan change after the first payment is priced by the difference, not by a list: left out.
        await pay(tx, { userId: 'i', createdAt: daysAgo(25), amount: '100', planSnapshot: bought(30) });
        await pay(tx, { userId: 'i', purchaseType: 'UPGRADE', createdAt: daysAgo(4), amount: '40', planSnapshot: bought(30) });
        // Not purchases of subscription time: an add-on, a payment for nothing, a refunded one.
        await pay(tx, { userId: 'j', purchaseType: 'ADDITIONAL', createdAt: daysAgo(5), amount: '20', planSnapshot: bought(30, { snapshotSource: 'ADDON_PURCHASE' }) });
        await pay(tx, { userId: 'j', createdAt: daysAgo(5), amount: '0', planSnapshot: bought(30) });
        await pay(tx, { userId: 'k', status: 'CANCELED', createdAt: daysAgo(5), amount: '50', gatewayData: { refundReversedAt: new Date().toISOString() }, planSnapshot: bought(30) });
        return service.getDiscountReport(30);
      });
      // Known: a (full), b, c, d, e, g1, g2 (full), h, i (full) = 9 purchases; discounted: b, c, d, e, g1, h = 6.
      assert.equal(report.purchases, 9);
      assert.equal(report.discounted, 6);
      assert.equal(report.unknown, 1);
      assert.equal(Math.round((report.averageDiscount ?? 0) * 100) / 100, Math.round((131 / 6) * 100) / 100);
      assert.deepEqual(
        report.buckets.map((bucket) => [bucket.from, bucket.to, bucket.purchases]),
        [
          [1, 10, 1],
          [10, 20, 1],
          [20, 30, 2],
          [30, 40, 1],
          [40, 50, 0],
          [50, null, 1],
        ],
      );
    });

    it('answers with nothing but zeroes when nothing was bought, and no average', async () => {
      const report = await onCleanSlate(async (_tx, service) => service.getDiscountReport(30));
      assert.equal(report.purchases, 0);
      assert.equal(report.discounted, 0);
      assert.equal(report.averageDiscount, null);
      assert.deepEqual(report.repeat.withDiscount, { clients: 0, boughtAgain: 0 });
      assert.equal(report.buckets.length, 6);
    });

    it('follows first purchases of the window that ended a week ago: do they buy again, and at the full price', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await catalog(tx);
        for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']) await customer(tx, id);
        // Seven days for 30: 24 is 20 % off.
        const first = (userId: string, ago: number, amount: string, extra: Partial<Prisma.TransactionUncheckedCreateInput> = {}) =>
          pay(tx, { userId, createdAt: daysAgo(ago), amount, planSnapshot: bought(7), ...extra });
        const again = (userId: string, ago: number, amount: string) =>
          pay(tx, { userId, purchaseType: 'RENEW', createdAt: daysAgo(ago), amount, planSnapshot: bought(7) });
        await first('r1', 20, '24');
        await again('r1', 5, '30');
        await first('r2', 20, '24');
        await again('r2', 5, '24');
        await first('r3', 20, '24');
        await first('r4', 20, '30');
        await again('r4', 5, '30');
        await first('r5', 20, '30');
        // Ended only five days ago: too soon to say.
        await first('r6', 12, '24');
        // First bought before the window.
        await first('r7', 100, '24');
        await again('r7', 5, '30');
        // The first price is unknown.
        await first('r8', 20, '5', { currency: 'USD' });
        return service.getDiscountReport(60);
      });
      assert.equal(report.repeat.afterDays, 7);
      assert.deepEqual(report.repeat.withDiscount, { clients: 3, boughtAgain: 2 });
      assert.deepEqual(report.repeat.withoutDiscount, { clients: 2, boughtAgain: 1 });
      assert.equal(report.repeat.secondPriceKnown, 2);
      assert.equal(report.repeat.secondFullPrice, 1);
    });

    it('does not count the second line of a combined first payment as the client buying again', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await catalog(tx);
        await customer(tx, 'twin');
        const one = await tx.subscription.create({ data: { userId: 'twin' } });
        const two = await tx.subscription.create({ data: { userId: 'twin' } });
        const combined = await pay(tx, { userId: 'twin', purchaseType: 'RENEW', createdAt: daysAgo(20), amount: '48', planSnapshot: { combinedRenewal: true } });
        await tx.transactionItem.createMany({
          data: [
            { transactionId: combined.id, subscriptionId: one.id, planId: 'pro', durationDays: 7, amount: '24', currency: 'RUB', discountPercent: 20 },
            { transactionId: combined.id, subscriptionId: two.id, planId: 'pro', durationDays: 7, amount: '24', currency: 'RUB', discountPercent: 20 },
          ],
        });
        return service.getDiscountReport(60);
      });
      assert.deepEqual(report.repeat.withDiscount, { clients: 1, boughtAgain: 0 });
    });
  });

  // ── Ценность клиента по месяцу первой оплаты ─────────────────────────────

  describe('lifetime value by month of first payment', () => {
    it('takes the mean and the median of everything each client has paid, net of refunds, in one currency', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await tx.fxRate.create({ data: { base: 'RUB', quote: 'USDT', rate: '80', source: 'TEST', fetchedAt: daysAgo(0.5) } });
        const first = midMonth(5);
        for (const id of ['a', 'b', 'c', 'd', 'later']) await customer(tx, id);
        // a: 100, 100, and an add-on of 200 — add-ons are money too.
        await pay(tx, { userId: 'a', createdAt: first, amount: '100', planSnapshot: bought(30) });
        await pay(tx, { userId: 'a', purchaseType: 'RENEW', createdAt: plusDays(first, 30), amount: '100', planSnapshot: bought(30) });
        await pay(tx, { userId: 'a', purchaseType: 'ADDITIONAL', createdAt: plusDays(first, 40), amount: '200', planSnapshot: bought(30, { snapshotSource: 'ADDON_PURCHASE' }) });
        await pay(tx, { userId: 'b', createdAt: first, amount: '100', planSnapshot: bought(30) });
        // c: 100 less a partial refund of 40.
        await pay(tx, { userId: 'c', createdAt: first, amount: '100', gatewayData: { refundedAmountTotal: '40' }, planSnapshot: bought(30) });
        // d: 10 USDT, at 80.
        await pay(tx, { userId: 'd', createdAt: first, amount: '10', currency: 'USDT', planSnapshot: bought(30) });
        // A partner's balance is not money received; a refunded payment is not either.
        await pay(tx, { userId: 'b', gatewayType: 'PARTNER_BALANCE', createdAt: plusDays(first, 5), amount: '999', planSnapshot: bought(30) });
        await pay(tx, { userId: 'b', status: 'CANCELED', createdAt: plusDays(first, 6), amount: '500', gatewayData: { refundReversedAt: first.toISOString() }, planSnapshot: bought(30) });
        // A client of a later month.
        await pay(tx, { userId: 'later', createdAt: midMonth(2), amount: '300', planSnapshot: bought(30) });
        return service.getPaidLtv();
      });
      const cohort = (monthsBack: number): { cohort: string; clients: number; mean: number | null; median: number | null } => {
        const row = report.rows[report.rows.length - 1 - monthsBack];
        assert.ok(row !== undefined);
        return row;
      };
      assert.equal(report.rows.length, 12);
      assert.deepEqual([cohort(5).clients, cohort(5).mean, cohort(5).median], [4, 340, 250]);
      assert.deepEqual([cohort(2).clients, cohort(2).mean, cohort(2).median], [1, 300, 300]);
      assert.deepEqual([cohort(0).clients, cohort(0).mean, cohort(0).median], [0, null, null]);
      // Over all five: 400, 100, 60, 800, 300.
      assert.equal(report.clients, 5);
      assert.equal(report.mean, 332);
      assert.equal(report.median, 300);
      assert.equal(report.money.currency, 'RUB');
    });

    it('leaves out money paid before the client registered, and does not take it for a first payment', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'moved', { createdAt: midMonth(3) });
        // The donor’s payment, dated long before the registration, then one in this panel.
        await pay(tx, { userId: 'moved', createdAt: midMonth(8), amount: '700', planSnapshot: bought(30) });
        await pay(tx, { userId: 'moved', createdAt: plusDays(midMonth(3), 2), amount: '100', planSnapshot: bought(30) });
        return service.getPaidLtv();
      });
      const withClients = report.rows.filter((row) => row.clients > 0);
      assert.equal(withClients.length, 1);
      assert.equal(withClients[0]?.mean, 100);
      assert.equal(report.mean, 100);
    });

    it('answers with no figures when nobody has paid', async () => {
      const report = await onCleanSlate((_tx, service) => service.getPaidLtv());
      assert.equal(report.clients, 0);
      assert.equal(report.mean, null);
      assert.equal(report.median, null);
      assert.equal(report.rows.every((row) => row.clients === 0 && row.mean === null), true);
    });

    it('files a first payment in the panel zone', async () => {
      const now = new Date();
      const edge = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4, 0, 21, 0, 0));
      const monthOf = async (timezone: string): Promise<string | undefined> => {
        const report = await onCleanSlate(
          async (tx, service) => {
            await customer(tx, 'edge');
            await pay(tx, { userId: 'edge', createdAt: edge, amount: '100', planSnapshot: bought(30) });
            return service.getPaidLtv();
          },
          { timezone },
        );
        return report.rows.find((row) => row.clients > 0)?.cohort;
      };
      const utc = await monthOf('UTC');
      const tokyo = await monthOf('Asia/Tokyo');
      assert.notEqual(utc, tokyo);
    });
  });

  // ── «Когда платят» ───────────────────────────────────────────────────────

  describe('when they pay', () => {
    /** The latest `isoWeekday` (1 = Monday) at least three days ago, at `hourUtc:minute` UTC. */
    function lastWeekday(isoWeekday: number, hourUtc: number, minute = 0): Date {
      const day = new Date(Date.now() - 3 * DAY_MS);
      day.setUTCHours(0, 0, 0, 0);
      while (((day.getUTCDay() + 6) % 7) + 1 !== isoWeekday) day.setTime(day.getTime() - DAY_MS);
      return new Date(day.getTime() + hourUtc * 3_600_000 + minute * 60_000);
    }

    it('counts payments by weekday and hour of the panel zone, and names the busiest hours', async () => {
      const report = await onCleanSlate(
        async (tx, service) => {
          for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) await customer(tx, id);
          // Monday 22:30 and 22:45 UTC are Tuesday 01:30 and 01:45 in Moscow: the same cell.
          await pay(tx, { userId: 'a', createdAt: lastWeekday(1, 22, 30), planSnapshot: bought(30) });
          await pay(tx, { userId: 'b', createdAt: lastWeekday(1, 22, 45), planSnapshot: bought(30) });
          await pay(tx, { userId: 'c', createdAt: lastWeekday(5, 15), planSnapshot: bought(30) });
          // A payment system’s first charge is the payer’s own: counted. An add-on is a payment too.
          await pay(tx, { userId: 'd', gatewayType: 'PLATEGA', createdAt: lastWeekday(6, 9), planSnapshot: bought(30) });
          await pay(tx, { userId: 'e', purchaseType: 'ADDITIONAL', createdAt: lastWeekday(4, 6), planSnapshot: bought(30, { snapshotSource: 'ADDON_PURCHASE' }) });
          // Automatic: the autopay scheduler’s checkout, and the repeat charge of a payment system.
          await pay(tx, { userId: 'f', createdAt: lastWeekday(3, 12), idempotencyKey: 'auto-renew:sub-1:1700000000000:a1', planSnapshot: bought(30) });
          await pay(tx, {
            userId: 'g', gatewayType: 'PLATEGA', purchaseType: 'RENEW', createdAt: lastWeekday(3, 13),
            planSnapshot: { snapshotSource: 'PROVIDER_SUBSCRIPTION_CHARGE', providerSubscriptionId: 'ps-1', chargeNumber: 2 },
          });
          // Not money received, or not in the period.
          await pay(tx, { userId: 'h', amount: '0', createdAt: lastWeekday(2, 10), planSnapshot: bought(30) });
          await pay(tx, { userId: 'i', createdAt: daysAgo(60), planSnapshot: bought(30) });
          return service.getPaymentHours(30);
        },
        { timezone: 'Europe/Moscow' },
      );
      const at = (weekday: number, hour: number): number => report.cells[(weekday - 1) * 24 + hour] ?? -1;
      assert.equal(report.cells.length, 168);
      assert.equal(at(2, 1), 2);
      assert.equal(at(5, 18), 1);
      assert.equal(at(6, 12), 1);
      assert.equal(at(4, 9), 1);
      assert.equal(report.total, 5);
      assert.equal(report.automatic, 2);
      assert.deepEqual(report.topHours, [
        { hour: 1, payments: 2 },
        { hour: 9, payments: 1 },
        { hour: 12, payments: 1 },
      ]);
      assert.equal(report.timeZone, 'Europe/Moscow');
    });

    it('is the same hour in UTC as the clock says there', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'a');
        await pay(tx, { userId: 'a', createdAt: lastWeekday(1, 22, 30), planSnapshot: bought(30) });
        return service.getPaymentHours(30);
      });
      assert.equal(report.cells[22], 1);
      assert.deepEqual(report.topHours, [{ hour: 22, payments: 1 }]);
    });

    it('answers with an empty grid when nobody paid', async () => {
      const report = await onCleanSlate((_tx, service) => service.getPaymentHours(30));
      assert.equal(report.total, 0);
      assert.equal(report.automatic, 0);
      assert.equal(report.cells.every((count) => count === 0), true);
      assert.deepEqual(report.topHours, []);
    });
  });

  // ── «Выручка по тарифам»: тариф × срок ───────────────────────────────────

  describe('revenue by plan and term', () => {
    it('makes a row of each plan and term, keeps the proportional split of a shared renewal, and the rows add up to the total', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'buyer');
        const plan = (days: number, extra: Prisma.InputJsonObject = {}): Prisma.InputJsonObject => ({ id: 'pro', name: 'Pro', selectedDurationDays: days, ...extra });
        await pay(tx, { userId: 'buyer', amount: '100', createdAt: daysAgo(5), planSnapshot: plan(30) });
        await pay(tx, { userId: 'buyer', amount: '100', purchaseType: 'RENEW', createdAt: daysAgo(4), planSnapshot: plan(30, { name: 'Pro (new name)' }) });
        await pay(tx, { userId: 'buyer', amount: '270', createdAt: daysAgo(4), planSnapshot: plan(90) });
        await pay(tx, { userId: 'buyer', amount: '150', createdAt: daysAgo(3), planSnapshot: plan(45) });
        await pay(tx, { userId: 'buyer', amount: '1000', createdAt: daysAgo(3), planSnapshot: plan(-1) });
        const one = await tx.subscription.create({ data: { userId: 'buyer' } });
        const two = await tx.subscription.create({ data: { userId: 'buyer' } });
        const combined = await pay(tx, { userId: 'buyer', amount: '900', purchaseType: 'RENEW', createdAt: daysAgo(2), planSnapshot: { combinedRenewal: true } });
        await tx.transactionItem.createMany({
          data: [
            { transactionId: combined.id, subscriptionId: one.id, planId: 'pro', planSnapshot: { id: 'pro', name: 'Pro' }, durationDays: 30, amount: '600', currency: 'RUB' },
            { transactionId: combined.id, subscriptionId: two.id, planId: 'pro', planSnapshot: { id: 'pro', name: 'Pro' }, durationDays: 90, amount: '400', currency: 'RUB' },
          ],
        });
        return service.getRevenueReport(30);
      });
      assert.deepEqual(
        report.byPlan.map((row) => [row.key, row.days, row.figure.value, row.payments]),
        [
          ['plan:pro:-1', -1, 1000, 1],
          ['plan:pro:30', 30, 740, 3],
          ['plan:pro:90', 90, 630, 2],
          ['plan:pro:45', 45, 150, 1],
        ],
      );
      assert.equal(report.byPlan.reduce((sum, row) => sum + row.figure.value, 0), report.total.value);
      assert.equal(report.byPlan[1]?.name, 'Pro');
    });

    it('splits add-ons by what they added: traffic, devices, traffic reset, and the ones that name no kind', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'buyer');
        const addon = (amount: string, addOnType?: string): Parameters<typeof pay>[1] => ({
          userId: 'buyer',
          purchaseType: 'ADDITIONAL',
          amount,
          createdAt: daysAgo(3),
          planSnapshot: { snapshotSource: 'ADDON_PURCHASE', name: 'Add-on', ...(addOnType === undefined ? {} : { addOnType }) },
        });
        await pay(tx, addon('50', 'EXTRA_TRAFFIC'));
        await pay(tx, addon('70', 'EXTRA_TRAFFIC'));
        await pay(tx, addon('40', 'EXTRA_DEVICES'));
        await pay(tx, addon('30', 'RESET_TRAFFIC'));
        await pay(tx, addon('20'));
        await pay(tx, addon('10', 'SOMETHING_NEW'));
        return service.getRevenueReport(30);
      });
      assert.deepEqual(
        report.byPlan.map((row) => [row.key, row.kind, row.addOnType, row.figure.value, row.payments]),
        [
          ['addon:EXTRA_TRAFFIC', 'addon', 'EXTRA_TRAFFIC', 120, 2],
          ['addon:EXTRA_DEVICES', 'addon', 'EXTRA_DEVICES', 40, 1],
          // 30 each: the one with more payments first.
          ['addon:', 'addon', null, 30, 2],
          ['addon:RESET_TRAFFIC', 'addon', 'RESET_TRAFFIC', 30, 1],
        ],
      );
    });

    it('puts plans outside the common catalogue under «Прочее», whatever their terms, and leaves the catalogue plans alone', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'buyer');
        await tx.plan.create({ data: { id: 'pro', name: 'Pro' } });
        await tx.plan.create({ data: { id: 'vip', name: 'VIP', availability: 'ALLOWED', allowedUserIds: ['buyer'] } });
        await tx.plan.create({ data: { id: 'gift', name: 'Invited', availability: 'INVITED' } });
        await pay(tx, { userId: 'buyer', amount: '100', createdAt: daysAgo(3), planSnapshot: { id: 'pro', name: 'Pro', selectedDurationDays: 30 } });
        await pay(tx, { userId: 'buyer', amount: '500', createdAt: daysAgo(3), planSnapshot: { id: 'vip', name: 'VIP', selectedDurationDays: 30 } });
        await pay(tx, { userId: 'buyer', amount: '1200', createdAt: daysAgo(2), planSnapshot: { id: 'vip', name: 'VIP', selectedDurationDays: 90 } });
        await pay(tx, { userId: 'buyer', amount: '60', createdAt: daysAgo(2), planSnapshot: { id: 'gift', name: 'Invited', selectedDurationDays: 30 } });
        return service.getRevenueReport(30);
      });
      assert.deepEqual(
        report.byPlan.map((row) => [row.key, row.kind, row.planId, row.days, row.name, row.figure.value, row.payments]),
        [
          ['other', 'other', null, null, null, 1700, 2],
          ['plan:pro:30', 'plan', 'pro', 30, 'Pro', 100, 1],
          ['plan:gift:30', 'plan', 'gift', 30, 'Invited', 60, 1],
        ],
      );
    });

    it('keeps a payment with no recorded term as a plan row without one', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await customer(tx, 'buyer');
        await pay(tx, { userId: 'buyer', amount: '80', createdAt: daysAgo(3), planSnapshot: { id: 'pro', name: 'Pro' } });
        return service.getRevenueReport(30);
      });
      assert.deepEqual(report.byPlan.map((row) => [row.key, row.days]), [['plan:pro:', null]]);
    });
  });

  // ── «От пробного до оплаты» по дням пробного ─────────────────────────────

  describe('days from the trial to the payment', () => {
    /** A trial plan whose shortest term is `days` (the one a free trial is granted for), and a longer one beside it. */
    async function trialPlan(tx: Prisma.TransactionClient, id: string, days: number) {
      await tx.plan.create({ data: { id, name: `Trial ${id}`, availability: 'TRIAL' } });
      for (const length of [days * 2, days]) {
        await tx.planDuration.create({ data: { planId: id, days: length, prices: { create: [{ currency: 'RUB', price: '1' }] } } });
      }
    }

    /** A free trial as `grantTrial` writes it: the trial subscription and the ledger's FREE claim. */
    async function trial(tx: Prisma.TransactionClient, userId: string, plan: string, startedAgo: number, paidAfter?: number) {
      await customer(tx, userId);
      const started = daysAgo(startedAgo);
      const subscription = await tx.subscription.create({
        data: { userId, isTrial: true, planSnapshot: { id: plan, name: `Trial ${plan}` }, createdAt: started, startedAt: started, expiresAt: plusDays(started, 3) },
      });
      await tx.trialClaim.create({
        data: { userId, planId: plan, subscriptionId: subscription.id, source: 'FREE', status: 'CONSUMED', units: 1, consumedAt: started, createdAt: started },
      });
      if (paidAfter !== undefined) {
        await pay(tx, { userId, purchaseType: 'UPGRADE', createdAt: plusDays(started, paidAfter), planSnapshot: bought(30) });
      }
    }

    it('files each conversion under the day of the trial it fell in, then «L+1…2L», then later; and counts who paid among trials old enough', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await trialPlan(tx, 'trial', 3);
        await trial(tx, 't1', 'trial', 40, 0.5);
        await trial(tx, 't2', 'trial', 40, 1.2);
        await trial(tx, 't3', 'trial', 40, 2.9);
        await trial(tx, 't4', 'trial', 40, 3.5);
        await trial(tx, 't5', 'trial', 40, 5.9);
        await trial(tx, 't6', 'trial', 40, 6.5);
        await trial(tx, 't7', 'trial', 40, 30);
        await trial(tx, 't8', 'trial', 40);
        // Too young to have had two trial lengths (6 days): counted in the days, not in the share.
        await trial(tx, 't9', 'trial', 2);
        await trial(tx, 't10', 'trial', 5, 1.1);
        return service.getTrialConversion(90);
      });
      assert.equal(report.trialLengthDays, 3);
      assert.deepEqual(report.perDay, { trialDays: 3, days: [1, 2, 1], after: 2, later: 2 });
      assert.equal(report.totalTrialUsers, 10);
      assert.equal(report.convertedUsers, 8);
      // Started over 6 days ago: t1…t8; paid: all but t8.
      assert.deepEqual(report.maturedConversion, { trials: 8, paid: 7, share: 7 / 8 });
      // The fixed bins are still there for a page that wants them.
      assert.equal(report.daysToConvert.length, 6);
    });

    it('keeps the fixed bins, and says no length, when the trials of the period have different lengths', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await trialPlan(tx, 'short', 3);
        await trialPlan(tx, 'long', 7);
        await trial(tx, 'a', 'short', 20, 1);
        await trial(tx, 'b', 'long', 20, 2);
        return service.getTrialConversion(90);
      });
      assert.equal(report.trialLengthDays, null);
      assert.equal(report.perDay, null);
      assert.equal(report.maturedConversion, null);
      assert.equal(report.convertedUsers, 2);
    });

    it('keeps the fixed bins for a trial longer than 14 days, but still states its length and the share over two lengths', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await trialPlan(tx, 'month', 20);
        // 2L = 40 days: only the first two are old enough.
        await trial(tx, 'old1', 'month', 60, 5);
        await trial(tx, 'old2', 'month', 60);
        await trial(tx, 'young', 'month', 30, 5);
        return service.getTrialConversion(90);
      });
      assert.equal(report.trialLengthDays, 20);
      assert.equal(report.perDay, null);
      assert.deepEqual(report.maturedConversion, { trials: 2, paid: 1, share: 0.5 });
    });

    it('does not guess a length for a trial whose plan has no term left', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await tx.plan.create({ data: { id: 'bare', name: 'Bare', availability: 'TRIAL' } });
        await trial(tx, 'a', 'bare', 20, 1);
        return service.getTrialConversion(90);
      });
      assert.equal(report.trialLengthDays, null);
      assert.equal(report.perDay, null);
    });

    it('has nothing to say when nobody took a trial', async () => {
      const report = await onCleanSlate((_tx, service) => service.getTrialConversion(90));
      assert.equal(report.trialLengthDays, null);
      assert.equal(report.perDay, null);
      assert.equal(report.maturedConversion, null);
    });

    it('names the day by the span from the start, not by the calendar: 23 hours is day 1, 25 hours day 2', async () => {
      const report = await onCleanSlate(async (tx, service) => {
        await trialPlan(tx, 'trial', 3);
        await trial(tx, 'a', 'trial', 30, 23 / 24);
        await trial(tx, 'b', 'trial', 30, 25 / 24);
        return service.getTrialConversion(90);
      });
      assert.deepEqual(report.perDay?.days, [1, 1, 0]);
    });
  });
});
