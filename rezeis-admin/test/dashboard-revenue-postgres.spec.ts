import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { BusinessAnalyticsService } from '../src/modules/business-analytics/services/business-analytics.service';
import { DashboardService } from '../src/modules/dashboard/services/dashboard.service';
import type { FxRateService } from '../src/modules/fx/fx-rate.service';
import type { SettingsService } from '../src/modules/settings/services/settings.service';
import { readPlatformBranding } from '../src/modules/settings/utils/platform-branding.util';

Logger.overrideLogger(false);

/**
 * The dashboard's «Выручка за всё время» against a real PostgreSQL: the same
 * money as «Бизнес-аналитика» → «Выручка», over the whole history.
 *
 * Before 2026-09 the tile was «Валовой оборот»: the sum of every completed
 * amount, currencies added together, with no unit. For 1 000 RUB, 10 USDT,
 * 500 Stars, 300 ₽ from a partner's balance, a checkout for nothing, 1 000 RUB
 * with 400 refunded and a Bedolaga payment of 5 000 RUB it read «7810»,
 * measured against this database on the pre-2026-09 service.
 *
 * Each test runs in a transaction that is rolled back (see
 * `analytics-reports-postgres.spec.ts`). Skipped without TEST_DATABASE_URL;
 * CI's PostgreSQL job runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const DAY_MS = 86_400_000;
let prisma: PrismaService;

const REPORTING_IN_RUB = ({ getBaseCurrency: () => 'RUB' } satisfies Pick<FxRateService, 'getBaseCurrency'>) as unknown as FxRateService;
const IN_UTC = ({ getPlatformBranding: async () => readPlatformBranding({ timezone: 'UTC' }) } satisfies Pick<
  SettingsService,
  'getPlatformBranding'
>) as unknown as SettingsService;
/** The summary is cached for a minute in production; here every read computes. */
const NO_CACHE = { getOrSet: async (_key: string, load: () => Promise<unknown>) => load() };

class RolledBack extends Error {}

async function onCleanSlate<T>(
  body: (tx: Prisma.TransactionClient, services: { dashboard: DashboardService; analytics: BusinessAnalyticsService }) => Promise<T>,
): Promise<T> {
  let observed: { value: T } | null = null;
  await assert.rejects(
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('TRUNCATE "users", "fx_rates" CASCADE');
        observed = {
          value: await body(tx, {
            dashboard: new DashboardService(tx as never, NO_CACHE as never, REPORTING_IN_RUB),
            analytics: new BusinessAnalyticsService(tx as never, REPORTING_IN_RUB, IN_UTC),
          }),
        };
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

type Payment = Partial<Prisma.TransactionUncheckedCreateInput> & { readonly userId: string };

async function pay(tx: Prisma.TransactionClient, payment: Payment) {
  return tx.transaction.create({
    data: { status: 'COMPLETED', purchaseType: 'NEW', gatewayType: 'YOOKASSA', currency: 'RUB', amount: '100', ...payment },
  });
}

/** Every kind of checkout the rule has an opinion on, all inside the last month. */
async function recentHistory(tx: Prisma.TransactionClient) {
  await tx.fxRate.create({ data: { base: 'RUB', quote: 'USDT', rate: '80', source: 'TEST', fetchedAt: daysAgo(0.5) } });
  for (const id of ['rub', 'usdt', 'stars', 'partner', 'free', 'partial', 'refunded', 'failed', 'waiting']) {
    await tx.user.create({ data: { id, referralCode: `${id}-ref`, name: id } });
  }
  await pay(tx, { userId: 'rub', amount: '1000', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'usdt', amount: '10', currency: 'USDT', gatewayType: 'CRYPTOPAY', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'stars', amount: '500', currency: 'XTR', gatewayType: 'TELEGRAM_STARS', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'partner', amount: '300', gatewayType: 'PARTNER_BALANCE', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'free', amount: '0', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'partial', amount: '1000', createdAt: daysAgo(3), gatewayData: { refundedAmountTotal: '400' } });
  await pay(tx, {
    userId: 'refunded',
    amount: '700',
    status: 'CANCELED',
    createdAt: daysAgo(3),
    gatewayData: { providerStatus: 'refund.succeeded', refundReversedAt: daysAgo(1).toISOString() },
  });
  await pay(tx, { userId: 'failed', amount: '100', status: 'FAILED', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'waiting', amount: '100', status: 'PENDING', createdAt: daysAgo(3) });
}

run('the dashboard’s revenue on PostgreSQL', () => {
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

  it('agrees with «Бизнес-аналитика» → «Выручка» over the same period, to the kopeck and in the same currency', async () => {
    const observed = await onCleanSlate(async (tx, { dashboard, analytics }) => {
      await recentHistory(tx);
      return { summary: await dashboard.getSummary(), revenue: await analytics.getRevenueReport(30) };
    });
    const { summary, revenue } = observed;
    assert.deepEqual(summary.revenue, { figure: revenue.total, money: revenue.money, payments: revenue.payments });
    // And what that is: 1 000 ₽ + 10 USDT at 80 ₽ + (1 000 − 400) ₽; Stars have no rate and are named.
    assert.deepEqual(
      {
        value: summary.revenue.figure.value,
        currency: summary.revenue.money.currency,
        unconverted: summary.revenue.money.unconverted,
        payments: summary.revenue.payments,
      },
      { value: 2400, currency: 'RUB', unconverted: ['XTR'], payments: 4 },
    );
    assert.equal(summary.transactions.grossVolume, '—');
  });

  it('counts the whole history — a payment of any date, an imported one too — and nothing but money received', async () => {
    const observed = await onCleanSlate(async (tx, { dashboard, analytics }) => {
      await recentHistory(tx);
      await tx.user.create({ data: { id: 'veteran', referralCode: 'veteran-ref', name: 'veteran' } });
      await pay(tx, { userId: 'veteran', amount: '2500', createdAt: daysAgo(400) });
      await pay(tx, { userId: 'veteran', amount: '5000', createdAt: daysAgo(700), planSnapshot: { importedFrom: 'bedolaga' } });
      return { summary: await dashboard.getSummary(), year: await analytics.getRevenueReport(365) };
    });
    assert.equal(observed.year.total.value, 2400, 'neither is in the last year');
    assert.equal(observed.summary.revenue.figure.value, 2400 + 2500 + 5000);
    assert.equal(observed.summary.revenue.payments, observed.year.payments + 2);
  });
});
