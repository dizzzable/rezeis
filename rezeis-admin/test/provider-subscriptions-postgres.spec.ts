import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import { Currency, PaymentGatewayType, Prisma, ProviderSubscriptionStatus } from '@prisma/client';
import { from, of, throwError } from 'rxjs';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PAYMENT_RECONCILIATION_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentWebhookInboxService } from '../src/modules/payments/services/payment-webhook-inbox.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import { SavedPaymentMethodService } from '../src/modules/payments/services/saved-payment-method.service';
import {
  ProviderSubscriptionService,
  STRANDED_SWEEP_PAGE,
} from '../src/modules/payments/services/provider-subscription.service';
import { REFUND_CANCELLED_BY } from '../src/modules/payments/utils/refund-autopay.util';

/**
 * `provider_subscriptions` (migration `20260919210000_provider_subscriptions`)
 * on PostgreSQL.
 *
 * The one property the code cannot check by itself: deleting an account keeps
 * the row and empties its user key (`ON DELETE SET NULL`). The row is the only
 * record that the provider still charges someone; with a cascade it vanished
 * with the account and the sweep had nothing left to cancel. And the provider's
 * id is unique per gateway, which is what makes a lost write safe to redo.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `psub-${process.pid}-${Date.now()}`;

let prisma: PrismaService;

function row(userId: string, providerSubscriptionId: string): Prisma.ProviderSubscriptionUncheckedCreateInput {
  return {
    userId,
    gatewayType: PaymentGatewayType.PLATEGA,
    providerSubscriptionId,
    status: ProviderSubscriptionStatus.ACTIVE,
    planId: `${prefix}-plan`,
    durationDays: 30,
    amount: new Prisma.Decimal('299'),
    currency: Currency.RUB,
    intervalUnit: 'month',
    intervalCount: 1,
    firstTransactionId: `${providerSubscriptionId}-first`,
    consentVersion: 'provider-subscription-v1',
  };
}

run('provider_subscriptions on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.providerSubscription.deleteMany({ where: { providerSubscriptionId: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.$disconnect();
  });

  it('sweeps every live row: a stranded one behind more than a page it cannot change is still cancelled', async () => {
    // The sweep read the oldest 500 once, and the oldest are the rows that stay.
    // Every row here is older than anything else in the table, and all share one
    // instant, so the page boundary falls inside one `createdAt` and only the id
    // carries the cursor past it.
    mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'log', () => undefined);
    const userId = `${prefix}-blocked`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId, isBlocked: true } });
    const createdAt = new Date('2020-01-01T00:00:00.000Z');
    const stuckCount = STRANDED_SWEEP_PAGE + 20;
    await prisma.providerSubscription.createMany({
      data: Array.from({ length: stuckCount }, (_, index) => {
        const id = `${prefix}-a-stuck-${String(index).padStart(4, '0')}`;
        return { ...row(userId, id), id, createdAt };
      }),
    });
    const lastId = `${prefix}-z-last`;
    await prisma.providerSubscription.create({ data: { ...row(userId, lastId), id: lastId, createdAt } });

    // The provider refuses the stuck ones for good; the gateway row is the
    // only thing not read from PostgreSQL.
    const client = new Proxy(prisma, {
      get: (target, property) =>
        property === 'paymentGateway'
          ? { findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }) }
          : Reflect.get(target, property, target),
    });
    const http = {
      post: (url: string) =>
        url.includes('-a-stuck-') ? throwError(() => new Error('provider refused')) : of({ data: { status: 'cancelled' } }),
    };
    const service = new ProviderSubscriptionService(client as never, http as never, {} as never, {} as never);

    await service.cancelStranded();
    mock.restoreAll();

    const last = await prisma.providerSubscription.findUniqueOrThrow({ where: { id: lastId } });
    assert.equal(last.status, ProviderSubscriptionStatus.CANCELLED, 'the row behind the stuck ones was never reached');
    assert.equal(last.cancelledBy, 'SYSTEM');
    assert.equal(
      await prisma.providerSubscription.count({
        where: { id: { startsWith: `${prefix}-a-stuck-` }, status: ProviderSubscriptionStatus.ACTIVE },
      }),
      stuckCount,
    );
  });

  it('keeps the row, without its user, when the account is deleted', async () => {
    const userId = `${prefix}-user`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    const created = await prisma.providerSubscription.create({ data: row(userId, `${prefix}-sub-1`) });

    await prisma.user.delete({ where: { id: userId } });

    const kept = await prisma.providerSubscription.findUnique({ where: { id: created.id } });
    assert.notEqual(kept, null);
    assert.equal(kept?.userId, null);
    assert.equal(kept?.status, ProviderSubscriptionStatus.ACTIVE);
  });

  it('holds one row per provider id on a gateway', async () => {
    const userId = `${prefix}-user-2`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    await prisma.providerSubscription.create({ data: row(userId, `${prefix}-sub-2`) });
    await assert.rejects(
      prisma.providerSubscription.create({
        data: { ...row(userId, `${prefix}-sub-2`), firstTransactionId: `${prefix}-another-first` },
      }),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
    );
    await prisma.user.delete({ where: { id: userId } });
  });
});

/**
 * «все возвраты … удаляют автосписания» (wave 6), on PostgreSQL, through the
 * real reconciliation, fulfilment, refund and provider-subscription services;
 * only the provider's HTTP, the queue and the post-payment hooks are stand-ins.
 *
 * What the database has to prove: the rows a refund ends are found by the
 * queries as written (a subscription's rows, a new purchase's unbound sign-up,
 * an autopay charge's line), the refund's mark lands under the reversal's row
 * lock, and a charge the provider takes after the refund is withheld instead of
 * renewing — and reviving — the refunded subscription.
 */
run('a refund ends the autopay, on PostgreSQL', () => {
  const autopayPrefix = `${prefix}-ra`;
  let db: PrismaService;
  let reconciliation: PaymentReconciliationService;
  let refunds: PaymentRefundService;
  let providerSubscriptions: ProviderSubscriptionService;
  let mutation: PaymentSubscriptionMutationService;
  let savedMethods: SavedPaymentMethodService;
  const events: Array<{ severity: string; type: string; metadata: Record<string, unknown> }> = [];
  const jobs: Array<{ name: string; data: Record<string, unknown> }> = [];
  const cancelCalls: string[] = [];
  const hooks = { partner: [] as string[] };
  const provider = {
    chargesSuccess: 1,
    /** What Platega's GET says the subscription is. */
    status: 'ACTIVE',
    /** Platega's API is down: every GET fails. */
    down: false,
    refuseCancel: new Set<string>(),
    /** Set: the cancel is answered only when this settles. */
    cancelAnswered: null as Promise<void> | null,
  };
  const created = { users: [] as string[], plans: [] as string[], admins: [] as string[] };
  let counter = 0;
  const next = (): number => ++counter;

  async function createUser(): Promise<string> {
    const id = `${autopayPrefix}-user-${next()}`;
    await db.user.create({ data: { id, referralCode: `${id}-ref`, name: id } });
    created.users.push(id);
    return id;
  }

  async function createPlan(): Promise<string> {
    const id = `${autopayPrefix}-plan-${next()}`;
    await db.plan.create({
      data: {
        id,
        name: id,
        orderIndex: 300_000 + next(),
        trafficLimit: 100,
        deviceLimit: 3,
        internalSquads: [],
        externalSquad: null,
        trafficLimitStrategy: 'NO_RESET',
        durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
      },
    });
    created.plans.push(id);
    return id;
  }

  async function createSubscription(userId: string, planId: string): Promise<{ id: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
    const subscription = await db.subscription.create({
      data: {
        userId,
        status: 'ACTIVE',
        planSnapshot: { id: planId, name: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
        trafficLimit: 100,
        deviceLimit: 3,
        internalSquads: [],
        externalSquad: null,
        startedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });
    return { id: subscription.id, expiresAt: subscription.expiresAt! };
  }

  /** A payment fulfilled a while ago. */
  async function paid(input: {
    readonly userId: string;
    readonly subscriptionId: string;
    readonly planId: string;
    readonly gatewayType: PaymentGatewayType;
    readonly purchaseType?: 'NEW' | 'RENEW';
    readonly gatewayId?: string;
  }) {
    return db.transaction.create({
      data: {
        paymentId: `${autopayPrefix}-pay-${next()}`,
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        status: 'COMPLETED',
        purchaseType: input.purchaseType ?? 'NEW',
        channel: 'WEB',
        gatewayType: input.gatewayType,
        ...(input.gatewayId === undefined ? {} : { gatewayId: input.gatewayId }),
        currency: 'RUB',
        amount: new Prisma.Decimal('299'),
        planSnapshot: { id: input.planId, name: input.planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
        fulfilledAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
  }

  /** A Platega autopay, charged once, renewing `subscriptionId`. */
  async function autopay(input: {
    readonly userId: string;
    readonly subscriptionId: string | null;
    readonly planId: string;
    readonly firstTransactionId: string;
  }) {
    const providerSubscriptionId = `${autopayPrefix}-sub-${next()}`;
    return db.providerSubscription.create({
      data: {
        userId: input.userId,
        gatewayType: PaymentGatewayType.PLATEGA,
        providerSubscriptionId,
        status: ProviderSubscriptionStatus.ACTIVE,
        subscriptionId: input.subscriptionId,
        planId: input.planId,
        durationDays: 30,
        amount: new Prisma.Decimal('299'),
        currency: Currency.RUB,
        intervalUnit: 'month',
        intervalCount: 1,
        firstTransactionId: input.firstTransactionId,
        appliedChargeCount: 1,
        consentVersion: 'provider-subscription-v1',
      },
    });
  }

  /** A provider notice for `paymentId`, stored and reconciled the way the worker does it. */
  async function notify(paymentId: string, gatewayType: PaymentGatewayType, eventStatus: string, rawPayload: Prisma.InputJsonValue) {
    const event = await db.paymentWebhookEvent.create({
      data: { gatewayType, paymentId, providerEventId: `${autopayPrefix}-evt-${next()}`, eventStatus, rawPayload },
      select: { id: true },
    });
    await reconciliation.reconcileWebhookEvent(event.id);
    return event.id;
  }

  /** Runs every reconciliation job the provider-subscription service queued, in order. */
  async function drainReconciliationJobs(): Promise<void> {
    for (const job of jobs.splice(0)) {
      if (job.name === PAYMENT_RECONCILIATION_JOB) await reconciliation.reconcileWebhookEvent(String(job.data['eventId']));
    }
  }

  const cardFor = (paymentId: string) =>
    events.find(
      (event) =>
        ['payment.refunded', 'payment.refund_partial', 'payment.withheld_refunded'].includes(event.type) &&
        event.metadata['paymentId'] === paymentId,
    );

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    db = new PrismaService();
    await db.$connect();
    mock.method(Logger.prototype, 'log', () => undefined);
    mock.method(Logger.prototype, 'warn', () => undefined);
    mock.method(Logger.prototype, 'error', () => undefined);

    const record =
      (severity: string) =>
      (type: string, _category: string, _message: string, metadata: Record<string, unknown> = {}) => {
        events.push({ severity, type, metadata });
      };
    const systemEvents = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR'), emit: () => undefined };
    // The gateways' own rows are the installation's: the ones these services ask for are stand-ins.
    const client = new Proxy(db, {
      get: (target, property) =>
        property === 'paymentGateway'
          ? {
              findUnique: async ({ where }: { where: { type: PaymentGatewayType } }) =>
                where.type === PaymentGatewayType.YOOKASSA
                  ? { type: PaymentGatewayType.YOOKASSA, isActive: true, settings: { shopId: 'shop-1', secretKey: 'test_key-1' } }
                  : { type: where.type, isActive: true, settings: { merchantId: 'm-1', secret: 's-1' } },
            }
          : Reflect.get(target, property, target),
    });
    const http = {
      get: () =>
        provider.down
          ? throwError(() => new Error('Platega is not answering'))
          : of({ data: { status: provider.status, chargeMetrics: { chargesSuccess: provider.chargesSuccess } } }),
      post: (url: string) => {
        if (url.includes('api.yookassa.ru')) {
          return of({ status: 200, data: { id: `yk-refund-${next()}`, status: 'succeeded' } });
        }
        cancelCalls.push(url);
        if ([...provider.refuseCancel].some((id) => url.includes(`/subscription/${id}/cancel`))) {
          return throwError(() => new Error('provider unreachable'));
        }
        return provider.cancelAnswered === null
          ? of({ data: { status: 'cancelled' } })
          : from(provider.cancelAnswered.then(() => ({ data: { status: 'cancelled' } })));
      },
    };
    const queue = {
      add: async (name: string, data: Record<string, unknown>) => {
        jobs.push({ name, data });
      },
    };
    const inbox = new PaymentWebhookInboxService(db);
    savedMethods = new SavedPaymentMethodService(db, systemEvents as never);
    providerSubscriptions = new ProviderSubscriptionService(
      client as never,
      http as never,
      inbox,
      queue as never,
      systemEvents as never,
      savedMethods,
    );
    mutation = new PaymentSubscriptionMutationService(
      db,
      systemEvents as never,
      new AddOnEntitlementService(),
      new EffectiveProjectionService(),
      new SubscriptionTermService(),
      {} as never,
    );
    reconciliation = new PaymentReconciliationService(
      db,
      inbox,
      mutation,
      { notifyWebhookFailed: async () => undefined } as never,
      {
        processPartnerEarning: async (input: { readonly sourceTransactionId: string }) => {
          hooks.partner.push(input.sourceTransactionId);
        },
        reverseEarningsForTransaction: async () => 0,
      } as never,
      {
        qualifyReferralAfterPurchase: async () => null,
        reverseQualificationForTransaction: async () => undefined,
      } as never,
      { enqueue: async () => undefined } as never,
      systemEvents as never,
      { enqueueRegisterIncome: async () => undefined, enqueueCancelIncome: async () => undefined } as never,
      { recordFirstPurchase: async () => undefined, revertConversion: async () => undefined } as never,
      savedMethods,
      { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
      {
        creditForTransactionBestEffort: async () => null,
        reverseForTransactionBestEffort: async () => undefined,
      } as never,
      { create: async () => undefined } as never,
      providerSubscriptions,
    );
    refunds = new PaymentRefundService(client as never, http as never, new PaymentWebhookPayloadRedactionService(), reconciliation);
  });

  after(async () => {
    mock.restoreAll();
    if (db === undefined) return;
    const users = created.users;
    await db.adminAuditLog.deleteMany({ where: { adminUserId: { in: created.admins } } });
    await db.adminUser.deleteMany({ where: { id: { in: created.admins } } });
    await db.providerSubscription.deleteMany({ where: { providerSubscriptionId: { startsWith: autopayPrefix } } });
    await db.paymentWebhookEvent.deleteMany({ where: { providerEventId: { startsWith: autopayPrefix } } });
    await db.paymentWebhookEvent.deleteMany({ where: { providerEventId: { startsWith: `subscription:${autopayPrefix}` } } });
    await db.profileSyncJob.deleteMany({ where: { subscription: { userId: { in: users } } } });
    await db.subscriptionTerm.deleteMany({ where: { subscription: { userId: { in: users } } } });
    await db.transaction.deleteMany({ where: { userId: { in: users } } });
    await db.subscription.deleteMany({ where: { userId: { in: users } } });
    await db.plan.deleteMany({ where: { id: { in: created.plans } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  it('a provider’s refund notice: the autopay is cancelled at once, and the card says so', async () => {
    const userId = await createUser();
    const planId = await createPlan();
    const subscription = await createSubscription(userId, planId);
    const bought = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA });
    const row = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: bought.id });

    await notify(bought.paymentId, PaymentGatewayType.PLATEGA, 'CHARGEBACKED', { status: 'CHARGEBACKED' });

    const ended = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(ended.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(ended.cancelledBy, REFUND_CANCELLED_BY);
    assert.ok(cancelCalls.some((url) => url.endsWith(`/subscription/${row.providerSubscriptionId}/cancel`)));
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: bought.id } })).status, 'CANCELED');
    assert.equal(cardFor(bought.paymentId)?.metadata['note'], 'Автосписание отменено: Platega.');
  });

  it('the panel’s ЮKassa refund, in full or in part: every autopay of the subscription ends', async () => {
    for (const amount of [null, '100.00'] as const) {
      const userId = await createUser();
      const planId = await createPlan();
      const subscription = await createSubscription(userId, planId);
      const bought = await paid({
        userId,
        subscriptionId: subscription.id,
        planId,
        gatewayType: PaymentGatewayType.YOOKASSA,
        gatewayId: `yk-${next()}`,
      });
      // The renewal the customer signed up for later, through Platega.
      const renewal = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA, purchaseType: 'RENEW' });
      const row = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: renewal.id });
      const admin = await db.adminUser.create({
        data: { login: `${autopayPrefix}-admin-${next()}`, loginNormalized: `${autopayPrefix}-admin-${counter}`, passwordHash: 'not-a-hash' },
      });
      created.admins.push(admin.id);

      await refunds.refundTransaction({
        transactionId: bought.id,
        amount,
        reason: null,
        currentAdmin: { id: admin.id } as never,
        requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
      });
      // The provider is asked after the operator's answer.
      await reconciliation.settleAfterResponse();

      const ended = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(ended.status, ProviderSubscriptionStatus.CANCELLED, `a ${amount === null ? 'full' : 'partial'} refund`);
      assert.equal(ended.cancelledBy, REFUND_CANCELLED_BY);
      const refunded = await db.transaction.findUniqueOrThrow({ where: { id: bought.id } });
      assert.equal(refunded.status, amount === null ? 'CANCELED' : 'COMPLETED');
    }
  });

  it('a provider that cannot be reached: the refund completes, the card says what to do, and the sweep ends it later', async () => {
    const userId = await createUser();
    const planId = await createPlan();
    const subscription = await createSubscription(userId, planId);
    const bought = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA });
    const row = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: bought.id });
    provider.refuseCancel.add(row.providerSubscriptionId);

    await notify(bought.paymentId, PaymentGatewayType.PLATEGA, 'CHARGEBACKED', { status: 'CHARGEBACKED' });

    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: bought.id } })).status, 'CANCELED');
    const pendingCancel = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(pendingCancel.status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(pendingCancel.cancelledBy, REFUND_CANCELLED_BY);
    assert.match(String(cardFor(bought.paymentId)?.metadata['note']), /Автосписание у Platega отменить не удалось/);

    provider.refuseCancel.delete(row.providerSubscriptionId);
    await providerSubscriptions.cancelStranded();

    const ended = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(ended.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(ended.cancelledBy, REFUND_CANCELLED_BY);
  });

  it('a Platega chargeback on a subscription charged once: reversed and the autopay cancelled', async () => {
    const userId = await createUser();
    const planId = await createPlan();
    const subscription = await createSubscription(userId, planId);
    const bought = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA });
    const row = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: bought.id });
    provider.chargesSuccess = 1;

    await providerSubscriptions.handleChargeback(PaymentGatewayType.PLATEGA, row.providerSubscriptionId, {
      providerPaymentId: `pl-${next()}`,
      providerStatus: 'CHARGEBACKED',
    });
    await drainReconciliationJobs();

    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: bought.id } })).status, 'CANCELED');
    const ended = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(ended.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(ended.cancelledBy, REFUND_CANCELLED_BY);
  });

  it('a charge the provider takes after the refund renews nothing: withheld for refund, the subscription stays as the refund left it', async () => {
    const userId = await createUser();
    const planId = await createPlan();
    const subscription = await createSubscription(userId, planId);
    const bought = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA });
    const row = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: bought.id });
    await notify(bought.paymentId, PaymentGatewayType.PLATEGA, 'CHARGEBACKED', { status: 'CHARGEBACKED' });
    const refundedState = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(refundedState.status, 'EXPIRED', 'the refund took the new purchase back');

    // The provider did not take the cancel in time, and charges the next period.
    provider.chargesSuccess = 2;
    await providerSubscriptions.sync(PaymentGatewayType.PLATEGA, row.providerSubscriptionId);
    await drainReconciliationJobs();

    const charge = await db.transaction.findFirstOrThrow({
      where: { userId, idempotencyKey: `provider-subscription:${row.id}:charge:2` },
    });
    assert.equal(charge.status, 'COMPLETED');
    assert.ok(charge.fulfilledAt !== null, 'settled, not left for a retry');
    const gatewayData = charge.gatewayData as Record<string, unknown>;
    assert.equal(typeof gatewayData['conversionWithheldAt'], 'string');
    assert.equal(gatewayData['withheldReason'], 'AUTOPAY_AFTER_REFUND');
    const after = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(after.status, refundedState.status, 'the refunded subscription was not revived');
    assert.equal(after.expiresAt?.getTime(), refundedState.expiresAt?.getTime());
    const notice = events.find((event) => event.type === 'payment.withheld' && event.metadata['paymentId'] === charge.paymentId);
    assert.equal(notice?.metadata['withheldReason'], 'AUTOPAY_AFTER_REFUND');
    assert.ok(!hooks.partner.includes(charge.id), 'no commission on money that goes back');

    // Fulfilled once more — a retry after a crash between the withhold and
    // its acknowledgement: the operator is not told twice (R5 H3).
    await mutation.applyCompletedTransaction(await db.transaction.findUniqueOrThrow({ where: { id: charge.id } }));
    assert.equal(
      events.filter((event) => event.type === 'payment.withheld' && event.metadata['paymentId'] === charge.paymentId).length,
      1,
      'a withheld charge was announced twice',
    );
  });

  it('«Отметить возврат» on a withheld conversion ends its own sign-up and leaves the converter’s autopay', async () => {
    const userId = await createUser();
    const planId = await createPlan();
    const subscription = await createSubscription(userId, planId);
    const converter = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA });
    const converterRow = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: converter.id });
    const withheld = await db.transaction.create({
      data: {
        paymentId: `${autopayPrefix}-pay-${next()}`,
        userId,
        subscriptionId: subscription.id,
        status: 'COMPLETED',
        purchaseType: 'UPGRADE',
        channel: 'WEB',
        gatewayType: PaymentGatewayType.PLATEGA,
        currency: 'RUB',
        amount: new Prisma.Decimal('299'),
        planSnapshot: { id: planId, selectedDurationDays: 30, convertsTrial: true } as Prisma.InputJsonValue,
        gatewayData: {
          conversionWithheldAt: new Date().toISOString(),
          trialConvertedByPaymentId: converter.paymentId,
        } as Prisma.InputJsonValue,
        fulfilledAt: new Date(),
      },
    });
    const withheldRow = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: withheld.id });
    const admin = await db.adminUser.create({
      data: { login: `${autopayPrefix}-admin-${next()}`, loginNormalized: `${autopayPrefix}-admin-${counter}`, passwordHash: 'not-a-hash' },
    });
    created.admins.push(admin.id);

    await refunds.recordWithheldRefund({
      transactionId: withheld.id,
      currentAdmin: { id: admin.id } as never,
      requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
    });
    await reconciliation.settleAfterResponse();

    assert.equal((await db.providerSubscription.findUniqueOrThrow({ where: { id: withheldRow.id } })).status, ProviderSubscriptionStatus.CANCELLED);
    const standing = await db.providerSubscription.findUniqueOrThrow({ where: { id: converterRow.id } });
    assert.equal(standing.status, ProviderSubscriptionStatus.ACTIVE);
    assert.equal(standing.cancelledBy, null);
  });

  it('the panel’s refund, in full or in part, answers before a provider that hangs: the autopay is marked first, and the card follows the provider (R5 F3)', async () => {
    for (const amount of [null, '100.00'] as const) {
      const userId = await createUser();
      const planId = await createPlan();
      const subscription = await createSubscription(userId, planId);
      const bought = await paid({
        userId,
        subscriptionId: subscription.id,
        planId,
        gatewayType: PaymentGatewayType.YOOKASSA,
        gatewayId: `yk-${next()}`,
      });
      const renewal = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA, purchaseType: 'RENEW' });
      const row = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: renewal.id });
      const admin = await db.adminUser.create({
        data: { login: `${autopayPrefix}-admin-${next()}`, loginNormalized: `${autopayPrefix}-admin-${counter}`, passwordHash: 'not-a-hash' },
      });
      created.admins.push(admin.id);
      const kind = amount === null ? 'a full refund' : 'a partial refund';
      let release: () => void = () => undefined;
      provider.cancelAnswered = new Promise<void>((resolve) => {
        release = resolve;
      });
      let timer: NodeJS.Timeout | undefined;

      try {
        const answered = await Promise.race([
          refunds
            .refundTransaction({
              transactionId: bought.id,
              amount,
              reason: null,
              currentAdmin: { id: admin.id } as never,
              requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
            })
            .then(() => 'answered'),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('waited for the provider'), 5000);
          }),
        ]);
        clearTimeout(timer);

        assert.equal(answered, 'answered', kind);
        const marked = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
        assert.equal(marked.status, ProviderSubscriptionStatus.ACTIVE, `${kind}: the provider has not answered yet`);
        assert.equal(marked.cancelledBy, REFUND_CANCELLED_BY, `${kind}: the autopay was not marked before the answer`);
        assert.equal(cardFor(bought.paymentId), undefined, `${kind}: the card went out before the provider said what it did`);
      } finally {
        release();
        provider.cancelAnswered = null;
        await reconciliation.settleAfterResponse();
      }

      const ended = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(ended.status, ProviderSubscriptionStatus.CANCELLED, kind);
      assert.equal(ended.cancelledBy, REFUND_CANCELLED_BY);
      if (amount === null) {
        assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: bought.id } })).status, 'CANCELED');
        assert.equal(cardFor(bought.paymentId)?.metadata['note'], 'Автосписание отменено: Platega.');
      }
    }
  });

  it('a refund’s cancel the operator finishes in Platega’s dashboard keeps the refund’s mark: a charge taken before it is withheld (R5 F1)', async () => {
    const userId = await createUser();
    const planId = await createPlan();
    const subscription = await createSubscription(userId, planId);
    const bought = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA });
    const row = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: bought.id });
    provider.chargesSuccess = 1;
    provider.refuseCancel.add(row.providerSubscriptionId);
    await notify(bought.paymentId, PaymentGatewayType.PLATEGA, 'CHARGEBACKED', { status: 'CHARGEBACKED' });
    provider.refuseCancel.delete(row.providerSubscriptionId);
    const refundedState = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

    // The card said to cancel at the provider, and the operator did; Platega
    // had charged the next period before that. Its callback says so.
    provider.status = 'CANCELLED';
    provider.chargesSuccess = 2;
    try {
      await providerSubscriptions.sync(PaymentGatewayType.PLATEGA, row.providerSubscriptionId);
      await drainReconciliationJobs();
    } finally {
      provider.status = 'ACTIVE';
    }

    const ended = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(ended.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(ended.cancelledBy, REFUND_CANCELLED_BY, `the refund's mark was written over with ${ended.cancelledBy}`);
    const charge = await db.transaction.findFirstOrThrow({
      where: { userId, idempotencyKey: `provider-subscription:${row.id}:charge:2` },
    });
    assert.equal((charge.gatewayData as Record<string, unknown>)['withheldReason'], 'AUTOPAY_AFTER_REFUND');
    const after = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(after.status, refundedState.status, 'the refunded subscription was renewed');
    assert.equal(after.expiresAt?.getTime(), refundedState.expiresAt?.getTime());
  });

  it('a dispute that comes while Platega’s API is down is kept FAILED, not dropped, and its retry reverses the charge (R5 F6)', async () => {
    const userId = await createUser();
    const planId = await createPlan();
    const subscription = await createSubscription(userId, planId);
    const bought = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.PLATEGA });
    const row = await autopay({ userId, subscriptionId: subscription.id, planId, firstTransactionId: bought.id });
    provider.chargesSuccess = 1;
    const body = { Id: `pl-${next()}`, SubscriptionId: row.providerSubscriptionId, Amount: 299, Status: 'CHARGEBACKED' };
    const dispute = { providerPaymentId: body.Id, providerStatus: 'CHARGEBACKED' };

    provider.down = true;
    try {
      const recorded = await providerSubscriptions.recordDispute(PaymentGatewayType.PLATEGA, row.providerSubscriptionId, dispute, body);
      assert.equal(recorded.duplicate, false);
      await assert.rejects(drainReconciliationJobs(), /Platega is not answering/);
    } finally {
      provider.down = false;
    }
    const kept = await db.paymentWebhookEvent.findFirstOrThrow({
      where: { providerEventId: `subscription:${row.providerSubscriptionId}:dispute-callback:${body.Id}` },
    });
    assert.equal(kept.status, 'FAILED', 'the dispute is kept for the retry and counted on the dashboard');
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: bought.id } })).status, 'COMPLETED');
    // Platega repeating the callback is the same event: nothing more is queued.
    const repeated = await providerSubscriptions.recordDispute(PaymentGatewayType.PLATEGA, row.providerSubscriptionId, dispute, body);
    assert.equal(repeated.duplicate, true);
    assert.deepEqual(jobs, []);

    // The auto-retry, or «Платежи» → «Вебхуки» → «Повторить».
    await reconciliation.reconcileWebhookEvent(kept.id);
    await drainReconciliationJobs();

    assert.equal((await db.paymentWebhookEvent.findUniqueOrThrow({ where: { id: kept.id } })).status, 'PROCESSED');
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: bought.id } })).status, 'CANCELED');
    const ended = await db.providerSubscription.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(ended.status, ProviderSubscriptionStatus.CANCELLED);
    assert.equal(ended.cancelledBy, REFUND_CANCELLED_BY);
  });

  it('a refund switches off the ЮKassa saved-card autopay: the next renewal charges nothing; a withheld payment’s refund leaves it on (the owner, 23.09.2026)', async () => {
    const renewalsCharged: string[] = [];
    const autoRenew = new AutoRenewService(
      db,
      {} as never,
      {
        renewalCheckout: async (input: { readonly subscriptionIds: readonly string[] }) => {
          renewalsCharged.push(...input.subscriptionIds);
          return { transactionStatus: 'PENDING', paymentId: `${autopayPrefix}-renewal-${next()}`, checkoutUrl: null };
        },
      } as never,
      savedMethods,
      {} as never,
      { requiresPlanSelection: async () => false } as never,
      { info: () => undefined, warn: () => undefined } as never,
    );
    /** A customer with a saved ЮKassa card, autopay on, and a subscription it is about to renew. */
    async function cardHolder() {
      const userId = await createUser();
      const planId = await createPlan();
      const bought = await createSubscription(userId, planId);
      const renewing = await db.subscription.create({
        data: {
          userId,
          status: 'ACTIVE',
          planSnapshot: { id: planId, name: planId, selectedDurationDays: 30 } as Prisma.InputJsonValue,
          trafficLimit: 100,
          deviceLimit: 3,
          internalSquads: [],
          externalSquad: null,
          startedAt: new Date(Date.now() - 27 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() + 3 * 60 * 1000),
        },
        select: { id: true },
      });
      await db.savedPaymentMethod.create({
        data: {
          userId,
          gatewayType: PaymentGatewayType.YOOKASSA,
          providerMethodId: `${autopayPrefix}-pm-${next()}`,
          methodType: 'bank_card',
          cardLast4: '4242',
        },
      });
      return { userId, planId, bought, renewing };
    }

    // An ordinary purchase's chargeback: a refund like any other.
    const refunded = await cardHolder();
    const sale = await paid({
      userId: refunded.userId,
      subscriptionId: refunded.bought.id,
      planId: refunded.planId,
      gatewayType: PaymentGatewayType.PLATEGA,
    });
    await notify(sale.paymentId, PaymentGatewayType.PLATEGA, 'CHARGEBACKED', { status: 'CHARGEBACKED' });

    // A withheld payment's refund: it bought nothing, and the autopay of what the customer did buy stands.
    const kept = await cardHolder();
    const converter = await paid({
      userId: kept.userId,
      subscriptionId: kept.bought.id,
      planId: kept.planId,
      gatewayType: PaymentGatewayType.PLATEGA,
    });
    const withheld = await db.transaction.create({
      data: {
        paymentId: `${autopayPrefix}-pay-${next()}`,
        userId: kept.userId,
        subscriptionId: kept.bought.id,
        status: 'COMPLETED',
        purchaseType: 'UPGRADE',
        channel: 'WEB',
        gatewayType: PaymentGatewayType.PLATEGA,
        currency: 'RUB',
        amount: new Prisma.Decimal('299'),
        planSnapshot: { id: kept.planId, selectedDurationDays: 30, convertsTrial: true } as Prisma.InputJsonValue,
        gatewayData: {
          conversionWithheldAt: new Date().toISOString(),
          trialConvertedByPaymentId: converter.paymentId,
        } as Prisma.InputJsonValue,
        fulfilledAt: new Date(),
      },
    });
    const admin = await db.adminUser.create({
      data: { login: `${autopayPrefix}-admin-${next()}`, loginNormalized: `${autopayPrefix}-admin-${counter}`, passwordHash: 'not-a-hash' },
    });
    created.admins.push(admin.id);
    await refunds.recordWithheldRefund({
      transactionId: withheld.id,
      currentAdmin: { id: admin.id } as never,
      requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
    });
    await reconciliation.settleAfterResponse();

    await autoRenew.processAutopayCharges();

    assert.equal(renewalsCharged.includes(refunded.renewing.id), false, 'the renewal charged the card of a refunded customer');
    assert.equal(renewalsCharged.includes(kept.renewing.id), true, 'the withheld refund switched the autopay off');
    const card = await db.savedPaymentMethod.findFirstOrThrow({ where: { userId: refunded.userId } });
    assert.equal(card.autopayEnabled, false);
    assert.equal(card.isActive, true, 'the card itself stays saved');
    assert.match(String(cardFor(sale.paymentId)?.metadata['note']), /Автосписание через ЮKassa выключено\./);
    // Told by the refund's card alone: not as the customer's own switch, which
    // rules, outbound webhooks and the email bridge act on (R6 m5).
    assert.deepEqual(
      events.filter(
        (event) => event.type === 'payment.method_autopay_updated' && event.metadata['userId'] === refunded.userId,
      ),
      [],
    );
  });

  it('the request does not wait for a charge that holds the card, and the switch after the answer does — stamping the payment with it', async () => {
    const userId = await createUser();
    const planId = await createPlan();
    const subscription = await createSubscription(userId, planId);
    const refunded = await paid({ userId, subscriptionId: subscription.id, planId, gatewayType: PaymentGatewayType.YOOKASSA });
    const method = await db.savedPaymentMethod.create({
      data: {
        userId,
        gatewayType: PaymentGatewayType.YOOKASSA,
        providerMethodId: `${autopayPrefix}-pm-${next()}`,
        methodType: 'bank_card',
      },
    });
    // An off-session charge of this card being submitted to ЮKassa: it holds
    // the card's lock (`withActiveForCharge`) for as long as ЮKassa takes.
    let letGo: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const charge = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "saved_payment_methods" WHERE "id" = ${method.id} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    await holding;

    try {
      const inRequest = await savedMethods.disableAutopayForRefund({
        userId,
        transactionId: refunded.id,
        waitForCharges: false,
      });
      assert.deepEqual(inRequest, { switched: 0, busy: 1 });
      assert.equal((await db.savedPaymentMethod.findUniqueOrThrow({ where: { id: method.id } })).autopayEnabled, true);
      const unstamped = (await db.transaction.findUniqueOrThrow({ where: { id: refunded.id } })).gatewayData;
      assert.equal((unstamped as Record<string, unknown> | null)?.['refundSavedCardAutopayOffAt'], undefined);

      const afterAnswer = savedMethods.disableAutopayForRefund({ userId, transactionId: refunded.id, waitForCharges: true });
      letGo();
      assert.deepEqual(await afterAnswer, { switched: 1, busy: 0 });
    } finally {
      letGo();
      await charge;
    }
    const card = await db.savedPaymentMethod.findUniqueOrThrow({ where: { id: method.id } });
    assert.equal(card.autopayEnabled, false);
    assert.equal(card.isActive, true);
    // Stamped with the switch, so another door of the same refund that finds
    // nothing left to switch still says it is off (R6 m3).
    const stamped = (await db.transaction.findUniqueOrThrow({ where: { id: refunded.id } })).gatewayData;
    assert.equal(typeof (stamped as Record<string, unknown>)['refundSavedCardAutopayOffAt'], 'string');
  });
});
