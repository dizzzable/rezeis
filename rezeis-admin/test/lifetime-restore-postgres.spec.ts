import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import type { SubscriptionTermHooksService } from '../src/modules/add-on-entitlements/services/subscription-term-hooks.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { PANEL_NO_END_EXPIRE_AT } from '../src/modules/remnawave/services/panel-expiry';
import {
  LIFETIME_RESTORE_CAUSE,
  LIFETIME_RESTORED_AUDIT_ACTION,
  LIFETIME_RESTORED_REASON,
  LifetimeRestoreService,
  type LifetimeCensusRow,
  type LifetimeRestoreResult,
} from '../src/modules/subscriptions/services/lifetime-restore.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { realTermHooks } from './helpers/term-model-hooks';
import { at, DAY_MS, GIB, newUser, termModelFixtures, type TermModelFixtures } from './helpers/term-model-fixtures';

/**
 * «Вернуть бессрочность» (owner, 24.09.2026) against PostgreSQL: the census
 * (W4's SQL, R1-01) and the restore, through the real term model, the real
 * boundary sweep producing the add-ons it brings back, and the real processor
 * sending the push; only Remnawave and the queue are doubles.
 *
 * Every instant is anchored to now. The wrong date `D` is two days ago: a
 * subscription sold with no end, re-dated by an older build's read-back, that
 * expired on it.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

/** A panel-id range no other spec uses. */
const PANEL_BASE = 1_450_000_000 + (Date.now() % 2_000_000) * 100;
const TELEGRAM_BASE = 7_450_000_000 + (Date.now() % 1_000_000) * 50;
const BYTES_PER_GIB = 1024 ** 3;
/** What the plan gives: 100 GB, 3 devices. */
const PLAN = { trafficLimit: 100, deviceLimit: 3 } as const;
const REQUEST = { requestId: 'lifetime-restore-spec', remoteAddress: '203.0.113.7', userAgent: 'lifetime-restore-spec/1' };

let prisma: PrismaService;
let fx: TermModelFixtures;
let adminId: string;
let lifetimePlan: string;
let datedPlan: string;
const terms = new SubscriptionTermService();
const projections = new EffectiveProjectionService();
const entitlements = new AddOnEntitlementService();
let boundary: EntitlementBoundaryService;
let service: LifetimeRestoreService;
/** The UPDATEs handed to the queue, in order. */
const enqueued: string[] = [];
/** Ids whose term-model step throws — one failing id among others. */
const failFor = new Set<string>();
/** Ids whose FIRST term-model step fails as PostgreSQL fails a deadlocked transaction. */
const conflictOnce = new Set<string>();
/** The term-model calls made, by subscription id. */
const hookCalls: string[] = [];

type Owner = { readonly userId: string; readonly subscriptionId: string; readonly panelId: number };

/** A subscription of a customer of its own, dated `expiresAt`, sold on `snapshot`. */
async function subscription(input: {
  readonly expiresAt: Date | null;
  readonly status?: SubscriptionStatus;
  readonly createdAt?: Date;
  readonly snapshot?: Record<string, unknown>;
  readonly unlinked?: boolean;
  /** Brought into the term model the way the background cutover does it, before `expiresAt` is written. */
  readonly inModel?: boolean;
  /** The date the cutover minted the term with; `expiresAt` is written after it. */
  readonly termEndsAt?: Date | null;
}): Promise<Owner> {
  const userId = await newUser(fx, { telegramId: BigInt(TELEGRAM_BASE + fx.next()) });
  const panelId = PANEL_BASE + fx.next();
  const createdAt = input.createdAt ?? at(-40);
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: (input.snapshot ?? {
        id: datedPlan,
        name: 'Годовой',
        trafficLimit: PLAN.trafficLimit,
        deviceLimit: PLAN.deviceLimit,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: -1,
      }) as Prisma.InputJsonValue,
      trafficLimit: PLAN.trafficLimit,
      deviceLimit: PLAN.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: input.unlinked === true ? null : String(panelId),
      remnawavePanelId: input.unlinked === true ? null : panelId,
      createdAt,
      startedAt: createdAt,
      expiresAt: input.termEndsAt === undefined ? input.expiresAt : input.termEndsAt,
    },
    select: { id: true },
  });
  const owner = { userId, subscriptionId: row.id, panelId };
  if (input.inModel === true) {
    const cutover = new EntitlementCutoverService(prisma, terms, projections);
    const entered = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, owner.subscriptionId));
    assert.equal(entered.outcome, 'CREATED');
  }
  await prisma.subscription.update({
    where: { id: owner.subscriptionId },
    data: { expiresAt: input.expiresAt, ...(input.status === undefined ? {} : { status: input.status }) },
  });
  return owner;
}

/** A completed payment of `owner`'s, for `days` (or an add-on, with no duration). */
async function payment(
  owner: { readonly userId: string },
  input: {
    readonly subscriptionId: string | null;
    readonly days?: number;
    readonly status?: TransactionStatus;
    readonly createdAt?: Date;
    readonly purchaseType?: 'NEW' | 'RENEW' | 'UPGRADE' | 'ADDITIONAL';
    /** When fulfilment applied it; unset for a payment never applied. */
    readonly fulfilledAt?: Date;
    readonly gatewayData?: Record<string, unknown>;
  },
): Promise<{ readonly id: string; readonly paymentId: string }> {
  return prisma.transaction.create({
    data: {
      userId: owner.userId,
      subscriptionId: input.subscriptionId,
      status: input.status ?? TransactionStatus.COMPLETED,
      purchaseType: input.purchaseType ?? (input.days === undefined ? 'ADDITIONAL' : input.days === -1 ? 'NEW' : 'RENEW'),
      gatewayType: 'YOOKASSA',
      currency: 'RUB',
      amount: new Prisma.Decimal('999'),
      planSnapshot: input.days === undefined ? {} : { id: datedPlan, selectedDurationDays: input.days },
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.fulfilledAt === undefined ? {} : { fulfilledAt: input.fulfilledAt }),
      ...(input.gatewayData === undefined ? {} : { gatewayData: input.gatewayData as Prisma.InputJsonValue }),
    },
    select: { id: true, paymentId: true },
  });
}

/**
 * A payment `reverseFulfilledPayment` reversed: CANCELED, stamped, and — for a
 * NEW purchase it could revoke — with the revocation's own audit, exactly the
 * keys that function merges (`payment-reconciliation.service.ts`).
 */
async function refundedPayment(
  owner: Owner,
  input: {
    readonly subscriptionId: string | null;
    readonly days?: number;
    readonly createdAt: Date;
    readonly refundedAt: Date;
    readonly providerStatus?: string;
    /**
     * False for a payment reversed before `fulfilled_at` existed: the column's
     * migration stamped only the payments COMPLETED at the time.
     */
    readonly fulfilled?: boolean;
  },
): Promise<{ readonly id: string; readonly paymentId: string }> {
  const revoked = input.days === -1 && input.subscriptionId !== null;
  return payment(owner, {
    subscriptionId: input.subscriptionId,
    ...(input.days === undefined ? {} : { days: input.days }),
    status: TransactionStatus.CANCELED,
    createdAt: input.createdAt,
    ...(input.fulfilled === false ? {} : { fulfilledAt: input.createdAt }),
    gatewayData: {
      providerStatus: input.providerStatus ?? 'refunded',
      refundReversedAt: input.refundedAt.toISOString(),
      subscriptionRevoked: revoked,
      ...(revoked
        ? {
            refundRevokedSubscriptionId: input.subscriptionId,
            refundRevokedFromExpiresAt: null,
            refundRevokedFromStatus: 'ACTIVE',
            refundRevokedAt: input.refundedAt.toISOString(),
          }
        : {}),
    },
  });
}

/** A CREATE of the profile that finished at `completedAt` (COMPLETED unless said otherwise). */
async function created(owner: Owner, completedAt: Date, status: SyncJobStatus = SyncJobStatus.COMPLETED): Promise<void> {
  await prisma.profileSyncJob.create({
    data: {
      subscriptionId: owner.subscriptionId,
      action: SyncAction.CREATE,
      status,
      startedAt: new Date(completedAt.getTime() - 1_000),
      completedAt,
      payload: {},
    },
  });
}

/**
 * An add-on bought on the ACTIVE term, as the ledger records a direct purchase:
 * its own completed payment, activated at `activatedAt`, ending at `expiresAt`.
 */
async function addOn(
  owner: Owner,
  input: {
    readonly type: AddOnType;
    readonly value: number;
    readonly expiresAt: Date | null;
    readonly activatedAt?: Date;
    readonly lifetime?: AddOnLifetime;
    readonly state?: AddOnEntitlementState;
    readonly expiryEpochId?: string;
  },
): Promise<string> {
  const term = await prisma.subscriptionTerm.findFirstOrThrow({
    where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
  });
  const paid = await payment(owner, { subscriptionId: owner.subscriptionId });
  const activatedAt = input.activatedAt ?? at(-30);
  const total = input.type === AddOnType.EXTRA_TRAFFIC ? BigInt(input.value) * GIB : BigInt(input.value);
  const state = input.state ?? AddOnEntitlementState.ACTIVE;
  const row = await prisma.addOnEntitlement.create({
    data: {
      subscriptionId: owner.subscriptionId,
      termId: term.id,
      sourceTransactionId: paid.id,
      sourceLineKey: 'line',
      catalogRevision: 1,
      receiptName: `${input.type} +${input.value}`,
      type: input.type,
      valuePerUnit: input.value,
      totalValue: total,
      lifetime: input.lifetime ?? AddOnLifetime.UNTIL_SUBSCRIPTION_END,
      unitAmount: new Prisma.Decimal('99'),
      totalAmount: new Prisma.Decimal('99'),
      currency: 'RUB',
      purchasedAt: at(-30),
      scheduledActivationAt: activatedAt,
      activatedAt: state === AddOnEntitlementState.ACTIVE ? activatedAt : null,
      expiresAt: input.expiresAt,
      expiryEpochId: input.expiryEpochId ?? null,
      state,
    },
    select: { id: true },
  });
  return row.id;
}

/** The projection over the live add-ons, and the columns mirroring it — as a purchase leaves them. */
async function recount(owner: Owner): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const projection = await projections.recomputeInTransaction(tx, { subscriptionId: owner.subscriptionId, mode: 'ACTIVE' });
    await tx.subscription.update({
      where: { id: owner.subscriptionId },
      data: {
        trafficLimit: projection.desiredTrafficLimitBytes === null ? null : Number(projection.desiredTrafficLimitBytes / GIB),
        deviceLimit: projection.desiredDeviceLimit ?? 0,
      },
    });
  });
}

/** An older build's read-back writes `date`; the hourly drift sweep then aligns the tail and the add-ons to it. */
async function redate(owner: Owner, date: Date): Promise<void> {
  await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { expiresAt: date } });
  await prisma.$transaction((tx) =>
    terms.alignTailToExpiryInTransaction(tx, owner.subscriptionId, { correlationId: `term-drift:${owner.subscriptionId}` }),
  );
}

async function transition(
  entitlementId: string,
  command: 'BEGIN_EXPIRY' | 'REMEDIATE' | 'REVERSE',
  reason: string,
  actorType: AddOnEntitlementActorType = AddOnEntitlementActorType.SYSTEM,
): Promise<void> {
  await prisma.$transaction((tx) =>
    entitlements.transitionInTransaction(tx, {
      entitlementId,
      command,
      commandKey: `spec-${command.toLowerCase()}:${entitlementId}`,
      correlationId: `spec:${entitlementId}`,
      actorType,
      ...(actorType === AddOnEntitlementActorType.ADMIN ? { actorId: adminId } : {}),
      reason,
    }),
  );
}

async function read(subscriptionId: string) {
  return prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: {
      status: true,
      expiresAt: true,
      trafficLimit: true,
      deviceLimit: true,
      planSnapshot: true,
      effectiveProjection: { select: { desiredTrafficLimitBytes: true, desiredDeviceLimit: true, state: true } },
    },
  });
}

const entitlement = (id: string) => prisma.addOnEntitlement.findUniqueOrThrow({ where: { id } });

const jobsOf = (subscriptionId: string) =>
  prisma.profileSyncJob.findMany({ where: { subscriptionId }, orderBy: { createdAt: 'asc' } });

/** The sync jobs of `subscriptionId` that were not there in `before` — what a restore queued. */
async function jobsSince(subscriptionId: string, before: readonly { readonly id: string }[]) {
  const known = new Set(before.map((job) => job.id));
  return (await jobsOf(subscriptionId)).filter((job) => !known.has(job.id));
}

const auditOf = (subscriptionId: string) =>
  prisma.adminAuditLog.findMany({
    where: { action: LIFETIME_RESTORED_AUDIT_ACTION, metadata: { path: ['subscriptionId'], equals: subscriptionId } },
  });

async function restore(ids: readonly string[]): Promise<Map<string, LifetimeRestoreResult>> {
  const answered = await service.restore(ids, { id: adminId }, REQUEST).catch((error: unknown) => error);
  assert.ok(!(answered instanceof Error), `the restore answers for every id instead of throwing: ${String(answered)}`);
  const response = answered as Awaited<ReturnType<LifetimeRestoreService['restore']>>;
  assert.deepEqual(
    response.results.map((result) => result.subscriptionId),
    [...ids],
    'one result per id, in the order given',
  );
  return new Map(response.results.map((result) => [result.subscriptionId, result]));
}

/** The processor over a Remnawave double that answers with what it was sent; records the bodies. */
function processorFor(owner: Owner, sent: Array<Record<string, unknown>>): ProfileSyncProcessor {
  const answer = (body: Record<string, unknown>) => ({
    kind: 'ok' as const,
    data: {
      response: {
        id: owner.panelId,
        username: `lrst-${owner.panelId}`,
        status: 'ACTIVE',
        subscriptionUrl: `https://panel.example/sub/${owner.panelId}`,
        description: `reiwa_id: ${owner.userId}`,
        expireAt: String(body['expireAt'] ?? PANEL_NO_END_EXPIRE_AT),
        createdAt: at(-40).toISOString(),
        trafficLimitBytes: body['trafficLimitBytes'] ?? PLAN.trafficLimit * BYTES_PER_GIB,
        hwidDeviceLimit: body['hwidDeviceLimit'] ?? PLAN.deviceLimit,
      },
    },
  });
  const missing = { kind: 'rejected' as const, status: 404, code: 'A063', detail: 'User not found' };
  const panel = {
    createUser: async (body: Record<string, unknown>) => (sent.push({ create: true, ...body }), answer(body)),
    updateUser: async (body: Record<string, unknown>) => (sent.push(body), answer(body)),
    resetTraffic: async () => answer({}),
    getUserById: async () => answer({}),
    getUserByUsername: async () => missing,
    resolveUser: async () => missing,
  };
  return new ProfileSyncProcessor(
    prisma,
    panel as never,
    {
      generateProfileName: async () => ({ username: `lrst-${owner.panelId}`, description: `reiwa_id: ${owner.userId}` }),
      getContactInfo: async () => ({ email: null, telegramId: null }),
    } as never,
    { error: () => undefined, warn: () => undefined, emit: () => undefined, info: () => undefined } as never,
  );
}

run('«Вернуть бессрочность»: the census and the restore (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `lrst-${process.pid}-${Date.now()}`);
    const admin = await prisma.adminUser.create({
      data: { login: `${fx.prefix}-admin`, loginNormalized: `${fx.prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
    lifetimePlan = `${fx.prefix}-lifetime`;
    datedPlan = `${fx.prefix}-dated`;
    for (const [id, days] of [
      [lifetimePlan, -1],
      [datedPlan, 30],
    ] as const) {
      await prisma.plan.create({
        data: {
          id,
          name: id,
          orderIndex: 710_000 + fx.next(),
          trafficLimit: PLAN.trafficLimit,
          deviceLimit: PLAN.deviceLimit,
          internalSquads: [],
          externalSquad: null,
          trafficLimitStrategy: 'NO_RESET',
          durations: { create: [{ days, prices: { create: [{ currency: 'RUB', price: '999' }] } }] },
        },
      });
      fx.plans.push(id);
    }
    boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projections);
    const real = realTermHooks(prisma);
    const hooks = {
      followExpiryInTransaction: (...args: Parameters<SubscriptionTermHooksService['followExpiryInTransaction']>) => {
        hookCalls.push(args[1]);
        if (failFor.has(args[1])) return Promise.reject(new Error('The term model is unavailable for this subscription'));
        if (conflictOnce.delete(args[1])) {
          // What a deadlock looks like through the pg driver adapter: the whole
          // transaction is rolled back, and running it again is safe.
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock', {
              code: 'P2034',
              clientVersion: 'spec',
            }),
          );
        }
        return real.followExpiryInTransaction(...args);
      },
    } as unknown as SubscriptionTermHooksService;
    service = new LifetimeRestoreService(prisma, hooks, projections, {
      enqueue: async (syncJobId: string) => void enqueued.push(syncJobId),
    } as never);
  });

  beforeEach(() => {
    enqueued.length = 0;
    failFor.clear();
    conflictOnce.clear();
    hookCalls.length = 0;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await prisma.profileSyncJob.deleteMany({ where: { subscription: { userId: { in: fx.users } } } }).catch(() => undefined);
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.plan.deleteMany({ where: { id: { in: fx.plans } } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  // ── The census ──────────────────────────────────────────────────────────

  it('lists each kind of evidence and both hints, pre-selects exactly the suggested rows, never a DELETED one or a control', async () => {
    const createdAt = at(-40);
    const thirtyAfter = new Date(createdAt.getTime() + 30 * DAY_MS + 5_000);

    // Each kind of evidence, on a row of its own.
    const bySnapshot = await subscription({ expiresAt: thirtyAfter, createdAt });
    await created(bySnapshot, new Date(createdAt.getTime() + 5_000));
    // A dated renewal that was never paid proves nothing was paid for.
    await payment(bySnapshot, {
      subscriptionId: bySnapshot.subscriptionId,
      days: 30,
      status: TransactionStatus.PENDING,
      createdAt: new Date(createdAt.getTime() + 20 * DAY_MS),
    });
    const dated = { id: datedPlan, name: 'Месячный', selectedDurationDays: 30 };
    const byPaymentDate = at(-5);
    const byPayment = await subscription({ expiresAt: byPaymentDate, createdAt, snapshot: dated });
    // A dated payment BEFORE the "no end" one: nothing was paid for after it.
    await payment(byPayment, { subscriptionId: byPayment.subscriptionId, days: 30, createdAt: new Date(createdAt.getTime() - DAY_MS) });
    const noEnd = await payment(byPayment, { subscriptionId: byPayment.subscriptionId, days: -1, createdAt });
    // The fingerprint's date, but from a CREATE that failed: no profile got it.
    await created(byPayment, new Date(byPaymentDate.getTime() - 30 * DAY_MS), SyncJobStatus.FAILED);
    const byPlanDate = at(-4);
    const byPlan = await subscription({ expiresAt: byPlanDate, createdAt, snapshot: { id: lifetimePlan, name: 'Навсегда' } });
    // A CREATE, but the date is thirty-five days after it, not thirty.
    await created(byPlan, new Date(byPlanDate.getTime() - 35 * DAY_MS));
    const byLineDate = at(-3);
    const byLine = await subscription({ expiresAt: byLineDate, createdAt, snapshot: dated, unlinked: true });
    // …and twenty-five days after this one.
    await created(byLine, new Date(byLineDate.getTime() - 25 * DAY_MS));
    const combined = await payment(byLine, { subscriptionId: null, days: 30, createdAt });
    await prisma.transactionItem.create({
      data: {
        transactionId: combined.id,
        subscriptionId: byLine.subscriptionId,
        planId: lifetimePlan,
        durationDays: -1,
        amount: new Prisma.Decimal('999'),
        currency: 'RUB',
      },
    });
    // The fingerprint, but a renewal was paid for a date after the "no end" payment.
    const paidLater = await subscription({ expiresAt: thirtyAfter, createdAt, snapshot: dated, status: SubscriptionStatus.EXPIRED });
    await created(paidLater, new Date(createdAt.getTime() + 5_000));
    await payment(paidLater, { subscriptionId: paidLater.subscriptionId, days: -1, createdAt });
    await payment(paidLater, { subscriptionId: paidLater.subscriptionId, days: 30, createdAt: new Date(createdAt.getTime() + 20 * DAY_MS) });

    // Never listed.
    const deleted = await subscription({ expiresAt: at(-6), createdAt, status: SubscriptionStatus.DELETED });
    const stillOpen = await subscription({ expiresAt: null, createdAt });
    const datedRow = await subscription({ expiresAt: at(-6), createdAt, snapshot: dated });
    const unpaid = await subscription({ expiresAt: at(-6), createdAt, snapshot: dated });
    await payment(unpaid, { subscriptionId: unpaid.subscriptionId, days: -1, status: TransactionStatus.PENDING, createdAt });
    const refunded = await subscription({ expiresAt: at(-6), createdAt, snapshot: dated });
    await payment(refunded, { subscriptionId: refunded.subscriptionId, days: -1, status: TransactionStatus.REFUNDED, createdAt });
    // A snapshot that names no plan: no plan can sell it "no end".
    const noPlan = await subscription({ expiresAt: at(-6), createdAt, snapshot: { name: 'Импорт' } });
    const failedLine = await subscription({ expiresAt: at(-6), createdAt, snapshot: dated });
    const failed = await payment(failedLine, { subscriptionId: null, days: 30, status: TransactionStatus.FAILED, createdAt });
    await prisma.transactionItem.create({
      data: {
        transactionId: failed.id,
        subscriptionId: failedLine.subscriptionId,
        planId: lifetimePlan,
        durationDays: -1,
        amount: new Prisma.Decimal('999'),
        currency: 'RUB',
      },
    });

    const census = await service.census();
    const listed = [bySnapshot, byPayment, byPlan, byLine, paidLater].map((owner) => owner.subscriptionId);
    const mine = census.rows.filter((row) => listed.includes(row.subscriptionId));
    const byId = new Map<string, LifetimeCensusRow>(mine.map((row) => [row.subscriptionId, row]));
    assert.deepEqual([...byId.keys()].sort(), [...listed].sort(), 'exactly the rows sold without an end');
    for (const control of [deleted, stillOpen, datedRow, unpaid, refunded, noPlan, failedLine]) {
      assert.equal(
        census.rows.some((row) => row.subscriptionId === control.subscriptionId),
        false,
        'never a DELETED row, one still open, a dated plan, a PENDING or REFUNDED payment, no plan, a FAILED combined line',
      );
    }

    assert.deepEqual(byId.get(bySnapshot.subscriptionId)!.evidence, [{ kind: 'snapshot' }]);
    assert.deepEqual(byId.get(byPayment.subscriptionId)!.evidence, [{ kind: 'payment', paymentId: noEnd.paymentId }]);
    assert.deepEqual(byId.get(byPlan.subscriptionId)!.evidence, [{ kind: 'plan', planId: lifetimePlan }]);
    assert.deepEqual(byId.get(byLine.subscriptionId)!.evidence, [{ kind: 'paymentLine', paymentId: combined.paymentId }]);

    const hints = (owner: Owner) => {
      const row = byId.get(owner.subscriptionId)!;
      return [row.thirtyDaysAfterCreate, row.datedPaymentAfter, row.suggested];
    };
    assert.deepEqual(hints(bySnapshot), [true, false, true], 'the fingerprint and nothing paid after it: pre-selected');
    assert.deepEqual(hints(byPayment), [false, false, false], 'a FAILED CREATE; a dated payment BEFORE the "no end" one');
    assert.deepEqual(hints(byPlan), [false, false, false], 'a CREATE thirty-five days before the date is not the fingerprint');
    assert.deepEqual(hints(byLine), [false, false, false], 'nor one twenty-five days before it');
    assert.deepEqual(hints(paidLater), [true, true, false], 'a renewal paid for a date after it: not pre-selected');
    assert.deepEqual(
      mine.filter((row) => row.suggested).map((row) => row.subscriptionId),
      [bySnapshot.subscriptionId],
      'pre-selection is exactly `suggested`',
    );

    const snapshotRow = byId.get(bySnapshot.subscriptionId)!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: bySnapshot.userId } });
    assert.equal(snapshotRow.userId, bySnapshot.userId);
    assert.equal(snapshotRow.userName, user.name);
    assert.equal(snapshotRow.userTelegramId, user.telegramId!.toString());
    assert.equal(snapshotRow.planName, 'Годовой');
    assert.equal(snapshotRow.status, 'ACTIVE');
    assert.equal(snapshotRow.expiresAt, thirtyAfter.toISOString());
    assert.equal(snapshotRow.createdAt, createdAt.toISOString());
    assert.equal(snapshotRow.linked, true);
    assert.equal(byId.get(byLine.subscriptionId)!.linked, false, 'no Remnawave link: a restore queues nothing');
    assert.equal(byId.get(paidLater.subscriptionId)!.status, 'EXPIRED');

    // Status first (ACTIVE before EXPIRED), then the date.
    assert.deepEqual(
      mine.map((row) => row.subscriptionId),
      [bySnapshot, byPayment, byPlan, byLine, paidLater]
        .map((owner) => byId.get(owner.subscriptionId)!)
        .sort((left, right) =>
          left.status === right.status
            ? left.expiresAt.localeCompare(right.expiresAt)
            : left.status === 'ACTIVE' ? -1 : 1,
        )
        .map((row) => row.subscriptionId),
    );
    assert.equal(census.truncated, false);
    assert.equal(census.total, census.rows.length, 'nothing cut: the total is the list');

    const cut = await service.census(2);
    assert.equal(cut.rows.length, 2);
    assert.equal(cut.truncated, true);
    assert.equal(cut.total, census.total, 'the total counts the whole population, not the page');
  });

  // ── A refunded "no end" purchase never comes back (review R2b-02) ────────

  it('R2b-02: a "no end" purchase refunded or charged back is neither listed nor restored — `refunded`, nothing written', async () => {
    // Bought for ever 31 days ago and refunded after 30: the reversal expired
    // the row at the refund's instant, and the row's own snapshot (or its plan)
    // still says "no end" — which used to list it pre-selected and restore it.
    const boughtAt = at(-31);
    const refundedAt = at(-1);
    const expired = { expiresAt: refundedAt, status: SubscriptionStatus.EXPIRED, createdAt: boughtAt } as const;
    const lifetimeSnapshot = { id: lifetimePlan, name: 'Навсегда' };

    const refundedNew = await subscription(expired);
    await created(refundedNew, boughtAt);
    await refundedPayment(refundedNew, { subscriptionId: refundedNew.subscriptionId, days: -1, createdAt: boughtAt, refundedAt });
    // A chargeback reversed before `fulfilled_at` existed: the stamp alone says so.
    const chargedBack = await subscription({ ...expired, snapshot: lifetimeSnapshot });
    await refundedPayment(chargedBack, {
      subscriptionId: chargedBack.subscriptionId,
      days: -1,
      createdAt: boughtAt,
      refundedAt,
      providerStatus: 'CHARGEBACK',
      fulfilled: false,
    });
    // An older build's refund: the legacy REFUNDED status.
    const legacyRefunded = await subscription(expired);
    await payment(legacyRefunded, {
      subscriptionId: legacyRefunded.subscriptionId,
      days: -1,
      status: TransactionStatus.REFUNDED,
      createdAt: boughtAt,
    });
    // A full refund whose stamp an older build's «Мой налог» write erased:
    // CANCELED after it was applied, its ledger left.
    const stampErased = await subscription(expired);
    await payment(stampErased, {
      subscriptionId: stampErased.subscriptionId,
      days: -1,
      status: TransactionStatus.CANCELED,
      createdAt: boughtAt,
      fulfilledAt: boughtAt,
      gatewayData: { refundedAmountTotal: '999.00' },
    });
    // A combined renewal refunded whole, whose line for this row was "no end".
    const lineRefunded = await subscription({ ...expired, snapshot: lifetimeSnapshot });
    const combined = await refundedPayment(lineRefunded, { subscriptionId: null, days: 30, createdAt: boughtAt, refundedAt });
    await prisma.transactionItem.create({
      data: {
        transactionId: combined.id,
        subscriptionId: lineRefunded.subscriptionId,
        planId: lifetimePlan,
        durationDays: -1,
        amount: new Prisma.Decimal('999'),
        currency: 'RUB',
      },
    });

    const refunded = [refundedNew, chargedBack, legacyRefunded, stampErased, lineRefunded];
    const census = await service.census();
    for (const owner of refunded) {
      assert.equal(
        census.rows.some((row) => row.subscriptionId === owner.subscriptionId),
        false,
        `a refunded "no end" purchase is not a lifetime subscription that lost its date (${owner.subscriptionId})`,
      );
    }

    const jobsBefore = new Map<string, Array<{ id: string }>>();
    for (const owner of refunded) jobsBefore.set(owner.subscriptionId, await jobsOf(owner.subscriptionId));
    const results = await restore(refunded.map((owner) => owner.subscriptionId));
    for (const owner of refunded) {
      assert.deepEqual(results.get(owner.subscriptionId), {
        subscriptionId: owner.subscriptionId,
        outcome: 'refunded',
        previousExpiresAt: refundedAt.toISOString(),
        statusBefore: 'EXPIRED',
        statusAfter: 'EXPIRED',
        revivedAddOns: 0,
        syncQueued: false,
        error: null,
      });
      const row = await read(owner.subscriptionId);
      assert.deepEqual([row.status, row.expiresAt?.toISOString()], [SubscriptionStatus.EXPIRED, refundedAt.toISOString()]);
      assert.deepEqual(await jobsSince(owner.subscriptionId, jobsBefore.get(owner.subscriptionId)!), [], 'nothing pushed');
      assert.deepEqual(await auditOf(owner.subscriptionId), [], 'nothing audited: nothing was restored');
    }
    assert.deepEqual(enqueued, []);
  });

  it('R2b-02 controls: a refund of ANOTHER payment, a later paid "no end" purchase, a lifetime granted without payment, an abandoned checkout and a partial refund stay listed and restorable', async () => {
    const boughtAt = at(-31);
    const expired = { expiresAt: at(-2), status: SubscriptionStatus.EXPIRED, createdAt: boughtAt } as const;

    // Granted by an operator: no payment at all.
    const granted = await subscription(expired);
    // Granted too; its dated renewal and an add-on were refunded, not what sold "no end".
    const otherRefunded = await subscription(expired);
    await refundedPayment(otherRefunded, { subscriptionId: otherRefunded.subscriptionId, days: 30, createdAt: at(-20), refundedAt: at(-10) });
    await refundedPayment(otherRefunded, { subscriptionId: otherRefunded.subscriptionId, createdAt: at(-15), refundedAt: at(-9) });
    // Refunded, then bought for ever again — and that one is paid.
    const boughtAgain = await subscription(expired);
    await refundedPayment(boughtAgain, { subscriptionId: boughtAgain.subscriptionId, days: -1, createdAt: boughtAt, refundedAt: at(-25) });
    const paidAgain = await payment(boughtAgain, {
      subscriptionId: boughtAgain.subscriptionId,
      days: -1,
      purchaseType: 'RENEW',
      createdAt: at(-20),
      fulfilledAt: at(-20),
    });
    // A "no end" checkout abandoned before it was paid: never applied, nothing refunded.
    const abandoned = await subscription(expired);
    await payment(abandoned, { subscriptionId: abandoned.subscriptionId, days: -1, status: TransactionStatus.CANCELED, createdAt: at(-30) });
    // A partial refund leaves the purchase standing (`handleRefundReversal`).
    const partial = await subscription(expired);
    const partlyRefunded = await payment(partial, {
      subscriptionId: partial.subscriptionId,
      days: -1,
      createdAt: boughtAt,
      fulfilledAt: boughtAt,
      gatewayData: { partialRefundAt: at(-5).toISOString(), refundNeedsManualReview: true, refundedAmountTotal: '100.00' },
    });

    const kept = [granted, otherRefunded, boughtAgain, abandoned, partial];
    const census = await service.census();
    const byId = new Map(census.rows.map((row) => [row.subscriptionId, row]));
    for (const owner of kept) assert.ok(byId.has(owner.subscriptionId), `listed: ${owner.subscriptionId}`);
    assert.deepEqual(byId.get(granted.subscriptionId)!.evidence, [{ kind: 'snapshot' }]);
    assert.deepEqual(byId.get(otherRefunded.subscriptionId)!.evidence, [{ kind: 'snapshot' }]);
    assert.deepEqual(byId.get(boughtAgain.subscriptionId)!.evidence, [
      { kind: 'snapshot' },
      { kind: 'payment', paymentId: paidAgain.paymentId },
    ]);
    assert.deepEqual(byId.get(partial.subscriptionId)!.evidence, [
      { kind: 'snapshot' },
      { kind: 'payment', paymentId: partlyRefunded.paymentId },
    ]);

    const results = await restore(kept.map((owner) => owner.subscriptionId));
    for (const owner of kept) {
      assert.equal(results.get(owner.subscriptionId)?.outcome, 'restored', `restored: ${owner.subscriptionId}`);
      assert.equal((await read(owner.subscriptionId)).expiresAt, null);
    }
  });

  // ── The restore ─────────────────────────────────────────────────────────

  it('an EXPIRED row: no end, ACTIVE, the term open-ended, the add-ons that ended at the wrong date back and counted — nothing else', async () => {
    const D = at(-2);
    const owner = await subscription({ expiresAt: at(20), inModel: true });
    const term = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: owner.subscriptionId, status: 'ACTIVE' } });
    const epoch = await prisma.subscriptionResetEpoch.create({
      data: { termId: term.id, ordinal: 1, startsAt: at(-40), plannedEndsAt: D },
      select: { id: true },
    });
    const endOfTerm = term.endsAt;
    // Bought «до конца подписки»: they end with the subscription.
    const traffic = await addOn(owner, { type: AddOnType.EXTRA_TRAFFIC, value: 50, expiresAt: endOfTerm });
    const devices = await addOn(owner, { type: AddOnType.EXTRA_DEVICES, value: 2, expiresAt: endOfTerm });
    // Controls. One ends on a date of its own, earlier than the subscription's
    // (a paid upgrade leaves one so): it did not end BECAUSE of the wrong date.
    const ownEnd = at(-6);
    const ownDate = await addOn(owner, { type: AddOnType.EXTRA_TRAFFIC, value: 7, expiresAt: ownEnd });
    const refundedAfter = await addOn(owner, { type: AddOnType.EXTRA_TRAFFIC, value: 11, expiresAt: endOfTerm });
    const reversed = await addOn(owner, { type: AddOnType.EXTRA_TRAFFIC, value: 13, expiresAt: endOfTerm });
    const remediation = await addOn(owner, { type: AddOnType.EXTRA_TRAFFIC, value: 17, expiresAt: endOfTerm });
    const untilReset = await addOn(owner, {
      type: AddOnType.EXTRA_TRAFFIC,
      value: 19,
      expiresAt: D,
      lifetime: AddOnLifetime.UNTIL_NEXT_RESET,
      expiryEpochId: epoch.id,
    });
    const otherReason = await addOn(owner, { type: AddOnType.EXTRA_TRAFFIC, value: 23, expiresAt: endOfTerm });
    const otherBegin = await addOn(owner, { type: AddOnType.EXTRA_DEVICES, value: 4, expiresAt: endOfTerm });
    await recount(owner);
    assert.deepEqual(
      await read(owner.subscriptionId).then((row) => [row.trafficLimit, row.deviceLimit]),
      [100 + 50 + 7 + 11 + 13 + 17 + 19 + 23, 3 + 2 + 4],
      'self-check: every add-on counts while it lives',
    );

    // The wrong date lands, the drift sweep follows it, and D passes.
    await redate(owner, D);
    await transition(remediation, 'REMEDIATE', 'PANEL_WRITE_FAILED');
    // A writer this build does not have began this one's expiry.
    await transition(otherBegin, 'BEGIN_EXPIRY', 'ANOTHER_WRITER');
    await boundary.expireDueForSubscription(owner.subscriptionId);
    await prisma.subscription.update({ where: { id: owner.subscriptionId }, data: { status: SubscriptionStatus.EXPIRED } });
    // Refunded after it ended: the money is back, the state stays EXPIRED.
    await prisma.$transaction((tx) =>
      entitlements.recordRefundOrChargebackInTransaction(tx, {
        entitlementId: refundedAfter,
        commandKey: 'refund-record:spec',
        supportRef: `addon-refund:spec:${refundedAfter}`,
        summaryCode: 'ADDON_REFUNDED',
        correlationId: 'refund:spec',
      }),
    );
    await transition(reversed, 'REVERSE', 'OPERATOR_REVERSED', AddOnEntitlementActorType.ADMIN);
    // Ended by a writer this build does not have.
    await prisma.addOnEntitlement.update({ where: { id: otherReason }, data: { terminalReason: 'ANOTHER_WRITER' } });

    // Self-check: what the sweep left.
    const states = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries({ traffic, devices, ownDate, refundedAfter, reversed, remediation, untilReset, otherReason, otherBegin }).map(
            async ([name, id]) => [name, (await entitlement(id)).state] as const,
          ),
        ),
      );
    assert.deepEqual(await states(), {
      traffic: 'EXPIRED',
      devices: 'EXPIRING',
      ownDate: 'EXPIRED',
      refundedAfter: 'EXPIRED',
      reversed: 'REVERSED',
      remediation: 'REMEDIATION_REQUIRED',
      untilReset: 'EXPIRED',
      otherReason: 'EXPIRED',
      otherBegin: 'EXPIRING',
    });
    assert.equal((await entitlement(traffic)).expiresAt?.getTime(), D.getTime(), 'it ended at the wrong date');
    assert.equal((await entitlement(traffic)).terminalReason, 'TRAFFIC_BOUNDARY_EXPIRY');
    assert.deepEqual(await read(owner.subscriptionId).then((row) => [row.trafficLimit, row.deviceLimit]), [100, 3]);
    // The sweep queued its own push of the dropped limits.
    const sweptJobs = await jobsOf(owner.subscriptionId);

    const results = await restore([owner.subscriptionId]);
    assert.deepEqual(results.get(owner.subscriptionId), {
      subscriptionId: owner.subscriptionId,
      outcome: 'restored',
      previousExpiresAt: D.toISOString(),
      statusBefore: 'EXPIRED',
      statusAfter: 'ACTIVE',
      revivedAddOns: 2,
      syncQueued: true,
      error: null,
    });

    const after = await read(owner.subscriptionId);
    assert.equal(after.expiresAt, null, 'no end');
    assert.equal(after.status, SubscriptionStatus.ACTIVE, 'it expired only by the wrong date');
    assert.equal((after.planSnapshot as { selectedDurationDays?: number }).selectedDurationDays, -1, 'the snapshot keeps "no end"');
    assert.equal(
      (await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: owner.subscriptionId, status: 'ACTIVE' } })).endsAt,
      null,
      'the tail term is open-ended',
    );

    for (const [id, from] of [
      [traffic, AddOnEntitlementState.EXPIRED],
      [devices, AddOnEntitlementState.EXPIRING],
    ] as const) {
      const back = await entitlement(id);
      assert.equal(back.state, AddOnEntitlementState.ACTIVE, 'ended at the wrong date: back');
      assert.equal(back.expiresAt, null, 'with no end, like its subscription');
      assert.equal(back.terminalAt, null);
      assert.equal(back.terminalReason, null);
      const events = await prisma.addOnEntitlementEvent.findMany({ where: { entitlementId: id, reason: LIFETIME_RESTORED_REASON } });
      assert.equal(events.length, 1, 'one event records the revival');
      assert.equal(events[0]!.fromState, from);
      assert.equal(events[0]!.toState, AddOnEntitlementState.ACTIVE);
      assert.equal(events[0]!.actorType, AddOnEntitlementActorType.ADMIN);
      assert.equal(events[0]!.actorId, adminId);
      assert.equal(events[0]!.correlationId, `lifetime-restore:${owner.subscriptionId}`);
      assert.equal(events[0]!.commandKey, `lifetime-restore:v${back.version}`);
    }
    assert.deepEqual(
      await states(),
      {
        traffic: 'ACTIVE',
        devices: 'ACTIVE',
        ownDate: 'EXPIRED',
        refundedAfter: 'EXPIRED',
        reversed: 'REVERSED',
        remediation: 'REMEDIATION_REQUIRED',
        untilReset: 'EXPIRED',
        otherReason: 'EXPIRED',
        otherBegin: 'EXPIRING',
      },
      'its own earlier date, a refund, a reversal, a remediation, «до следующего сброса», another writer: untouched',
    );
    assert.equal((await entitlement(ownDate)).expiresAt?.getTime(), ownEnd.getTime(), 'its own date stands');

    // They count again: the projection and the columns the push sends.
    assert.deepEqual([after.trafficLimit, after.deviceLimit], [150, 5], 'the plan plus the two add-ons back');
    assert.equal(after.effectiveProjection?.desiredTrafficLimitBytes, 150n * GIB);
    assert.equal(after.effectiveProjection?.desiredDeviceLimit, 5);

    // One audit row.
    const audit = await auditOf(owner.subscriptionId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.adminUserId, adminId);
    assert.equal(audit[0]!.ipAddress, REQUEST.remoteAddress);
    assert.equal(audit[0]!.userAgent, REQUEST.userAgent);
    const jobs = await jobsSince(owner.subscriptionId, sweptJobs);
    assert.equal(jobs.length, 1, 'exactly one push');
    const { term: auditTerm, limits, revivedAddOnIds, ...facts } = audit[0]!.metadata as Record<string, unknown>;
    assert.deepEqual(facts, {
      requestId: REQUEST.requestId,
      subscriptionId: owner.subscriptionId,
      userId: owner.userId,
      previousExpiresAt: D.toISOString(),
      statusBefore: 'EXPIRED',
      statusAfter: 'ACTIVE',
      evidence: [{ kind: 'snapshot' }],
      syncJobId: jobs[0]!.id,
    });
    assert.deepEqual([...(revivedAddOnIds as string[])].sort(), [traffic, devices].sort());
    assert.deepEqual(limits, { from: { trafficLimit: 100, deviceLimit: 3 }, to: { trafficLimit: 150, deviceLimit: 5 } });
    assert.equal((auditTerm as { outcome: string }).outcome, 'ALIGNED');
    assert.equal((auditTerm as { termId: string }).termId, term.id);

    // One ordinary UPDATE, no status, queued at once — and its PATCH carries «без срока» and the add-ons.
    assert.equal(jobs[0]!.action, SyncAction.UPDATE);
    assert.equal(jobs[0]!.status, SyncJobStatus.PENDING);
    assert.equal(jobs[0]!.cause, LIFETIME_RESTORE_CAUSE);
    assert.deepEqual(jobs[0]!.payload, { source: LIFETIME_RESTORE_CAUSE }, 'no status is pushed with it');
    assert.deepEqual(enqueued, [jobs[0]!.id]);
    const sent: Array<Record<string, unknown>> = [];
    await processorFor(owner, sent).process({ data: { syncJobId: jobs[0]!.id } } as never);
    const done = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: jobs[0]!.id } });
    assert.equal(done.status, SyncJobStatus.COMPLETED, `the push completed (${done.lastError ?? ''})`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!['expireAt'], PANEL_NO_END_EXPIRE_AT, 'Remnawave gets 31.12.2099');
    assert.equal('status' in sent[0]!, false, 'and no status: Remnawave lifts the EXPIRED profile itself');
    assert.equal(sent[0]!['trafficLimitBytes'], 150 * BYTES_PER_GIB);
    assert.equal(sent[0]!['hwidDeviceLimit'], 5);
    assert.equal((await read(owner.subscriptionId)).status, SubscriptionStatus.ACTIVE);
  });

  it('DISABLED and LIMITED keep their status; a live add-on and a pending one follow the open end; a device add-on the reduction completed comes back', async () => {
    const D = at(-2);
    const disabled = await subscription({ expiresAt: at(20), inModel: true });
    const termEnd = (
      await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: disabled.subscriptionId, status: 'ACTIVE' } })
    ).endsAt;
    const devices = await addOn(disabled, { type: AddOnType.EXTRA_DEVICES, value: 1, expiresAt: termEnd });
    await recount(disabled);
    await redate(disabled, D);
    const swept = await boundary.expireDueForSubscription(disabled.subscriptionId);
    assert.equal(swept.deviceExpiryTriggered, true);
    // Nothing to reduce on this profile: the reduction completes the expiry.
    await boundary.completeUnreducibleDeviceExpiryForSubscription(disabled.subscriptionId, swept.desiredRevision!, 'NO_PANEL_PROFILE');
    assert.equal((await entitlement(devices)).state, AddOnEntitlementState.EXPIRED);
    assert.equal((await entitlement(devices)).terminalReason, 'DEVICE_REDUCTION_NOT_APPLICABLE');
    await prisma.subscription.update({ where: { id: disabled.subscriptionId }, data: { status: SubscriptionStatus.DISABLED } });

    const limited = await subscription({ expiresAt: D, status: SubscriptionStatus.LIMITED });

    // Re-dated to a date still ahead: nothing ended yet.
    const ahead = at(10);
    const live = await subscription({ expiresAt: ahead, termEndsAt: ahead, inModel: true });
    const active = await addOn(live, { type: AddOnType.EXTRA_TRAFFIC, value: 5, expiresAt: ahead });
    const pending = await addOn(live, {
      type: AddOnType.EXTRA_TRAFFIC,
      value: 6,
      expiresAt: ahead,
      activatedAt: at(1),
      state: AddOnEntitlementState.PENDING_ACTIVATION,
    });

    const results = await restore([disabled.subscriptionId, limited.subscriptionId, live.subscriptionId]);
    assert.equal(results.get(disabled.subscriptionId)?.outcome, 'restored');
    assert.equal(results.get(disabled.subscriptionId)?.statusAfter, 'DISABLED');
    assert.equal(results.get(disabled.subscriptionId)?.revivedAddOns, 1);
    assert.equal(results.get(limited.subscriptionId)?.statusAfter, 'LIMITED');
    assert.equal(results.get(live.subscriptionId)?.revivedAddOns, 0, 'nothing had ended');

    const disabledAfter = await read(disabled.subscriptionId);
    assert.deepEqual([disabledAfter.status, disabledAfter.expiresAt], [SubscriptionStatus.DISABLED, null], 'DISABLED stays DISABLED');
    assert.equal((await entitlement(devices)).state, AddOnEntitlementState.ACTIVE, 'completed by the reduction at the wrong date: back');
    assert.equal(disabledAfter.deviceLimit, 4, 'and counted');
    const limitedAfter = await read(limited.subscriptionId);
    assert.deepEqual([limitedAfter.status, limitedAfter.expiresAt], [SubscriptionStatus.LIMITED, null], 'LIMITED stays LIMITED');
    assert.equal(
      ((await auditOf(limited.subscriptionId))[0]!.metadata as { term: { outcome: string } }).term.outcome,
      'NOT_IN_MODEL',
      'a subscription that never had a term stays outside the model',
    );

    const liveAfter = await read(live.subscriptionId);
    assert.deepEqual([liveAfter.status, liveAfter.expiresAt], [SubscriptionStatus.ACTIVE, null]);
    assert.equal(
      (await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: live.subscriptionId, status: 'ACTIVE' } })).endsAt,
      null,
    );
    for (const id of [active, pending]) {
      const followed = await entitlement(id);
      assert.equal(followed.expiresAt, null, 'an add-on «до конца подписки» that has not ended follows the open end');
      const moved = await prisma.addOnEntitlementEvent.findFirstOrThrow({ where: { entitlementId: id, reason: LIFETIME_RESTORED_REASON } });
      assert.equal(moved.actorType, AddOnEntitlementActorType.ADMIN);
      assert.equal(moved.correlationId, `lifetime-restore:${live.subscriptionId}`);
    }
    assert.equal((await entitlement(active)).state, AddOnEntitlementState.ACTIVE);
    assert.equal((await entitlement(pending)).state, AddOnEntitlementState.PENDING_ACTIVATION);
  });

  it('pushes once for a linked row, never for an unlinked one; a second press does nothing', async () => {
    const linked = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.EXPIRED });
    const unlinked = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.EXPIRED, unlinked: true });

    const first = await restore([linked.subscriptionId, unlinked.subscriptionId]);
    assert.equal(first.get(linked.subscriptionId)?.syncQueued, true);
    assert.equal(first.get(unlinked.subscriptionId)?.outcome, 'restored');
    assert.equal(first.get(unlinked.subscriptionId)?.syncQueued, false);
    assert.deepEqual(await jobsOf(unlinked.subscriptionId), [], 'no profile to tell: no push');
    assert.equal((await read(unlinked.subscriptionId)).expiresAt, null);
    const linkedJobs = await jobsOf(linked.subscriptionId);
    assert.equal(linkedJobs.length, 1);
    assert.deepEqual(enqueued, [linkedJobs[0]!.id]);
    assert.equal(
      ((await auditOf(unlinked.subscriptionId))[0]!.metadata as { syncJobId: string | null }).syncJobId,
      null,
    );

    enqueued.length = 0;
    const second = await restore([linked.subscriptionId]);
    assert.deepEqual(second.get(linked.subscriptionId), {
      subscriptionId: linked.subscriptionId,
      outcome: 'alreadyLifetime',
      previousExpiresAt: null,
      statusBefore: 'ACTIVE',
      statusAfter: 'ACTIVE',
      revivedAddOns: 0,
      syncQueued: false,
      error: null,
    });
    assert.equal((await jobsOf(linked.subscriptionId)).length, 1, 'no second push');
    assert.deepEqual(enqueued, []);
    assert.equal((await auditOf(linked.subscriptionId)).length, 1, 'and no second audit row');
  });

  it('refuses a row whose evidence is gone, a DELETED row and an unknown id — and writes nothing for them', async () => {
    const dated = { id: datedPlan, name: 'Месячный', selectedDurationDays: 30 };
    const gone = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.EXPIRED, snapshot: dated });
    const noEnd = await payment(gone, { subscriptionId: gone.subscriptionId, days: -1, createdAt: at(-40) });
    assert.ok(
      (await service.census()).rows.some((row) => row.subscriptionId === gone.subscriptionId),
      'self-check: it was on the list',
    );
    // Refunded since the operator's list was read.
    await prisma.transaction.update({ where: { id: noEnd.id }, data: { status: 'REFUNDED' } });
    const deleted = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.DELETED });

    const results = await restore([gone.subscriptionId, deleted.subscriptionId, 'no-such-subscription']);
    assert.equal(results.get(gone.subscriptionId)?.outcome, 'notEligible');
    assert.equal(results.get(gone.subscriptionId)?.previousExpiresAt, (await read(gone.subscriptionId)).expiresAt?.toISOString());
    assert.equal(results.get(deleted.subscriptionId)?.outcome, 'deleted');
    assert.equal(results.get(deleted.subscriptionId)?.statusBefore, 'DELETED');
    assert.deepEqual(results.get('no-such-subscription'), {
      subscriptionId: 'no-such-subscription',
      outcome: 'notFound',
      previousExpiresAt: null,
      statusBefore: null,
      statusAfter: null,
      revivedAddOns: 0,
      syncQueued: false,
      error: null,
    });
    for (const [owner, status] of [
      [gone, SubscriptionStatus.EXPIRED],
      [deleted, SubscriptionStatus.DELETED],
    ] as const) {
      const row = await read(owner.subscriptionId);
      assert.equal(row.status, status, 'unchanged');
      assert.notEqual(row.expiresAt, null, 'still dated');
      assert.deepEqual(await jobsOf(owner.subscriptionId), []);
      assert.deepEqual(await auditOf(owner.subscriptionId), []);
    }
    assert.deepEqual(enqueued, []);
  });

  it('one failing id does not stop the others, and nothing is written for it', async () => {
    const first = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.EXPIRED });
    const failing = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.EXPIRED });
    const last = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.EXPIRED });
    failFor.add(failing.subscriptionId);

    const results = await restore([first.subscriptionId, failing.subscriptionId, last.subscriptionId]);
    assert.equal(results.get(first.subscriptionId)?.outcome, 'restored');
    assert.equal(results.get(last.subscriptionId)?.outcome, 'restored');
    assert.deepEqual(results.get(failing.subscriptionId), {
      subscriptionId: failing.subscriptionId,
      outcome: 'failed',
      previousExpiresAt: null,
      statusBefore: null,
      statusAfter: null,
      revivedAddOns: 0,
      syncQueued: false,
      error: 'The term model is unavailable for this subscription',
    });
    const row = await read(failing.subscriptionId);
    assert.equal(row.status, SubscriptionStatus.EXPIRED, 'rolled back');
    assert.notEqual(row.expiresAt, null, 'rolled back: the date written before the failure is gone');
    assert.deepEqual(await jobsOf(failing.subscriptionId), []);
    assert.deepEqual(await auditOf(failing.subscriptionId), []);
    assert.equal((await read(last.subscriptionId)).expiresAt, null);
    assert.equal(enqueued.length, 2, 'the two others pushed');
  });

  it('a transaction PostgreSQL aborted on a conflict is run again, whole', async () => {
    const owner = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.EXPIRED });
    conflictOnce.add(owner.subscriptionId);

    const results = await restore([owner.subscriptionId]);
    assert.equal(results.get(owner.subscriptionId)?.outcome, 'restored');
    assert.deepEqual(hookCalls, [owner.subscriptionId, owner.subscriptionId], 'the second attempt from the start');
    assert.deepEqual([(await read(owner.subscriptionId)).expiresAt, (await auditOf(owner.subscriptionId)).length], [null, 1]);
    assert.equal((await jobsOf(owner.subscriptionId)).length, 1, 'the first attempt left nothing behind');
  });

  it('a row whose terms are all closed is restored on its columns: ensureTerm mints nothing beside them', async () => {
    const owner = await subscription({ expiresAt: at(-2), status: SubscriptionStatus.EXPIRED, inModel: true, termEndsAt: at(20) });
    // Not reachable through the product — the boundary sweep never closes a
    // term, only a successor's activation and a deletion do — so made by hand.
    await prisma.subscriptionTerm.updateMany({
      where: { subscriptionId: owner.subscriptionId, status: 'ACTIVE' },
      data: { status: SubscriptionTermStatus.ENDED, endedAt: at(-1) },
    });
    const ensured = await prisma.$transaction((tx) =>
      new EntitlementCutoverService(prisma, terms, projections).ensureTermInTransaction(tx, owner.subscriptionId),
    );
    assert.deepEqual([ensured.outcome, ensured.activeTermId], ['EXISTING', null], 'no fresh term beside closed ones');

    const results = await restore([owner.subscriptionId]);
    assert.equal(results.get(owner.subscriptionId)?.outcome, 'restored');
    const row = await read(owner.subscriptionId);
    assert.deepEqual([row.status, row.expiresAt], [SubscriptionStatus.ACTIVE, null]);
    assert.equal(
      ((await auditOf(owner.subscriptionId))[0]!.metadata as { term: { outcome: string } }).term.outcome,
      'NO_ACTIVE_TERM',
    );
    assert.equal(
      await prisma.subscriptionTerm.count({ where: { subscriptionId: owner.subscriptionId, status: 'ACTIVE' } }),
      0,
      'nothing minted',
    );
  });
});
