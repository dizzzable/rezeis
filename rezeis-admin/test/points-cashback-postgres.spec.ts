import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AddOnType,
  Currency,
  PaymentGatewayType,
  PointsCashbackMode,
  PointsLedgerSource,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PointsCashbackService } from '../src/modules/points/services/points-cashback.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';

/**
 * The cashback end to end on a real PostgreSQL: a real plan with a real price
 * list, a real completed transaction, the real settings row, the real wallet.
 * The unit spec models these; this one proves the queries the service issues
 * — the catalogue select with nested durations and prices, the settings
 * read, the ledger key — are the queries the schema answers.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `cb-${process.pid}-${Date.now()}`;
let prisma: PrismaService;
let service: PointsCashbackService;

const events: Array<{ type: string }> = [];

run('PointsCashbackService on PostgreSQL', () => {
  let userId: string;
  let planId: string;
  let addOnId: string;
  let previousSettings: { pointsSettings: Prisma.JsonValue; defaultCurrency: Currency } | null = null;
  const transactionIds: string[] = [];

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    service = new PointsCashbackService(prisma, new PointsWalletService(), {
      info: (type: string) => events.push({ type }),
      warn: (type: string) => events.push({ type }),
      error: () => undefined,
    } as never);

    userId = `${prefix}-user`;
    await prisma.user.create({ data: { id: userId, referralCode: `${prefix}-ref`, name: 'Cashback' } });

    const plan = await prisma.plan.create({
      data: {
        name: `${prefix}-plan`,
        cashbackMode: PointsCashbackMode.INHERIT,
        durations: {
          create: [
            {
              days: 90,
              prices: {
                create: [
                  { currency: Currency.RUB, price: new Prisma.Decimal('300') },
                  { currency: Currency.XTR, price: new Prisma.Decimal('200') },
                ],
              },
            },
            {
              days: 30,
              cashbackPoints: 40,
              prices: { create: [{ currency: Currency.RUB, price: new Prisma.Decimal('100') }] },
            },
          ],
        },
      },
      select: { id: true },
    });
    planId = plan.id;

    const addOn = await prisma.addOn.create({
      data: {
        name: `${prefix}-addon`,
        type: AddOnType.EXTRA_TRAFFIC,
        value: 10,
        cashbackMode: PointsCashbackMode.FIXED,
        cashbackPoints: 20,
        prices: { create: [{ currency: Currency.RUB, price: new Prisma.Decimal('50') }] },
      },
      select: { id: true },
    });
    addOnId = addOn.id;

    const settings = await prisma.settings.upsert({
      where: { id: 1 },
      update: {},
      create: {},
      select: { pointsSettings: true, defaultCurrency: true },
    });
    previousSettings = settings;
    await prisma.settings.update({
      where: { id: 1 },
      data: { pointsSettings: { cashback: { enabled: true, percent: 5 } }, defaultCurrency: Currency.RUB },
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    if (previousSettings !== null) {
      await prisma.settings
        .update({
          where: { id: 1 },
          data: {
            pointsSettings: previousSettings.pointsSettings as Prisma.InputJsonValue,
            defaultCurrency: previousSettings.defaultCurrency,
          },
        })
        .catch(() => undefined);
    }
    await prisma.transaction.deleteMany({ where: { id: { in: transactionIds } } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.plan.delete({ where: { id: planId } }).catch(() => undefined);
    await prisma.addOn.delete({ where: { id: addOnId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  async function completedTransaction(input: {
    readonly suffix: string;
    readonly amount: string;
    readonly currency: Currency;
    readonly purchaseType: PurchaseType;
    readonly planSnapshot: Prisma.InputJsonObject;
  }) {
    const id = `${prefix}-tx-${input.suffix}`;
    transactionIds.push(id);
    return prisma.transaction.create({
      data: {
        id,
        paymentId: `${prefix}-pay-${input.suffix}`,
        userId,
        status: TransactionStatus.COMPLETED,
        purchaseType: input.purchaseType,
        channel: PurchaseChannel.WEB,
        gatewayType: PaymentGatewayType.TELEGRAM_STARS,
        currency: input.currency,
        amount: new Prisma.Decimal(input.amount),
        planSnapshot: input.planSnapshot,
      },
    });
  }

  it('credits a foreign-currency purchase at the plan\'s own rate, once, and reverses it once', async () => {
    const transaction = await completedTransaction({
      suffix: 'stars',
      amount: '180',
      currency: Currency.XTR,
      purchaseType: PurchaseType.NEW,
      planSnapshot: { id: planId, name: 'Premium', selectedDurationDays: 90 },
    });

    const credited = await service.creditForTransaction(transaction);
    assert.equal(credited.credited, true, JSON.stringify(credited));
    assert.equal((credited as { points: number }).points, 13, '180 XTR × 300/200 = 270 RUB, 5% → 13');

    const again = await service.creditForTransaction(transaction);
    assert.equal(again.credited, false);
    assert.equal((again as { reason: string }).reason, 'ALREADY_CREDITED');

    const row = await prisma.pointsLedgerEntry.findUniqueOrThrow({
      where: { source_referenceKey: { source: PointsLedgerSource.CASHBACK, referenceKey: transaction.id } },
    });
    assert.equal(row.delta, 13);
    assert.equal(row.balanceAfter, 13);
    const details = row.details as { lines: Array<{ base: string; points: number; effective: string }> };
    assert.equal(details.lines[0]!.base, '270');
    assert.equal(details.lines[0]!.effective, 'PERCENT');

    const reversed = await service.reverseForTransaction(transaction.id);
    assert.deepEqual(reversed, { reversed: true, credited: 13, debited: 13, shortfall: 0 });
    const replay = await service.reverseForTransaction(transaction.id);
    assert.deepEqual(replay, { reversed: false, reason: 'ALREADY_REVERSED' });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { points: true } });
    assert.equal(user.points, 0);
  });

  it('a combined renewal credits the plan line and the add-on line from the item rows', async () => {
    const transaction = await completedTransaction({
      suffix: 'combined',
      amount: '150',
      currency: Currency.RUB,
      purchaseType: PurchaseType.RENEW,
      planSnapshot: {},
    });
    // An item renews a real subscription; the row must exist for the foreign key.
    const subscription = await prisma.subscription.create({
      data: { id: `${prefix}-sub`, userId, status: 'ACTIVE', planSnapshot: {}, deviceLimit: 2 },
      select: { id: true },
    });
    await prisma.transactionItem.create({
      data: {
        transactionId: transaction.id,
        subscriptionId: subscription.id,
        planId,
        planSnapshot: { name: 'Premium' },
        durationDays: 30,
        amount: new Prisma.Decimal('100'),
        currency: Currency.RUB,
        addOnLines: [
          {
            addOnId,
            catalogRevision: 1,
            type: 'EXTRA_TRAFFIC',
            value: 10,
            lifetime: 'UNTIL_SUBSCRIPTION_END',
            activation: 'IMMEDIATE',
            sourceLineKey: `${addOnId}:1`,
            unitAmount: '50',
            receiptName: 'Extra 10 GB',
          },
        ],
      },
    });

    const credited = await service.creditForTransaction(transaction);

    assert.equal(credited.credited, true, JSON.stringify(credited));
    assert.equal((credited as { points: number }).points, 25, 'INHERIT 5% of 100 = 5, plus FIXED 20 for the add-on');
    const row = await prisma.pointsLedgerEntry.findUniqueOrThrow({
      where: { source_referenceKey: { source: PointsLedgerSource.CASHBACK, referenceKey: transaction.id } },
    });
    const details = row.details as { lines: Array<{ kind: string; name: string; points: number }> };
    assert.deepEqual(
      details.lines.map((line) => [line.kind, line.name, line.points]),
      [
        ['PLAN', 'Premium', 5],
        ['ADD_ON', 'Extra 10 GB', 20],
      ],
    );
  });

  it('a plan with no price in the default currency earns nothing and leaves a card', async () => {
    await prisma.settings.update({ where: { id: 1 }, data: { defaultCurrency: Currency.USD } });
    try {
      const transaction = await completedTransaction({
        suffix: 'no-usd',
        amount: '180',
        currency: Currency.XTR,
        purchaseType: PurchaseType.NEW,
        planSnapshot: { id: planId, name: 'Premium', selectedDurationDays: 90 },
      });
      events.length = 0;

      const outcome = await service.creditForTransaction(transaction);

      assert.equal(outcome.credited, false);
      assert.deepEqual(events.map((event) => event.type), ['points.cashback_skipped']);
    } finally {
      await prisma.settings.update({ where: { id: 1 }, data: { defaultCurrency: Currency.RUB } });
    }
  });
});
