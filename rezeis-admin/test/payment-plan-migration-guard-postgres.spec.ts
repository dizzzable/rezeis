import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, PurchaseType, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { LATE_PLAN_MIGRATION_RENEWAL_CODE } from '../src/modules/payments/services/payment-renewal-plan-migration-guard.util';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentWebhookInboxService } from '../src/modules/payments/services/payment-webhook-inbox.service';
import { ADD_ON_ROLLOUT_FLAG_NAMES } from './helpers/rollout-flags';

/**
 * A RENEWAL PAID AFTER A PLAN MIGRATION, against a real PostgreSQL (decision 10).
 *
 * What only an engine can prove is here: that the guard's statement means on
 * PostgreSQL what the unit double says it means — the enum comparison, the
 * `timestamptz` comparison against the payment row's own `created_at`, and the
 * predicates that must NOT match — and that the whole path a payment really
 * takes keeps it: a success webhook through `PaymentReconciliationService`, its
 * fulfilment claim, the real mutation service, the real term service, and the
 * post-payment hooks after it.
 *
 * The move itself is seeded as the contract describes the state it leaves
 * (`spec.md` §5): the snapshot names the target plan and carries its limits,
 * the columns hold them, and a MOVED `plan_migration_items` row is stamped
 * `moved_at`. The webhook inbox is the real one. The collaborators outside the
 * payment path — the queue, the referral, partner, cashback, tax and
 * advertising services — are recorders: what is under test is that they are
 * still called, not what they do.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it (`.github/workflows/ci.yml`). Every row carries this run's prefix and
 * is removed in `after`.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `pmg-${process.pid}-${Date.now()}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const GIB = 1024n * 1024n * 1024n;
/**
 * The period every payment here buys. Deliberately NOT the 30 days the seeded
 * snapshots hold, so a kept renewal that forgot to record it is visible.
 */
const PAID_DAYS = 90;

interface Emitted {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

interface PlanFixture {
  readonly id: string;
  readonly name: string;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly internalSquads: string[];
  readonly externalSquad: string | null;
}

let prisma: PrismaService;
let reconciliation: PaymentReconciliationService;
const events: Emitted[] = [];
const hooks = {
  referral: [] as string[],
  partner: [] as string[],
  cashback: [] as string[],
  adConversion: [] as string[],
  enqueued: [] as string[],
  webhookFailedAlerts: [] as string[],
};
const created = { plans: [] as string[], users: [] as string[], runs: [] as string[], paymentIds: [] as string[] };
let counter = 0;
const next = (): number => ++counter;

async function createPlan(label: string, limits: Omit<PlanFixture, 'id' | 'name'>): Promise<PlanFixture> {
  const id = `${prefix}-plan-${label}`;
  const name = `${prefix} ${label}`;
  await prisma.plan.create({
    data: {
      id,
      name,
      orderIndex: 100_000 + next(),
      trafficLimit: limits.trafficLimit,
      deviceLimit: limits.deviceLimit,
      internalSquads: limits.internalSquads,
      externalSquad: limits.externalSquad,
      trafficLimitStrategy: 'NO_RESET',
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '199' }] } }] },
    },
  });
  created.plans.push(id);
  return { id, name, ...limits };
}

async function createUser(label: string): Promise<string> {
  const id = `${prefix}-user-${label}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: label } });
  created.users.push(id);
  return id;
}

/** The snapshot a subscription carries on `plan`, as fulfilment and the move write it. */
function snapshotOn(plan: PlanFixture): Record<string, unknown> {
  return {
    id: plan.id,
    name: plan.name,
    description: null,
    tag: null,
    type: 'BOTH',
    icon: null,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [...plan.internalSquads],
    externalSquad: plan.externalSquad,
    selectedDurationDays: 30,
  };
}

async function createSubscriptionOn(userId: string, plan: PlanFixture, expiresAt: Date): Promise<string> {
  const subscription = await prisma.subscription.create({
    data: {
      userId,
      status: 'ACTIVE',
      planSnapshot: snapshotOn(plan) as Prisma.InputJsonValue,
      trafficLimit: plan.trafficLimit,
      deviceLimit: plan.deviceLimit,
      internalSquads: plan.internalSquads,
      externalSquad: plan.externalSquad,
      remnawaveId: `${prefix}-rw-${next()}`,
      startedAt: new Date(Date.now() - 20 * DAY_MS),
      expiresAt,
    },
    select: { id: true },
  });
  return subscription.id;
}

/**
 * The state a completed move leaves (`spec.md` §5): the snapshot names the
 * target and carries its limits, the columns hold them, and the item is MOVED.
 *
 * `movedAt` is either a chosen instant, or `'DATABASE_CLOCK'` — stamped the way
 * the real move stamps it, with PostgreSQL's `clock_timestamp()` in its own
 * statement (`plan-migration-move.service.ts`), not with the Node clock.
 */
async function move(
  subscriptionId: string,
  from: PlanFixture,
  to: PlanFixture,
  movedAt: Date | 'DATABASE_CLOCK',
): Promise<string> {
  const current = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      planSnapshot: { ...(current.planSnapshot as Record<string, unknown>), ...snapshotOn(to) } as Prisma.InputJsonValue,
      trafficLimit: to.trafficLimit,
      deviceLimit: to.deviceLimit,
      internalSquads: to.internalSquads,
      externalSquad: to.externalSquad,
    },
  });
  const runAt = movedAt === 'DATABASE_CLOCK' ? new Date() : movedAt;
  const migrationRun = await prisma.planMigrationRun.create({
    data: { sourcePlanId: from.id, status: 'COMPLETED', totalItems: 1, startedAt: runAt, finishedAt: runAt },
    select: { id: true },
  });
  created.runs.push(migrationRun.id);
  const item = await prisma.planMigrationItem.create({
    data: {
      runId: migrationRun.id,
      subscriptionId,
      fromPlanId: from.id,
      toPlanId: to.id,
      status: movedAt === 'DATABASE_CLOCK' ? 'PENDING' : 'MOVED',
      attempts: movedAt === 'DATABASE_CLOCK' ? 0 : 1,
      movedAt: movedAt === 'DATABASE_CLOCK' ? null : movedAt,
    },
    select: { id: true },
  });
  if (movedAt === 'DATABASE_CLOCK') {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "plan_migration_items"
         SET "status" = 'MOVED', "moved_at" = clock_timestamp(), "attempts" = "attempts" + 1
       WHERE "id" = ${item.id}
    `);
  }
  return migrationRun.id;
}

async function createPayment(input: {
  readonly userId: string;
  readonly subscriptionId: string | null;
  readonly purchaseType: PurchaseType;
  readonly status: TransactionStatus;
  /** Omitted: stamped the way checkout stamps it — Prisma's `now()`, on the Node clock. */
  readonly createdAt?: Date;
  readonly planSnapshot: Record<string, unknown>;
}) {
  const paymentId = `${prefix}-pay-${next()}`;
  created.paymentIds.push(paymentId);
  return prisma.transaction.create({
    data: {
      paymentId,
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      status: input.status,
      purchaseType: input.purchaseType,
      channel: 'WEB',
      gatewayType: 'PLATEGA',
      currency: 'RUB',
      amount: new Prisma.Decimal('199'),
      planSnapshot: input.planSnapshot as Prisma.InputJsonValue,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    },
  });
}

function renewalOf(plan: PlanFixture): Record<string, unknown> {
  return { id: plan.id, selectedDurationDays: PAID_DAYS, availability: 'ALL' };
}

/** A strictly-verifiable combined renewal draft line for `plan`. */
function renewalDraft(plan: PlanFixture): Record<string, unknown> {
  return {
    snapshotVersion: 2,
    snapshotSource: 'RENEWAL_DRAFT',
    purchaseType: 'RENEW',
    availability: 'ALL',
    ...snapshotOn(plan),
    selectedDurationDays: PAID_DAYS,
    gatewayType: 'PLATEGA',
    amount: '199',
    currency: 'RUB',
  };
}

/** A provider success notification for `paymentId`, reconciled the way the worker does it. */
async function deliverSuccess(paymentId: string): Promise<string> {
  const event = await prisma.paymentWebhookEvent.create({
    data: {
      gatewayType: 'PLATEGA',
      paymentId,
      providerEventId: `${prefix}-evt-${next()}`,
      eventStatus: 'PAID',
      rawPayload: {},
    },
    select: { id: true },
  });
  await reconciliation.reconcileWebhookEvent(event.id);
  return event.id;
}

function completionsFor(paymentId: string): Emitted[] {
  return events.filter(
    (event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED && event.metadata['paymentId'] === paymentId,
  );
}

async function withDurableTerms<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
  process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
    else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
  }
}

run('a renewal paid after a plan migration, on PostgreSQL', () => {
  let oldPlan: PlanFixture;
  let currentPlan: PlanFixture;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    // Written against every stage off (the legacy renewal); the durable cases
    // turn stage 1 on themselves (`withDurableTerms`). Spelled out: stages 1, 2
    // and 6 default ON since the 24.09.2026 flip.
    for (const flag of ADD_ON_ROLLOUT_FLAG_NAMES) process.env[flag] = 'false';
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
      {
        enqueue: async (jobId: string) => {
          hooks.enqueued.push(jobId);
        },
      } as never,
      systemEvents as never,
      { enqueueRegisterIncome: async () => undefined, enqueueCancelIncome: async () => undefined } as never,
      {
        recordFirstPurchase: async (input: { readonly id: string }) => {
          hooks.adConversion.push(input.id);
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

    oldPlan = await createPlan('old', {
      trafficLimit: 50,
      deviceLimit: 2,
      internalSquads: [`${prefix}-squad-old`],
      externalSquad: `${prefix}-ext-old`,
    });
    currentPlan = await createPlan('current', {
      trafficLimit: 200,
      deviceLimit: 5,
      internalSquads: [`${prefix}-squad-current`],
      externalSquad: null,
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    const users = created.users;
    await prisma.planMigrationRun.deleteMany({ where: { id: { in: created.runs } } });
    await prisma.paymentWebhookEvent.deleteMany({ where: { paymentId: { in: created.paymentIds } } });
    await prisma.subscriptionTerm.deleteMany({ where: { subscription: { userId: { in: users } } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: users } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: users } } });
    await prisma.plan.deleteMany({ where: { id: { in: created.plans } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  /**
   * The subscription as the move left it, apart from the period the payment
   * bought: its expiry and — on the column path — the paid duration recorded in
   * the snapshot, which autopay renews by. With a durable term the snapshot is
   * untouched now; the appended term carries the duration.
   */
  async function assertKeptOnCurrentPlan(
    subscriptionId: string,
    expiresAt: Date,
    options: { readonly durableTerm?: boolean } = {},
  ): Promise<void> {
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.expiresAt?.getTime(), expiresAt.getTime() + PAID_DAYS * DAY_MS, 'expiry is not extended by the paid period');
    assert.deepEqual(
      row.planSnapshot,
      options.durableTerm === true
        ? snapshotOn(currentPlan)
        : { ...snapshotOn(currentPlan), selectedDurationDays: PAID_DAYS },
      'the snapshot left the current plan, or did not record exactly the paid duration',
    );
    assert.equal(row.trafficLimit, currentPlan.trafficLimit);
    assert.equal(row.deviceLimit, currentPlan.deviceLimit);
    assert.deepEqual(row.internalSquads, currentPlan.internalSquads);
    assert.equal(row.externalSquad, currentPlan.externalSquad);
  }

  function assertOneReviewCompletion(paymentId: string, subscriptionIds: readonly string[], runId: string): void {
    const completions = completionsFor(paymentId);
    assert.equal(completions.length, 1, `one payment must raise one payment.completed; got ${completions.length}`);
    const [completion] = completions;
    assert.equal(completion!.severity, 'WARNING');
    assert.equal(completion!.metadata['code'], LATE_PLAN_MIGRATION_RENEWAL_CODE);
    const renewals =
      (completion!.metadata['planMigrationRenewals'] as Array<Record<string, unknown>> | undefined) ?? [
        completion!.metadata,
      ];
    assert.deepEqual(
      renewals.map((renewal) => renewal['subscriptionId']),
      subscriptionIds,
    );
    for (const renewal of renewals) {
      assert.equal(renewal['paidPlanId'], oldPlan.id);
      assert.equal(renewal['currentPlanId'], currentPlan.id);
      assert.equal(renewal['planMigrationRunId'], runId);
    }
  }

  it('extends a single renewal paid after the move on the current plan, keeps its inherited limits, and tells the operator once', async () => {
    const user = await createUser('single');
    const expiresAt = new Date(Date.now() + 10 * DAY_MS);
    const subscriptionId = await createSubscriptionOn(user, oldPlan, expiresAt);
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      planSnapshot: renewalOf(oldPlan),
    });
    const runId = await move(subscriptionId, oldPlan, currentPlan, new Date(Date.now() - HOUR_MS));

    const eventId = await deliverSuccess(payment.paymentId);

    await assertKeptOnCurrentPlan(subscriptionId, expiresAt);
    const settled = await prisma.transaction.findUniqueOrThrow({ where: { id: payment.id } });
    assert.equal(settled.status, TransactionStatus.COMPLETED);
    assert.ok(settled.fulfilledAt instanceof Date, 'the payment was not stamped fulfilled');
    const jobs = await prisma.profileSyncJob.findMany({ where: { subscriptionId } });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.action, 'UPDATE');
    assert.deepEqual(jobs[0]!.payload, { source: 'PAYMENT_COMPLETION', paymentId: payment.paymentId, resetTraffic: true });
    assert.ok(hooks.enqueued.includes(jobs[0]!.id), 'the sync job was not enqueued');
    for (const [hook, calls] of Object.entries({
      referral: hooks.referral,
      partner: hooks.partner,
      cashback: hooks.cashback,
      adConversion: hooks.adConversion,
    })) {
      assert.equal(calls.filter((id) => id === payment.id).length, 1, `the ${hook} hook did not run once`);
    }
    assertOneReviewCompletion(payment.paymentId, [subscriptionId], runId);
    const webhook = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(webhook.status, 'PROCESSED');
  });

  it('keeps a combined renewal line the same way, beside a line renewed on its paid plan', async () => {
    const user = await createUser('combined');
    const expiresAt = new Date(Date.now() + 10 * DAY_MS);
    const movedId = await createSubscriptionOn(user, oldPlan, expiresAt);
    const stayedId = await createSubscriptionOn(user, oldPlan, expiresAt);
    const payment = await createPayment({
      userId: user,
      subscriptionId: null,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      planSnapshot: { combinedRenewal: true, snapshotVersion: 1 },
    });
    for (const subscriptionId of [movedId, stayedId]) {
      await prisma.transactionItem.create({
        data: {
          transactionId: payment.id,
          subscriptionId,
          planId: oldPlan.id,
          planSnapshot: renewalDraft(oldPlan) as Prisma.InputJsonValue,
          durationDays: PAID_DAYS,
          amount: new Prisma.Decimal('199'),
          currency: 'RUB',
        },
      });
    }
    const runId = await move(movedId, oldPlan, currentPlan, new Date(Date.now() - HOUR_MS));

    await deliverSuccess(payment.paymentId);

    await assertKeptOnCurrentPlan(movedId, expiresAt);
    const stayed = await prisma.subscription.findUniqueOrThrow({ where: { id: stayedId } });
    assert.equal(stayed.expiresAt?.getTime(), expiresAt.getTime() + PAID_DAYS * DAY_MS);
    assert.equal((stayed.planSnapshot as Record<string, unknown>)['id'], oldPlan.id);
    assert.equal((stayed.planSnapshot as Record<string, unknown>)['selectedDurationDays'], PAID_DAYS);
    assert.equal((stayed.planSnapshot as Record<string, unknown>)['snapshotSource'], 'RENEWAL_DRAFT');
    const items = await prisma.transactionItem.findMany({ where: { transactionId: payment.id } });
    assert.equal(items.filter((item) => item.appliedAt !== null).length, 2);
    assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: { in: [movedId, stayedId] } } }), 2);
    assertOneReviewCompletion(payment.paymentId, [movedId], runId);
  });

  it('keeps a checkout cancelled before the move and revived by a late success webhook', async () => {
    const user = await createUser('revived');
    const expiresAt = new Date(Date.now() + 10 * DAY_MS);
    const subscriptionId = await createSubscriptionOn(user, oldPlan, expiresAt);
    // The expiry sweep cancelled it; the provider's success arrives later.
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.CANCELED,
      createdAt: new Date(Date.now() - 3 * HOUR_MS),
      planSnapshot: renewalOf(oldPlan),
    });
    const runId = await move(subscriptionId, oldPlan, currentPlan, new Date(Date.now() - HOUR_MS));

    await deliverSuccess(payment.paymentId);

    const revived = await prisma.transaction.findUniqueOrThrow({ where: { id: payment.id } });
    assert.equal(revived.status, TransactionStatus.COMPLETED, 'the late success did not revive the checkout');
    assert.ok(revived.fulfilledAt instanceof Date);
    await assertKeptOnCurrentPlan(subscriptionId, expiresAt);
    assertOneReviewCompletion(payment.paymentId, [subscriptionId], runId);
  });

  it('keeps a renewal whose draft row was inserted after the move committed: moved_at on the database clock, created_at on the app’s', async () => {
    // The read→insert gap as it happens: checkout priced the old plan, the
    // move committed — stamped with `clock_timestamp()` as the real move stamps
    // it — and the draft row was inserted a couple of seconds later, its
    // `created_at` filled in by Prisma on the Node clock.
    const user = await createUser('read-insert-gap');
    const expiresAt = new Date(Date.now() + 10 * DAY_MS);
    const subscriptionId = await createSubscriptionOn(user, oldPlan, expiresAt);
    const runId = await move(subscriptionId, oldPlan, currentPlan, 'DATABASE_CLOCK');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.PENDING,
      planSnapshot: renewalOf(oldPlan),
    });
    const [stamps] = await prisma.$queryRaw<Array<{ readonly movedAt: Date; readonly createdAt: Date }>>(Prisma.sql`
      SELECT i."moved_at" AS "movedAt", t."created_at" AS "createdAt"
      FROM "plan_migration_items" AS i, "transactions" AS t
      WHERE i."run_id" = ${runId} AND t."id" = ${payment.id}
    `);
    assert.ok(
      stamps!.createdAt.getTime() > stamps!.movedAt.getTime(),
      `the payment row must postdate the move for this case to mean anything: created ${stamps!.createdAt.toISOString()}, moved ${stamps!.movedAt.toISOString()}`,
    );

    await deliverSuccess(payment.paymentId);

    await assertKeptOnCurrentPlan(subscriptionId, expiresAt);
    assertOneReviewCompletion(payment.paymentId, [subscriptionId], runId);
  });

  it('renews a renewal for the current plan created after the move exactly as before', async () => {
    const user = await createUser('after-current');
    const expiresAt = new Date(Date.now() + 10 * DAY_MS);
    const subscriptionId = await createSubscriptionOn(user, oldPlan, expiresAt);
    await move(subscriptionId, oldPlan, currentPlan, new Date(Date.now() - 2 * HOUR_MS));
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - HOUR_MS),
      planSnapshot: renewalOf(currentPlan),
    });

    await deliverSuccess(payment.paymentId);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal(row.expiresAt?.getTime(), expiresAt.getTime() + PAID_DAYS * DAY_MS);
    const snapshot = row.planSnapshot as Record<string, unknown>;
    assert.equal(snapshot['id'], currentPlan.id);
    // Rebuilt by fulfilment, which is what an ordinary renewal does.
    assert.equal(snapshot['snapshotSource'], 'PAYMENT_COMPLETION');
    const completions = completionsFor(payment.paymentId);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.severity, 'INFO');
    assert.equal(completions[0]!.metadata['code'], undefined);
  });

  it('applies a paid upgrade after the move as bought', async () => {
    const user = await createUser('upgrade-after');
    const upgradePlan = await createPlan('upgrade', {
      trafficLimit: 500,
      deviceLimit: 10,
      internalSquads: [`${prefix}-squad-upgrade`],
      externalSquad: null,
    });
    const subscriptionId = await createSubscriptionOn(user, oldPlan, new Date(Date.now() + 10 * DAY_MS));
    await move(subscriptionId, oldPlan, currentPlan, new Date(Date.now() - 2 * HOUR_MS));
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - HOUR_MS),
      planSnapshot: renewalOf(upgradePlan),
    });
    const startedAt = Date.now();

    await deliverSuccess(payment.paymentId);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal((row.planSnapshot as Record<string, unknown>)['id'], upgradePlan.id);
    assert.equal(row.trafficLimit, 500);
    assert.equal(row.deviceLimit, 10);
    assert.deepEqual(row.internalSquads, upgradePlan.internalSquads);
    assert.ok((row.expiresAt?.getTime() ?? 0) >= startedAt + PAID_DAYS * DAY_MS - 1000, 'the upgrade did not reset expiry');
    assert.equal(completionsFor(payment.paymentId)[0]?.severity, 'INFO');
  });

  it('lets a paid upgrade win even over a move that postdates its checkout', async () => {
    // Synthetic on purpose: the one shape where the guard's condition WOULD
    // match an upgrade — a MOVED item off the upgrade's plan, stamped after its
    // checkout — so that wiring the guard into the upgrade path shows up here.
    const user = await createUser('upgrade-wins');
    const subscriptionId = await createSubscriptionOn(user, oldPlan, new Date(Date.now() + 10 * DAY_MS));
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      planSnapshot: renewalOf(oldPlan),
    });
    await move(subscriptionId, oldPlan, currentPlan, new Date(Date.now() - HOUR_MS));

    await deliverSuccess(payment.paymentId);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal((row.planSnapshot as Record<string, unknown>)['id'], oldPlan.id);
    assert.equal(row.deviceLimit, oldPlan.deviceLimit);
    assert.equal(completionsFor(payment.paymentId)[0]?.metadata['code'], undefined);
  });

  it('does not keep a renewal for the old plan created an hour after the move — well past the ten-minute window', async () => {
    // Pins `moved_at >= payment.created_at - 10 minutes` on the engine:
    // `timestamptz` against `timestamptz`, the payment row's own instant.
    //
    // A checkout drafted AFTER the move priced the old plan only because the
    // plan the move put it on renews onto it (archived, replaced on renewal).
    // Onto a plan that renews as itself, such a payment was drafted before a
    // plan change and is converted instead (`readRenewalPricedBeforePlanChange`).
    const user = await createUser('after-old');
    const replacedOnRenew = await createPlan('replaced-on-renew', {
      trafficLimit: currentPlan.trafficLimit,
      deviceLimit: currentPlan.deviceLimit,
      internalSquads: currentPlan.internalSquads,
      externalSquad: currentPlan.externalSquad,
    });
    await prisma.plan.update({
      where: { id: replacedOnRenew.id },
      data: { isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: [oldPlan.id] },
    });
    const subscriptionId = await createSubscriptionOn(user, oldPlan, new Date(Date.now() + 10 * DAY_MS));
    await move(subscriptionId, oldPlan, replacedOnRenew, new Date(Date.now() - 2 * HOUR_MS));
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - HOUR_MS),
      planSnapshot: renewalOf(oldPlan),
    });

    await deliverSuccess(payment.paymentId);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal((row.planSnapshot as Record<string, unknown>)['id'], oldPlan.id);
    assert.equal(completionsFor(payment.paymentId)[0]?.severity, 'INFO');
  });

  it('keeps a renewal priced before the move for the replacement the archived old plan renews onto', async () => {
    // The paid plan is NOT the plan the move left: an archived plan set to
    // renew onto a replacement prices its renewals for that replacement. Before
    // the guard stopped matching `from_plan_id` against the paid plan, this
    // payment put the subscription on the replacement — the operator's move
    // undone, and no alert.
    const user = await createUser('replacement');
    const replacement = await createPlan('replacement', {
      trafficLimit: 300,
      deviceLimit: 7,
      internalSquads: [`${prefix}-squad-replacement`],
      externalSquad: null,
    });
    const archived = await createPlan('archived', {
      trafficLimit: 50,
      deviceLimit: 2,
      internalSquads: [`${prefix}-squad-archived`],
      externalSquad: null,
    });
    await prisma.plan.update({
      where: { id: archived.id },
      data: { isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: [replacement.id] },
    });
    const expiresAt = new Date(Date.now() + 10 * DAY_MS);
    const subscriptionId = await createSubscriptionOn(user, archived, expiresAt);
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      planSnapshot: renewalOf(replacement),
    });
    const runId = await move(subscriptionId, archived, currentPlan, new Date(Date.now() - HOUR_MS));

    await deliverSuccess(payment.paymentId);

    await assertKeptOnCurrentPlan(subscriptionId, expiresAt);
    const completions = completionsFor(payment.paymentId);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.severity, 'WARNING');
    assert.equal(completions[0]!.metadata['code'], LATE_PLAN_MIGRATION_RENEWAL_CODE);
    assert.equal(completions[0]!.metadata['paidPlanId'], replacement.id);
    assert.equal(completions[0]!.metadata['currentPlanId'], currentPlan.id);
    assert.equal(completions[0]!.metadata['planMigrationRunId'], runId);
  });

  it('does not keep a renewal when the subscription was never moved, whatever plan the payment is for', async () => {
    // The lookup is bound to the subscription: another subscription's move says
    // nothing about this payment, which renews onto the plan it bought — the
    // one its own plan, archived, is replaced by on renewal.
    const user = await createUser('not-moved');
    const chosenPlan = await createPlan('chosen', {
      trafficLimit: 300,
      deviceLimit: 7,
      internalSquads: [`${prefix}-squad-chosen`],
      externalSquad: null,
    });
    const ownPlan = await createPlan('own-replaced', {
      trafficLimit: oldPlan.trafficLimit,
      deviceLimit: oldPlan.deviceLimit,
      internalSquads: oldPlan.internalSquads,
      externalSquad: oldPlan.externalSquad,
    });
    await prisma.plan.update({
      where: { id: ownPlan.id },
      data: { isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW', replacementPlanIds: [chosenPlan.id] },
    });
    const subscriptionId = await createSubscriptionOn(user, ownPlan, new Date(Date.now() + 10 * DAY_MS));
    const neighbour = await createSubscriptionOn(user, oldPlan, new Date(Date.now() + 10 * DAY_MS));
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      planSnapshot: renewalOf(chosenPlan),
    });
    await move(neighbour, oldPlan, currentPlan, new Date(Date.now() - HOUR_MS));

    await deliverSuccess(payment.paymentId);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal((row.planSnapshot as Record<string, unknown>)['id'], chosenPlan.id);
    assert.equal(row.deviceLimit, chosenPlan.deviceLimit);
    assert.equal(completionsFor(payment.paymentId)[0]?.severity, 'INFO');
  });

  it('with durable terms, appends the current plan’s term and no term for the paid plan', async () => {
    await withDurableTerms(async () => {
      const user = await createUser('terms');
      const expiresAt = new Date(Date.now() + 10 * DAY_MS);
      const subscriptionId = await createSubscriptionOn(user, oldPlan, expiresAt);
      const payment = await createPayment({
        userId: user,
        subscriptionId,
        purchaseType: PurchaseType.RENEW,
        status: TransactionStatus.PENDING,
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
        planSnapshot: renewalOf(oldPlan),
      });
      const runId = await move(subscriptionId, oldPlan, currentPlan, new Date(Date.now() - HOUR_MS));
      // The move rotates the ACTIVE term onto the current plan (§5.1 step 7).
      await prisma.subscriptionTerm.create({
        data: {
          subscriptionId,
          generation: 1,
          status: 'ACTIVE',
          planId: currentPlan.id,
          planSnapshot: snapshotOn(currentPlan) as Prisma.InputJsonValue,
          startsAt: new Date(Date.now() - 20 * DAY_MS),
          endsAt: expiresAt,
          baseTrafficLimitBytes: 200n * GIB,
          baseDeviceLimit: 5,
          trafficResetStrategy: 'NO_RESET',
        },
      });

      await deliverSuccess(payment.paymentId);

      await assertKeptOnCurrentPlan(subscriptionId, expiresAt, { durableTerm: true });
      const terms = await prisma.subscriptionTerm.findMany({ where: { subscriptionId }, orderBy: { generation: 'asc' } });
      assert.deepEqual(
        terms.map((term) => [term.generation, term.status, term.planId]),
        [
          [1, 'ACTIVE', currentPlan.id],
          [2, 'SCHEDULED', currentPlan.id],
        ],
      );
      assert.equal(terms[1]!.baseTrafficLimitBytes, 200n * GIB);
      assert.equal(terms[1]!.baseDeviceLimit, 5);
      assert.equal(terms[1]!.startsAt.getTime(), expiresAt.getTime());
      assert.equal(terms[1]!.endsAt?.getTime(), expiresAt.getTime() + PAID_DAYS * DAY_MS);
      // The paid duration rides on the term; its snapshot replaces the
      // subscription's when it activates.
      assert.equal((terms[1]!.planSnapshot as Record<string, unknown>)['selectedDurationDays'], PAID_DAYS);
      assertOneReviewCompletion(payment.paymentId, [subscriptionId], runId);
    });
  });

  it('a late renewal first aligns the tail: bonus days the sweep has not caught up with are not lost', async () => {
    // Every flag off: the subscription is in the model, and the renewal's term
    // follows that row.
    const user = await createUser('drifted');
    const expiresAt = new Date(Date.now() + 10 * DAY_MS);
    const subscriptionId = await createSubscriptionOn(user, oldPlan, expiresAt);
    const payment = await createPayment({
      userId: user,
      subscriptionId,
      purchaseType: PurchaseType.RENEW,
      status: TransactionStatus.PENDING,
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
      planSnapshot: renewalOf(oldPlan),
    });
    await move(subscriptionId, oldPlan, currentPlan, new Date(Date.now() - HOUR_MS));
    // The term still ends where the period stood before five bonus days moved
    // `expiresAt`; the hourly drift sweep has not run yet.
    await prisma.subscriptionTerm.create({
      data: {
        subscriptionId,
        generation: 1,
        status: 'ACTIVE',
        planId: currentPlan.id,
        planSnapshot: snapshotOn(currentPlan) as Prisma.InputJsonValue,
        startsAt: new Date(Date.now() - 20 * DAY_MS),
        endsAt: new Date(expiresAt.getTime() - 5 * DAY_MS),
        baseTrafficLimitBytes: 200n * GIB,
        baseDeviceLimit: 5,
        trafficResetStrategy: 'NO_RESET',
      },
    });

    await deliverSuccess(payment.paymentId);

    const terms = await prisma.subscriptionTerm.findMany({ where: { subscriptionId }, orderBy: { generation: 'asc' } });
    assert.deepEqual(
      terms.map((term) => [term.generation, term.status, term.planId]),
      [
        [1, 'ACTIVE', currentPlan.id],
        [2, 'SCHEDULED', currentPlan.id],
      ],
    );
    assert.equal(terms[0]!.endsAt?.getTime(), expiresAt.getTime(), 'the ACTIVE term caught up with the bonus days');
    assert.equal(terms[1]!.startsAt.getTime(), expiresAt.getTime(), 'the renewal follows the real end');
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal(terms[1]!.endsAt?.getTime(), row.expiresAt?.getTime(), 'the chain ends where the subscription does');
  });

  it('fails closed when the current plan is gone but a term chain exists: nothing applied, the payment left for replay', async () => {
    await withDurableTerms(async () => {
      const user = await createUser('gone');
      const expiresAt = new Date(Date.now() + 10 * DAY_MS);
      const subscriptionId = await createSubscriptionOn(user, oldPlan, expiresAt);
      const payment = await createPayment({
        userId: user,
        subscriptionId,
        purchaseType: PurchaseType.RENEW,
        status: TransactionStatus.PENDING,
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
        planSnapshot: renewalOf(oldPlan),
      });
      // A current plan with no row at all: the move's target is referenced by
      // id only, with no foreign key.
      const gonePlan: PlanFixture = { ...currentPlan, id: `${prefix}-plan-gone`, name: `${prefix} gone` };
      await move(subscriptionId, oldPlan, gonePlan, new Date(Date.now() - HOUR_MS));
      await prisma.subscriptionTerm.create({
        data: {
          subscriptionId,
          generation: 1,
          status: 'ACTIVE',
          planId: gonePlan.id,
          startsAt: new Date(Date.now() - 20 * DAY_MS),
          endsAt: expiresAt,
          baseTrafficLimitBytes: 200n * GIB,
          baseDeviceLimit: 5,
          trafficResetStrategy: 'NO_RESET',
        },
      });
      const eventCount = events.length;

      await assert.rejects(() => deliverSuccess(payment.paymentId), /LATE_RENEWAL_CURRENT_PLAN_NOT_FOUND/);

      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
      assert.equal(row.expiresAt?.getTime(), expiresAt.getTime(), 'expiry moved on a payment that was not applied');
      const unapplied = await prisma.transaction.findUniqueOrThrow({ where: { id: payment.id } });
      assert.equal(unapplied.status, TransactionStatus.COMPLETED);
      assert.equal(unapplied.fulfilledAt, null, 'the fulfilment claim was not released for a replay');
      assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId, status: 'SCHEDULED' } }), 0);
      assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId } }), 0);
      const webhook = await prisma.paymentWebhookEvent.findFirstOrThrow({
        where: { paymentId: payment.paymentId },
      });
      assert.equal(webhook.status, 'FAILED');
      // The reason survives the inbox's error normalization, which keeps only
      // a bounded code — so the operator's failed-webhook alert names it.
      assert.equal(webhook.lastError, 'LATE_RENEWAL_CURRENT_PLAN_NOT_FOUND');
      assert.ok(hooks.webhookFailedAlerts.includes(webhook.id), 'the operator was not alerted');
      assert.equal(
        events.slice(eventCount).filter((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED).length,
        0,
      );
    });
  });
});
