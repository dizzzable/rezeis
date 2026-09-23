import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { ConflictException, Logger } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  PlanAvailability,
  PlanType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { OPERATOR_ONLY_EVENT_TYPES } from '../src/common/services/system-events.service';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import {
  PaymentRefundService,
  WITHHELD_REFUND_CLAIM_MS,
} from '../src/modules/payments/services/payment-refund.service';
import { REFUND_REVERSAL_CLAIM_MS } from '../src/modules/payments/utils/payment-refund-ledger.util';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PlanReferenceGuardService } from '../src/modules/plans/services/plan-reference-guard.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

/**
 * A trial's conversion paid after ANOTHER payment converted the trial is
 * withheld: received, settled, applied to nothing, and the operator told once
 * to refund it at the provider (R2-support-money M1).
 *
 * It used to throw out of fulfilment. The notification then failed three times
 * and kept the dashboard CRITICAL for good; the YooKassa poll only logged an
 * error; «Платёж получен» was never raised, and payment webhook alerts are off
 * by default — so nobody was told, and the payment stayed COMPLETED without
 * `fulfilledAt`, which the plan deletion guard counts as unsettled for ever.
 *
 * The real reconciliation, expiry poll and fulfilment, over one in-memory
 * store; the post-payment hooks are spies. `payments-withheld-conversion-
 * postgres.spec.ts` repeats the webhook path on PostgreSQL.
 */

const DAY = 24 * 60 * 60 * 1000;
const PLAN_ID = 'plan-p';

type Row = Record<string, unknown> & { readonly id: string };

interface RaisedEvent {
  readonly severity: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

afterEach(() => mock.restoreAll());

function pick(row: Row, select: Record<string, boolean> | undefined): Record<string, unknown> {
  if (select === undefined) return { ...row };
  return Object.fromEntries(Object.entries(row).filter(([key]) => select[key] === true));
}

/**
 * A trial, `trial-sub`, converted by `payment-first`; and `payment-second`, a
 * conversion of the same trial drafted before that, paid now.
 */
function world(options: { readonly gatewayType?: PaymentGatewayType } = {}) {
  const gatewayType = options.gatewayType ?? PaymentGatewayType.PLATEGA;
  const convertedUntil = new Date(Date.now() + 30 * DAY);
  const subscription = {
    id: 'trial-sub',
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    remnawaveId: 'rw-1',
    planSnapshot: { id: PLAN_ID, name: 'Plan P' },
    expiresAt: convertedUntil,
  };
  const first: Row = {
    id: 'tx-first',
    paymentId: 'payment-first',
    userId: 'user-1',
    subscriptionId: 'trial-sub',
    purchaseType: PurchaseType.UPGRADE,
    status: TransactionStatus.COMPLETED,
    fulfilledAt: new Date(Date.now() - 5 * 60 * 1000),
    gatewayType: PaymentGatewayType.PLATEGA,
    gatewayData: {},
    currency: Currency.RUB,
    amount: new Prisma.Decimal('299'),
    planSnapshot: { id: PLAN_ID, selectedDurationDays: 30, convertsTrial: true },
  };
  const second: Row = {
    id: 'tx-second',
    paymentId: 'payment-second',
    userId: 'user-1',
    subscriptionId: 'trial-sub',
    purchaseType: PurchaseType.UPGRADE,
    status: TransactionStatus.PENDING,
    fulfilledAt: null,
    isTest: false,
    channel: PurchaseChannel.WEB,
    gatewayType,
    gatewayId: 'provider-second',
    gatewayData: {},
    currency: Currency.RUB,
    amount: new Prisma.Decimal('299'),
    paymentAsset: null,
    planSnapshot: { id: PLAN_ID, name: 'Plan P', selectedDurationDays: 30, convertsTrial: true },
    deviceTypes: [],
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  };
  const rows: Row[] = [first, second];
  const byId = (id: unknown): Row | undefined => rows.find((row) => row.id === id);
  const subscriptionWrites: unknown[] = [];
  const syncJobs: unknown[] = [];
  const audits: Record<string, unknown>[] = [];
  const events: RaisedEvent[] = [];
  const inbox = { processed: [] as string[], failed: [] as string[], failedAlerts: [] as string[] };
  const hooks = { partner: 0, referral: 0, cashback: 0, moyNalog: 0, adConversion: 0, savedMethod: 0 };
  const plan = {
    id: PLAN_ID,
    name: 'Plan P',
    description: null,
    tag: null,
    type: PlanType.BOTH,
    icon: null,
    availability: PlanAvailability.ALL,
    trafficLimit: 100,
    deviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
  };

  // The success notification every test starts from, and whatever a test
  // delivers after it (`notify`).
  const webhookEvents = new Map<string, Record<string, unknown>>([
    [
      'event-1',
      {
        id: 'event-1',
        gatewayType,
        paymentId: 'payment-second',
        providerEventId: 'provider-event-1',
        eventStatus: gatewayType === PaymentGatewayType.YOOKASSA ? 'succeeded' : 'CONFIRMED',
        status: PaymentWebhookLifecycleStatus.ENQUEUED,
        rawPayload: { status: 'CONFIRMED' },
      },
    ],
  ]);

  const prisma: Record<string, unknown> = {
    paymentWebhookEvent: {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        webhookEvents.get(where.id ?? '') ?? webhookEvents.get('event-1'),
    },
    paymentGateway: {
      findUnique: async () => ({ settings: { shopId: 'shop-1', apiKey: 'secret-1' } }),
    },
    transaction: {
      findUnique: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = rows.find((candidate) => candidate.id === where.id || candidate.paymentId === where.paymentId);
        return row === undefined ? null : pick(row, select);
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => row.gatewayId === where.gatewayId) ?? null,
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        // The expiry sweep's scan of stale PENDING rows.
        if (where.status === TransactionStatus.PENDING) {
          return rows.filter((row) => row.status === TransactionStatus.PENDING).map((row) => pick(row, select));
        }
        // Fulfilment's look for the payment that converted the trial.
        const except = (where.id as { not?: string } | undefined)?.not;
        return rows
          .filter(
            (row) =>
              row.subscriptionId === where.subscriptionId &&
              row.purchaseType === where.purchaseType &&
              row.status === where.status &&
              row.fulfilledAt !== null &&
              row.id !== except,
          )
          .map((row) => pick(row, select));
      },
      // The claims: fulfilment's (`fulfilledAt` empty), the poll's (PENDING and
      // empty), and a release fenced on the stamp it holds.
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = byId(where.id);
        if (row === undefined) return { count: 0 };
        if (where.status !== undefined && row.status !== where.status) return { count: 0 };
        if ('fulfilledAt' in where) {
          const fence = where.fulfilledAt as Date | null;
          const stamp = row.fulfilledAt as Date | null;
          const holds = fence === null ? stamp === null : stamp?.getTime() === fence.getTime();
          if (!holds) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = byId(where.id);
        assert.ok(row, `no transaction ${String(where.id)}`);
        Object.assign(row, data);
        return { ...row };
      },
    },
    transactionItem: { findMany: async () => [] },
    plan: { findUnique: async () => plan },
    subscription: {
      findUnique: async () => ({ ...subscription }),
      update: async (args: unknown) => {
        subscriptionWrites.push(args);
        return subscription;
      },
    },
    profileSyncJob: {
      create: async (args: unknown) => {
        syncJobs.push(args);
        return { id: 'job-1' };
      },
    },
    trialClaim: { updateMany: async () => ({ count: 0 }) },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
    // The row lock a conversion takes on its trial, and the refund writers' on
    // the payment: one row either way.
    $queryRaw: async () => [{ id: 'trial-sub' }],
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: (id) => byId(id)?.gatewayData,
      update: async ({ where, data }) => Object.assign(byId(where.id)!, data),
      updateMany: async ({ where, data }) => {
        const row = byId(where.id);
        if (row === undefined || (where.status !== undefined && row.status !== where.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    }),
  };
  prisma.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma);

  const record =
    (severity: string) =>
    (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
      events.push({ severity, type, message, metadata });
    };
  const systemEvents = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR'), emit: () => undefined };
  const mutation = new PaymentSubscriptionMutationService(
    prisma as never,
    systemEvents as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const reconciliation = new PaymentReconciliationService(
    prisma as never,
    {
      incrementReconciliationAttempts: async () => undefined,
      markProcessing: async () => undefined,
      markProcessed: async (id: string) => {
        inbox.processed.push(id);
      },
      markFailed: async (id: string) => {
        inbox.failed.push(id);
        return { id };
      },
    } as never,
    mutation,
    {
      notifyWebhookFailed: async (input: { readonly event: { readonly id: string } }) => {
        inbox.failedAlerts.push(input.event.id);
      },
    } as never,
    {
      processPartnerEarning: async () => {
        hooks.partner += 1;
      },
      reverseEarningsForTransaction: async () => 0,
    } as never,
    {
      qualifyReferralAfterPurchase: async () => {
        hooks.referral += 1;
        return null;
      },
      reverseQualificationForTransaction: async () => undefined,
    } as never,
    { enqueue: async () => undefined } as never,
    systemEvents as never,
    {
      enqueueRegisterIncome: async () => {
        hooks.moyNalog += 1;
      },
      enqueueCancelIncome: async () => undefined,
    } as never,
    {
      recordFirstPurchase: async () => {
        hooks.adConversion += 1;
      },
      revertConversion: async () => undefined,
    } as never,
    {
      upsertFromYookassaPayment: async () => {
        hooks.savedMethod += 1;
      },
      disableAutopayForProviderMethod: async () => undefined,
    } as never,
    { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
    {
      creditForTransactionBestEffort: async () => {
        hooks.cashback += 1;
        return null;
      },
      reverseForTransactionBestEffort: async () => undefined,
    } as never,
    { create: async () => 'notification-1' } as never,
  );
  const expiry = new PaymentPendingExpiryService(
    prisma as never,
    systemEvents as never,
    { get: () => of({ status: 200, data: { id: 'provider-second', status: 'succeeded', paid: true } }) } as never,
    mutation,
    { enqueue: async () => undefined } as never,
    reconciliation,
  );
  // «Отметить возврат»: nothing reaches a provider, so no HTTP client and no redaction.
  const refunds = new PaymentRefundService(prisma as never, {} as never, {} as never, reconciliation);
  const hookCalls = () => Object.values(hooks).reduce((sum, count) => sum + count, 0);
  /** A further notification from the provider about the second payment, reconciled. */
  const notify = async (id: string, fields: { readonly eventStatus: string; readonly rawPayload: unknown; readonly paymentId?: string }) => {
    webhookEvents.set(id, {
      id,
      gatewayType,
      paymentId: fields.paymentId ?? 'payment-second',
      providerEventId: `provider-${id}`,
      status: PaymentWebhookLifecycleStatus.ENQUEUED,
      eventStatus: fields.eventStatus,
      rawPayload: fields.rawPayload,
      // Received now, first delivery: the provider speaking, not a replay.
      receivedAt: new Date(Date.now() + 1000),
      replayCount: 0,
      reconciliationAttempts: 0,
    });
    await reconciliation.reconcileWebhookEvent(id);
  };
  return {
    reconciliation,
    expiry,
    refunds,
    notify,
    prisma,
    first,
    second,
    subscription,
    convertedUntil,
    subscriptionWrites,
    syncJobs,
    audits,
    events,
    inbox,
    hookCalls,
  };
}

/**
 * What was said of a refund: to the operator alone (`payment.withheld_refunded`,
 * operator-only), and to everyone a sale's refund reaches — rules, outbound
 * webhooks, refund emails (`payment.refunded`, `payment.refund_partial`).
 */
function refundEvents(w: ReturnType<typeof world>): { operator: RaisedEvent[]; shared: RaisedEvent[] } {
  return {
    operator: w.events.filter((event) => event.type === 'payment.withheld_refunded'),
    shared: w.events.filter((event) => event.type === 'payment.refunded' || event.type === 'payment.refund_partial'),
  };
}

function assertWithheld(w: ReturnType<typeof world>): void {
  assert.equal(w.second.status, TransactionStatus.COMPLETED);
  assert.ok(w.second.fulfilledAt instanceof Date, 'settled: fulfilled, not left for a retry');
  const gatewayData = w.second.gatewayData as Record<string, unknown>;
  assert.equal(typeof gatewayData.conversionWithheldAt, 'string');
  assert.equal(gatewayData.trialConvertedByPaymentId, 'payment-first');
  assert.deepEqual(w.subscriptionWrites, [], 'the subscription the first payment converted is untouched');
  assert.deepEqual(w.syncJobs, []);
  assert.equal(w.hookCalls(), 0, 'no commission, reward, cashback, «Мой налог», ad conversion or saved card');
  // No `payment.completed` for it at all: that is a receipt to the payer and a
  // sale to rules and integrations. The operator's notice is its own type.
  assert.deepEqual(
    w.events.filter((event) => event.type === 'payment.completed'),
    [],
    'a withheld payment was announced as a completed sale',
  );
  const notices = w.events.filter((event) => event.type === 'payment.withheld');
  assert.equal(notices.length, 1, JSON.stringify(w.events));
  assert.equal(notices[0]?.severity, 'WARNING');
  assert.equal(notices[0]?.metadata.paymentId, 'payment-second');
  assert.equal(notices[0]?.metadata.trialConvertedByPaymentId, 'payment-first');
  assert.match(String(notices[0]?.metadata.note), /Верните деньги у платёжного провайдера/);
}

describe('a conversion paid after another payment converted the trial', () => {
  it('on the webhook path: processed, not failed; settled and withheld; one notice; no hook', async () => {
    const w = world();

    await w.reconciliation.reconcileWebhookEvent('event-1');

    assert.deepEqual(w.inbox.processed, ['event-1']);
    assert.deepEqual(w.inbox.failed, [], 'the dashboard counts FAILED notifications as CRITICAL');
    assert.deepEqual(w.inbox.failedAlerts, []);
    assertWithheld(w);
  });

  it('a replay of the notification changes nothing and says nothing again', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const settled = { ...w.second };

    await w.reconciliation.reconcileWebhookEvent('event-1');

    assert.deepEqual(w.inbox.processed, ['event-1', 'event-1']);
    assert.deepEqual(w.inbox.failed, []);
    assert.deepEqual({ ...w.second }, settled);
    assertWithheld(w);
  });

  it('on the YooKassa poll path: settled and withheld the same way, with no error logged', async () => {
    const errors = mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'warn', () => undefined);
    const w = world({ gatewayType: PaymentGatewayType.YOOKASSA });

    await w.expiry.expireStalePending();

    assert.equal(errors.mock.callCount(), 0, JSON.stringify(errors.mock.calls.map((call) => call.arguments)));
    assertWithheld(w);
  });

  it('is closed by its refund as refunded, taking nothing from the subscription the first payment converted', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');

    await w.reconciliation.reverseFulfilledPayment(w.second as never, 'refund.succeeded');

    assert.equal(w.second.status, TransactionStatus.CANCELED);
    const gatewayData = w.second.gatewayData as Record<string, unknown>;
    assert.equal(typeof gatewayData.refundReversedAt, 'string');
    assert.equal(gatewayData.subscriptionRevoked, false);
    assert.equal(gatewayData.refundRevocationSkippedReason, 'CONVERSION_NOT_APPLIED');
    assert.equal('refundNeedsManualReview' in gatewayData, false, 'nothing is left to review on the subscription');
    assert.deepEqual(w.subscriptionWrites, []);
    // The operator's alone: no sale was ever announced for it.
    const { operator, shared } = refundEvents(w);
    assert.deepEqual(shared, [], 'a refund of a sale nobody was told about reached rules and integrations');
    assert.equal(operator.length, 1);
    assert.equal(operator[0]?.severity, 'WARNING');
    assert.equal(operator[0]?.metadata.conversionWithheld, true);
    assert.equal(operator[0]?.metadata.needsManualReview, false);
  });

  it("leaves nothing the plan deletion guard counts as unsettled", async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const guard = new PlanReferenceGuardService({} as never);

    const counts = await guard.countReferences([PLAN_ID], { client: countingClient([w.second]) });

    assert.equal(counts.get(PLAN_ID)?.unsettledPayments, 0);
    // The same query sees the row as it was before this change: paid, never fulfilled.
    const before = await guard.countReferences([PLAN_ID], {
      client: countingClient([{ ...w.second, fulfilledAt: null }]),
    });
    assert.equal(before.get(PLAN_ID)?.unsettledPayments, 1);
  });
});

/**
 * «Отметить возврат» (R3-support-money N4): the operator returned a withheld
 * payment's money at the provider — most gateways never report a refund — and
 * records it here, which runs the reversal a refund notification runs.
 */
describe('recording the refund of a withheld payment', () => {
  const OPERATOR = { id: 'admin-1' } as CurrentAdminInterface;
  const REQUEST = { requestId: 'request-1', remoteAddress: '203.0.113.5', userAgent: 'spec' };
  const record = (w: ReturnType<typeof world>, transactionId = 'tx-second') =>
    w.refunds.recordWithheldRefund({ transactionId, currentAdmin: OPERATOR, requestMetadata: REQUEST });

  it('reverses it as refunded, says who recorded it, and leaves the subscription alone', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');

    const result = await record(w);

    assert.equal(result.recorded, true);
    assert.equal(w.second.status, TransactionStatus.CANCELED);
    const gatewayData = w.second.gatewayData as Record<string, unknown>;
    assert.equal(typeof gatewayData.refundReversedAt, 'string');
    assert.equal(result.refundedAt, gatewayData.refundReversedAt);
    assert.equal(gatewayData.manualRefundRecordedBy, 'admin-1');
    assert.equal(gatewayData.refundRevocationSkippedReason, 'CONVERSION_NOT_APPLIED');
    assert.equal('refundNeedsManualReview' in gatewayData, false);
    // The provider's own last word is kept, not overwritten by the record.
    assert.equal(gatewayData.providerStatus, 'CONFIRMED');
    assert.deepEqual(w.subscriptionWrites, [], 'the subscription the first payment converted is untouched');
    assert.deepEqual(w.syncJobs, []);
    assert.equal(w.audits.length, 1);
    assert.equal(w.audits[0]?.action, 'payments.transaction.withheld_refund_recorded');
    assert.deepEqual(w.audits[0]?.adminUser, { connect: { id: 'admin-1' } });
    assert.equal((w.audits[0]?.metadata as Record<string, unknown>).transactionId, 'tx-second');
    assert.equal(refundEvents(w).operator.length, 1);
    assert.deepEqual(refundEvents(w).shared, [], 'a refund of a sale nobody was told about reached rules and integrations');
  });

  it('is idempotent: a second click changes nothing and says nothing', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const first = await record(w);
    const settled = JSON.stringify(w.second);

    const again = await record(w);

    assert.deepEqual(again, { transactionId: 'tx-second', recorded: false, refundedAt: first.refundedAt });
    assert.deepEqual(JSON.stringify(w.second), settled);
    assert.equal(w.audits.length, 1);
    assert.equal(refundEvents(w).operator.length, 1);
    assert.deepEqual(refundEvents(w).shared, [], 'a refund of a sale nobody was told about reached rules and integrations');
  });

  it('does nothing for a payment its provider already reported refunded', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    await w.reconciliation.reverseFulfilledPayment(w.second as never, 'refund.succeeded');

    const result = await record(w);

    assert.equal(result.recorded, false);
    assert.equal(typeof result.refundedAt, 'string');
    assert.equal(w.audits.length, 0);
    assert.equal('manualRefundRecordedAt' in (w.second.gatewayData as Record<string, unknown>), false);
    assert.equal(refundEvents(w).operator.length, 1);
    assert.deepEqual(refundEvents(w).shared, [], 'a refund of a sale nobody was told about reached rules and integrations');
  });

  it('refuses a payment that was not withheld, and changes nothing', async () => {
    // The payment that did convert the trial: a refund recorded here would
    // book a sale that stands as returned.
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const before = JSON.stringify(w.first);

    await assert.rejects(
      record(w, 'tx-first'),
      (error: unknown) => error instanceof ConflictException && error.message === 'PAYMENT_NOT_WITHHELD',
    );

    assert.deepEqual(JSON.stringify(w.first), before);
    assert.equal(w.audits.length, 0);
    assert.equal(refundEvents(w).operator.length + refundEvents(w).shared.length, 0);
  });

  it('turns a second click away while the first one runs, and finishes a run that died', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const gatewayData = w.second.gatewayData as Record<string, unknown>;
    gatewayData.manualRefundRecordedAt = new Date(Date.now() - 1000).toISOString();

    await assert.rejects(
      record(w),
      (error: unknown) => error instanceof ConflictException && error.message === 'PAYMENT_WITHHELD_REFUND_IN_PROGRESS',
    );
    assert.equal(w.second.status, TransactionStatus.COMPLETED);
    assert.equal(w.audits.length, 0);

    // A claim older than the run could take belongs to one that died before
    // its reversal: the next click finishes it.
    gatewayData.manualRefundRecordedAt = new Date(Date.now() - WITHHELD_REFUND_CLAIM_MS - 1000).toISOString();
    const result = await record(w);

    assert.equal(result.recorded, true);
    assert.equal(w.second.status, TransactionStatus.CANCELED);
    assert.equal(w.audits.length, 1);
  });
});

/**
 * A withheld payment's refund, told by the PROVIDER — the other door
 * (R3-support-money wave 4b). No sale was ever announced for the payment, so
 * its refund is the operator's alone: `payment.withheld_refunded`, which
 * `OPERATOR_ONLY_EVENT_TYPES` keeps from rules, outbound webhooks and refund
 * emails. As `payment.refunded` it told all of them of a refund of a sale none
 * of them had seen.
 */
describe("a withheld payment's refund reported by the provider", () => {
  const yookassaRefund = (value: string) => ({
    event: 'refund.succeeded',
    object: { id: `refund-${value}`, payment_id: 'provider-second', status: 'succeeded', amount: { value, currency: 'RUB' } },
  });

  it('YooKassa, in full: reversed, and told to the operator alone', async () => {
    const w = world({ gatewayType: PaymentGatewayType.YOOKASSA });
    await w.reconciliation.reconcileWebhookEvent('event-1');

    await w.notify('refund-1', { eventStatus: 'REFUNDED', rawPayload: yookassaRefund('299.00'), paymentId: 'provider-second' });

    assert.equal(w.second.status, TransactionStatus.CANCELED);
    assert.deepEqual(w.subscriptionWrites, []);
    const { operator, shared } = refundEvents(w);
    assert.deepEqual(shared, [], 'a refund of a sale nobody was told about reached rules and integrations');
    assert.equal(operator.length, 1);
    assert.equal(operator[0]?.metadata.conversionWithheld, true);
    assert.equal(operator[0]?.metadata.partial, undefined);
    assert.ok(OPERATOR_ONLY_EVENT_TYPES.has('payment.withheld_refunded'));
  });

  it('YooKassa, in part: held for review, and told to the operator alone', async () => {
    const w = world({ gatewayType: PaymentGatewayType.YOOKASSA });
    await w.reconciliation.reconcileWebhookEvent('event-1');

    await w.notify('refund-1', { eventStatus: 'REFUNDED', rawPayload: yookassaRefund('100.00'), paymentId: 'provider-second' });

    assert.equal(w.second.status, TransactionStatus.COMPLETED, 'a partial refund reverses nothing');
    assert.equal((w.second.gatewayData as Record<string, unknown>).refundNeedsManualReview, true);
    const { operator, shared } = refundEvents(w);
    assert.deepEqual(shared, [], 'a partial refund of a sale nobody was told about reached rules and integrations');
    assert.equal(operator.length, 1);
    assert.equal(operator[0]?.metadata.partial, true);
    assert.equal(operator[0]?.metadata.refundedAmount, '100');
  });

  for (const gatewayType of [PaymentGatewayType.CRYPTOMUS, PaymentGatewayType.HELEKET]) {
    it(`${gatewayType} \`refund_paid\`: reversed, and told to the operator alone`, async () => {
      const w = world({ gatewayType });
      await w.reconciliation.reconcileWebhookEvent('event-1');

      await w.notify('refund-1', { eventStatus: 'refund_paid', rawPayload: { status: 'refund_paid' } });

      assert.equal(w.second.status, TransactionStatus.CANCELED);
      assert.deepEqual(w.subscriptionWrites, []);
      const { operator, shared } = refundEvents(w);
      assert.deepEqual(shared, []);
      assert.equal(operator.length, 1);
    });
  }

  it('leaves the partial refund of an ordinary payment where it always went', async () => {
    // The control for the partial branch: the payment that DID convert the
    // trial, refunded in part through ЮKassa, is a sale everyone heard of.
    const w = world({ gatewayType: PaymentGatewayType.YOOKASSA });
    await w.reconciliation.reconcileWebhookEvent('event-1');
    Object.assign(w.first, { gatewayType: PaymentGatewayType.YOOKASSA, gatewayId: 'provider-first' });

    await w.notify('refund-first', {
      eventStatus: 'REFUNDED',
      paymentId: 'provider-first',
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'refund-first-1', payment_id: 'provider-first', status: 'succeeded', amount: { value: '100.00', currency: 'RUB' } },
      },
    });

    const { operator, shared } = refundEvents(w);
    assert.equal(operator.length, 0);
    assert.deepEqual(shared.map((event) => event.type), ['payment.refund_partial']);
    assert.equal(shared[0]?.metadata.paymentId, 'payment-first');
    assert.equal(shared[0]?.metadata.conversionWithheld, undefined);
    assert.equal(w.first.status, TransactionStatus.COMPLETED);
  });

  it('leaves the refund of an ordinary payment where it always went', async () => {
    // The control: the payment that DID convert the trial is a sale everyone
    // heard of, and so is its refund.
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');

    await w.reconciliation.reverseFulfilledPayment(w.first as never, 'CHARGEBACKED');

    const { operator, shared } = refundEvents(w);
    assert.equal(operator.length, 0);
    assert.deepEqual(shared.map((event) => event.type), ['payment.refunded']);
    assert.equal(shared[0]?.metadata.conversionWithheld, undefined);
  });
});

/**
 * The reversal runs ONCE, whichever door comes second (R4 F1, laterList 2).
 *
 * `refundReversedAt` is written at the END of the reversal, so while one door's
 * run was still going, another found it unset and ran the whole reversal as
 * well: two cards, the partner debit and the subscription revocation twice, and
 * the provider's status written back to an older word by whichever ended last.
 * The run is now claimed under the row lock. Each case below holds the first
 * run inside its reversal — at the partner step, its first step — while the
 * second door comes in, then lets it finish.
 */
describe('the refund reversal, from two doors at once', () => {
  /** Holds the first reversal run at its partner step until `release()`; counts the runs. */
  function holdFirstRun(w: ReturnType<typeof world>) {
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runs = { count: 0 };
    const partner = (w.reconciliation as unknown as {
      partnerEarningsService: { reverseEarningsForTransaction: () => Promise<number> };
    }).partnerEarningsService;
    partner.reverseEarningsForTransaction = async () => {
      runs.count += 1;
      if (runs.count === 1) {
        entered();
        await gate;
      }
      return 0;
    };
    return { inside, release, runs };
  }
  const OPERATOR = { id: 'admin-1' } as CurrentAdminInterface;
  const REQUEST = { requestId: 'request-1', remoteAddress: '203.0.113.5', userAgent: 'spec' };

  it('«Отметить возврат», then the provider’s notice while it runs: one reversal, one card, the provider’s word kept', async () => {
    const w = world({ gatewayType: PaymentGatewayType.CRYPTOMUS });
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const held = holdFirstRun(w);

    const manual = w.refunds.recordWithheldRefund({ transactionId: 'tx-second', currentAdmin: OPERATOR, requestMetadata: REQUEST });
    await held.inside;
    await w.notify('refund-1', { eventStatus: 'refund_paid', rawPayload: { status: 'refund_paid' } });
    // Recorded under the lock while the click's run was going.
    assert.equal((w.second.gatewayData as Record<string, unknown>).providerStatus, 'refund_paid');
    held.release();
    const result = await manual;

    assert.equal(result.recorded, true);
    assert.equal(held.runs.count, 1, `the reversal ran ${held.runs.count} times`);
    assert.equal(refundEvents(w).operator.length, 1);
    assert.deepEqual(refundEvents(w).shared, []);
    const gatewayData = w.second.gatewayData as Record<string, unknown>;
    assert.equal(w.second.status, TransactionStatus.CANCELED);
    assert.equal(gatewayData.providerStatus, 'refund_paid', 'the provider’s word was written back to an older one');
    assert.equal('refundReversalClaimedAt' in gatewayData, false, 'the claim goes with the write that ends the run');
  });

  it('the provider’s notice, then «Отметить возврат» while it runs: the click is turned away, and the reversal runs once', async () => {
    const w = world({ gatewayType: PaymentGatewayType.CRYPTOMUS });
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const held = holdFirstRun(w);

    const notice = w.notify('refund-1', { eventStatus: 'refund_paid', rawPayload: { status: 'refund_paid' } });
    await held.inside;
    await assert.rejects(
      w.refunds.recordWithheldRefund({ transactionId: 'tx-second', currentAdmin: OPERATOR, requestMetadata: REQUEST }),
      (error: unknown) => error instanceof ConflictException && error.message === 'PAYMENT_WITHHELD_REFUND_IN_PROGRESS',
    );
    assert.equal(w.audits.length, 0, 'a turned-away click writes nothing');
    held.release();
    await notice;

    assert.equal(held.runs.count, 1);
    assert.equal(refundEvents(w).operator.length, 1);
    assert.equal(w.second.status, TransactionStatus.CANCELED);
    assert.equal((w.second.gatewayData as Record<string, unknown>).providerStatus, 'refund_paid');
    // And once it is done, a click is told so.
    const again = await w.refunds.recordWithheldRefund({ transactionId: 'tx-second', currentAdmin: OPERATOR, requestMetadata: REQUEST });
    assert.equal(again.recorded, false);
  });

  it('an ordinary payment: the panel’s refund and its own notice reverse it once, ending with the newest word', async () => {
    // R4 laterList 2: the panel's ЮKassa refund and its `refund.succeeded` both
    // found the total full and both reversed.
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const held = holdFirstRun(w);

    const panel = w.reconciliation.reverseFulfilledPayment({ ...w.first } as never, 'succeeded');
    await held.inside;
    await w.reconciliation.reverseFulfilledPayment({ ...w.first } as never, 'REFUNDED');
    held.release();
    await panel;

    assert.equal(held.runs.count, 1, `the reversal ran ${held.runs.count} times`);
    assert.deepEqual(refundEvents(w).shared.map((event) => event.type), ['payment.refunded']);
    assert.equal(w.first.status, TransactionStatus.CANCELED);
    assert.equal((w.first.gatewayData as Record<string, unknown>).providerStatus, 'REFUNDED');
  });

  it('takes over a claim left by a run that died before its end', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    const stale = new Date(Date.now() - REFUND_REVERSAL_CLAIM_MS - 1000).toISOString();
    Object.assign(w.first, { gatewayData: { refundReversalClaimedAt: stale } });

    await w.reconciliation.reverseFulfilledPayment({ ...w.first } as never, 'CHARGEBACKED');

    assert.equal(w.first.status, TransactionStatus.CANCELED);
    assert.deepEqual(refundEvents(w).shared.map((event) => event.type), ['payment.refunded']);
    // A fresh claim, on the other hand, is a run under way: nothing more is run.
    const other = world();
    await other.reconciliation.reconcileWebhookEvent('event-1');
    Object.assign(other.first, { gatewayData: { refundReversalClaimedAt: new Date().toISOString() } });
    await other.reconciliation.reverseFulfilledPayment({ ...other.first } as never, 'CHARGEBACKED');
    assert.equal(other.first.status, TransactionStatus.COMPLETED);
    assert.deepEqual(refundEvents(other).shared, []);
  });
});

describe('a withheld payment paid again after its refund', () => {
  it('is told to the operator alone, as the withheld payment it is', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    await w.refunds.recordWithheldRefund({
      transactionId: 'tx-second',
      currentAdmin: { id: 'admin-1' } as CurrentAdminInterface,
      requestMetadata: { requestId: 'request-1', remoteAddress: '203.0.113.5', userAgent: 'spec' },
    });

    await w.notify('paid-again', { eventStatus: 'CONFIRMED', rawPayload: { status: 'CONFIRMED' } });

    const again = w.events.filter((event) => event.metadata.paidAfterRefund === true);
    assert.deepEqual(again.map((event) => event.type), ['payment.withheld']);
    assert.equal(again[0]?.metadata.conversionWithheld, true);
    assert.ok(OPERATOR_ONLY_EVENT_TYPES.has('payment.withheld'));
    assert.equal(w.second.status, TransactionStatus.CANCELED, 'a refunded payment is not revived');
  });

  it('stays a mismatch for an ordinary payment', async () => {
    const w = world();
    await w.reconciliation.reconcileWebhookEvent('event-1');
    await w.reconciliation.reverseFulfilledPayment({ ...w.first } as never, 'CHARGEBACKED');

    await w.notify('paid-again', { eventStatus: 'CONFIRMED', rawPayload: { status: 'CONFIRMED' }, paymentId: 'payment-first' });

    const again = w.events.filter((event) => event.metadata.paidAfterRefund === true);
    assert.deepEqual(again.map((event) => event.type), ['payment.amount_mismatch']);
    assert.equal(again[0]?.metadata.conversionWithheld, undefined);
  });
});

/**
 * A client for `PlanReferenceGuardService.countReferences` that holds only
 * `transactions`: its two `transaction.count` shapes are evaluated on them, and
 * every other model is empty.
 */
function countingClient(transactions: readonly Record<string, unknown>[]): never {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(condition as Record<string, unknown>[]).some((part) => matches(row, part))) return false;
        continue;
      }
      if (key === 'planSnapshot') {
        const { path, equals } = condition as { path: string[]; equals: unknown };
        let value: unknown = row.planSnapshot;
        for (const segment of path) value = (value as Record<string, unknown> | null)?.[segment];
        if (value !== equals) return false;
        continue;
      }
      if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
        const operators = condition as { in?: unknown[]; gt?: Date };
        if (operators.in !== undefined && !operators.in.includes(row[key])) return false;
        if (operators.gt !== undefined && !((row[key] as Date) > operators.gt)) return false;
        continue;
      }
      if (row[key] !== condition) return false;
    }
    return true;
  };
  const empty = new Proxy(
    {},
    {
      get: (_target, method) =>
        async () => (method === 'count' ? 0 : method === 'findFirst' || method === 'findUnique' ? null : []),
    },
  );
  return new Proxy(
    {},
    {
      get: (_target, model) =>
        model === 'transaction'
          ? {
              count: async ({ where }: { where: Record<string, unknown> }) =>
                transactions.filter((row) => matches(row, where)).length,
            }
          : empty,
    },
  ) as never;
}
