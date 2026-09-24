import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';
import { PaymentGatewayType, PaymentWebhookLifecycleStatus, Prisma, TransactionStatus, UserRole } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../src/modules/auth/interfaces/request-metadata.interface';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentWebhookInboxService } from '../src/modules/payments/services/payment-webhook-inbox.service';
import { PlanReferenceGuardService } from '../src/modules/plans/services/plan-reference-guard.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { ADD_ON_ROLLOUT_FLAG_NAMES } from './helpers/rollout-flags';

/**
 * A trial's conversion paid after another payment converted the trial, on
 * PostgreSQL, through the real reconciliation, fulfilment, webhook inbox and
 * plan deletion guard.
 *
 * It used to throw out of fulfilment. What that left, and what each check
 * below now reads instead:
 *   - the notification FAILED — the dashboard counts every FAILED one as
 *     CRITICAL, and a replay failed again;
 *   - the payment COMPLETED without `fulfilledAt` — counted by the plan
 *     deletion guard as unsettled, for ever;
 *   - no «Платёж получен»; the only other trace, the webhook-failure alert, is
 *     off by default.
 * And a trial that a plan migration made regular — no payment converted it —
 * was refused too, so its payer paid and got nothing; it is converted again.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `wcv-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Emitted {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

let prisma: PrismaService;
let reconciliation: PaymentReconciliationService;
let refunds: PaymentRefundService;
const events: Emitted[] = [];
const hooks = { referral: [] as string[], partner: [] as string[], cashback: [] as string[], ads: [] as string[], webhookFailedAlerts: [] as string[] };
const created = { plans: [] as string[], users: [] as string[], paymentIds: [] as string[], admins: [] as string[] };
let counter = 0;
const next = (): number => ++counter;

async function createPlan(): Promise<string> {
  const id = `${prefix}-plan-${next()}`;
  await prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 200_000 + next(),
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      trafficLimitStrategy: 'NO_RESET',
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '199' }] } }] },
    },
  });
  created.plans.push(id);
  return id;
}

async function createUser(): Promise<string> {
  const id = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: id } });
  created.users.push(id);
  return id;
}

/** A subscription that is no longer a trial: on `planId`, expiring in 20 days. */
async function createConvertedSubscription(userId: string, planId: string): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + 20 * DAY_MS);
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: 'ACTIVE',
      isTrial: false,
      planSnapshot: { id: planId, name: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: `${prefix}-rw-${next()}`,
      startedAt: new Date(Date.now() - 10 * DAY_MS),
      expiresAt,
    },
    select: { id: true, expiresAt: true },
  });
  return { id: subscription.id, expiresAt: subscription.expiresAt! };
}

/** A trial conversion's UPGRADE: drafted while the subscription was a trial. */
async function createConversion(input: {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly planId: string;
  readonly status: TransactionStatus;
  readonly fulfilledAt?: Date;
  readonly gatewayType?: PaymentGatewayType;
}) {
  const paymentId = `${prefix}-pay-${next()}`;
  created.paymentIds.push(paymentId);
  return prisma.transaction.create({
    data: {
      paymentId,
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      status: input.status,
      purchaseType: 'UPGRADE',
      channel: 'WEB',
      gatewayType: input.gatewayType ?? PaymentGatewayType.PLATEGA,
      currency: 'RUB',
      amount: new Prisma.Decimal('199'),
      planSnapshot: { id: input.planId, selectedDurationDays: 30, convertsTrial: true } as Prisma.InputJsonValue,
      ...(input.fulfilledAt === undefined ? {} : { fulfilledAt: input.fulfilledAt }),
    },
  });
}

/** A provider success notification for `paymentId`, reconciled the way the worker does it. */
async function deliverSuccess(paymentId: string, gatewayType: PaymentGatewayType = PaymentGatewayType.PLATEGA): Promise<string> {
  return deliver(paymentId, gatewayType, 'PAID', {});
}

/** A provider notification for `paymentId`, stored and reconciled the way the worker does it. */
async function deliver(
  paymentId: string,
  gatewayType: PaymentGatewayType,
  eventStatus: string,
  rawPayload: Prisma.InputJsonValue,
): Promise<string> {
  const event = await prisma.paymentWebhookEvent.create({
    data: {
      gatewayType,
      paymentId,
      providerEventId: `${prefix}-evt-${next()}`,
      eventStatus,
      rawPayload,
    },
    select: { id: true },
  });
  await reconciliation.reconcileWebhookEvent(event.id);
  return event.id;
}

function raisedFor(type: string, paymentId: string): Emitted[] {
  return events.filter((event) => event.type === type && event.metadata['paymentId'] === paymentId);
}

function completionsFor(paymentId: string): Emitted[] {
  return raisedFor(EVENT_TYPES.PAYMENT_COMPLETED, paymentId);
}

function withheldNoticesFor(paymentId: string): Emitted[] {
  return raisedFor(EVENT_TYPES.PAYMENT_WITHHELD, paymentId);
}

const OPERATOR: CurrentAdminInterface = {
  id: '',
  login: 'operator',
  email: null,
  name: 'Operator',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};
const REQUEST: RequestMetadataInterface = { requestId: 'request-1', remoteAddress: '203.0.113.5', userAgent: 'spec' };

/**
 * Twice. With every `ADDON_*` stage OFF: the legacy path, and where an install
 * stands after switching the durable model off (rollback). And on the shipped
 * defaults (stages 1, 2 and 6 ON, 24.09.2026), where the conversion that IS
 * applied brings its subscription into the term model on the way.
 */
for (const stages of ['off (rollback)', 'as shipped'] as const) {
  run(`a trial conversion paid after another payment converted the trial, on PostgreSQL — stages ${stages}`, () => {
    const savedFlags = new Map<string, string | undefined>();
    before(() => {
      for (const name of ADD_ON_ROLLOUT_FLAG_NAMES) {
        savedFlags.set(name, process.env[name]);
        if (stages === 'as shipped') delete process.env[name];
        else process.env[name] = 'false';
      }
    });
    after(() => {
      for (const [name, value] of savedFlags) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    before(async () => {
      process.env.DATABASE_URL = testUrl;
      process.env.DATABASE_POOL_SIZE = '4';
      prisma = new PrismaService();
      await prisma.$connect();

      const record =
        (severity: Emitted['severity']) =>
        (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
          events.push({ severity, type, message, metadata });
        };
      const systemEvents = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR'), emit: () => undefined };
      const mutation = new PaymentSubscriptionMutationService(
        prisma,
        systemEvents as never,
        new AddOnEntitlementService(),
        new EffectiveProjectionService(),
        new SubscriptionTermService(),
        {} as never,
      );
      reconciliation = new PaymentReconciliationService(
        prisma,
        new PaymentWebhookInboxService(prisma),
        mutation,
        {
          notifyWebhookFailed: async (input: { readonly event: { readonly id: string } }) => {
            hooks.webhookFailedAlerts.push(input.event.id);
          },
        } as never,
        {
          processPartnerEarning: async (input: { readonly sourceTransactionId: string }) => {
            hooks.partner.push(input.sourceTransactionId);
          },
          reverseEarningsForTransaction: async () => 0,
        } as never,
        {
          qualifyReferralAfterPurchase: async (transactionId: string) => {
            hooks.referral.push(transactionId);
            return null;
          },
          reverseQualificationForTransaction: async () => undefined,
        } as never,
        { enqueue: async () => undefined } as never,
        systemEvents as never,
        { enqueueRegisterIncome: async () => undefined, enqueueCancelIncome: async () => undefined } as never,
        {
          recordFirstPurchase: async (input: { readonly id: string }) => {
            hooks.ads.push(input.id);
          },
          revertConversion: async () => undefined,
        } as never,
        { upsertFromYookassaPayment: async () => undefined, disableAutopayForProviderMethod: async () => undefined } as never,
        { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
        {
          creditForTransactionBestEffort: async (transaction: { readonly id: string }) => {
            hooks.cashback.push(transaction.id);
            return null;
          },
          reverseForTransactionBestEffort: async () => undefined,
        } as never,
        { create: async () => undefined } as never,
      );
      // Nothing reaches a provider when a withheld refund is recorded: no HTTP
      // client, no payload redaction.
      refunds = new PaymentRefundService(prisma, {} as never, {} as never, reconciliation);
    });

    after(async () => {
      if (prisma === undefined) return;
      await prisma.adminAuditLog.deleteMany({ where: { adminUserId: { in: created.admins } } });
      await prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } });
      await prisma.paymentWebhookEvent.deleteMany({ where: { paymentId: { in: created.paymentIds } } });
      // Terms, projections and the rest of the term model's rows go in the order
      // their foreign keys allow; sync jobs go with their subscriptions (cascade).
      await removeDurableFixtures(prisma, created.users);
      await prisma.plan.deleteMany({ where: { id: { in: created.plans } } });
      await prisma.$disconnect();
    });

    it('is processed, settled and withheld; its plan can be deleted; the dashboard has no failure for it', async () => {
      const planId = await createPlan();
      const userId = await createUser();
      const subscription = await createConvertedSubscription(userId, planId);
      const first = await createConversion({
        userId,
        subscriptionId: subscription.id,
        planId,
        status: TransactionStatus.COMPLETED,
        fulfilledAt: new Date(Date.now() - 5 * 60 * 1000),
      });
      const second = await createConversion({
        userId,
        subscriptionId: subscription.id,
        planId,
        status: TransactionStatus.PENDING,
      });
      const untouched = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

      const eventId = await deliverSuccess(second.paymentId);

      // 1. The notification is processed, not failed: nothing for the dashboard's
      //    «failed payment webhook(s)» (it counts FAILED, `dashboard.service.ts`).
      const event = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(event.status, PaymentWebhookLifecycleStatus.PROCESSED);
      assert.equal(
        await prisma.paymentWebhookEvent.count({
          where: { status: PaymentWebhookLifecycleStatus.FAILED, paymentId: second.paymentId },
        }),
        0,
      );
      assert.deepEqual(hooks.webhookFailedAlerts, []);

      // 2. The payment is settled — nothing keeps its plan from being deleted.
      const settled = await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } });
      assert.equal(settled.status, TransactionStatus.COMPLETED);
      assert.ok(settled.fulfilledAt !== null);
      const gatewayData = settled.gatewayData as Record<string, unknown>;
      assert.equal(typeof gatewayData['conversionWithheldAt'], 'string');
      assert.equal(gatewayData['trialConvertedByPaymentId'], first.paymentId);
      const counts = await new PlanReferenceGuardService(prisma).countReferences([planId]);
      assert.equal(counts.get(planId)?.unsettledPayments, 0);

      // 3. Applied to nothing, paid out on nothing; the operator told once.
      const current = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      assert.equal(current.expiresAt?.getTime(), untouched.expiresAt?.getTime());
      assert.deepEqual(current.planSnapshot, untouched.planSnapshot);
      for (const list of [hooks.partner, hooks.referral, hooks.cashback, hooks.ads]) {
        assert.equal(list.includes(second.id), false);
      }
      // Never announced as a completed sale; the operator's notice is its own type.
      assert.deepEqual(completionsFor(second.paymentId), []);
      const notices = withheldNoticesFor(second.paymentId);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.severity, 'WARNING');
      assert.equal(notices[0]!.metadata['trialConvertedByPaymentId'], first.paymentId);
      assert.match(String(notices[0]!.metadata['note']), /Верните деньги у платёжного провайдера \(PLATEGA\)/);

      // A replay changes nothing and says nothing again.
      const replayId = await deliverSuccess(second.paymentId);
      assert.equal(
        (await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: replayId } })).status,
        PaymentWebhookLifecycleStatus.PROCESSED,
      );
      assert.equal(withheldNoticesFor(second.paymentId).length, 1);
      assert.deepEqual(completionsFor(second.paymentId), []);
      assert.deepEqual(
        await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } }),
        settled,
      );
    });

    it('converts a trial that a plan migration made regular — no payment converted it — as before', async () => {
      const planId = await createPlan();
      const userId = await createUser();
      const subscription = await createConvertedSubscription(userId, planId);
      const conversion = await createConversion({
        userId,
        subscriptionId: subscription.id,
        planId,
        status: TransactionStatus.PENDING,
      });

      await deliverSuccess(conversion.paymentId);

      const applied = await prisma.transaction.findUniqueOrThrow({ where: { id: conversion.id } });
      assert.equal(applied.status, TransactionStatus.COMPLETED);
      assert.ok(applied.fulfilledAt !== null);
      assert.equal('conversionWithheldAt' in ((applied.gatewayData as Record<string, unknown> | null) ?? {}), false);
      const upgraded = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      assert.equal(
        Math.round(((upgraded.expiresAt?.getTime() ?? 0) - Date.now()) / DAY_MS),
        30,
        'the payer gets the term they paid for',
      );
      // Which half this is: as shipped, the applied conversion brought the
      // subscription into the term model on the way; with the stages off it
      // stays on the legacy columns.
      assert.equal(
        (await prisma.subscriptionTerm.count({ where: { subscriptionId: subscription.id, status: 'ACTIVE' } })) > 0,
        stages === 'as shipped',
        `in the term model with the stages ${stages}`,
      );
      const completions = completionsFor(conversion.paymentId);
      assert.equal(completions.length, 1);
      assert.equal(completions[0]!.severity, 'INFO');
      assert.deepEqual(withheldNoticesFor(conversion.paymentId), []);
    });

    it('«Отметить возврат»: reverses a withheld payment once, attributed, and leaves the subscription alone', async () => {
      const planId = await createPlan();
      const userId = await createUser();
      const subscription = await createConvertedSubscription(userId, planId);
      const first = await createConversion({
        userId,
        subscriptionId: subscription.id,
        planId,
        status: TransactionStatus.COMPLETED,
        fulfilledAt: new Date(Date.now() - 5 * 60 * 1000),
      });
      const second = await createConversion({ userId, subscriptionId: subscription.id, planId, status: TransactionStatus.PENDING });
      await deliverSuccess(second.paymentId);
      const before = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      const admin = await prisma.adminUser.create({
        data: { login: `${prefix}-admin-${next()}`, loginNormalized: `${prefix}-admin-${counter}`, passwordHash: 'not-a-hash' },
      });
      created.admins.push(admin.id);
      const operator = { ...OPERATOR, id: admin.id };

      const recorded = await refunds.recordWithheldRefund({ transactionId: second.id, currentAdmin: operator, requestMetadata: REQUEST });

      assert.equal(recorded.recorded, true);
      const reversed = await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } });
      assert.equal(reversed.status, TransactionStatus.CANCELED);
      const gatewayData = reversed.gatewayData as Record<string, unknown>;
      assert.equal(typeof gatewayData['refundReversedAt'], 'string');
      assert.equal(recorded.refundedAt, gatewayData['refundReversedAt']);
      assert.equal(gatewayData['manualRefundRecordedBy'], admin.id);
      assert.equal(gatewayData['refundRevocationSkippedReason'], 'CONVERSION_NOT_APPLIED');
      // The withheld mark stays: the lists keep saying what the payment was.
      assert.equal(typeof gatewayData['conversionWithheldAt'], 'string');
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      assert.equal(after.status, before.status);
      assert.equal(after.expiresAt?.getTime(), before.expiresAt?.getTime());
      assert.deepEqual(after.planSnapshot, before.planSnapshot);
      assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: subscription.id } }), 0);
      const audit = await prisma.adminAuditLog.findMany({
        where: { action: 'payments.transaction.withheld_refund_recorded', adminUserId: admin.id },
      });
      assert.equal(audit.length, 1);
      assert.equal((audit[0]!.metadata as Record<string, unknown>)['transactionId'], second.id);
      assert.equal(raisedFor(EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED, second.paymentId).length, 1);
      assert.deepEqual(raisedFor(EVENT_TYPES.PAYMENT_REFUNDED, second.paymentId), [], 'the refund of a sale nobody was told about');

      // Again: nothing more — no second reversal, audit row or event.
      const again = await refunds.recordWithheldRefund({ transactionId: second.id, currentAdmin: operator, requestMetadata: REQUEST });
      assert.deepEqual(again, { transactionId: second.id, recorded: false, refundedAt: recorded.refundedAt });
      assert.deepEqual(await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } }), reversed);
      assert.equal(
        await prisma.adminAuditLog.count({ where: { action: 'payments.transaction.withheld_refund_recorded', adminUserId: admin.id } }),
        1,
      );
      assert.equal(raisedFor(EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED, second.paymentId).length, 1);
      assert.deepEqual(raisedFor(EVENT_TYPES.PAYMENT_REFUNDED, second.paymentId), [], 'the refund of a sale nobody was told about');

      // A provider's late refund notice for it changes nothing more.
      await deliver(second.paymentId, PaymentGatewayType.PLATEGA, 'CHARGEBACKED', { status: 'CHARGEBACKED' });
      assert.equal(raisedFor(EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED, second.paymentId).length, 1);
      assert.deepEqual(raisedFor(EVENT_TYPES.PAYMENT_REFUNDED, second.paymentId), []);

      // The payment that did convert the trial is refused, and stays as it was.
      const firstBefore = await prisma.transaction.findUniqueOrThrow({ where: { id: first.id } });
      await assert.rejects(
        refunds.recordWithheldRefund({ transactionId: first.id, currentAdmin: operator, requestMetadata: REQUEST }),
        (error: unknown) => error instanceof ConflictException && error.message === 'PAYMENT_NOT_WITHHELD',
      );
      assert.deepEqual(await prisma.transaction.findUniqueOrThrow({ where: { id: first.id } }), firstBefore);
    });

    it("a provider's refund notice for a withheld payment reverses it, and tells the operator alone", async () => {
      // Cryptomus reports a completed refund as `refund_paid`, with no amount.
      const planId = await createPlan();
      const userId = await createUser();
      const subscription = await createConvertedSubscription(userId, planId);
      await createConversion({
        userId,
        subscriptionId: subscription.id,
        planId,
        status: TransactionStatus.COMPLETED,
        fulfilledAt: new Date(Date.now() - 5 * 60 * 1000),
        gatewayType: PaymentGatewayType.CRYPTOMUS,
      });
      const second = await createConversion({
        userId,
        subscriptionId: subscription.id,
        planId,
        status: TransactionStatus.PENDING,
        gatewayType: PaymentGatewayType.CRYPTOMUS,
      });
      await deliverSuccess(second.paymentId, PaymentGatewayType.CRYPTOMUS);
      assert.equal(withheldNoticesFor(second.paymentId).length, 1);
      const before = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

      const eventId = await deliver(second.paymentId, PaymentGatewayType.CRYPTOMUS, 'refund_paid', { status: 'refund_paid' });

      assert.equal(
        (await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: eventId } })).status,
        PaymentWebhookLifecycleStatus.PROCESSED,
      );
      const refunded = await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } });
      assert.equal(refunded.status, TransactionStatus.CANCELED);
      assert.equal(typeof (refunded.gatewayData as Record<string, unknown>)['refundReversedAt'], 'string');
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      assert.equal(after.expiresAt?.getTime(), before.expiresAt?.getTime());
      assert.deepEqual(after.planSnapshot, before.planSnapshot);
      const told = raisedFor(EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED, second.paymentId);
      assert.equal(told.length, 1);
      assert.equal(told[0]!.metadata['conversionWithheld'], true);
      assert.deepEqual(raisedFor(EVENT_TYPES.PAYMENT_REFUNDED, second.paymentId), []);
      assert.deepEqual(raisedFor(EVENT_TYPES.PAYMENT_REFUND_PARTIAL, second.paymentId), []);
    });
  });
}
