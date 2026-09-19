import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { BusinessAnalyticsService } from '../src/modules/business-analytics/services/business-analytics.service';
import type { FxRateService } from '../src/modules/fx/fx-rate.service';
import { PaymentAnalyticsService } from '../src/modules/payment-analytics/services/payment-analytics.service';
import type { SettingsService } from '../src/modules/settings/services/settings.service';
import { readPlatformBranding } from '../src/modules/settings/utils/platform-branding.util';

Logger.overrideLogger(false);

/**
 * «Платежи» → «Аналитика» against a real PostgreSQL: the statements of
 * `payment-provider-report.util.ts`, and that the tab now says what
 * «Бизнес-аналитика» says about the same window.
 *
 * Each test runs in a transaction that is rolled back, and first TRUNCATEs
 * `users` (cascading to payments) and `fx_rates` inside it — so it reads
 * exactly the rows it seeded and leaves the database as it found it.
 *
 * What the tab said before, measured on the pre-2026-09 service against this
 * database for one history (1 000 RUB, 10 USDT at 80 ₽, 500 Stars, 300 ₽ from a
 * partner's balance, a checkout for nothing, 1 000 RUB with 400 refunded, a
 * Bedolaga payment of 5 000 RUB dated 200 days back, a full refund of 700):
 * «Оборот (GMV)» over 30 days read 7810 — every amount added across
 * currencies, the import dated by its `updated_at` (the import), the partner's
 * balance and the partial refund at face value. It is now 2 400 ₽, 500 XTR
 * without a rate named, 300 ₽ stated apart.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it. Run it once more against a database whose own time zone is not UTC
 * (`ALTER DATABASE … SET timezone 'Europe/Moscow'`): Prisma's pg adapter sends
 * a `Date` as UTC wall time with no offset, and every day here must still fall
 * where the operator's calendar puts it.
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

interface Services {
  readonly payments: PaymentAnalyticsService;
  readonly analytics: BusinessAnalyticsService;
}

async function onCleanSlate<T>(
  body: (tx: Prisma.TransactionClient, services: Services) => Promise<T>,
  options: { readonly timezone?: string | null } = {},
): Promise<T> {
  let observed: { value: T } | null = null;
  await assert.rejects(
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('TRUNCATE "users", "fx_rates" CASCADE');
        const settings = zoneSetting(options.timezone === undefined ? 'UTC' : options.timezone);
        observed = {
          value: await body(tx, {
            payments: new PaymentAnalyticsService(tx as never, REPORTING_IN_RUB, settings),
            analytics: new BusinessAnalyticsService(tx as never, REPORTING_IN_RUB, settings),
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

async function customer(tx: Prisma.TransactionClient, id: string) {
  return tx.user.create({ data: { id, referralCode: `${id}-ref`, name: id } });
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

/** Stamp `updated_at` as a later write would. Raw, because Prisma stamps it on every write it makes. */
async function touchedAt(tx: Prisma.TransactionClient, id: string, at: Date) {
  await tx.$executeRaw`UPDATE "transactions" SET "updated_at" = ${at} WHERE "id" = ${id}`;
}

/** Deliver a payment `afterMs` after its checkout started, the way the panel stamps it: Prisma, from a JS `Date`. */
async function fulfilledAfter(tx: Prisma.TransactionClient, row: { readonly id: string; readonly createdAt: Date }, afterMs: number) {
  await tx.transaction.update({ where: { id: row.id }, data: { fulfilledAt: new Date(row.createdAt.getTime() + afterMs) } });
}

async function rate(tx: Prisma.TransactionClient, quote: string, value: string) {
  await tx.fxRate.create({ data: { base: 'RUB', quote, rate: value, source: 'TEST', fetchedAt: daysAgo(0.5) } });
}

/** The history the file comment describes, three days back unless said otherwise. */
async function mixedHistory(tx: Prisma.TransactionClient) {
  await rate(tx, 'USDT', '80');
  for (const id of ['rub', 'usdt', 'stars', 'partner', 'free', 'partial', 'imported', 'refunded', 'failed', 'waiting']) {
    await customer(tx, id);
  }
  await pay(tx, { userId: 'rub', amount: '1000', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'usdt', amount: '10', currency: 'USDT', gatewayType: 'CRYPTOPAY', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'stars', amount: '500', currency: 'XTR', gatewayType: 'TELEGRAM_STARS', createdAt: daysAgo(3) });
  await pay(tx, { userId: 'partner', amount: '300', gatewayType: 'PARTNER_BALANCE', createdAt: daysAgo(3) });
  // A 100 % promo code: completed at 0 without reaching the gateway it names.
  await pay(tx, { userId: 'free', amount: '0', createdAt: daysAgo(3) });
  // A partial refund leaves the payment COMPLETED at its full amount.
  await pay(tx, { userId: 'partial', amount: '1000', createdAt: daysAgo(3), gatewayData: { refundedAmountTotal: '400' } });
  // Imported today: the donor's date lives in `created_at` only.
  await pay(tx, { userId: 'imported', amount: '5000', createdAt: daysAgo(200), planSnapshot: { importedFrom: 'bedolaga' } });
  // A full refund as reconciliation writes it.
  await pay(tx, {
    userId: 'refunded',
    amount: '700',
    status: 'CANCELED',
    createdAt: daysAgo(3),
    gatewayData: { providerStatus: 'refund.succeeded', refundReversedAt: daysAgo(1).toISOString() },
  });
  await pay(tx, { userId: 'failed', amount: '100', status: 'FAILED', createdAt: daysAgo(3), gatewayData: { providerStatus: 'card_declined' } });
  await pay(tx, { userId: 'waiting', amount: '100', status: 'PENDING', createdAt: daysAgo(3) });
}

run('payments analytics on PostgreSQL', () => {
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

  it('files a checkout under the day it started, not the day its row was last written', async () => {
    const observed = await onCleanSlate(async (tx, { payments }) => {
      await customer(tx, 'importer');
      // Imported today with its original date 200 days back.
      await pay(tx, { userId: 'importer', amount: '5000', createdAt: daysAgo(200), planSnapshot: { importedFrom: 'bedolaga' } });
      await pay(tx, { userId: 'importer', amount: '700', createdAt: daysAgo(2) });
      // Made 40 days ago, written today — a tax receipt, an account merge.
      const old = await pay(tx, { userId: 'importer', amount: '900', createdAt: daysAgo(40) });
      await touchedAt(tx, old.id, daysAgo(0.1));
      const report = await payments.getProviderReport(30);
      const yookassa = report.providers.find((p) => p.gatewayType === 'YOOKASSA');
      return {
        transactions: yookassa?.transactions,
        completed: yookassa?.completed,
        revenue: report.revenue.value,
        daily: yookassa?.daily.filter((point) => point.transactions > 0).map((point) => [point.transactions, point.revenueValue]),
        previousShows: yookassa?.delta.revenuePct,
      };
    });
    assert.deepEqual(observed, {
      transactions: 1,
      completed: 1,
      revenue: 700,
      daily: [[1, 700]],
      // The 900 ₽ of 40 days ago is the previous window's: +700 against 900.
      previousShows: (700 - 900) / 900,
    });
  });

  it('states money in several currencies in the base at the panel’s rate, names the one with no rate — and says what «Выручка» says for the same window', async () => {
    const observed = await onCleanSlate(async (tx, { payments, analytics }) => {
      await mixedHistory(tx);
      return { tab: await payments.getProviderReport(30), revenue: await analytics.getRevenueReport(30) };
    });
    const { tab, revenue } = observed;
    assert.deepEqual(
      { money: { currency: tab.money.currency, rates: tab.money.rates.map((r) => [r.currency, r.rate]), unconverted: tab.money.unconverted }, revenue: tab.revenue, payments: tab.payments },
      {
        money: { currency: 'RUB', rates: [['USDT', 80]], unconverted: ['XTR'] },
        // 1 000 ₽ + 10 USDT × 80 ₽ + (1 000 − 400) ₽ — the Stars in no rouble figure, the partner's balance apart.
        revenue: {
          value: 2400,
          byCurrency: [
            { currency: 'RUB', amount: 1600 },
            { currency: 'USDT', amount: 10 },
            { currency: 'XTR', amount: 500 },
          ],
        },
        payments: 4,
      },
    );
    assert.deepEqual(tab.partnerBalance, { figure: { value: 300, byCurrency: [{ currency: 'RUB', amount: 300 }] }, payments: 1 });
    // One rule for the panel: the tab and «Бизнес-аналитика» → «Выручка» agree to the kopeck.
    assert.deepEqual(tab.money, revenue.money);
    assert.deepEqual(tab.revenue, revenue.total);
    assert.equal(tab.payments, revenue.payments);
    assert.deepEqual(tab.partnerBalance, revenue.partnerBalance);
    assert.deepEqual(
      tab.providers.filter((p) => p.revenue.value > 0 || p.revenue.byCurrency.length > 0).map((p) => [p.gatewayType, p.revenue]),
      revenue.byGateway.map((g) => [g.gatewayType, g.figure]),
    );
  });

  // How a checkout ended is `paymentOutcomeSql`, the one «Платёжные системы» counts by — shared, so there is
  // no second copy to hold against it; this holds the behaviour.
  it('rates each gateway on its checkouts: a refund went through, a checkout for nothing reached no gateway', async () => {
    const report = await onCleanSlate(async (tx, { payments }) => {
      await mixedHistory(tx);
      return payments.getProviderReport(7);
    });
    const yookassa = report.providers.find((p) => p.gatewayType === 'YOOKASSA');
    assert.deepEqual(
      {
        transactions: yookassa?.transactions,
        completed: yookassa?.completed,
        refunded: yookassa?.refunded,
        canceled: yookassa?.canceled,
        failed: yookassa?.failed,
        pending: yookassa?.pending,
        successRate: yookassa?.successRate,
        payments: yookassa?.payments,
        averagePayment: yookassa?.averagePayment,
      },
      // rub, partial, refunded, failed, waiting — not the checkout for nothing, not the import of 200 days ago.
      { transactions: 5, completed: 2, refunded: 1, canceled: 0, failed: 1, pending: 1, successRate: 3 / 4, payments: 2, averagePayment: { currency: 'RUB', amount: 800 } },
    );
  });

  it('keeps a partner’s balance as a row for its health, never as revenue', async () => {
    const partner = await onCleanSlate(async (tx, { payments }) => {
      await mixedHistory(tx);
      const report = await payments.getProviderReport(30);
      return report.providers.find((p) => p.gatewayType === 'PARTNER_BALANCE');
    });
    assert.deepEqual(
      {
        countsAsRevenue: partner?.countsAsRevenue,
        transactions: partner?.transactions,
        completed: partner?.completed,
        successRate: partner?.successRate,
        revenue: partner?.revenue,
        payments: partner?.payments,
        averagePayment: partner?.averagePayment,
      },
      { countsAsRevenue: false, transactions: 1, completed: 1, successRate: 1, revenue: { value: 0, byCurrency: [] }, payments: 0, averagePayment: null },
    );
  });

  it('breaks failures down among the failed and canceled checkouts only — a refund is not a failure', async () => {
    const reasons = await onCleanSlate(async (tx, { payments }) => {
      await mixedHistory(tx);
      await customer(tx, 'quitter');
      await pay(tx, { userId: 'quitter', status: 'CANCELED', amount: '100', createdAt: daysAgo(2), gatewayData: { providerStatus: 'expired' } });
      const report = await payments.getProviderReport(30);
      return report.providers.find((p) => p.gatewayType === 'YOOKASSA')?.topFailureReasons;
    });
    assert.deepEqual(reasons, [
      { reason: 'card_declined', count: 1, share: 0.5 },
      { reason: 'expired', count: 1, share: 0.5 },
    ]);
  });

  it('counts days in the operator’s time zone: 01:30 MSK is in that day’s point, and the window opens at local midnight', async () => {
    const MSK_MS = 3 * 3_600_000;
    const now = Date.now();
    const mskToday = new Date(now + MSK_MS).toISOString().slice(0, 10);
    let paidAt = Date.parse(`${mskToday}T01:30:00+03:00`);
    if (paidAt > now) paidAt -= DAY_MS;
    const mskDay = new Date(paidAt + MSK_MS).toISOString().slice(0, 10);
    const report = await onCleanSlate(
      async (tx, { payments }) => {
        await customer(tx, 'night');
        await pay(tx, { userId: 'night', amount: '777', createdAt: new Date(paidAt) });
        return payments.getProviderReport(7);
      },
      { timezone: 'Europe/Moscow' },
    );
    const daily = report.providers.find((p) => p.gatewayType === 'YOOKASSA')?.daily ?? [];
    assert.deepEqual(
      daily.filter((point) => point.transactions > 0).map((point) => [point.day, point.revenueValue]),
      [[mskDay, 777]],
      'the Moscow day, not the UTC day before it',
    );
    assert.equal(daily.length, 7);
    assert.equal(daily[6]?.day, mskToday);
    assert.equal(report.windowStart, new Date(Date.parse(`${mskToday}T00:00:00+03:00`) - 6 * DAY_MS).toISOString());
    assert.deepEqual([report.timeZone, report.timeZoneFallback], ['Europe/Moscow', false]);
  });

  it('draws one point per local day for a 60-day window too, where «Бизнес-аналитика» draws weeks', async () => {
    const report = await onCleanSlate(async (tx, { payments }) => {
      await customer(tx, 'steady');
      await pay(tx, { userId: 'steady', amount: '400', createdAt: daysAgo(40) });
      await pay(tx, { userId: 'steady', amount: '100', createdAt: daysAgo(1) });
      return payments.getProviderReport(60);
    });
    const daily = report.providers.find((p) => p.gatewayType === 'YOOKASSA')?.daily ?? [];
    const utcDay = (days: number): string => daysAgo(days).toISOString().slice(0, 10);
    assert.equal(daily.length, 60);
    assert.deepEqual(
      daily.filter((point) => point.transactions > 0).map((point) => [point.day, point.revenueValue]),
      [
        [utcDay(40), 400],
        [utcDay(1), 100],
      ],
    );
  });

  it('measures the time to pay from the checkout’s start to its fulfilment — a receipt that rewrites updated_at changes nothing', async () => {
    const time = await onCleanSlate(async (tx, { payments }) => {
      await customer(tx, 'payer');
      const quick = await pay(tx, { userId: 'payer', createdAt: daysAgo(2) });
      await fulfilledAfter(tx, quick, 120_000);
      // A tax receipt registered for it a day later: the row's LAST write, not its settlement.
      await touchedAt(tx, quick.id, daysAgo(1));
      const slow = await pay(tx, { userId: 'payer', createdAt: daysAgo(2) });
      await fulfilledAfter(tx, slow, 600_000);
      // Paid, delivery still pending: no settle time yet — neither 0 s nor a crash.
      await pay(tx, { userId: 'payer', createdAt: daysAgo(1) });
      // Imported, and backfilled `fulfilled_at = created_at`: 0 s that no gateway of this panel took.
      const imported = await pay(tx, { userId: 'payer', createdAt: daysAgo(1), planSnapshot: { importedFrom: 'remnashop' } });
      await fulfilledAfter(tx, imported, 0);
      // Created before the window, delivered inside it: not a payment of this window.
      const old = await pay(tx, { userId: 'payer', createdAt: daysAgo(40) });
      await fulfilledAfter(tx, old, 39 * DAY_MS);
      const report = await payments.getProviderReport(30);
      const yookassa = report.providers.find((p) => p.gatewayType === 'YOOKASSA');
      return [yookassa?.medianTimeToPaySeconds, yookassa?.p95TimeToPaySeconds];
    });
    // percentile_cont of 120 s and 600 s.
    assert.deepEqual(time, [360, 576]);
  });

  it('reads the time to pay exactly on any database time zone: a payment the panel created and fulfilled 90 s later', async () => {
    const median = await onCleanSlate(async (tx, { payments }) => {
      await customer(tx, 'now');
      // As a checkout writes it: no date given, `created_at` from Prisma's own default.
      const row = await tx.transaction.create({
        data: { userId: 'now', status: 'COMPLETED', purchaseType: 'NEW', gatewayType: 'YOOKASSA', currency: 'RUB', amount: '100' },
      });
      await fulfilledAfter(tx, row, 90_000);
      const report = await payments.getProviderReport(7);
      return report.providers.find((p) => p.gatewayType === 'YOOKASSA')?.medianTimeToPaySeconds;
    });
    assert.equal(median, 90);
  });

  it('leaves imported payments out of «Транзакции без вебхука» — no webhook of theirs was ever this panel’s', async () => {
    const gap = await onCleanSlate(async (tx, { payments }) => {
      await customer(tx, 'buyer');
      // A checkout its gateway never called back about: the alert is for this one.
      await pay(tx, { userId: 'buyer', gatewayId: 'yk-silent', createdAt: daysAgo(2) });
      // A checkout whose webhook arrived.
      const heard = await pay(tx, { userId: 'buyer', gatewayId: 'yk-heard', createdAt: daysAgo(2) });
      await tx.paymentWebhookEvent.create({
        data: { gatewayType: 'YOOKASSA', paymentId: heard.paymentId, providerEventId: `wp11-${heard.id}`, rawPayload: {} },
      });
      // Imported: the donor's own gateway id, and the donor's webhooks went to the donor.
      await pay(tx, { userId: 'buyer', gatewayId: 'donor-777', createdAt: daysAgo(2), planSnapshot: { importedFrom: 'bedolaga' } });
      const report = await payments.getWebhookHealth(7);
      return report.reconciliation.transactionsMissingWebhook;
    });
    assert.equal(gap, 1);
  });

  // The pending sweep (`PaymentPendingExpiryService`, every 5 minutes) cancels an abandoned checkout 30
  // minutes after it started — and re-stamps `updated_at` on every YooKassa payment the provider still
  // reports as open. So "untouched for an hour" never held for the payments stuck longest; "started over
  // an hour ago and still pending" is what stuck means.
  it('calls a checkout stuck when it is still pending an hour after it started — however recently the sweep polled it', async () => {
    const stuck = await onCleanSlate(async (tx, { payments }) => {
      await customer(tx, 'waiting');
      // YooKassa, 3 days pending, still open at the provider: polled — and re-stamped — 2 minutes ago.
      const polled = await pay(tx, { userId: 'waiting', status: 'PENDING', createdAt: daysAgo(3) });
      await touchedAt(tx, polled.id, new Date(Date.now() - 2 * 60_000));
      // Platega, 3 days pending: nothing polls it.
      const quiet = await pay(tx, { userId: 'waiting', status: 'PENDING', gatewayType: 'PLATEGA', createdAt: daysAgo(3) });
      await touchedAt(tx, quiet.id, daysAgo(3));
      // Started 40 minutes ago: not stuck yet.
      const fresh = await pay(tx, { userId: 'waiting', status: 'PENDING', createdAt: new Date(Date.now() - 40 * 60_000) });
      await touchedAt(tx, fresh.id, new Date(Date.now() - 40 * 60_000));
      // A checkout for nothing never waits on a gateway.
      const free = await pay(tx, { userId: 'waiting', status: 'PENDING', amount: '0', createdAt: daysAgo(2) });
      await touchedAt(tx, free.id, daysAgo(2));
      const report = await payments.getProviderReport(7);
      const of = (gateway: string) => report.providers.find((p) => p.gatewayType === gateway);
      return { yookassa: of('YOOKASSA')?.stuckPending, platega: of('PLATEGA')?.stuckPending, yookassaPending: of('YOOKASSA')?.pending };
    });
    assert.deepEqual(stuck, { yookassa: 1, platega: 1, yookassaPending: 2 });
  });

  it('leaves a partner’s balance out of the gateways’ totals — its own row and its own line keep it', async () => {
    const report = await onCleanSlate(async (tx, { payments }) => {
      await customer(tx, 'buyer');
      await pay(tx, { userId: 'buyer', amount: '100', createdAt: daysAgo(2) });
      await pay(tx, { userId: 'buyer', amount: '100', status: 'FAILED', createdAt: daysAgo(2) });
      await pay(tx, { userId: 'buyer', amount: '300', gatewayType: 'PARTNER_BALANCE', createdAt: daysAgo(2) });
      await pay(tx, { userId: 'buyer', amount: '300', gatewayType: 'PARTNER_BALANCE', createdAt: daysAgo(1) });
      return payments.getProviderReport(7);
    });
    const partner = report.providers.find((p) => p.gatewayType === 'PARTNER_BALANCE');
    assert.deepEqual(
      {
        totalTransactions: report.totalTransactions,
        totalPaid: report.totalPaid,
        totalCompleted: report.totalCompleted,
        partnerRow: [partner?.transactions, partner?.completed],
        partnerLine: report.partnerBalance.payments,
      },
      // YooKassa 1 paid of 2: 50 %, not the 75 % the balance's 2 purchases made of it.
      { totalTransactions: 2, totalPaid: 1, totalCompleted: 1, partnerRow: [2, 2], partnerLine: 2 },
    );
  });
});
