import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import { AddOnEntitlementActorType, AddOnLifetime, AddOnType, Currency, PaymentGatewayType, Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { GIB_BYTES } from '../src/modules/add-on-entitlements/domain/cutover-baseline';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { describeDurableRows } from '../src/modules/add-on-entitlements/services/cutover-disposal.util';
import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import {
  ADDON_REFUND_ENDED_AT_KEY,
  ADDON_REFUND_REBASED_TERM,
  ADDON_REFUNDED_SUMMARY,
  AddOnRefundService,
} from '../src/modules/payments/services/addon-refund.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentWebhookInboxService } from '../src/modules/payments/services/payment-webhook-inbox.service';
import { SavedPaymentMethodService } from '../src/modules/payments/services/saved-payment-method.service';

/**
 * «Возврат денег за докупку заканчивает её сразу» (the owner, 24.09.2026) — on
 * PostgreSQL, through two of the doors into the one reversal: the operator's
 * «Отметить возврат» and a provider's chargeback notice. A durable add-on is
 * reversed and the projection pushed; a legacy one comes off the column, never
 * below the plan. And the days an upgrade converted a refunded payment into
 * are named on the card.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `addonrefund-${process.pid}-${Date.now()}`;

run('an add-on refund ends the add-on, on PostgreSQL', () => {
  let db: PrismaService;
  let reconciliation: PaymentReconciliationService;
  let refunds: PaymentRefundService;
  let addOnRefunds: AddOnRefundService;
  let boundary: EntitlementBoundaryService;
  let scheduler: EntitlementBoundarySchedulerService;
  const created = { users: [] as string[], admins: [] as string[] };
  const events: Array<{ readonly type: string; readonly metadata: Record<string, unknown> }> = [];
  const enqueued: string[] = [];
  const planned: string[] = [];
  const executed: string[] = [];
  /** What the refund's own run of the device planner answers; a case that needs another answer sets it. */
  const PLANNED = async (subscriptionId: string): Promise<unknown> => ({
    status: 'PLANNED',
    planId: `plan-${subscriptionId}`,
    targetCount: 2,
  });
  let planOutcome: (subscriptionId: string) => Promise<unknown> = PLANNED;
  let counter = 0;
  const next = (): number => {
    counter += 1;
    return counter;
  };

  const cardFor = (paymentId: string) =>
    events.find((event) => event.type === 'payment.refunded' && event.metadata['paymentId'] === paymentId);

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    db = new PrismaService();
    await db.$connect();
    mock.method(Logger.prototype, 'warn', () => undefined);
    mock.method(Logger.prototype, 'log', () => undefined);
    const record = (type: string, _category: string, _message: string, metadata: Record<string, unknown> = {}) => {
      events.push({ type, metadata });
    };
    const systemEvents = { info: record, warn: record, error: record, emit: () => undefined };
    const syncQueue = {
      enqueue: async (jobId: string) => {
        enqueued.push(jobId);
      },
    };
    addOnRefunds = new AddOnRefundService(
      db,
      new AddOnEntitlementService(),
      new EffectiveProjectionService(),
      syncQueue as never,
      {
        planForSubscription: async (subscriptionId: string) => {
          planned.push(subscriptionId);
          return planOutcome(subscriptionId);
        },
      } as never,
      {
        executePlan: async (planId: string) => {
          executed.push(planId);
          return { status: 'APPLIED', deleted: 2 };
        },
      } as never,
    );
    const mutation = new PaymentSubscriptionMutationService(
      db,
      systemEvents as never,
      new AddOnEntitlementService(),
      new EffectiveProjectionService(),
      new SubscriptionTermService(),
      {} as never,
    );
    reconciliation = new PaymentReconciliationService(
      db,
      new PaymentWebhookInboxService(db),
      mutation,
      { notifyWebhookFailed: async () => undefined } as never,
      { reverseEarningsForTransaction: async () => 0 } as never,
      { reverseQualificationForTransaction: async () => undefined } as never,
      syncQueue as never,
      systemEvents as never,
      { enqueueCancelIncome: async () => undefined } as never,
      { revertConversion: async () => undefined } as never,
      new SavedPaymentMethodService(db, systemEvents as never),
      { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
      { reverseForTransactionBestEffort: async () => undefined } as never,
      { create: async () => undefined } as never,
      undefined,
      addOnRefunds,
    );
    // «Отметить возврат» sends nothing to a provider: no HTTP client, no redaction.
    refunds = new PaymentRefundService(db, {} as never, {} as never, reconciliation);
    const terms = new SubscriptionTermService();
    boundary = new EntitlementBoundaryService(db, new AddOnEntitlementService(), terms, new EffectiveProjectionService());
    // The regular sweep, with the real planner: a subscription with no panel
    // profile has nothing to reduce, so no panel is needed to finish one.
    scheduler = new EntitlementBoundarySchedulerService(
      db,
      boundary,
      syncQueue as never,
      new DeviceReductionPlanService(db, {} as never),
      {} as never,
      terms,
    );
  });

  after(async () => {
    mock.restoreAll();
    if (db === undefined) return;
    const users = created.users;
    const subscriptions = (await db.subscription.findMany({ where: { userId: { in: users } }, select: { id: true } })).map(
      (row) => row.id,
    );
    const inSubscriptions = { subscriptionId: { in: subscriptions } };
    await db.adminAuditLog.deleteMany({ where: { adminUserId: { in: created.admins } } });
    await db.adminUser.deleteMany({ where: { id: { in: created.admins } } });
    await db.entitlementIncident.deleteMany({ where: inSubscriptions });
    await db.addOnEntitlementEvent.deleteMany({ where: { entitlement: inSubscriptions } });
    await db.addOnEntitlement.deleteMany({ where: inSubscriptions });
    await db.subscriptionEffectiveProjection.deleteMany({ where: inSubscriptions });
    await db.subscriptionTerm.deleteMany({ where: inSubscriptions });
    await db.profileSyncJob.deleteMany({ where: inSubscriptions });
    await db.transaction.deleteMany({ where: { userId: { in: users } } });
    await db.subscription.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  async function customer(limits: {
    readonly deviceLimit: number;
    readonly trafficLimit: number | null;
    /** No panel profile linked: the device planner has nothing to reduce. */
    readonly unlinked?: boolean;
  }) {
    const userId = `${prefix}-user-${next()}`;
    await db.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    created.users.push(userId);
    const subscription = await db.subscription.create({
      data: {
        userId,
        status: 'ACTIVE',
        // The plan: 3 devices, 100 GB — what a refund never goes below.
        planSnapshot: { id: `${prefix}-plan`, name: 'Pro', deviceLimit: 3, trafficLimit: 100 } as Prisma.InputJsonValue,
        deviceLimit: limits.deviceLimit,
        trafficLimit: limits.trafficLimit,
        remnawaveId: limits.unlinked === true ? null : `${prefix}-rw-${counter}`,
        startedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
      },
      select: { id: true, expiresAt: true },
    });
    return { userId, subscriptionId: subscription.id, expiresAt: subscription.expiresAt! };
  }

  async function addOnPayment(input: {
    readonly userId: string;
    readonly subscriptionId: string;
    readonly type: AddOnType;
    readonly value: number;
  }) {
    return db.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        status: 'COMPLETED',
        purchaseType: 'ADDITIONAL',
        channel: 'WEB',
        gatewayType: PaymentGatewayType.PLATEGA,
        currency: Currency.RUB,
        amount: new Prisma.Decimal('99'),
        planSnapshot: {
          snapshotSource: 'ADDON_PURCHASE',
          addOnId: `${prefix}-addon`,
          addOnType: input.type,
          addOnValue: input.value,
          targetSubscriptionId: input.subscriptionId,
          name: 'Extra',
          lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
          sourceLineKey: 'direct',
        } as Prisma.InputJsonValue,
        // Bought a while ago: a durable add-on starts when it was paid for,
        // and its end can never be at or before its start.
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        fulfilledAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
  }

  async function operator(): Promise<{ readonly id: string }> {
    const admin = await db.adminUser.create({
      data: { login: `${prefix}-admin-${next()}`, loginNormalized: `${prefix}-admin-${counter}`, passwordHash: 'not-a-hash' },
    });
    created.admins.push(admin.id);
    return admin;
  }

  /** «Отметить возврат», as the operator presses it, and the work after the answer. */
  async function recordRefund(transactionId: string): Promise<void> {
    const admin = await operator();
    await refunds.recordProviderRefund({
      transactionId,
      currentAdmin: { id: admin.id } as never,
      requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
    });
    await reconciliation.settleAfterResponse();
  }

  /** The ACTIVE term of a subscription in the model: 100 GB and `devices` in its base, to the subscription's end. */
  async function activeTermOf(
    owner: { readonly subscriptionId: string; readonly expiresAt: Date },
    devices = 3,
  ) {
    return db.subscriptionTerm.create({
      data: {
        subscriptionId: owner.subscriptionId,
        generation: 1,
        status: 'ACTIVE',
        planSnapshot: { id: `${prefix}-plan` } as Prisma.InputJsonValue,
        startsAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        endsAt: owner.expiresAt,
        baseTrafficLimitBytes: 100n * GIB_BYTES,
        baseDeviceLimit: devices,
        trafficResetStrategy: 'NO_RESET',
      },
    });
  }

  /** A paid add-on as the durable direct purchase records it: ACTIVE on the term, projected, mirrored. */
  async function durableAddOn(
    owner: { readonly userId: string; readonly subscriptionId: string; readonly expiresAt: Date },
    termId: string,
    type: AddOnType,
    value: number,
  ) {
    const payment = await addOnPayment({ userId: owner.userId, subscriptionId: owner.subscriptionId, type, value });
    const entitlements = new AddOnEntitlementService();
    const entitlementId = await db.$transaction(async (tx) => {
      const pending = await entitlements.createPendingInTransaction(tx, {
        subscriptionId: owner.subscriptionId,
        termId,
        sourceTransactionId: payment.id,
        sourceLineKey: 'direct',
        // No catalog row: the entitlement's own snapshot is what a refund reads.
        addOnId: null,
        catalogRevision: 1,
        receiptName: 'Extra',
        type,
        valuePerUnit: value,
        totalValue: type === AddOnType.EXTRA_TRAFFIC ? BigInt(value) * GIB_BYTES : BigInt(value),
        lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
        applicabilitySnapshot: {},
        unitAmount: payment.amount,
        totalAmount: payment.amount,
        currency: Currency.RUB,
        purchasedAt: payment.createdAt,
        scheduledActivationAt: payment.createdAt,
        expiresAt: owner.expiresAt,
        expiryEpochId: null,
        correlationId: `payment:${payment.paymentId}`,
      });
      await entitlements.transitionInTransaction(tx, {
        entitlementId: pending.entitlementId,
        command: 'ACTIVATE',
        commandKey: `activate:${pending.entitlementId}`,
        correlationId: `payment:${payment.paymentId}`,
        actorType: AddOnEntitlementActorType.SYSTEM,
        reason: 'DIRECT_PURCHASE_ACTIVATION',
      });
      const projection = await new EffectiveProjectionService().recomputeInTransaction(tx, {
        subscriptionId: owner.subscriptionId,
        mode: 'ACTIVE',
      });
      await tx.subscription.update({
        where: { id: owner.subscriptionId },
        data: {
          deviceLimit: projection.desiredDeviceLimit ?? 0,
          trafficLimit: projection.desiredTrafficLimitBytes === null ? null : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
        },
      });
      return pending.entitlementId;
    });
    return { payment, entitlementId };
  }

  /** The PostgreSQL backends `pid` holds a lock over, until one appears or `ms` pass. */
  async function waitUntilBlockedBy(pid: number, ms = 5_000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const [row] = await db.$queryRaw<Array<{ readonly n: number }>>(
        Prisma.sql`SELECT count(*)::int AS "n" FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`,
      );
      if ((row?.n ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it('«Отметить возврат» on a durable device add-on: ended, the projection pushed, the extra devices reduced, the card says so', async () => {
    const saved = process.env.ADDON_DEVICE_CLEANUP_AUTO;
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'true';
    try {
      const owner = await customer({ deviceLimit: 3, trafficLimit: 100 });
      const { subscriptionId } = owner;
      const term = await activeTermOf(owner);
      const { payment, entitlementId } = await durableAddOn(owner, term.id, AddOnType.EXTRA_DEVICES, 2);
      assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).deviceLimit, 5, 'the purchase did not land');

      await recordRefund(payment.id);

      // In the regular reduction queue: due now, and out of the projection.
      const entitlement = await db.addOnEntitlement.findUniqueOrThrow({ where: { id: entitlementId } });
      assert.equal(entitlement.state, 'EXPIRING');
      assert.ok(entitlement.expiresAt !== null && entitlement.expiresAt.getTime() <= Date.now(), 'not due at once');
      const incident = await db.entitlementIncident.findFirst({ where: { entitlementId } });
      assert.equal(incident?.summaryCode, ADDON_REFUNDED_SUMMARY, 'the refund is not recorded on the add-on');
      assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).deviceLimit, 3);
      const projection = await db.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId } });
      assert.equal(projection.desiredDeviceLimit, 3);
      const push = await db.profileSyncJob.findFirst({ where: { subscriptionId, cause: 'ADDON_REFUND' } });
      assert.ok(push !== null, 'the lowered limit is never pushed');
      assert.ok(enqueued.includes(push.id));
      assert.deepEqual(planned, [subscriptionId], 'the extra devices are never reduced');
      assert.deepEqual(executed, [`plan-${subscriptionId}`]);
      const card = cardFor(payment.paymentId);
      assert.equal(card?.metadata['note'], 'Докупка «+2 устройства» отключена. Лишние устройства удалены: 2.');
      assert.equal(card?.metadata['needsManualReview'], false);
      assert.equal(card?.metadata['addOnType'], AddOnType.EXTRA_DEVICES);
      assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: payment.id } })).status, 'CANCELED');

      // What the real executor does once the devices are gone: it completes
      // the reduction — and a refunded add-on ends as the refund it is.
      await boundary.completeVerifiedDeviceExpiryForSubscription(subscriptionId, projection.desiredRevision);
      const done = await db.addOnEntitlement.findUniqueOrThrow({ where: { id: entitlementId } });
      assert.equal(done.state, 'REVERSED', 'EXPIRED would tell the customer it ran out');
      assert.equal(done.terminalReason, ADDON_REFUNDED_SUMMARY);
    } finally {
      if (saved === undefined) delete process.env.ADDON_DEVICE_CLEANUP_AUTO;
      else process.env.ADDON_DEVICE_CLEANUP_AUTO = saved;
    }
  });

  it('a device reduction the panel could not do stays in the regular queue: the sweep finishes it, and the add-on ends REVERSED', async () => {
    const saved = process.env.ADDON_DEVICE_CLEANUP_AUTO;
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'true';
    // The refund's own run finds Remnawave unreachable.
    planOutcome = async () => ({ status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' });
    try {
      const owner = await customer({ deviceLimit: 3, trafficLimit: 100, unlinked: true });
      const term = await activeTermOf(owner);
      const { payment, entitlementId } = await durableAddOn(owner, term.id, AddOnType.EXTRA_DEVICES, 2);

      await recordRefund(payment.id);

      assert.equal(
        cardFor(payment.paymentId)?.metadata['note'],
        'Докупка «+2 устройства» отключена. Remnawave не ответила — лишние устройства панель удалит сама при следующей попытке, через 5 минут.',
      );
      const queued = await db.addOnEntitlement.findUniqueOrThrow({ where: { id: entitlementId } });
      assert.equal(queued.state, 'EXPIRING', 'REVERSED would have left the queue for good');
      // The customer is not told the add-on ran out: it was refunded.
      const notice = await db.addOnEntitlementEvent.findFirst({
        where: { entitlementId, commandKey: 'customer-notice:ended' },
      });
      assert.equal((notice?.metadata as Record<string, unknown> | undefined)?.['outcome'], 'refunded');

      // The next tick of the regular sweep takes it as it takes an expired add-on.
      await scheduler.runDueBoundaries();
      const done = await db.addOnEntitlement.findUniqueOrThrow({ where: { id: entitlementId } });
      assert.equal(done.state, 'REVERSED');
      assert.equal(done.terminalReason, ADDON_REFUNDED_SUMMARY);
    } finally {
      planOutcome = PLANNED;
      if (saved === undefined) delete process.env.ADDON_DEVICE_CLEANUP_AUTO;
      else process.env.ADDON_DEVICE_CLEANUP_AUTO = saved;
    }
  });

  it('a card sent before the device work finished — the panel stopping — says what happens to the devices', async () => {
    const saved = process.env.ADDON_DEVICE_CLEANUP_AUTO;
    // Stage 6 explicitly OFF: unset is ON since the 24.09.2026 flip.
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'false';
    let answer: (outcome: unknown) => void = () => undefined;
    planOutcome = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    try {
      const owner = await customer({ deviceLimit: 3, trafficLimit: 100 });
      const term = await activeTermOf(owner);
      const { payment } = await durableAddOn(owner, term.id, AddOnType.EXTRA_DEVICES, 2);
      const admin = await operator();

      await refunds.recordProviderRefund({
        transactionId: payment.id,
        currentAdmin: { id: admin.id } as never,
        requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
      });
      // The panel stops while the reduction is still asking Remnawave.
      await reconciliation.onModuleDestroy();

      // Then the autopay's own line about the stop, which is not this case's.
      const note = String(cardFor(payment.paymentId)?.metadata['note']);
      const devices =
        'Докупка «+2 устройства» отключена. Лишние устройства панель сама не удаляет: выключено ' +
        '«Удалять лишние устройства автоматически» («Доп. услуги» → вкладка «Настройки»). ' +
        'Чтобы удалить их, утвердите план: «Доп. услуги» → вкладка «Доставка» → «Открыть инспектор подписки» → ' +
        `«ID подписки»: ${owner.subscriptionId} → «Открыть» → впишите «Причина» → «Планы сокращения устройств» → ` +
        '«Утвердить» → «Утвердить и выполнить».';
      assert.ok(note.startsWith(devices), note);
    } finally {
      answer({ status: 'NOT_APPLICABLE', reason: 'STOPPED' });
      await reconciliation.settleAfterResponse();
      planOutcome = PLANNED;
      if (saved === undefined) delete process.env.ADDON_DEVICE_CLEANUP_AUTO;
      else process.env.ADDON_DEVICE_CLEANUP_AUTO = saved;
    }
  });

  it('a refund and the sweep expiring the same add-on take their locks in one order: neither is a deadlock victim', async () => {
    const owner = await customer({ deviceLimit: 3, trafficLimit: 100 });
    const term = await activeTermOf(owner);
    const { payment, entitlementId } = await durableAddOn(owner, term.id, AddOnType.EXTRA_TRAFFIC, 50);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sweepHolds: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      sweepHolds = resolve;
    });
    // The boundary sweep's order: the subscription row, then the add-on.
    const sweep = db.$transaction(
      async (tx) => {
        const [self] = await tx.$queryRaw<Array<{ readonly pid: number }>>(Prisma.sql`SELECT pg_backend_pid() AS "pid"`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${owner.subscriptionId} FOR UPDATE`);
        sweepHolds(self!.pid);
        await gate;
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "add_on_entitlements" WHERE "id" = ${entitlementId} FOR UPDATE`);
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    const sweepPid = await holding;
    try {
      const refunded = addOnRefunds.endForRefund(payment, 'REFUND');
      assert.equal(await waitUntilBlockedBy(sweepPid), true, 'the refund never reached the subscription lock');
      release();
      const [swept, ended] = await Promise.allSettled([sweep, refunded]);
      assert.equal(swept.status, 'fulfilled', 'the sweep was chosen as a deadlock victim');
      assert.equal(ended.status === 'fulfilled' ? ended.value?.ended : null, true, 'the refund was chosen as a deadlock victim');
      assert.equal((await db.addOnEntitlement.findUniqueOrThrow({ where: { id: entitlementId } })).state, 'REVERSED');
    } finally {
      release();
      await sweep.catch(() => undefined);
    }
  });

  it('a chargeback of a legacy traffic add-on: the column comes down by its value, is pushed, and a second run takes nothing more', async () => {
    // The plan's 100 GB, this add-on's 50 and another one's 50.
    const { userId, subscriptionId } = await customer({ deviceLimit: 3, trafficLimit: 200 });
    const payment = await addOnPayment({ userId, subscriptionId, type: AddOnType.EXTRA_TRAFFIC, value: 50 });
    const event = await db.paymentWebhookEvent.create({
      data: {
        gatewayType: PaymentGatewayType.PLATEGA,
        paymentId: payment.paymentId,
        providerEventId: `${prefix}-evt-${next()}`,
        eventStatus: 'CHARGEBACKED',
        rawPayload: { status: 'CHARGEBACKED' },
      },
      select: { id: true },
    });

    await reconciliation.reconcileWebhookEvent(event.id);
    await reconciliation.settleAfterResponse();
    await db.paymentWebhookEvent.delete({ where: { id: event.id } });

    assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).trafficLimit, 150);
    const refunded = await db.transaction.findUniqueOrThrow({ where: { id: payment.id } });
    const stamp = refunded.gatewayData as Record<string, unknown>;
    assert.equal(typeof stamp[ADDON_REFUND_ENDED_AT_KEY], 'string');
    assert.deepEqual(stamp['addOnRefundLimit'], { column: 'trafficLimit', from: 200, to: 150 });
    const pushes = await db.profileSyncJob.findMany({ where: { subscriptionId, cause: 'ADDON_REFUND' } });
    assert.equal(pushes.length, 1, 'the lowered limit is never pushed');
    const card = cardFor(payment.paymentId);
    assert.equal(card?.metadata['note'], 'Докупка «+50 ГБ» отключена.');
    assert.equal(card?.metadata['needsManualReview'], false);

    // The same refund again (a door that comes later): nothing more comes off.
    const again = await addOnRefunds.endForRefund(refunded, 'REFUND');
    assert.equal(again?.ended, true);
    assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).trafficLimit, 150);
    assert.equal((await db.profileSyncJob.count({ where: { subscriptionId, cause: 'ADDON_REFUND' } })), 1);
  });

  it('a legacy add-on inside the term’s base comes off it: the rest of the period is rotated onto a lowered base', async () => {
    // Bought before the term model: the background cutover minted the term's
    // base from the columns, add-on included (the owner, 24.09.2026, answer 1).
    const owner = await customer({ deviceLimit: 5, trafficLimit: 100 });
    const { userId, subscriptionId, expiresAt } = owner;
    const term = await activeTermOf(owner, 5);
    const payment = await addOnPayment({ userId, subscriptionId, type: AddOnType.EXTRA_DEVICES, value: 2 });

    await recordRefund(payment.id);

    assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).deviceLimit, 3);
    const projection = await db.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId } });
    assert.equal(projection.desiredDeviceLimit, 3, 'the panel is sent 5: the term kept the add-on');
    const terms = await db.subscriptionTerm.findMany({ where: { subscriptionId }, orderBy: { generation: 'asc' } });
    assert.deepEqual(
      terms.map((row) => [row.generation, row.status, row.baseDeviceLimit]),
      [
        [1, 'ENDED', 5],
        [2, 'ACTIVE', 3],
      ],
    );
    const rebased = terms[1]!;
    assert.equal(rebased.baseTrafficLimitBytes, 100n * GIB_BYTES, 'the other field keeps its base');
    assert.equal(rebased.endsAt?.getTime(), expiresAt.getTime(), 'the same period');
    assert.equal((rebased.planSnapshot as Record<string, unknown>)['snapshotSource'], ADDON_REFUND_REBASED_TERM);
    const card = cardFor(payment.paymentId);
    assert.equal(card?.metadata['note'], 'Докупка «+2 устройства» отключена.');
    assert.equal(card?.metadata['needsManualReview'], false);
    const stamp = (await db.transaction.findUniqueOrThrow({ where: { id: payment.id } })).gatewayData as Record<string, unknown>;
    assert.deepEqual(stamp['addOnRefundTermRebased'], { from: term.id, to: rebased.id });
    const push = await db.profileSyncJob.findFirst({ where: { subscriptionId, cause: 'ADDON_REFUND' } });
    assert.equal(push?.desiredRevision, projection.desiredRevision, 'the lowered limit is never pushed');
    // The rebase records no payment: a period the cutover minted, rebased by a
    // refund, can still go with a merged or deleted row (`NON_MONEY_TERM_SOURCES`).
    assert.equal((await describeDurableRows(db, subscriptionId)).paidTerms, 0, 'the refund’s rebase is not money');
  });

  it('a refund’s rebase of a PAID period leaves it paid: the term it replaced stays and is still counted', async () => {
    // A renewal already running when the grandfathered add-on is refunded.
    const owner = await customer({ deviceLimit: 5, trafficLimit: 100 });
    const { userId, subscriptionId } = owner;
    const term = await activeTermOf(owner, 5);
    await db.subscriptionTerm.update({
      where: { id: term.id },
      data: { generation: 2, planSnapshot: { id: `${prefix}-plan`, snapshotSource: 'RENEWAL_TERM' } },
    });
    const payment = await addOnPayment({ userId, subscriptionId, type: AddOnType.EXTRA_DEVICES, value: 2 });

    await recordRefund(payment.id);

    const terms = await db.subscriptionTerm.findMany({ where: { subscriptionId }, orderBy: { generation: 'asc' } });
    assert.deepEqual(
      terms.map((row) => [row.generation, row.status, (row.planSnapshot as Record<string, unknown>)['snapshotSource']]),
      [
        [2, 'ENDED', 'RENEWAL_TERM'],
        [3, 'ACTIVE', ADDON_REFUND_REBASED_TERM],
      ],
    );
    const described = await describeDurableRows(db, subscriptionId);
    assert.equal(described.paidTerms, 1, 'the paid renewal is still on the books');
    assert.equal(described.disposable, false, 'a merge or a deletion still refuses');
  });

  it('the rotation keeps a queued paid period after it, and never takes a live add-on’s share or goes below the plan', async () => {
    // The plan's 3 devices and the legacy add-on's 2 in the base; a durable
    // +1 bought since; a renewal already paid for and queued.
    const owner = await customer({ deviceLimit: 5, trafficLimit: 100 });
    const { userId, subscriptionId, expiresAt } = owner;
    const term = await activeTermOf(owner, 5);
    await durableAddOn(owner, term.id, AddOnType.EXTRA_DEVICES, 1);
    const queued = await db.subscriptionTerm.create({
      data: {
        subscriptionId,
        generation: 2,
        status: 'SCHEDULED',
        planSnapshot: { id: `${prefix}-plan`, name: 'Pro', deviceLimit: 3, trafficLimit: 100 } as Prisma.InputJsonValue,
        startsAt: expiresAt,
        endsAt: new Date(expiresAt.getTime() + 30 * 24 * 60 * 60 * 1000),
        baseTrafficLimitBytes: 100n * GIB_BYTES,
        baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET',
      },
    });
    assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).deviceLimit, 6);
    // The marker says +3: more than is left above the plan.
    const payment = await addOnPayment({ userId, subscriptionId, type: AddOnType.EXTRA_DEVICES, value: 3 });

    await recordRefund(payment.id);

    assert.equal(
      (await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).deviceLimit,
      4,
      'the plan’s 3 and the live add-on’s 1',
    );
    const terms = await db.subscriptionTerm.findMany({ where: { subscriptionId }, orderBy: { generation: 'asc' } });
    assert.deepEqual(
      terms.map((row) => [row.id === queued.id ? 'queued' : row.id === term.id ? 'old' : 'rebased', row.generation, row.status, row.baseDeviceLimit]),
      [
        ['old', 1, 'ENDED', 5],
        ['rebased', 3, 'ACTIVE', 3],
        ['queued', 4, 'SCHEDULED', 3],
      ],
      'the queued term moved above the new one, untouched',
    );
    assert.equal(cardFor(payment.paymentId)?.metadata['note'], 'Докупка «+3 устройства» отключена.');

    // And it still starts when its time comes.
    const started = await boundary.activateDueScheduledTerm(subscriptionId, new Date(expiresAt.getTime() + 1_000));
    assert.equal(started.termId, queued.id);
  });

  it('never takes a legacy add-on below the plan: an operator’s lower column stays where it is', async () => {
    // The plan is 3 devices; the add-on added 2, then someone took one away.
    const { userId, subscriptionId } = await customer({ deviceLimit: 4, trafficLimit: 100 });
    const payment = await addOnPayment({ userId, subscriptionId, type: AddOnType.EXTRA_DEVICES, value: 2 });

    await recordRefund(payment.id);

    assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).deviceLimit, 3);
    assert.equal(cardFor(payment.paymentId)?.metadata['note'], 'Докупка «+2 устройства» отключена.');
  });

  it('names the days an upgrade converted a refunded payment into, and where to take them off', async () => {
    const { userId, subscriptionId } = await customer({ deviceLimit: 3, trafficLimit: 100 });
    const bought = await db.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId,
        subscriptionId,
        status: 'COMPLETED',
        purchaseType: 'NEW',
        channel: 'WEB',
        gatewayType: PaymentGatewayType.PLATEGA,
        currency: Currency.RUB,
        amount: new Prisma.Decimal('299'),
        planSnapshot: { id: `${prefix}-plan`, name: 'Pro', selectedDurationDays: 30 } as Prisma.InputJsonValue,
        fulfilledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      },
    });
    const upgrade = await db.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId,
        subscriptionId,
        status: 'COMPLETED',
        purchaseType: 'UPGRADE',
        channel: 'WEB',
        gatewayType: PaymentGatewayType.PLATEGA,
        currency: Currency.RUB,
        amount: new Prisma.Decimal('499'),
        planSnapshot: { id: `${prefix}-plan-2`, name: 'Max', selectedDurationDays: 30 } as Prisma.InputJsonValue,
        fulfilledAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        gatewayData: {
          paidRemainderConversion: { days: 10, sources: [{ transactionId: bought.id, days: '6.15' }] },
        } as Prisma.InputJsonValue,
      },
    });

    await recordRefund(bought.id);

    const card = cardFor(bought.paymentId);
    assert.equal(
      card?.metadata['note'],
      `Остаток этого платежа при улучшении перевёлся в +7 дн. (платёж ${upgrade.paymentId}) — эти дни остались у подписки; ` +
        'уберите их вручную: «Пользователи» → клиент → вкладка «Подписки» → «Быстрые действия» → «Истекает» → «Сохранить».',
    );
    assert.deepEqual(card?.metadata['convertedDays'], [{ upgradePaymentId: upgrade.paymentId, days: 7 }]);
    // Manual review, as for every refund that leaves days: the subscription keeps them.
    assert.equal(card?.metadata['needsManualReview'], true);
    assert.ok((await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).expiresAt! > new Date());
  });

  it('names the days of an upgrade still in flight when the refund is marked: the card waits for it', async () => {
    const { userId, subscriptionId } = await customer({ deviceLimit: 3, trafficLimit: 100 });
    const renewal = await db.transaction.create({
      data: {
        paymentId: `${prefix}-pay-${next()}`,
        userId,
        subscriptionId,
        status: 'COMPLETED',
        purchaseType: 'RENEW',
        channel: 'WEB',
        gatewayType: PaymentGatewayType.PLATEGA,
        currency: Currency.RUB,
        amount: new Prisma.Decimal('299'),
        planSnapshot: { id: `${prefix}-plan`, name: 'Pro', selectedDurationDays: 30 } as Prisma.InputJsonValue,
        fulfilledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      },
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upgradeHolds: (held: { readonly pid: number; readonly paymentId: string }) => void = () => undefined;
    const holding = new Promise<{ readonly pid: number; readonly paymentId: string }>((resolve) => {
      upgradeHolds = resolve;
    });
    // An upgrade as fulfilment runs it: the subscription row locked, the
    // renewal's money read and converted — and not committed yet.
    const upgrade = db.$transaction(
      async (tx) => {
        const [self] = await tx.$queryRaw<Array<{ readonly pid: number }>>(Prisma.sql`SELECT pg_backend_pid() AS "pid"`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`);
        const row = await tx.transaction.create({
          data: {
            paymentId: `${prefix}-pay-${next()}`,
            userId,
            subscriptionId,
            status: 'COMPLETED',
            purchaseType: 'UPGRADE',
            channel: 'WEB',
            gatewayType: PaymentGatewayType.PLATEGA,
            currency: Currency.RUB,
            amount: new Prisma.Decimal('499'),
            planSnapshot: { id: `${prefix}-plan-2`, name: 'Max', selectedDurationDays: 30 } as Prisma.InputJsonValue,
            fulfilledAt: new Date(),
            gatewayData: {
              paidRemainderConversion: { days: 12, sources: [{ transactionId: renewal.id, days: '9.4' }] },
            } as Prisma.InputJsonValue,
          },
        });
        upgradeHolds({ pid: self!.pid, paymentId: row.paymentId });
        await gate;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    const held = await holding;
    try {
      const refunded = recordRefund(renewal.id);
      assert.equal(await waitUntilBlockedBy(held.pid), true, 'the card was written without waiting for the upgrade');
      release();
      await upgrade;
      await refunded;
    } finally {
      release();
      await upgrade.catch(() => undefined);
    }

    const card = cardFor(renewal.paymentId);
    assert.deepEqual(card?.metadata['convertedDays'], [{ upgradePaymentId: held.paymentId, days: 10 }]);
  });
});
