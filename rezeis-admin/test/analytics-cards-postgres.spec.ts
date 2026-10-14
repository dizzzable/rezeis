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
});
