import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';
import { from } from 'rxjs';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { MOY_NALOG_JOBS } from '../src/modules/payments/constants/moy-nalog.constant';
import { MoyNalogProcessor } from '../src/modules/payments/processors/moy-nalog.processor';
import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { lockTransactionRefundLedger } from '../src/modules/payments/utils/payment-refund-ledger.util';
import { writeTransactionGatewayData } from '../src/modules/payments/utils/transaction-gateway-data.util';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import {
  REFERRAL_REVERSED_AT_KEY,
  ReferralQualificationService,
} from '../src/modules/referrals/services/referral-qualification.service';

/**
 * Two paths writing one payment's `gatewayData` at once both keep what they wrote.
 * ════════════════════════════════════════════════════════════════════════════════
 * Each case lets one path read the row, holds it where it waits on something
 * outside — YooKassa, the tax service, the steps of a reversal — lets another
 * path write the same row meanwhile, and then lets the first one write. Before
 * `writeTransactionGatewayData` the first one wrote back the copy it had read,
 * and the second path's write was gone. The paths are the real ones; YooKassa,
 * the tax service and the reconciler's other collaborators are stand-ins, so the
 * order in which the writes land is the test's to choose.
 *
 * The referral reversal's stamp waits on nothing outside: it reads the payment
 * and writes it a moment later, holding the payer's referral row, not the
 * payment's. Its case records a refund the way both refund writers do — the
 * payment row taken with `lockTransactionRefundLedger`, then the write — so the
 * stamp's write has to wait for it.
 *
 * The refund ledger's own case — a partial refund recorded while a «Мой налог»
 * registration waited — is `moy-nalog-receipt-race-postgres.spec.ts`.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `gda-${process.pid}-${Date.now()}`;
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

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

class TaxService {
  public registered = 0;
  public cancelled = 0;
  public registerAnswers: Promise<void> | null = null;

  public async registerIncome(): Promise<string> {
    this.registered += 1;
    const receipt = `receipt-${this.registered}`;
    if (this.registerAnswers !== null) await this.registerAnswers;
    return receipt;
  }

  public async cancelIncome(): Promise<boolean> {
    this.cancelled += 1;
    return true;
  }
}

function job(name: string, transactionId: string): never {
  return { name, data: { transactionId } } as never;
}

/** The processor, whose queue runs a cancellation it hands over at once, as a worker would. */
function processorFor(tax: TaxService, handedOver: string[] = []): MoyNalogProcessor {
  const processor: MoyNalogProcessor = new MoyNalogProcessor(prisma, tax as never, {
    enqueueCancelIncomeAfterRegistration: async (transactionId: string) => {
      handedOver.push(transactionId);
      await processor.process(job(MOY_NALOG_JOBS.CANCEL_INCOME, transactionId));
    },
  } as never);
  (processor as unknown as { logger: unknown }).logger = silent;
  return processor;
}

type Verdict =
  | { readonly outcome: 'CONFIRMED'; readonly providerStatus: string }
  | { readonly outcome: 'CONTRADICTED'; readonly providerStatus: string; readonly reason: string };

/** The reconciler; `verify` is YooKassa answering the completion check, `onCancelEnqueued` a worker taking the job. */
function reconciler(input: {
  readonly verify?: () => Promise<Verdict>;
  readonly onCancelEnqueued?: (transactionId: string) => Promise<void>;
  readonly inAdRevert?: () => Promise<void>;
} = {}): PaymentReconciliationService {
  const service = new PaymentReconciliationService(
    prisma,
    {
      incrementReconciliationAttempts: async () => ({}),
      markProcessing: async () => ({}),
      markProcessed: async () => ({}),
      markFailed: async (id: string) => ({ id }),
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { notifyWebhookFailed: async () => undefined } as never,
    { reverseEarningsForTransaction: async () => 0, processPartnerEarning: async () => undefined } as never,
    {
      reverseQualificationForTransaction: async () => undefined,
      qualifyReferralAfterPurchase: async () => null,
    } as never,
    { enqueue: async () => undefined } as never,
    { warn: () => undefined, info: () => undefined, error: () => undefined } as never,
    {
      enqueueCancelIncome: async (transactionId: string) => {
        await input.onCancelEnqueued?.(transactionId);
      },
      enqueueRegisterIncome: async () => undefined,
    } as never,
    {
      revertConversion: async () => {
        await input.inAdRevert?.();
      },
      recordFirstPurchase: async () => undefined,
    } as never,
    { upsertFromYookassaPayment: async () => undefined, disableAutopayForProviderMethod: async () => undefined } as never,
    {
      verifyCompletion: async () =>
        input.verify === undefined ? { outcome: 'CONFIRMED', providerStatus: 'succeeded' } : input.verify(),
    } as never,
    { reverseForTransactionBestEffort: async () => undefined, creditForTransactionBestEffort: async () => null } as never,
    { create: async () => undefined } as never,
  );
  (service as unknown as { logger: unknown }).logger = silent;
  return service;
}

/**
 * The expiry sweep, with YooKassa answering the poll `providerStatus` once
 * `answers` settles; `asked` is called when the sweep, having read the row,
 * sends its question.
 */
function sweep(
  providerStatus: string,
  answers: Promise<void> = Promise.resolve(),
  asked: () => void = () => undefined,
): PaymentPendingExpiryService {
  const service = new PaymentPendingExpiryService(
    prisma,
    { info: () => undefined, warn: () => undefined } as never,
    {
      get: (url: string) => {
        asked();
        return from(
          answers.then(() => ({
            status: 200,
            data: { id: decodeURIComponent(url.split('/').pop() ?? ''), status: providerStatus },
          })),
        );
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  (service as unknown as { logger: unknown }).logger = silent;
  return service;
}

/** The sweep's per-row poll — `isProviderTerminal` — on the row as the sweep read it. */
async function poll(service: PaymentPendingExpiryService, transactionId: string): Promise<unknown> {
  const row = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: {
      id: true, paymentId: true, userId: true, purchaseType: true, gatewayType: true, gatewayId: true,
      gatewayData: true, planSnapshot: true, amount: true, currency: true,
    },
  });
  return (service as unknown as { isProviderTerminal(row: unknown): Promise<unknown> }).isProviderTerminal(row);
}

async function payment(input: { readonly status: 'COMPLETED' | 'PENDING'; readonly gatewayData?: Record<string, unknown> }): Promise<string> {
  sequence += 1;
  const id = `${prefix}-tx-${sequence}`;
  const userId = `${prefix}-user-${sequence}`;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "users" ("id", "referral_code", "updated_at") VALUES (${userId}, ${`${userId}-ref`}, now())
  `);
  const fulfilledAt = input.status === 'COMPLETED' ? new Date(Date.now() - 10 * 60 * 1000) : null;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "transactions"
      ("id", "payment_id", "user_id", "status", "purchase_type", "gateway_type", "gateway_id", "currency", "amount",
       "plan_snapshot", "gateway_data", "fulfilled_at", "created_at", "updated_at")
    VALUES
      (${id}, ${`${id}-pay`}, ${userId}, ${input.status}::"TransactionStatus", 'RENEW'::"PurchaseType",
       'YOOKASSA'::"PaymentGatewayType", ${`${id}-yk`}, 'RUB'::"Currency", 1000,
       ${JSON.stringify({ id: 'plan-month', name: 'Месяц' })}::jsonb, ${JSON.stringify(input.gatewayData ?? {})}::jsonb,
       ${fulfilledAt}, now() - interval '2 hours', now() - interval '2 hours')
  `);
  return id;
}

async function notification(transactionId: string, kind: 'refund' | 'success'): Promise<string> {
  sequence += 1;
  const event = await prisma.paymentWebhookEvent.create({
    data: {
      gatewayType: 'YOOKASSA',
      paymentId: `${transactionId}-yk`,
      providerEventId: `${prefix}-event-${sequence}`,
      eventStatus: kind === 'refund' ? 'REFUNDED' : 'succeeded',
      rawPayload:
        kind === 'refund'
          ? {
              event: 'refund.succeeded',
              object: { id: `${prefix}-refund-${sequence}`, payment_id: `${transactionId}-yk`, status: 'succeeded', amount: { value: '1000.00', currency: 'RUB' } },
            }
          : {
              event: 'payment.succeeded',
              object: { id: `${transactionId}-yk`, status: 'succeeded', amount: { value: '1000.00', currency: 'RUB' }, metadata: { paymentId: `${transactionId}-pay` } },
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

/** A completed payment by a payer someone invited, so the reversal holds the payer's referral row. */
async function referredPayment(gatewayData: Record<string, unknown>): Promise<string> {
  const id = await payment({ status: 'COMPLETED', gatewayData });
  const { userId } = await prisma.transaction.findUniqueOrThrow({ where: { id }, select: { userId: true } });
  const referrerId = `${id}-referrer`;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "users" ("id", "referral_code", "updated_at") VALUES (${referrerId}, ${`${referrerId}-ref`}, now())
  `);
  await prisma.referral.create({ data: { referrerId, referredId: userId } });
  return id;
}

/** The referral program's reversal; what it logs as an error goes to `errors`. */
function referralReversal(errors: string[]): ReferralQualificationService {
  const service = new ReferralQualificationService(
    prisma,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    new PointsWalletService(),
    { enqueue: async () => undefined } as never,
  );
  (service as unknown as { logger: unknown }).logger = { ...silent, error: (message: string) => errors.push(message) };
  return service;
}

/** How many sessions wait for a lock that session `pid` holds. */
async function waitingOn(pid: number): Promise<number> {
  const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>(Prisma.sql`
    SELECT count(*)::int AS "waiting" FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids("pid"))
  `);
  return waiting;
}

run('gatewayData written by two paths at once, on PostgreSQL', () => {
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
    if (prisma === undefined) return;
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "payment_webhook_events" WHERE "provider_event_id" LIKE ${`${prefix}-%`}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "referrals" WHERE "referred_id" LIKE ${`${prefix}-%`}`);
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

  it('a refund landing while the receipt is being registered: the receipt is recorded, then cancelled', async () => {
    const tax = new TaxService();
    const answer = gate();
    tax.registerAnswers = answer.opened;
    const handedOver: string[] = [];
    const id = await payment({ status: 'COMPLETED' });
    const registering = processorFor(tax, handedOver).process(job(MOY_NALOG_JOBS.REGISTER_INCOME, id));
    await until(() => tax.registered === 1, 'the registration to reach the tax service');

    await reconciler({
      // The refund's cancellation is taken at once and finds no receipt yet.
      onCancelEnqueued: async (transactionId) => {
        await processorFor(tax).process(job(MOY_NALOG_JOBS.CANCEL_INCOME, transactionId));
      },
      // The tax service answers the registration now: after that cancellation,
      // before the reversal's own write.
      inAdRevert: async () => {
        answer.open();
        await registering;
      },
    }).reconcileWebhookEvent(await notification(id, 'refund'));

    const { status, gatewayData } = await stored(id);
    assert.equal(status, 'CANCELED');
    assert.equal(typeof gatewayData['refundReversedAt'], 'string');
    assert.equal(gatewayData['moyNalogReceiptUuid'], 'receipt-1', 'the reversal erased the receipt');
    assert.equal(typeof gatewayData['moyNalogCancelledAt'], 'string', 'income stays declared for money given back');
    assert.deepEqual({ registered: tax.registered, cancelled: tax.cancelled }, { registered: 1, cancelled: 1 });
    assert.deepEqual(handedOver, [id]);
  });

  it('a success notification keeps what the expiry sweep recorded while YooKassa was being asked', async () => {
    const id = await payment({ status: 'PENDING' });

    await reconciler({
      verify: async () => {
        // The sweep polls the same payment while the notification waits on YooKassa.
        assert.equal(await poll(sweep('pending'), id), 'keep');
        return { outcome: 'CONFIRMED', providerStatus: 'succeeded' };
      },
    }).reconcileWebhookEvent(await notification(id, 'success'));

    const { status, gatewayData } = await stored(id);
    assert.equal(status, 'COMPLETED');
    assert.equal(typeof gatewayData['reconciledAt'], 'string');
    assert.equal(typeof gatewayData['polledAt'], 'string', "the sweep's record of its poll was overwritten");
    assert.equal(gatewayData['providerStatus'], 'succeeded');
  });

  it("a manual-review hold survives the sweep's poll that was waiting on YooKassa", async () => {
    const id = await payment({ status: 'PENDING' });
    const answer = gate();
    let asked = false;
    const polling = poll(
      sweep('pending', answer.opened, () => {
        asked = true;
      }),
      id,
    );
    await until(() => asked, 'the sweep to read the row and ask YooKassa');

    // While the sweep waits, a notification for the payment is held for review.
    await reconciler({
      verify: async () => ({
        outcome: 'CONTRADICTED',
        providerStatus: 'canceled',
        reason: 'PAYMENT_VERIFICATION_PROVIDER_CANCELED',
      }),
    }).reconcileWebhookEvent(await notification(id, 'success'));
    answer.open();
    assert.equal(await polling, 'keep');

    const { status, gatewayData } = await stored(id);
    assert.equal(status, 'PENDING');
    assert.equal(gatewayData['paymentNeedsManualReview'], true, 'the hold was overwritten, and the sweep may cancel the row');
    assert.equal(typeof gatewayData['polledAt'], 'string');
  });

  it('the one writer: merges onto what the row holds, takes keys out, and claims in the same statement', async () => {
    const id = await payment({ status: 'PENDING', gatewayData: { kept: 1, dropped: 2 } });

    // A claim that does not hold writes nothing.
    assert.equal(
      await writeTransactionGatewayData(prisma, id, { onlyIfStatus: 'COMPLETED', status: 'CANCELED', merge: { claimed: true } }),
      0,
    );
    assert.deepEqual(await stored(id), { status: 'PENDING', gatewayData: { kept: 1, dropped: 2 } });

    // One that holds moves the status with the merge, keeps what it does not
    // name, and takes out what it names in `remove`.
    assert.equal(
      await writeTransactionGatewayData(prisma, id, {
        onlyIfStatus: 'PENDING',
        status: 'COMPLETED',
        gatewayId: `${id}-yk-new`,
        merge: { added: 'yes', left: undefined },
        remove: ['dropped'],
      }),
      1,
    );
    assert.deepEqual(await stored(id), { status: 'COMPLETED', gatewayData: { kept: 1, added: 'yes' } });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id }, select: { gatewayId: true } });
    assert.equal(row.gatewayId, `${id}-yk-new`);

    // A row holding no object merges as `{}`, as the spread it replaces did.
    for (const held of [Prisma.sql`NULL`, Prisma.sql`'[1,2]'::jsonb`, Prisma.sql`'"text"'::jsonb`]) {
      await prisma.$executeRaw(Prisma.sql`UPDATE "transactions" SET "gateway_data" = ${held} WHERE "id" = ${id}`);
      await writeTransactionGatewayData(prisma, id, { merge: { receipt: 'r-1' } });
      assert.deepEqual((await stored(id)).gatewayData, { receipt: 'r-1' });
    }
  });

  it('a manual-review hold keeps what the sweep recorded while the notification was being verified', async () => {
    const id = await payment({ status: 'PENDING' });

    await reconciler({
      verify: async () => {
        assert.equal(await poll(sweep('pending'), id), 'keep');
        return { outcome: 'CONTRADICTED', providerStatus: 'canceled', reason: 'PAYMENT_VERIFICATION_PROVIDER_CANCELED' };
      },
    }).reconcileWebhookEvent(await notification(id, 'success'));

    const { gatewayData } = await stored(id);
    assert.equal(gatewayData['paymentNeedsManualReview'], true);
    assert.equal(typeof gatewayData['polledAt'], 'string', "the sweep's record of its poll was overwritten");
  });

  it('the referral reversal keeps a refund recorded on the payment between its read and its stamp', async () => {
    const first = { refundId: 'refund-1', amount: '400.00', at: '2026-09-19T08:00:00.000Z' };
    const second = { refundId: 'refund-2', amount: '600.00', at: '2026-09-19T08:05:00.000Z' };
    const id = await referredPayment({ providerStatus: 'succeeded', refunds: [first], refundedAmountTotal: '400.00' });
    const errors: string[] = [];

    const { reversal } = await prisma.$transaction(
      async (ledger) => {
        // A refund recorded the way both refund writers record one: the payment
        // row first, then the write. The reversal holds only the payer's
        // referral row, so it reads the payment and then waits here to write
        // its stamp.
        await lockTransactionRefundLedger(ledger, id);
        const [{ pid }] = await ledger.$queryRaw<[{ pid: number }]>(Prisma.sql`SELECT pg_backend_pid() AS "pid"`);
        const reversing = referralReversal(errors).reverseQualificationForTransaction(id);
        await until(async () => (await waitingOn(pid)) > 0, "the reversal's stamp to wait for the payment row");
        await writeTransactionGatewayData(ledger, id, {
          merge: { providerStatus: 'succeeded', refundedAmountTotal: '1000.00', refunds: [first, second] },
        });
        return { reversal: reversing };
      },
      { timeout: 20_000 },
    );
    await reversal;

    const { gatewayData } = await stored(id);
    assert.deepEqual(errors, []);
    assert.equal(typeof gatewayData[REFERRAL_REVERSED_AT_KEY], 'string', 'the payment was not stamped');
    assert.deepEqual(
      { refundedAmountTotal: gatewayData['refundedAmountTotal'], refunds: gatewayData['refunds'] },
      { refundedAmountTotal: '1000.00', refunds: [first, second] },
      'the stamp wrote back the ledger it had read, and the refund recorded meanwhile is gone',
    );
  });

  it('the referral reversal leaves a payment it has already stamped as it is', async () => {
    const stampedAt = '2026-09-19T08:00:00.000Z';
    const id = await referredPayment({ providerStatus: 'succeeded', [REFERRAL_REVERSED_AT_KEY]: stampedAt });
    const errors: string[] = [];

    await referralReversal(errors).reverseQualificationForTransaction(id);

    assert.deepEqual(errors, []);
    assert.deepEqual((await stored(id)).gatewayData, { providerStatus: 'succeeded', [REFERRAL_REVERSED_AT_KEY]: stampedAt });
  });
});
