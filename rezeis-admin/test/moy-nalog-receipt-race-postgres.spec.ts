import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { MOY_NALOG_JOBS } from '../src/modules/payments/constants/moy-nalog.constant';
import { MoyNalogProcessor } from '../src/modules/payments/processors/moy-nalog.processor';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';

/**
 * A МойНалог receipt is recorded without overwriting what the refund path wrote.
 * ═══════════════════════════════════════════════════════════════════════════════
 * The МойНалог job reads the transaction, waits on the tax service, and then
 * records the receipt. It used to record it by writing back the WHOLE
 * `gatewayData` it had read before the call — so whatever the refund path
 * wrote while the tax service answered was lost:
 *
 *   - the cancellation a full refund enqueues is taken by a worker at once and
 *     waits on the tax service while the reversal finishes; its write then
 *     erased the reversal's own `refundReversedAt`, `refundNeedsManualReview`
 *     and `subscriptionRevoked` — 19 of 20 runs with the tax service answering
 *     in 50-500 ms;
 *   - a registration still waiting on the tax service erased a partial refund's
 *     ledger entry, so the refund that completed the amount was counted as
 *     partial again and the payment was never reversed: commission, referral
 *     reward, cashback, declared income and access all stayed on money that had
 *     gone back in full.
 *
 * And income was declared for money that had gone back: a registration that
 * ran after the refund — this job retries for minutes when the tax service is
 * down — found nothing stopping it, as did one run again after a replayed
 * success notification had revived the refunded row.
 *
 * These run the real processor and the real refund path of the reconciler on
 * PostgreSQL; the tax service and the reconciler's other collaborators are
 * stand-ins, so the order in which the writes land is the test's to choose.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `mnr-${process.pid}-${Date.now()}`;
let prisma: PrismaService;
let previousGateway: { settings: Prisma.JsonValue } | null = null;
let sequence = 0;

const silent = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The tax service: counts what it was asked, answers when the case says so. */
class TaxService {
  public registered = 0;
  public cancelled = 0;
  public registerAnswers: Promise<void> | null = null;
  public cancelAnswers: Promise<void> | null = null;

  public async registerIncome(): Promise<string> {
    this.registered += 1;
    const receipt = `receipt-${this.registered}`;
    if (this.registerAnswers !== null) await this.registerAnswers;
    return receipt;
  }

  public async cancelIncome(): Promise<boolean> {
    this.cancelled += 1;
    if (this.cancelAnswers !== null) await this.cancelAnswers;
    return true;
  }
}

function processorFor(tax: TaxService): MoyNalogProcessor {
  const processor = new MoyNalogProcessor(prisma, tax as never);
  (processor as unknown as { logger: unknown }).logger = silent;
  return processor;
}

function job(name: string, transactionId: string): never {
  return { name, data: { transactionId } } as never;
}

interface Seen {
  partnerReversed: number;
  cancelEnqueued: number;
}

/** The reconciler, whose refund path is the real one; `onCancelEnqueued` is the worker taking the job. */
function reconciler(onCancelEnqueued: (transactionId: string) => Promise<void> = async () => undefined): {
  readonly service: PaymentReconciliationService;
  readonly seen: Seen;
} {
  const seen: Seen = { partnerReversed: 0, cancelEnqueued: 0 };
  const service = new PaymentReconciliationService(
    prisma,
    {
      incrementReconciliationAttempts: async () => ({}),
      markProcessing: async () => ({}),
      markProcessed: async () => ({}),
      markFailed: async (id: string) => ({ id }),
    } as never,
    {} as never,
    { notifyWebhookFailed: async () => undefined } as never,
    {
      reverseEarningsForTransaction: async () => {
        seen.partnerReversed += 1;
      },
    } as never,
    { reverseQualificationForTransaction: async () => undefined } as never,
    {} as never,
    { warn: () => undefined, info: () => undefined, error: () => undefined } as never,
    {
      enqueueCancelIncome: async (transactionId: string) => {
        seen.cancelEnqueued += 1;
        await onCancelEnqueued(transactionId);
      },
    } as never,
    { revertConversion: async () => undefined } as never,
    {} as never,
    {} as never,
    { reverseForTransactionBestEffort: async () => undefined } as never,
    {} as never,
  );
  (service as unknown as { logger: unknown }).logger = silent;
  return { service, seen };
}

/** A completed YooKassa renewal the panel delivered ten minutes ago. */
async function payment(input: { readonly status?: string; readonly gatewayData: Record<string, unknown> | null }): Promise<string> {
  sequence += 1;
  const id = `${prefix}-tx-${sequence}`;
  const userId = `${prefix}-user-${sequence}`;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "users" ("id", "referral_code", "updated_at") VALUES (${userId}, ${`${userId}-ref`}, now())
  `);
  const gatewayData = input.gatewayData === null ? null : JSON.stringify(input.gatewayData);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "transactions"
      ("id", "payment_id", "user_id", "status", "purchase_type", "gateway_type", "gateway_id", "currency", "amount",
       "plan_snapshot", "gateway_data", "fulfilled_at", "created_at", "updated_at")
    VALUES
      (${id}, ${`${id}-pay`}, ${userId}, ${input.status ?? 'COMPLETED'}::"TransactionStatus", 'RENEW'::"PurchaseType",
       'YOOKASSA'::"PaymentGatewayType", ${`${id}-yk`}, 'RUB'::"Currency", 1000,
       ${JSON.stringify({ id: 'plan-month', name: 'Месяц' })}::jsonb, ${gatewayData}::jsonb,
       now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '10 minutes')
  `);
  return id;
}

/** A YooKassa `refund.succeeded` for `amount` of the payment, stored the way the inbox stores one. */
async function refund(transactionId: string, refundId: string, amount: string): Promise<string> {
  const event = await prisma.paymentWebhookEvent.create({
    data: {
      gatewayType: 'YOOKASSA',
      paymentId: `${transactionId}-yk`,
      providerEventId: `${prefix}-${refundId}`,
      eventStatus: 'REFUNDED',
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: refundId, payment_id: `${transactionId}-yk`, status: 'succeeded', amount: { value: amount, currency: 'RUB' } },
      },
    },
  });
  return event.id;
}

async function stored(transactionId: string): Promise<{ status: string; gatewayData: Record<string, unknown> }> {
  const row = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { status: true, gatewayData: true },
  });
  return { status: row.status, gatewayData: (row.gatewayData ?? {}) as Record<string, unknown> };
}

run('МойНалог receipts and the refund path, on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    previousGateway = await prisma.paymentGateway.findUnique({ where: { type: 'YOOKASSA' }, select: { settings: true } });
    const settings = JSON.stringify({ selfEmployedEnabled: true, shopId: 'shop', apiKey: 'key' });
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "payment_gateways" ("id", "type", "currency", "is_active", "settings", "updated_at")
      VALUES (${`${prefix}-yookassa`}, 'YOOKASSA'::"PaymentGatewayType", 'RUB'::"Currency", true, ${settings}::jsonb, now())
      ON CONFLICT ("type") DO UPDATE SET "settings" = EXCLUDED."settings"
    `);
  });

  after(async () => {
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "payment_webhook_events" WHERE "provider_event_id" LIKE ${`${prefix}-%`}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "transactions" WHERE "id" LIKE ${`${prefix}-%`}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "users" WHERE "id" LIKE ${`${prefix}-%`}`);
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

  it('keeps the record of the refund reversal whose cancellation it runs', async () => {
    const tax = new TaxService();
    const answer = gate();
    tax.cancelAnswers = answer.opened;
    const id = await payment({ gatewayData: { moyNalogReceiptUuid: 'receipt-live' } });
    let cancelling: Promise<void> | null = null;
    // A worker takes the cancellation the moment it is enqueued, reads the row
    // and waits on the tax service while the reversal goes on and finishes.
    const { service } = reconciler(async (transactionId) => {
      cancelling = processorFor(tax).process(job(MOY_NALOG_JOBS.CANCEL_INCOME, transactionId));
      await until(() => tax.cancelled === 1, 'the cancellation to reach the tax service');
    });

    await service.reconcileWebhookEvent(await refund(id, 'refund-full', '1000.00'));
    answer.open();
    await cancelling;

    const { status, gatewayData } = await stored(id);
    assert.equal(status, 'CANCELED');
    assert.equal(typeof gatewayData['moyNalogCancelledAt'], 'string', 'the cancellation was not recorded');
    assert.equal(typeof gatewayData['refundReversedAt'], 'string', 'the reversal stamp was overwritten');
    assert.equal(gatewayData['refundNeedsManualReview'], true, 'the operator review flag was overwritten');
    assert.equal(gatewayData['subscriptionRevoked'], false, 'the revocation outcome was overwritten');
  });

  it('keeps a partial refund recorded while the tax service answered, so the refund that completes it reverses the payment', async () => {
    const tax = new TaxService();
    const answer = gate();
    tax.registerAnswers = answer.opened;
    const id = await payment({ gatewayData: {} });
    const registering = processorFor(tax).process(job(MOY_NALOG_JOBS.REGISTER_INCOME, id));
    await until(() => tax.registered === 1, 'the registration to reach the tax service');

    await reconciler().service.reconcileWebhookEvent(await refund(id, 'refund-1', '400.00'));
    answer.open();
    await registering;

    const registered = await stored(id);
    assert.equal(registered.gatewayData['moyNalogReceiptUuid'], 'receipt-1');
    assert.equal(registered.gatewayData['refundedAmountTotal'], '400.00', 'the first refund was overwritten');
    assert.equal((registered.gatewayData['refunds'] as unknown[] | undefined)?.length, 1);

    const second = reconciler();
    await second.service.reconcileWebhookEvent(await refund(id, 'refund-2', '600.00'));

    const { status, gatewayData } = await stored(id);
    assert.equal(gatewayData['refundedAmountTotal'], '1000.00');
    assert.equal(second.seen.partnerReversed, 1, 'the payment refunded in full was never reversed');
    assert.equal(second.seen.cancelEnqueued, 1, 'the declared income was never cancelled');
    assert.equal(status, 'CANCELED');
  });

  it('declares no income for a payment refunded before its registration ran', async () => {
    const tax = new TaxService();
    const id = await payment({ gatewayData: {} });
    await reconciler(async (transactionId) => {
      await processorFor(tax).process(job(MOY_NALOG_JOBS.CANCEL_INCOME, transactionId));
    }).service.reconcileWebhookEvent(await refund(id, 'refund-early', '1000.00'));

    await processorFor(tax).process(job(MOY_NALOG_JOBS.REGISTER_INCOME, id));

    assert.equal(tax.registered, 0, 'income declared for money already given back');
    assert.equal((await stored(id)).gatewayData['moyNalogReceiptUuid'], undefined);
  });

  it('declares no income for a payment that is no longer completed', async () => {
    const tax = new TaxService();
    const id = await payment({ status: 'CANCELED', gatewayData: {} });

    await processorFor(tax).process(job(MOY_NALOG_JOBS.REGISTER_INCOME, id));

    assert.equal(tax.registered, 0);
  });

  it('does not declare a refunded payment again when a replayed notification has revived it', async () => {
    // What the reconciler leaves after a success notification is replayed for
    // a payment already refunded and reversed: COMPLETED again, the reversal
    // stamp kept, and no receipt if the reversal's own write had overwritten it.
    const tax = new TaxService();
    const id = await payment({
      gatewayData: { refundReversedAt: '2026-09-18T20:00:00.000Z', refundedAmountTotal: '1000.00' },
    });

    await processorFor(tax).process(job(MOY_NALOG_JOBS.REGISTER_INCOME, id));

    assert.equal(tax.registered, 0, 'a second receipt for money already given back');
  });

  it('records a receipt and its cancellation on top of what the row holds, an empty gatewayData included', async () => {
    const tax = new TaxService();
    const empty = await payment({ gatewayData: null });
    await processorFor(tax).process(job(MOY_NALOG_JOBS.REGISTER_INCOME, empty));
    assert.equal((await stored(empty)).gatewayData['moyNalogReceiptUuid'], 'receipt-1');

    const withMethod = await payment({ gatewayData: { paymentMethodId: 'pm-1' } });
    await processorFor(tax).process(job(MOY_NALOG_JOBS.REGISTER_INCOME, withMethod));
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "transactions" SET "status" = 'CANCELED'::"TransactionStatus" WHERE "id" = ${withMethod}
    `);
    await processorFor(tax).process(job(MOY_NALOG_JOBS.CANCEL_INCOME, withMethod));

    const { gatewayData } = await stored(withMethod);
    assert.equal(gatewayData['paymentMethodId'], 'pm-1');
    assert.equal(gatewayData['moyNalogReceiptUuid'], 'receipt-2');
    assert.equal(typeof gatewayData['moyNalogRegisteredAt'], 'string');
    assert.equal(typeof gatewayData['moyNalogCancelledAt'], 'string');
    assert.equal(tax.cancelled, 1);
  });
});
