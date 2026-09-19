import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PartnerEarningsService } from '../src/modules/partners/services/partner-earnings.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { ReferralQualificationService } from '../src/modules/referrals/services/referral-qualification.service';

/**
 * A payment refunded in full stays refunded when a success notification runs again.
 * ═════════════════════════════════════════════════════════════════════════════════
 * The reconciler revives a CANCELED payment on a success notification — that is
 * how a checkout the expiry sweep cancelled still delivers when it is paid late.
 * A payment refunded in full is CANCELED too, and a success notification run
 * after the refund — an operator replaying it, or the inbox retrying a run that
 * had failed — revived it to COMPLETED and ran its post-payment hooks again.
 *
 * With the real partner-commission and referral-reward services, what that did
 * before this: the refund had deleted the partner's accrual, so the commission
 * was paid a second time on money that had gone back; the referral reward,
 * keyed on a row the refund keeps, was not.
 *
 * Now such a notification is acknowledged and nothing changes. An operator is
 * told once, and only when the provider itself reports the payment paid after
 * the refund. The last case holds the late-paid expired checkout to the revival
 * it always had.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `rrv-${process.pid}-${Date.now()}`;
const HOUR = 60 * 60 * 1000;

let prisma: PrismaService;
let previousSettings: { partnerSettings: Prisma.JsonValue; referralSettings: Prisma.JsonValue } | null = null;
let previousGateway: { settings: Prisma.JsonValue } | null = null;
let sequence = 0;

const silent = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const quietEvents = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Notice {
  readonly type: string;
  readonly metadata: Record<string, unknown>;
}

interface World {
  readonly service: PaymentReconciliationService;
  readonly transactionId: string;
  readonly gatewayId: string;
  readonly partnerId: string;
  readonly referrerId: string;
  readonly successEventId: string;
  readonly hooks: { moyNalog: number; cashback: number; ads: number };
  readonly notices: Notice[];
  readonly logs: string[];
  readonly processed: string[];
}

function paymentObject(gatewayId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'payment.succeeded',
    object: { id: gatewayId, status: 'succeeded', paid: true, amount: { value: '1000.00', currency: 'RUB' }, ...extra },
  };
}

/**
 * A payer referred by a user and attached to a partner, and a 1000 ₽ YooKassa
 * payment that was delivered two hours ago with every post-payment hook run.
 */
async function world(input: { readonly status?: 'COMPLETED' | 'CANCELED'; readonly fulfilled?: boolean } = {}): Promise<World> {
  sequence += 1;
  const tag = `${prefix}-${sequence}`;
  const [partnerUser, referrerId, payer] = [`${tag}-partner`, `${tag}-referrer`, `${tag}-payer`];
  for (const id of [partnerUser, referrerId, payer]) {
    await prisma.user.create({ data: { id, referralCode: `${id}-code`, name: id } });
  }
  const partner = await prisma.partner.create({ data: { userId: partnerUser, isActive: true } });
  await prisma.partnerReferral.create({ data: { partnerId: partner.id, referralUserId: payer, level: 1 } });
  await prisma.referral.create({ data: { referrerId, referredId: payer } });

  const transactionId = `${tag}-tx`;
  const gatewayId = `${tag}-yk`;
  const fulfilledAt = input.fulfilled === false ? null : new Date(Date.now() - 2 * HOUR);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "transactions"
      ("id", "payment_id", "user_id", "status", "purchase_type", "gateway_type", "gateway_id", "currency", "amount",
       "plan_snapshot", "gateway_data", "fulfilled_at", "created_at", "updated_at")
    VALUES
      (${transactionId}, ${`${transactionId}-pay`}, ${payer}, ${input.status ?? 'COMPLETED'}::"TransactionStatus",
       'RENEW'::"PurchaseType", 'YOOKASSA'::"PaymentGatewayType", ${gatewayId}, 'RUB'::"Currency", 1000,
       ${JSON.stringify({ id: 'plan-month', name: 'Месяц' })}::jsonb, '{}'::jsonb, ${fulfilledAt},
       now() - interval '2 hours', now() - interval '2 hours')
  `);
  const success = await prisma.paymentWebhookEvent.create({
    data: {
      gatewayType: 'YOOKASSA',
      paymentId: gatewayId,
      providerEventId: `${tag}-success`,
      eventStatus: 'succeeded',
      rawPayload: paymentObject(gatewayId) as Prisma.InputJsonValue,
      receivedAt: new Date(Date.now() - 2 * HOUR),
    },
  });

  const hooks = { moyNalog: 0, cashback: 0, ads: 0 };
  const notices: Notice[] = [];
  const logs: string[] = [];
  const processed: string[] = [];
  const partners = new PartnerEarningsService(prisma, quietEvents as never, { notifyEarning: async () => undefined } as never);
  (partners as unknown as { logger: unknown }).logger = silent;
  const referrals = new ReferralQualificationService(prisma, quietEvents as never, new PointsWalletService(), {
    enqueue: async () => undefined,
  } as never);
  (referrals as unknown as { logger: unknown }).logger = silent;
  const service = new PaymentReconciliationService(
    prisma,
    {
      incrementReconciliationAttempts: async () => ({}),
      markProcessing: async () => ({}),
      markProcessed: async (id: string) => {
        processed.push(id);
        return {};
      },
      markFailed: async (id: string) => ({ id }),
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { notifyWebhookFailed: async () => undefined } as never,
    partners,
    referrals,
    { enqueue: async () => undefined } as never,
    {
      info: () => undefined,
      error: () => undefined,
      warn: (type: string, _category: string, _message: string, metadata: Record<string, unknown> = {}) => {
        notices.push({ type, metadata });
      },
    } as never,
    {
      enqueueRegisterIncome: async () => {
        hooks.moyNalog += 1;
      },
      enqueueCancelIncome: async () => undefined,
    } as never,
    {
      recordFirstPurchase: async () => {
        hooks.ads += 1;
      },
      revertConversion: async () => undefined,
    } as never,
    { upsertFromYookassaPayment: async () => undefined, disableAutopayForProviderMethod: async () => undefined } as never,
    { verifyCompletion: async () => ({ outcome: 'CONFIRMED', providerStatus: 'succeeded' }) } as never,
    {
      creditForTransactionBestEffort: async () => {
        hooks.cashback += 1;
        return null;
      },
      reverseForTransactionBestEffort: async () => undefined,
    } as never,
    { create: async () => undefined } as never,
  );
  (service as unknown as { logger: unknown }).logger = {
    ...silent,
    log: (message: string) => logs.push(message),
  };

  if (fulfilledAt !== null && (input.status ?? 'COMPLETED') === 'COMPLETED') {
    // The payment as it was delivered: every post-payment hook, once.
    const paid = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    await service.runPostFulfillmentHooks(paid, paymentObject(gatewayId) as Prisma.JsonValue);
  }
  return {
    service,
    transactionId,
    gatewayId,
    partnerId: partner.id,
    referrerId,
    successEventId: success.id,
    hooks,
    notices,
    logs,
    processed,
  };
}

async function refundInFull(w: World): Promise<void> {
  const refund = await prisma.paymentWebhookEvent.create({
    data: {
      gatewayType: 'YOOKASSA',
      paymentId: w.gatewayId,
      providerEventId: `${w.transactionId}-refund`,
      eventStatus: 'REFUNDED',
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: `${w.transactionId}-refund-1`, payment_id: w.gatewayId, status: 'succeeded', amount: { value: '1000.00', currency: 'RUB' } },
      },
    },
  });
  await w.service.reconcileWebhookEvent(refund.id);
}

interface Money {
  readonly status: string;
  readonly refundReversedAt: unknown;
  readonly partnerBalance: number;
  readonly accruals: number;
  readonly referrerPoints: number;
}

async function money(w: World): Promise<Money> {
  const transaction = await prisma.transaction.findUniqueOrThrow({
    where: { id: w.transactionId },
    select: { status: true, gatewayData: true },
  });
  const partner = await prisma.partner.findUniqueOrThrow({ where: { id: w.partnerId }, select: { balance: true } });
  const referrer = await prisma.user.findUniqueOrThrow({ where: { id: w.referrerId }, select: { points: true } });
  return {
    status: transaction.status,
    refundReversedAt: ((transaction.gatewayData ?? {}) as Record<string, unknown>)['refundReversedAt'],
    partnerBalance: partner.balance,
    accruals: await prisma.partnerTransaction.count({ where: { sourceTransactionId: w.transactionId } }),
    referrerPoints: referrer.points,
  };
}

function paidAgainNotices(w: World): Notice[] {
  return w.notices.filter((notice) => notice.metadata['paidAfterRefund'] === true);
}

run('a success notification after a full refund, on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const settings = await prisma.settings.upsert({
      where: { id: 1 },
      update: {},
      create: {},
      select: { partnerSettings: true, referralSettings: true },
    });
    previousSettings = settings;
    await prisma.settings.update({
      where: { id: 1 },
      data: {
        partnerSettings: {
          enabled: true,
          levels: { LEVEL_1: 10, LEVEL_2: 0, LEVEL_3: 0 },
          gatewayCommissions: { YOOKASSA: 0 },
          taxPercent: 0,
          autoCalculateCommission: false,
        },
        referralSettings: { enabled: true, accrualStrategy: 'ON_EACH_PAYMENT', rewardType: 'POINTS', level1Reward: 100, level2Reward: 0 },
      },
    });
    previousGateway = await prisma.paymentGateway.findUnique({ where: { type: 'YOOKASSA' }, select: { settings: true } });
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "payment_gateways" ("id", "type", "currency", "is_active", "settings", "updated_at")
      VALUES (${`${prefix}-yookassa`}, 'YOOKASSA'::"PaymentGatewayType", 'RUB'::"Currency", true,
              ${JSON.stringify({ selfEmployedEnabled: true })}::jsonb, now())
      ON CONFLICT ("type") DO UPDATE SET "settings" = EXCLUDED."settings"
    `);
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = Prisma.sql`SELECT "id" FROM "users" WHERE "id" LIKE ${`${prefix}-%`}`;
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "payment_webhook_events" WHERE "provider_event_id" LIKE ${`${prefix}-%`}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "points_ledger" WHERE "user_id" IN (${users})`).catch(() => undefined);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "referral_rewards" WHERE "user_id" IN (${users})`).catch(() => undefined);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "partner_transactions" WHERE "source_transaction_id" LIKE ${`${prefix}-%`}`).catch(() => undefined);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "transactions" WHERE "id" LIKE ${`${prefix}-%`}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "referrals" WHERE "referred_id" IN (${users})`).catch(() => undefined);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "partners" WHERE "user_id" IN (${users})`).catch(() => undefined);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "users" WHERE "id" LIKE ${`${prefix}-%`}`).catch(() => undefined);
    if (previousSettings !== null) {
      await prisma.settings.update({
        where: { id: 1 },
        data: {
          partnerSettings: previousSettings.partnerSettings as Prisma.InputJsonValue,
          referralSettings: previousSettings.referralSettings as Prisma.InputJsonValue,
        },
      });
    }
    if (previousGateway === null) {
      await prisma.$executeRaw(Prisma.sql`DELETE FROM "payment_gateways" WHERE "type" = 'YOOKASSA'::"PaymentGatewayType"`);
    } else {
      await prisma.paymentGateway.update({
        where: { type: 'YOOKASSA' },
        data: { settings: previousGateway.settings as Prisma.InputJsonValue },
      });
    }
    await prisma.$disconnect();
  });

  it('leaves the refunded payment as the refund left it when its notification is replayed — commission included', async () => {
    const w = await world();
    assert.deepEqual(
      { partnerBalance: (await money(w)).partnerBalance, referrerPoints: (await money(w)).referrerPoints },
      { partnerBalance: 10_000, referrerPoints: 100 },
      'the payment did not pay its commission and reward in the first place',
    );
    await refundInFull(w);
    const refunded = await money(w);
    assert.equal(refunded.status, 'CANCELED');
    assert.equal(refunded.partnerBalance, 0);

    // An operator replays the success notification, twice.
    await w.service.reconcileWebhookEvent(w.successEventId);
    await w.service.reconcileWebhookEvent(w.successEventId);

    assert.deepEqual(await money(w), refunded);
    assert.deepEqual(w.hooks, { moyNalog: 1, cashback: 1, ads: 1 }, 'post-payment hooks ran again');
    assert.equal(w.processed.filter((id) => id === w.successEventId).length, 2, 'not acknowledged');
    assert.deepEqual(paidAgainNotices(w), []);
    assert.equal(w.logs.filter((line) => line.includes(`${w.successEventId}`) && line.includes('refunded in full')).length, 2);
  });

  it('is not revived either when only the refund ledger shows the refund', async () => {
    // A full refund whose reversal stamp the «Мой налог» cancellation erased —
    // what most full refunds before that merged in the statement looked like.
    const w = await world();
    await refundInFull(w);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "transactions" SET "gateway_data" = "gateway_data" - 'refundReversedAt' WHERE "id" = ${w.transactionId}
    `);
    const refunded = await money(w);
    assert.equal(refunded.refundReversedAt, undefined);

    await w.service.reconcileWebhookEvent(w.successEventId);

    assert.deepEqual(await money(w), refunded);
    assert.deepEqual(w.hooks, { moyNalog: 1, cashback: 1, ads: 1 });
  });

  it('tells an operator once when the provider reports the payment paid after the refund', async () => {
    const w = await world();
    await refundInFull(w);
    const refunded = await money(w);
    const fresh = await prisma.paymentWebhookEvent.create({
      data: {
        gatewayType: 'YOOKASSA',
        paymentId: w.gatewayId,
        providerEventId: `${w.transactionId}-success-again`,
        eventStatus: 'succeeded',
        rawPayload: paymentObject(w.gatewayId) as Prisma.InputJsonValue,
      },
    });

    await w.service.reconcileWebhookEvent(fresh.id);
    // The same notification replayed by an operator is not the provider speaking again.
    await prisma.paymentWebhookEvent.update({ where: { id: fresh.id }, data: { replayCount: 1 } });
    await w.service.reconcileWebhookEvent(fresh.id);

    const notices = paidAgainNotices(w);
    assert.equal(notices.length, 1, JSON.stringify(w.notices));
    assert.equal(notices[0]?.type, 'payment.amount_mismatch');
    assert.equal(notices[0]?.metadata['paymentId'], `${w.transactionId}-pay`);
    assert.deepEqual(await money(w), refunded);
    assert.deepEqual(w.hooks, { moyNalog: 1, cashback: 1, ads: 1 });
  });

  it('says nothing when that notification’s own payment object shows the refund', async () => {
    const w = await world();
    await refundInFull(w);
    const fresh = await prisma.paymentWebhookEvent.create({
      data: {
        gatewayType: 'YOOKASSA',
        paymentId: w.gatewayId,
        providerEventId: `${w.transactionId}-success-refunded`,
        eventStatus: 'succeeded',
        rawPayload: paymentObject(w.gatewayId, {
          refunded_amount: { value: '1000.00', currency: 'RUB' },
        }) as Prisma.InputJsonValue,
      },
    });

    await w.service.reconcileWebhookEvent(fresh.id);

    assert.deepEqual(paidAgainNotices(w), []);
    assert.equal((await money(w)).status, 'CANCELED');
  });

  it('still revives and delivers a checkout the expiry sweep cancelled, paid late', async () => {
    const w = await world({ status: 'CANCELED', fulfilled: false });

    await w.service.reconcileWebhookEvent(w.successEventId);

    const after = await money(w);
    assert.equal(after.status, 'COMPLETED');
    assert.equal(after.accruals, 1, 'the late payment paid no commission');
    assert.equal(after.referrerPoints, 100);
    assert.deepEqual(w.hooks, { moyNalog: 1, cashback: 1, ads: 1 });
  });
});
