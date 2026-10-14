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
});
