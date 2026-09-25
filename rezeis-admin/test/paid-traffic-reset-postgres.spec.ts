import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus, type Transaction } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { TrafficResetService } from '../src/modules/add-ons/services/traffic-reset.service';
import { AddOnRefundService } from '../src/modules/payments/services/addon-refund.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentWebhookInboxService } from '../src/modules/payments/services/payment-webhook-inbox.service';
import { SavedPaymentMethodService } from '../src/modules/payments/services/saved-payment-method.service';
import { PAID_TRAFFIC_RESET_CAUSE } from '../src/modules/payments/utils/add-on-not-applied.util';
import { DuplicateSubscriptionMergeService } from '../src/modules/profile-sync/duplicate-subscription-merge.service';
import { PROFILE_SYNC_MAX_ATTEMPTS } from '../src/modules/profile-sync/profile-sync.constants';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * A PAID «ОБНУЛИТЬ ТРАФИК» IS NEVER A LOG LINE (FX5a follow-up), on PostgreSQL.
 *
 * It used to be: a reset Remnawave did not perform after the money came was
 * logged, and the customer — told the purchase went through — heard nothing.
 * Now the capture writes the reset's TRAFFIC_RESET job with the payment, HELD,
 * and performs it right after the commit:
 *
 *  - performed: the sale, once;
 *  - Remnawave out of reach: nothing yet — the job is released to the
 *    profile-sync machinery, its worker performs it, and the settle announces
 *    the sale once; or, when it fails for good, the operator's ONE card
 *    «Платёж получен, но не применён» (the worker sends no generic one for it)
 *    and the customer's notice;
 *  - never performable (no profile in Remnawave): that card and that notice at
 *    once;
 *  - a capture that died before its reset leaves the held job, and the settle
 *    performs it.
 *
 * Every outcome is claimed on the job row, so two settles running together
 * announce it once. And (review R5):
 *
 *  - a FULL refund closes a reset not performed yet, in one statement against
 *    whoever would perform it — the capture's run, the worker, the settle —
 *    so exactly one of the two wins; nothing performs a closed job, and a
 *    refunded payment is told nothing: no sale, no «Верните деньги», no
 *    notice. The refund's card says what it read: performed, closed by it, or
 *    in flight. A partial refund keeps the reset (R5-01);
 *  - one job the settle fails to settle or to tell takes no other job down,
 *    and is told by the next settle, once (R5-02);
 *  - a duplicate merged while it owes a paid reset hands the reset on to the
 *    survivor with its payment (R5-04);
 *  - what the job tells is decided before it goes out, only while the payment
 *    is COMPLETED and holding its row; the refund reads that decision after
 *    the payment turns CANCELED, so a sale told is refunded in public and a
 *    sale not told to the operator alone — in full or in part (R5-07, R5-09);
 *  - a refund that could not read the reset says so, asks for review, and
 *    stays the operator's (R5-08).
 *
 * Rows are this spec's own (the `prefix`), removed after. Skipped without
 * TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `paidreset-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';

interface Emitted {
  readonly severity: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

interface Notice {
  readonly userId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface Owner {
  readonly userId: string;
  readonly subscriptionId: string;
  /** Its Remnawave profile's numeric id, or `null` when it has none. */
  readonly panelId: number | null;
}

/** «Отметить возврат» is for a provider the panel cannot refund through: Platega. ЮKassa's refunds come as its notices. */
type Gateway = 'YOOKASSA' | 'PLATEGA';

type PanelAnswer = Record<string, unknown>;

const OK = (): PanelAnswer => ({ kind: 'ok', data: { response: {} } });
const UNREACHABLE: PanelAnswer = { kind: 'network', detail: 'connect ECONNREFUSED 10.0.0.9:3000' };
const REFUSED: PanelAnswer = {
  kind: 'rejected',
  status: 400,
  code: 'A001',
  detail: 'Traffic reset is not allowed for this user',
  retryAfterMs: null,
};

/** The refund card's words for a paid reset (`AddOnRefundService`): performed, closed by the refund, in flight. */
const PERFORMED_NOTE = 'Сброс трафика по докупке «сброс трафика» уже выполнен — отменить его нельзя.';
const CLOSED_NOTE = 'Сброс трафика по докупке «сброс трафика» не был выполнен и уже не будет — его отменил возврат.';
const IN_FLIGHT_NOTE =
  'Сброс трафика по докупке «сброс трафика» выполняется прямо сейчас: выполнен он или нет, ' +
  'проверьте трафик подписчика в Remnawave.';
/** …when the refund could not read the reset at all (R5-08). */
const NOT_CHECKED_NOTE =
  'Сброс трафика по докупке «сброс трафика»: проверить, выполнен ли он, не удалось — проверьте трафик подписчика в Remnawave.';
/** …and for one paid before this release, with no job and no record of a reset. */
const NOT_PERFORMED_NOTE = 'Сброс трафика по докупке «сброс трафика» не был выполнен — отменять нечего.';

let prisma: PrismaService;
let cutover: EntitlementCutoverService;
let fulfilment: PaymentSubscriptionMutationService;
/** A second fulfilment over the same database: the other worker, the other tick. */
let otherFulfilment: PaymentSubscriptionMutationService;
let worker: ProfileSyncProcessor;
let reconciliation: PaymentReconciliationService;
let refunds: PaymentRefundService;

/** The refund's two doors — «Отметить возврат» and a provider's notice — over one `AddOnRefundService`. */
interface RefundDoors {
  readonly refunds: PaymentRefundService;
  readonly reconciliation: PaymentReconciliationService;
}

/**
 * The refund's doors over the given `AddOnRefundService` — the real one, one
 * held, one that fails — and the reversal over `client` (the database, unless
 * a case holds it).
 */
let refundsOver: (addOnRefunds: unknown, client?: PrismaService) => RefundDoors;
/** The add-on refund over the given client. */
let addOnRefundsOver: (client: PrismaService) => AddOnRefundService;
/** A fulfilment over the given client: the database, or one that fails where a case says. */
let fulfilmentOver: (client: PrismaService) => PaymentSubscriptionMutationService;
/** The profile-sync worker over the given client. */
let workerOver: (client: PrismaService) => ProfileSyncProcessor;
const emitted: Emitted[] = [];
const notices: Notice[] = [];
/**
 * What Remnawave answers to each reset, in order (`OK` once they run out), and
 * a door a case may hold a reset at, inside the call.
 */
const panel = {
  answers: [] as PanelAnswer[],
  calls: [] as number[],
  hold: null as (() => Promise<void>) | null,
};
const created = { users: [] as string[], addOns: [] as string[], admins: [] as string[], webhookEvents: [] as string[] };
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function recorder(severity: string) {
  return (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
    emitted.push({ severity, type, message, metadata });
  };
}

/** A door a case opens: `reached` once somebody waits at it. */
interface Door {
  readonly wait: () => Promise<void>;
  readonly reached: Promise<void>;
  readonly open: () => void;
}

/** `promise`, or a failure after `ms`: a door nobody reaches fails the case instead of hanging it. */
async function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} — not within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function door(): Door {
  let open!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return {
    wait: () => {
      arrive();
      return opened;
    },
    reached,
    open,
  };
}

async function newOwner(options: { readonly linked?: boolean } = {}): Promise<Owner> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  created.users.push(userId);
  const panelId = 880_000 + next();
  const row = await prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: {
        id: `${prefix}-plan`,
        name: 'Pro',
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'MONTH',
      } as Prisma.InputJsonValue,
      trafficLimit: 100,
      deviceLimit: 3,
      ...(options.linked === false ? {} : { remnawaveId: String(panelId), remnawavePanelId: panelId }),
      createdAt: inDays(-10),
      startedAt: inDays(-10),
      expiresAt: inDays(20),
    },
    select: { id: true },
  });
  await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, row.id));
  return { userId, subscriptionId: row.id, panelId: options.linked === false ? null : panelId };
}

async function resetAddOn(): Promise<string> {
  const id = `${prefix}-reset-${next()}`;
  await prisma.addOn.create({
    data: { id, name: 'Обнулить трафик', type: 'RESET_TRAFFIC', value: 1, prices: { create: [{ currency: 'RUB', price: '99' }] } },
  });
  created.addOns.push(id);
  return id;
}

/** A paid «Обнулить трафик», its money in: the row the payment webhook fulfils. */
async function paidReset(owner: Owner, addOnId: string, amount = '99', gateway: Gateway = 'YOOKASSA'): Promise<Transaction> {
  return prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: null,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: gateway,
      currency: 'RUB',
      amount: new Prisma.Decimal(amount),
      planSnapshot: {
        snapshotSource: 'ADDON_PURCHASE',
        targetSubscriptionId: owner.subscriptionId,
        addOnId,
        addOnType: 'RESET_TRAFFIC',
        addOnValue: 1,
        name: 'Обнулить трафик',
        sourceLineKey: addOnId,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        contractVersion: 2,
      } as Prisma.InputJsonValue,
    },
  });
}

/** A paid reset Remnawave could not be reached for at the capture: RELEASED to the profile-sync machinery. */
async function releasedReset(
  options: { readonly owner?: Owner; readonly gateway?: Gateway } = {},
): Promise<{ readonly owner: Owner; readonly paid: Transaction; readonly jobId: string }> {
  const owner = options.owner ?? (await newOwner());
  const paid = await paidReset(owner, await resetAddOn(), '99', options.gateway);
  panel.answers = [UNREACHABLE];
  await fulfilment.applyCompletedTransaction(paid);
  const job = await jobOf(paid.id);
  assert.equal(job.status, SyncJobStatus.PENDING, 'fixture: released');
  assert.equal(job.supersededAt, null, 'fixture: released');
  return { owner, paid, jobId: job.id };
}

/**
 * What a capture that died after its commit leaves, written as the capture
 * writes it: the payment fulfilled, the job HELD — PENDING before its run's
 * attempt, RUNNING inside it — and no reset recorded, no card.
 */
async function heldByDeadCapture(owner: Owner, paid: Transaction, addOnId: string, status: SyncJobStatus) {
  const committedAt = new Date(Date.now() - 20 * MINUTE_MS);
  await prisma.transaction.update({
    where: { id: paid.id },
    data: { subscriptionId: owner.subscriptionId, fulfilledAt: committedAt },
  });
  return prisma.profileSyncJob.create({
    data: {
      subscriptionId: owner.subscriptionId,
      action: SyncAction.TRAFFIC_RESET,
      status,
      cause: PAID_TRAFFIC_RESET_CAUSE,
      supersededAt: committedAt,
      createdAt: committedAt,
      ...(status === SyncJobStatus.RUNNING ? { startedAt: new Date(committedAt.getTime() + 1_000) } : {}),
      payload: {
        source: PAID_TRAFFIC_RESET_CAUSE,
        paymentId: paid.paymentId,
        transactionId: paid.id,
        addOnId,
        held: true,
      },
    },
  });
}

async function jobOf(transactionId: string) {
  const job = await prisma.profileSyncJob.findFirst({
    where: { cause: PAID_TRAFFIC_RESET_CAUSE, payload: { path: ['transactionId'], equals: transactionId } },
  });
  assert.ok(job, `no paid reset job for ${transactionId}`);
  return job;
}

/** The resets Remnawave was asked for on this owner's profile. */
function callsFor(owner: Owner): number {
  return panel.calls.filter((userId) => userId === owner.panelId).length;
}

async function jobById(jobId: string) {
  return prisma.profileSyncJob.findUniqueOrThrow({ where: { id: jobId } });
}

function payloadOf(job: { readonly payload: unknown }): Record<string, unknown> {
  return job.payload as Record<string, unknown>;
}

async function resetsOf(transactionId: string) {
  return prisma.subscriptionTrafficReset.findMany({ where: { transactionId } });
}

/** Every card this payment raised: a sale, a sale with a note, not applied, a refund. */
function cardsOf(paymentId: string): Emitted[] {
  return emitted.filter((event) => event.metadata['paymentId'] === paymentId);
}

const REFUND_CARDS: readonly string[] = [
  EVENT_TYPES.PAYMENT_REFUNDED,
  EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED,
  EVENT_TYPES.PAYMENT_REFUND_PARTIAL,
];

/** The refund's own cards for this payment. */
function refundCardsOf(paymentId: string): Emitted[] {
  return cardsOf(paymentId).filter((event) => REFUND_CARDS.includes(event.type));
}

/** What the reset itself told for this payment: the sale, or «Верните деньги». */
function tellingsOf(paymentId: string): string[] {
  return cardsOf(paymentId)
    .filter((event) => !REFUND_CARDS.includes(event.type))
    .map((event) => event.type);
}

/** The words a refund card opens with (an autopay's line may follow them). */
function noteOf(card: Emitted | undefined): string {
  return String(card?.metadata['note'] ?? '');
}

function noticesOf(paymentId: string): Notice[] {
  return notices.filter((notice) => notice.payload['paymentId'] === paymentId);
}

async function stampOf(transactionId: string): Promise<unknown> {
  const row = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
  return ((row.gatewayData as Record<string, unknown> | null)?.['addOnNotApplied'] as Record<string, unknown> | undefined)?.[
    'reason'
  ];
}

/** The profile-sync worker, on the job — the attempt the sweep would re-drive. */
async function work(jobId: string, by: ProfileSyncProcessor = worker): Promise<unknown> {
  return by.process({ data: { syncJobId: jobId } } as never).then(
    () => null,
    (error: unknown) => error,
  );
}

async function newAdmin(): Promise<string> {
  const login = `${prefix}-admin-${next()}`;
  const admin = await prisma.adminUser.create({
    data: { login, loginNormalized: login, passwordHash: 'not-a-real-hash' },
    select: { id: true },
  });
  created.admins.push(admin.id);
  return admin.id;
}

/** «Отметить возврат»: the operator records the full refund they made at the provider. */
async function refundInFull(
  transactionId: string,
  adminId?: string,
  through: RefundDoors = { refunds, reconciliation },
): Promise<void> {
  const by = adminId ?? (await newAdmin());
  await through.refunds.recordProviderRefund({
    transactionId,
    currentAdmin: { id: by } as never,
    requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
  });
  await through.reconciliation.settleAfterResponse();
}

/**
 * The refund's doors held at `afterClose` right after the add-on refund's own
 * step — its close of the reset — and before the payment turns CANCELED.
 */
function refundsHeldAfterClose(afterClose: Door): RefundDoors {
  const real = addOnRefundsOver(prisma);
  const held = new Proxy(real, {
    get(target, prop) {
      if (prop !== 'endForRefund') return passThrough(target, prop);
      return async (...args: Parameters<AddOnRefundService['endForRefund']>) => {
        const outcome = await target.endForRefund(...args);
        await afterClose.wait();
        return outcome;
      };
    },
  });
  return refundsOver(held);
}

/**
 * The refund's doors over a database that fails ONCE where the case says — a
 * dropped connection: the add-on refund's transaction (`transactions`), or
 * its read of whether the reset's sale was told (`saleReads`).
 */
function refundsFailingOnce(fail: { readonly transactions?: boolean; readonly saleReads?: boolean }): RefundDoors {
  const spent = new Set<string>();
  const failOnce = (key: string): void => {
    if (spent.has(key)) return;
    spent.add(key);
    throw new Error('Connection terminated unexpectedly (simulated)');
  };
  const flaky = new Proxy(prisma, {
    get(target, prop) {
      if (prop === '$transaction' && fail.transactions === true) {
        return async (...args: unknown[]) => {
          failOnce('transaction');
          const run = Reflect.get(target, '$transaction', target) as (...more: unknown[]) => unknown;
          return Reflect.apply(run, target, args);
        };
      }
      if (prop === '$queryRaw' && fail.saleReads === true) {
        return async (query: Prisma.Sql, ...rest: unknown[]) => {
          if (String(query.sql).includes("'announcedAs'")) failOnce('sale-read');
          const raw = Reflect.get(target, '$queryRaw', target) as (...more: unknown[]) => unknown;
          return Reflect.apply(raw, target, [query, ...rest]);
        };
      }
      return passThrough(target, prop);
    },
  });
  return refundsOver(addOnRefundsOver(flaky));
}

/** The refund's doors held at `atCancel` right before the payment is written CANCELED. */
function refundsHeldAtCancel(atCancel: Door): RefundDoors {
  const held = new Proxy(prisma, {
    get(target, prop) {
      if (prop !== '$executeRaw') return passThrough(target, prop);
      return async (query: Prisma.Sql, ...rest: unknown[]) => {
        const values: readonly unknown[] = Array.isArray(query.values) ? query.values : [];
        if (String(query.sql).includes('UPDATE "transactions"') && values.includes('CANCELED')) await atCancel.wait();
        const raw = Reflect.get(target, '$executeRaw', target) as (...args: unknown[]) => unknown;
        return Reflect.apply(raw, target, [query, ...rest]);
      };
    },
  });
  return refundsOver(addOnRefundsOver(prisma), held);
}

/** Whether a backend is waiting on a lock `pid` holds, within `ms`. */
async function waitUntilBlockedBy(pid: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const [found] = await prisma.$queryRaw<Array<{ readonly n: number }>>(
      Prisma.sql`SELECT count(*)::int AS "n" FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`,
    );
    if ((found?.n ?? 0) > 0) return true;
    await sleep(25);
  }
  return false;
}

/** ЮKassa's notice of a refund of `value` of the payment: a partial one. */
async function refundPartly(paid: Transaction, value: string): Promise<void> {
  const event = await prisma.paymentWebhookEvent.create({
    data: {
      gatewayType: 'YOOKASSA',
      paymentId: paid.paymentId,
      providerEventId: `${prefix}-evt-${next()}`,
      eventStatus: 'REFUNDED',
      rawPayload: { object: { id: `${prefix}-refund-${counter}`, amount: { value, currency: 'RUB' } } },
    },
    select: { id: true },
  });
  created.webhookEvents.push(event.id);
  await reconciliation.reconcileWebhookEvent(event.id);
  await reconciliation.settleAfterResponse();
}

/** A property of `target`, its methods bound to it. */
function passThrough(target: object, prop: string | symbol): unknown {
  const value: unknown = Reflect.get(target, prop, target);
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * The worker, stopped at `stop` right before it asks whether the payment is
 * still paid: after its claim, before its call to Remnawave.
 */
function workerStoppedBeforeItsCall(stop: Door): ProfileSyncProcessor {
  const stopped = new Proxy(prisma, {
    get(target, prop) {
      if (prop !== '$queryRaw') return passThrough(target, prop);
      return async (query: Prisma.Sql, ...rest: unknown[]) => {
        if (String(query.sql).includes('the payment was refunded before the reset')) await stop.wait();
        const raw = Reflect.get(target, '$queryRaw', target) as (...args: unknown[]) => unknown;
        return Reflect.apply(raw, target, [query, ...rest]);
      };
    },
  });
  return workerOver(stopped);
}

/**
 * A fulfilment whose telling is held at `hold` inside its decision — after it
 * took the payment's row (`FOR SHARE`), before it records what it tells —
 * with the backend holding that row reported to `heldBy`.
 */
function fulfilmentWithTellingHeld(hold: Door, heldBy: (pid: number) => void): PaymentSubscriptionMutationService {
  const inTransaction = (tx: object) =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop !== '$queryRaw') return passThrough(target, prop);
        const raw = Reflect.get(target, '$queryRaw', target) as (...args: unknown[]) => Promise<unknown>;
        return async (query: Prisma.Sql, ...rest: unknown[]) => {
          const result = await Reflect.apply(raw, target, [query, ...rest]);
          const sql = String(query.sql);
          if (sql.includes('FROM "transactions"') && sql.includes('FOR SHARE')) {
            const [backend] = (await Reflect.apply(raw, target, [Prisma.sql`SELECT pg_backend_pid() AS "pid"`])) as Array<{
              readonly pid: number;
            }>;
            heldBy(backend!.pid);
            await hold.wait();
          }
          return result;
        };
      },
    });
  const held = new Proxy(prisma, {
    get(target, prop) {
      if (prop !== '$transaction') return passThrough(target, prop);
      return (work: unknown, options?: unknown) =>
        typeof work === 'function'
          ? target.$transaction((tx) => (work as (client: unknown) => Promise<unknown>)(inTransaction(tx)), options as never)
          : target.$transaction(work as never, options as never);
    },
  });
  return fulfilmentOver(held);
}

/**
 * A fulfilment over the database that fails ONCE where the case says — a
 * dropped connection: the read of a payment (`reads`, by its row id), the
 * settle transaction of a job (`settles`), the claim on telling a job again
 * (`claims`, both by the job's id), or the first record that a job was told
 * (`failFirstMark`).
 */
function flakyFulfilment(fail: {
  readonly reads?: readonly string[];
  readonly settles?: readonly string[];
  readonly claims?: readonly string[];
  readonly failFirstMark?: boolean;
}): PaymentSubscriptionMutationService {
  const spent = new Set<string>();
  const failOnce = (key: string): void => {
    if (spent.has(key)) return;
    spent.add(key);
    throw new Error('Connection terminated unexpectedly (simulated)');
  };
  const inTransaction = (tx: object) =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop !== '$queryRaw') return passThrough(target, prop);
        return async (query: Prisma.Sql, ...rest: unknown[]) => {
          const values: readonly unknown[] = Array.isArray(query.values) ? query.values : [];
          const job = (fail.settles ?? []).find((id) => values.includes(id));
          if (job !== undefined) failOnce(`settle:${job}`);
          const raw = Reflect.get(target, '$queryRaw', target) as (...args: unknown[]) => unknown;
          return Reflect.apply(raw, target, [query, ...rest]);
        };
      },
    });
  const flaky = new Proxy(prisma, {
    get(target, prop) {
      if (prop === 'transaction') {
        return new Proxy(target.transaction, {
          get(delegate, method) {
            if (method !== 'findUnique') return passThrough(delegate, method);
            return async (args: { readonly where?: { readonly id?: string } }) => {
              const id = args.where?.id;
              if (id !== undefined && (fail.reads ?? []).includes(id)) failOnce(`read:${id}`);
              return delegate.findUnique(args as never);
            };
          },
        });
      }
      if (prop === '$queryRaw') {
        return async (query: Prisma.Sql, ...rest: unknown[]) => {
          const values: readonly unknown[] = Array.isArray(query.values) ? query.values : [];
          const job = (fail.claims ?? []).find((id) => values.includes(id));
          if (job !== undefined) failOnce(`claim:${job}`);
          const raw = Reflect.get(target, '$queryRaw', target) as (...args: unknown[]) => unknown;
          return Reflect.apply(raw, target, [query, ...rest]);
        };
      }
      if (prop === '$executeRaw') {
        return async (query: Prisma.Sql, ...rest: unknown[]) => {
          if (fail.failFirstMark === true && String(query.sql).includes("'announcedAt'")) failOnce('mark');
          const raw = Reflect.get(target, '$executeRaw', target) as (...args: unknown[]) => unknown;
          return Reflect.apply(raw, target, [query, ...rest]);
        };
      }
      if (prop === '$transaction') {
        return (work: unknown, options?: unknown) =>
          typeof work === 'function'
            ? target.$transaction(
                (tx) => (work as (client: unknown) => Promise<unknown>)(inTransaction(tx)),
                options as never,
              )
            : target.$transaction(work as never, options as never);
      }
      return passThrough(target, prop);
    },
  });
  return fulfilmentOver(flaky);
}

/**
 * One duplicate pair, as the 2.x → 3.x identity split leaves it
 * (`duplicate-merge-cutover-postgres.spec.ts`): the OLDER row holds a dead
 * uuid, the NEWER one the live profile — the one the customer paid to reset.
 */
async function duplicatePair(): Promise<{
  readonly userId: string;
  readonly survivorId: string;
  readonly duplicateId: string;
  readonly panelId: number;
}> {
  const userId = `${prefix}-user-${next()}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
  created.users.push(userId);
  const panelId = 880_000 + next();
  const common = {
    userId,
    status: SubscriptionStatus.ACTIVE,
    trafficLimit: 100,
    deviceLimit: 3,
    expiresAt: inDays(20),
    remnawavePanelUsername: `${prefix}-${panelId}`,
  };
  const survivor = await prisma.subscription.create({
    data: {
      ...common,
      planSnapshot: { id: `${prefix}-plan`, name: 'Pro', trafficLimitStrategy: 'MONTH' } as Prisma.InputJsonValue,
      createdAt: inDays(-400),
      remnawaveId: DEAD_UUID,
      configUrl: `https://sub.example.test/OLD${panelId}`,
    },
    select: { id: true },
  });
  const duplicate = await prisma.subscription.create({
    data: {
      ...common,
      planSnapshot: { importedFrom: 'remnawave', trafficLimitStrategy: 'MONTH' } as Prisma.InputJsonValue,
      createdAt: inDays(-2),
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      configUrl: `https://sub.example.test/NEW${panelId}`,
    },
    select: { id: true },
  });
  return { userId, survivorId: survivor.id, duplicateId: duplicate.id, panelId };
}

/** «Слияние подписок-дубликатов» of the pair: both halves resolve to the one profile, which names this customer. */
async function mergeDuplicate(pair: Awaited<ReturnType<typeof duplicatePair>>): Promise<void> {
  const lookup = {
    resolveUser: async () => ({ kind: 'ok', data: { response: { id: pair.panelId, shortUuid: null, username: null } } }),
    getUserById: async () => ({
      kind: 'ok',
      data: { response: { description: `reiwa_id: ${pair.userId}`, username: 'profile' } },
    }),
  };
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const report = await new DuplicateSubscriptionMergeService(prisma, lookup as never, {} as never, silent as never).merge({
    dryRun: false,
    pairs: [{ survivorSubscriptionId: pair.survivorId, duplicateSubscriptionId: pair.duplicateId }],
  });
  const row = report.rows[0];
  assert.equal(row?.outcome, 'merged', row?.reason ?? 'no row');
}

run('a paid «Обнулить трафик» is never a log line (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '6';
    mock.method(Logger.prototype, 'log', () => undefined);
    mock.method(Logger.prototype, 'warn', () => undefined);
    prisma = new PrismaService();
    await prisma.$connect();
    const terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    const events = { info: recorder('INFO'), warn: recorder('WARNING'), error: recorder('ERROR'), emit: () => undefined };
    const panelUsers = {
      resetTraffic: async (userId: number) => {
        panel.calls.push(userId);
        const hold = panel.hold;
        if (hold !== null) await hold();
        return panel.answers.shift() ?? OK();
      },
    };
    const userNotifications = {
      create: async (notice: Notice) => {
        notices.push(notice);
        return `notice-${notices.length}`;
      },
    };
    const switches = { flags: async () => resolveAddOnRolloutFlags({ durableAccounting: true }, {}) };
    fulfilmentOver = (client) =>
      new PaymentSubscriptionMutationService(
        client,
        events as never,
        new AddOnEntitlementService(),
        projection,
        terms,
        new TrafficResetService(prisma, panelUsers as never),
        cutover,
        switches as never,
        userNotifications as never,
      );
    workerOver = (client) => new ProfileSyncProcessor(client, panelUsers as never, {} as never, events as never);
    fulfilment = fulfilmentOver(prisma);
    otherFulfilment = fulfilmentOver(prisma);
    worker = workerOver(prisma);
    // The refund's doors, as `addon-refund-postgres.spec.ts` builds them: the
    // reversal's other hooks are doubles; the add-on's end is the real one.
    const syncQueue = { enqueue: async () => undefined };
    addOnRefundsOver = (client) =>
      new AddOnRefundService(client, new AddOnEntitlementService(), projection, syncQueue as never);
    refundsOver = (addOnRefunds, client = prisma) => {
      const doors = new PaymentReconciliationService(
        client,
        new PaymentWebhookInboxService(prisma),
        fulfilment,
        { notifyWebhookFailed: async () => undefined } as never,
        { reverseEarningsForTransaction: async () => 0 } as never,
        { reverseQualificationForTransaction: async () => undefined } as never,
        syncQueue as never,
        events as never,
        { enqueueCancelIncome: async () => undefined } as never,
        { revertConversion: async () => undefined } as never,
        new SavedPaymentMethodService(prisma, events as never),
        { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
        { reverseForTransactionBestEffort: async () => undefined } as never,
        { create: async () => undefined } as never,
        undefined,
        addOnRefunds as never,
      );
      // «Отметить возврат» sends nothing to a provider: no HTTP client, no redaction.
      return { reconciliation: doors, refunds: new PaymentRefundService(prisma, {} as never, {} as never, doors) };
    };
    ({ reconciliation, refunds } = refundsOver(addOnRefundsOver(prisma)));
  });

  beforeEach(() => {
    panel.answers = [];
    panel.calls = [];
    panel.hold = null;
  });

  after(async () => {
    mock.restoreAll();
    if (prisma === undefined) return;
    const quietly = (what: string) => (error: unknown) => {
      console.error(`paid reset cleanup failed: ${what}`, error);
    };
    await prisma.paymentWebhookEvent.deleteMany({ where: { id: { in: created.webhookEvents } } }).catch(quietly('events'));
    await removeDurableFixtures(prisma, created.users).catch(quietly('fixtures'));
    await prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } }).catch(() => undefined);
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: { in: created.admins } } }).catch(quietly('audit'));
    await prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } }).catch(quietly('admins'));
    await prisma.$disconnect();
  });

  it('performed at once: the sale, the reset recorded, the job settled — and nothing else', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn());

    await fulfilment.applyCompletedTransaction(paid);

    assert.equal(panel.calls.length, 1);
    assert.deepEqual(
      cardsOf(paid.paymentId).map((event) => [event.type, event.severity]),
      [[EVENT_TYPES.PAYMENT_COMPLETED, 'INFO']],
    );
    assert.equal((await resetsOf(paid.id)).length, 1);
    const job = await jobOf(paid.id);
    assert.equal(job.status, SyncJobStatus.COMPLETED);
    assert.equal(payloadOf(job)['settledAs'], 'APPLIED');
    assert.equal(payloadOf(job)['announcedAs'], 'SALE');
    assert.notEqual(job.supersededAt, null, 'it never stands for the subscription’s sync state');
    assert.deepEqual(noticesOf(paid.paymentId), []);

    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));
    assert.equal(cardsOf(paid.paymentId).length, 1, 'announced again by the settle');
  });

  it('Remnawave out of reach, then back: nothing is sent but the sale — once, when the worker has performed it', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn());
    panel.answers = [UNREACHABLE];

    await fulfilment.applyCompletedTransaction(paid);

    assert.deepEqual(cardsOf(paid.paymentId), [], 'a sale or a card before anybody knows');
    const released = await jobOf(paid.id);
    assert.equal(released.status, SyncJobStatus.PENDING);
    assert.equal(released.supersededAt, null, 'released: the profile-sync sweep re-drives it');
    assert.equal(payloadOf(released)['held'], undefined);
    assert.equal(typeof payloadOf(released)['releasedAt'], 'string');
    assert.deepEqual(await resetsOf(paid.id), []);

    // The sweep's worker, with Remnawave back.
    assert.equal(await work(released.id), null);
    const performed = await jobById(released.id);
    assert.equal(performed.status, SyncJobStatus.COMPLETED);
    assert.deepEqual(cardsOf(paid.paymentId), [], 'the worker announces nothing itself');

    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets();

    assert.deepEqual(
      cardsOf(paid.paymentId).map((event) => [event.type, event.severity]),
      [[EVENT_TYPES.PAYMENT_COMPLETED, 'INFO']],
      'one sale, and nothing else',
    );
    assert.equal(cardsOf(paid.paymentId)[0]!.metadata['userId'], owner.userId, 'pop-ups and automations find the customer');
    assert.deepEqual(noticesOf(paid.paymentId), [], 'nothing sent to the customer');
    const resets = await resetsOf(paid.id);
    assert.equal(resets.length, 1, 'the reset recorded, as one performed at once is');
    assert.equal(resets[0]!.performedAt.getTime(), performed.completedAt!.getTime());
    assert.equal(await stampOf(paid.id), undefined);
  });

  it('failed for good: exactly ONE card for it — «Платёж получен, но не применён», the worker sending none — and one notice', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn());
    panel.answers = [UNREACHABLE, REFUSED];
    await fulfilment.applyCompletedTransaction(paid);
    const job = await jobOf(paid.id);
    // The last attempt the worker has: this one is final.
    await prisma.profileSyncJob.update({ where: { id: job.id }, data: { attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1 } });

    assert.ok(await work(job.id), 'the worker failed the job');
    const failed = await jobById(job.id);
    assert.equal(failed.status, SyncJobStatus.FAILED);
    assert.equal((failed.recoveryData as Record<string, unknown>)['classification'], 'TERMINAL');
    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets();

    // Every card this reset raised, from either side: the worker's generic one
    // names the job, the payment's names the payment.
    const cards = emitted.filter(
      (event) => event.metadata['syncJobId'] === job.id || event.metadata['paymentId'] === paid.paymentId,
    );
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD], 'exactly one card');
    const card = cards[0]!;
    assert.equal(card.message, 'Докупка оплачена, но не применена');
    assert.equal(card.metadata['addOnNotAppliedReason'], 'RESET_NOT_PERFORMED');
    assert.match(String(card.metadata['note']), /сбросить трафик не удалось: Remnawave так и не выполнила сброс \(/);
    assert.match(String(card.metadata['note']), /«Быстрые действия» → «Сброс трафика» → «Сбросить»/);
    assert.equal(card.metadata['needsManualReview'], true);
    assert.deepEqual(
      noticesOf(paid.paymentId).map((notice) => [notice.type, notice.payload['reason']]),
      [['addon_not_applied_other', 'RESET_NOT_PERFORMED']],
    );
    assert.equal(await stampOf(paid.id), 'RESET_NOT_PERFORMED');
    const settled = await jobById(job.id);
    assert.equal(payloadOf(settled)['settledAs'], 'NOT_APPLIED');
    assert.equal(payloadOf(settled)['announcedAs'], 'NOT_APPLIED');
    assert.notEqual(settled.supersededAt, null, 'no late retry resets it after the customer was told');

    // Its refund takes nothing back and says so.
    const refundsOfAddOns = new AddOnRefundService(
      prisma,
      new AddOnEntitlementService(),
      new EffectiveProjectionService(),
      { enqueue: async () => undefined } as never,
    );
    const outcome = await refundsOfAddOns.endForRefund(await prisma.transaction.findUniqueOrThrow({ where: { id: paid.id } }), 'REFUND');
    assert.equal(outcome?.note, 'Докупка «сброс трафика» не была применена — отключать нечего.');
  });

  it('a refusal with the worker’s retries still to come is not told yet: only the last attempt is final', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn());
    panel.answers = [UNREACHABLE, REFUSED];
    await fulfilment.applyCompletedTransaction(paid);
    const job = await jobOf(paid.id);

    assert.ok(await work(job.id), 'fixture: the first attempt failed');
    const first = await jobById(job.id);
    assert.equal(first.attempts, 1);
    assert.equal((first.recoveryData as Record<string, unknown>)['classification'], 'TERMINAL');
    await fulfilment.settlePaidTrafficResets();

    assert.deepEqual(cardsOf(paid.paymentId), [], 'told before the worker’s own retries were spent');
    assert.deepEqual(noticesOf(paid.paymentId), []);
    assert.equal(payloadOf(await jobById(job.id))['settledAt'], undefined);

    // BullMQ's retry, Remnawave back: performed, and the sale told.
    assert.equal(await work(job.id), null);
    await fulfilment.settlePaidTrafficResets();
    assert.deepEqual(cardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_COMPLETED]);
  });

  it('…while a TRAFFIC_RESET that is not a paid one still gets the worker’s own card', async () => {
    const owner = await newOwner();
    const job = await prisma.profileSyncJob.create({
      data: {
        subscriptionId: owner.subscriptionId,
        action: SyncAction.TRAFFIC_RESET,
        status: SyncJobStatus.PENDING,
        attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1,
      },
    });
    panel.answers = [REFUSED];

    assert.ok(await work(job.id));

    const cards = emitted.filter((event) => event.metadata['syncJobId'] === job.id);
    assert.deepEqual(cards.map((event) => [event.type, event.metadata['reason']]), [
      [EVENT_TYPES.SYSTEM_ERROR, 'profile_sync_failed'],
    ]);
  });

  it('never performable — no profile in Remnawave: the card and the notice at once, and the sweep never takes it', async () => {
    const owner = await newOwner({ linked: false });
    const paid = await paidReset(owner, await resetAddOn());

    await fulfilment.applyCompletedTransaction(paid);

    assert.deepEqual(panel.calls, [], 'Remnawave asked about a profile that does not exist');
    const cards = cardsOf(paid.paymentId);
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD]);
    assert.match(String(cards[0]!.metadata['note']), /сбросить трафик не удалось: у подписки нет профиля в Remnawave\./);
    assert.deepEqual(noticesOf(paid.paymentId).map((notice) => notice.type), ['addon_not_applied_other']);
    assert.equal(await stampOf(paid.id), 'RESET_NOT_PERFORMED');
    const job = await jobOf(paid.id);
    assert.equal(job.status, SyncJobStatus.FAILED);
    assert.notEqual(job.supersededAt, null, 'the profile-sync sweep would re-drive it');
    assert.equal(payloadOf(job)['settledAs'], 'NOT_APPLIED');

    await fulfilment.settlePaidTrafficResets();
    assert.equal(cardsOf(paid.paymentId).length, 1);
    assert.equal(noticesOf(paid.paymentId).length, 1);
  });

  it('nothing charged: the card says there is nothing to refund, and the customer gets no notice', async () => {
    const owner = await newOwner({ linked: false });
    const paid = await paidReset(owner, await resetAddOn(), '0');

    await fulfilment.applyCompletedTransaction(paid);

    const cards = cardsOf(paid.paymentId);
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD]);
    assert.match(String(cards[0]!.metadata['note']), /Денег по ней не списано — возвращать нечего\./);
    assert.deepEqual(noticesOf(paid.paymentId), []);
  });

  it('a capture that died before its reset: the hold it left is performed by the settle, and the sale told once', async () => {
    const owner = await newOwner();
    const addOnId = await resetAddOn();
    const paid = await paidReset(owner, addOnId);
    const held = await heldByDeadCapture(owner, paid, addOnId, SyncJobStatus.PENDING);

    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets();

    assert.equal(panel.calls.length, 1, 'performed once');
    assert.deepEqual(cardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_COMPLETED]);
    assert.equal((await resetsOf(paid.id)).length, 1);
    const settled = await jobById(held.id);
    assert.equal(settled.status, SyncJobStatus.COMPLETED);
    assert.equal(payloadOf(settled)['settledAs'], 'APPLIED');
    assert.equal(typeof payloadOf(settled)['attemptAt'], 'string');
  });

  it('a capture that died inside its attempt: the settle attempts it again — performed, and the sale told once', async () => {
    const owner = await newOwner();
    const addOnId = await resetAddOn();
    const paid = await paidReset(owner, addOnId);
    const held = await heldByDeadCapture(owner, paid, addOnId, SyncJobStatus.RUNNING);

    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets();

    assert.equal(callsFor(owner), 1, 'performed once');
    assert.deepEqual(tellingsOf(paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED]);
    assert.equal((await resetsOf(paid.id)).length, 1);
    assert.equal(payloadOf(await jobById(held.id))['settledAs'], 'APPLIED');
  });

  it('a hold still inside its run’s window is left alone: the run that holds it answers for it', async () => {
    const owner = await newOwner();
    const addOnId = await resetAddOn();
    const paid = await paidReset(owner, addOnId);
    const held = await prisma.profileSyncJob.create({
      data: {
        subscriptionId: owner.subscriptionId,
        action: SyncAction.TRAFFIC_RESET,
        status: SyncJobStatus.PENDING,
        cause: PAID_TRAFFIC_RESET_CAUSE,
        supersededAt: new Date(),
        payload: { source: PAID_TRAFFIC_RESET_CAUSE, paymentId: paid.paymentId, transactionId: paid.id, addOnId, held: true },
      },
    });

    await fulfilment.settlePaidTrafficResets();

    assert.deepEqual(panel.calls, []);
    const untouched = await jobById(held.id);
    assert.equal(payloadOf(untouched)['attemptAt'], undefined);
  });

  it('two settles started together on one COMPLETED job: one claim, one sale', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { paid, jobId } = await releasedReset();
      assert.equal(await work(jobId), null, 'fixture: the worker performed it');

      await Promise.all([fulfilment.settlePaidTrafficResets(), otherFulfilment.settlePaidTrafficResets()]);

      assert.deepEqual(
        cardsOf(paid.paymentId).map((event) => event.type),
        [EVENT_TYPES.PAYMENT_COMPLETED],
        `round ${round}: the sale announced twice`,
      );
      assert.equal((await resetsOf(paid.id)).length, 1, `round ${round}: the claim ran twice`);
      const settled = await jobById(jobId);
      assert.equal(payloadOf(settled)['settledAs'], 'APPLIED');
    }
  });

  // ── R5-01: A FULL REFUND BEFORE THE RESET ──────────────────────────────────

  it('refunded in full while Remnawave was out of reach: the refund closes it — and when Remnawave is back, no reset, no sale, no card, no notice (R5-01)', async () => {
    const { owner, paid, jobId } = await releasedReset({ gateway: 'PLATEGA' });
    // The sweep's worker tried again: still out of reach — FAILED, its retries to come.
    panel.answers = [UNREACHABLE];
    assert.ok(await work(jobId), 'fixture: the worker failed');
    assert.equal((await jobById(jobId)).status, SyncJobStatus.FAILED);

    await refundInFull(paid.id);

    const closed = await jobById(jobId);
    assert.equal(payloadOf(closed)['settledAs'], 'CLOSED');
    assert.equal(typeof payloadOf(closed)['closedByRefundAt'], 'string');
    assert.equal(payloadOf(closed)['announcedAs'], 'NONE', 'closed is told: there is nothing to tell');
    assert.notEqual(closed.supersededAt, null, 'the profile-sync sweep would re-drive it');
    const cards = refundCardsOf(paid.paymentId);
    assert.deepEqual(
      cards.map((event) => event.type),
      [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED],
      'the refund of a sale nobody was told of is the operator’s alone',
    );
    assert.ok(noteOf(cards[0]).startsWith(CLOSED_NOTE), noteOf(cards[0]));
    assert.equal(cards[0]!.metadata['addOnSaleNotAnnounced'], true);

    // Remnawave is back: the sweep's worker, and the settle — now and at its next ticks.
    const calls = callsFor(owner);
    assert.equal(await work(jobId), null);
    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));

    assert.equal(callsFor(owner), calls, 'a refunded customer’s traffic reset');
    assert.deepEqual(await resetsOf(paid.id), []);
    assert.deepEqual(tellingsOf(paid.paymentId), [], 'a sale, or «Верните деньги», for money already back');
    assert.deepEqual(noticesOf(paid.paymentId), []);
    assert.equal(await stampOf(paid.id), undefined);
  });

  it('refunded before the capture’s run attempted it: the hold is closed, and nothing performs it (R5-01)', async () => {
    const owner = await newOwner();
    const addOnId = await resetAddOn();
    const paid = await paidReset(owner, addOnId, '99', 'PLATEGA');
    const held = await heldByDeadCapture(owner, paid, addOnId, SyncJobStatus.PENDING);

    await refundInFull(paid.id);
    await fulfilment.settlePaidTrafficResets();

    assert.equal(callsFor(owner), 0, 'performed after the refund');
    const closed = await jobById(held.id);
    assert.equal(payloadOf(closed)['settledAs'], 'CLOSED');
    assert.equal(payloadOf(closed)['held'], undefined);
    assert.ok(noteOf(refundCardsOf(paid.paymentId)[0]).startsWith(CLOSED_NOTE));
    assert.deepEqual(tellingsOf(paid.paymentId), []);
    assert.deepEqual(noticesOf(paid.paymentId), []);
  });

  it('refunded while the capture’s run was inside its attempt: the card says so, and the settle closes the hold instead of performing it (R5-01)', async () => {
    const owner = await newOwner();
    const addOnId = await resetAddOn();
    const paid = await paidReset(owner, addOnId, '99', 'PLATEGA');
    const held = await heldByDeadCapture(owner, paid, addOnId, SyncJobStatus.RUNNING);

    await refundInFull(paid.id);

    const [card, ...more] = refundCardsOf(paid.paymentId);
    assert.deepEqual(more, []);
    assert.ok(noteOf(card).startsWith(IN_FLIGHT_NOTE), noteOf(card));
    assert.equal(card!.metadata['needsManualReview'], true, 'the operator looks at the traffic');

    await fulfilment.settlePaidTrafficResets();

    assert.equal(callsFor(owner), 0, 'the settle performed a refunded reset');
    const closed = await jobById(held.id);
    assert.equal(payloadOf(closed)['settledAs'], 'CLOSED');
    assert.deepEqual(tellingsOf(paid.paymentId), []);
    assert.deepEqual(noticesOf(paid.paymentId), []);
    assert.equal(await stampOf(paid.id), undefined);
  });

  it('claimed by the worker, refunded before its call: the worker closes it instead of calling Remnawave (R5-01)', async () => {
    const { owner, paid, jobId } = await releasedReset({ gateway: 'PLATEGA' });
    const calls = callsFor(owner);
    const stop = door();
    const working = work(jobId, workerStoppedBeforeItsCall(stop));
    await within(stop.reached, 'the worker never came to its check before the call');
    assert.equal((await jobById(jobId)).status, SyncJobStatus.RUNNING, 'fixture: claimed');

    await refundInFull(paid.id);
    stop.open();
    assert.equal(await working, null);
    await fulfilment.settlePaidTrafficResets();

    assert.equal(callsFor(owner), calls, 'Remnawave asked to reset a refunded customer');
    const closed = await jobById(jobId);
    assert.equal(payloadOf(closed)['settledAs'], 'CLOSED');
    assert.notEqual(closed.supersededAt, null);
    assert.ok(noteOf(refundCardsOf(paid.paymentId)[0]).startsWith(IN_FLIGHT_NOTE));
    assert.deepEqual(await resetsOf(paid.id), []);
    assert.deepEqual(tellingsOf(paid.paymentId), []);
    assert.deepEqual(noticesOf(paid.paymentId), []);
  });

  it('refunded while Remnawave was resetting it, which then refused for good: nothing is sent to anyone but the refund’s own card (R5-01)', async () => {
    const { paid, jobId } = await releasedReset({ gateway: 'PLATEGA' });
    await prisma.profileSyncJob.update({ where: { id: jobId }, data: { attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1 } });
    const inside = door();
    panel.hold = inside.wait;
    const working = work(jobId);
    await within(inside.reached, 'Remnawave was never asked');

    await refundInFull(paid.id);
    panel.answers = [REFUSED];
    inside.open();
    assert.ok(await working, 'fixture: Remnawave refused, on the last attempt');
    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));

    const failed = await jobById(jobId);
    assert.equal(failed.status, SyncJobStatus.FAILED);
    assert.equal((failed.recoveryData as Record<string, unknown>)['classification'], 'TERMINAL');
    assert.equal(payloadOf(failed)['settledAs'], 'CLOSED');
    // Every card naming the job or the payment: the worker's, the settle's, the refund's.
    const cards = emitted.filter(
      (event) => event.metadata['syncJobId'] === jobId || event.metadata['paymentId'] === paid.paymentId,
    );
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED]);
    assert.ok(noteOf(cards[0]).startsWith(IN_FLIGHT_NOTE));
    assert.deepEqual(noticesOf(paid.paymentId), [], '«Мы разберёмся и свяжемся с вами» after the money went back');
    assert.equal(await stampOf(paid.id), undefined);
  });

  it('refunded while Remnawave was resetting it, which then did: performed and recorded — and no sale for a refunded payment (R5-01)', async () => {
    const { paid, jobId } = await releasedReset({ gateway: 'PLATEGA' });
    const inside = door();
    panel.hold = inside.wait;
    const working = work(jobId);
    await within(inside.reached, 'Remnawave was never asked');

    await refundInFull(paid.id);
    inside.open();
    assert.equal(await working, null);
    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));

    const performed = await jobById(jobId);
    assert.equal(performed.status, SyncJobStatus.COMPLETED);
    assert.equal(payloadOf(performed)['settledAs'], 'APPLIED');
    assert.equal(payloadOf(performed)['announcedAs'], 'NONE');
    assert.equal((await resetsOf(paid.id)).length, 1, 'a reset performed is recorded, refunded or not');
    assert.ok(noteOf(refundCardsOf(paid.paymentId)[0]).startsWith(IN_FLIGHT_NOTE));
    assert.deepEqual(tellingsOf(paid.paymentId), [], 'payment.completed for a CANCELED payment');
    assert.deepEqual(noticesOf(paid.paymentId), []);
  });

  it('refunded during the capture’s own attempt, which Remnawave then refused: closed — nothing told, nothing stamped (R5-01)', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn(), '99', 'PLATEGA');
    const inside = door();
    panel.hold = inside.wait;
    const capturing = fulfilment.applyCompletedTransaction(paid);
    await within(inside.reached, 'Remnawave was never asked');

    await refundInFull(paid.id);
    panel.answers = [REFUSED];
    inside.open();
    await capturing;
    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));

    assert.equal(payloadOf(await jobOf(paid.id))['settledAs'], 'CLOSED');
    assert.ok(noteOf(refundCardsOf(paid.paymentId)[0]).startsWith(IN_FLIGHT_NOTE));
    assert.deepEqual(tellingsOf(paid.paymentId), [], '«Верните деньги» for money already back');
    assert.deepEqual(noticesOf(paid.paymentId), []);
    assert.equal(await stampOf(paid.id), undefined);
    assert.equal(callsFor(owner), 1);
  });

  it('refunded during the capture’s own attempt, which Remnawave then performed: recorded — and no sale for a refunded payment (R5-01)', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn(), '99', 'PLATEGA');
    const inside = door();
    panel.hold = inside.wait;
    const capturing = fulfilment.applyCompletedTransaction(paid);
    await within(inside.reached, 'Remnawave was never asked');

    await refundInFull(paid.id);
    inside.open();
    await capturing;
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));

    const job = await jobOf(paid.id);
    assert.equal(payloadOf(job)['settledAs'], 'APPLIED');
    assert.equal(payloadOf(job)['announcedAs'], 'NONE');
    assert.equal((await resetsOf(paid.id)).length, 1);
    assert.deepEqual(tellingsOf(paid.paymentId), [], 'payment.completed for a CANCELED payment');
    assert.deepEqual(noticesOf(paid.paymentId), []);
    // The refund came first, and no sale was told: its refund is the operator's (R5-07).
    assert.deepEqual(refundCardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED]);
  });

  it('performed by the worker, refunded before the settle told the sale: «уже выполнен», the operator’s alone, and no sale (R5-01)', async () => {
    const { paid, jobId } = await releasedReset({ gateway: 'PLATEGA' });
    assert.equal(await work(jobId), null, 'fixture: performed');

    await refundInFull(paid.id);

    const cards = refundCardsOf(paid.paymentId);
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED]);
    assert.ok(noteOf(cards[0]).startsWith(PERFORMED_NOTE), noteOf(cards[0]));
    assert.equal(cards[0]!.metadata['addOnSaleNotAnnounced'], true);
    await fulfilment.settlePaidTrafficResets();
    const job = await jobById(jobId);
    assert.equal(payloadOf(job)['settledAs'], 'APPLIED');
    assert.equal(payloadOf(job)['announcedAs'], 'NONE');
    assert.deepEqual(tellingsOf(paid.paymentId), []);
    assert.equal((await resetsOf(paid.id)).length, 1);
  });

  it('paid before this release, with no job: the refund reads the record of the reset (R5-01)', async () => {
    for (const performed of [true, false]) {
      const owner = await newOwner();
      const addOnId = await resetAddOn();
      const paid = await paidReset(owner, addOnId, '99', 'PLATEGA');
      const capturedAt = new Date(Date.now() - DAY_MS);
      await prisma.transaction.update({
        where: { id: paid.id },
        data: { subscriptionId: owner.subscriptionId, fulfilledAt: capturedAt },
      });
      if (performed) {
        await prisma.subscriptionTrafficReset.create({
          data: { subscriptionId: owner.subscriptionId, addOnId, transactionId: paid.id, performedAt: capturedAt },
        });
      }

      await refundInFull(paid.id);

      const cards = refundCardsOf(paid.paymentId);
      assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_REFUNDED], 'its sale was told at the capture');
      assert.ok(noteOf(cards[0]).startsWith(performed ? PERFORMED_NOTE : NOT_PERFORMED_NOTE), noteOf(cards[0]));
    }
  });

  it('a full refund racing the worker’s claim, truly concurrent: exactly one of performed or closed, and the card says what the refund read (R5-01)', async (t) => {
    // [the worker's lag, the refund's lag, how long Remnawave takes] in ms.
    // The refund runs a dozen statements before its compare-and-set; the
    // worker claims almost at once. A slow Remnawave keeps the claim RUNNING
    // while the refund reads it.
    const rounds: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0],
      [0, 4, 0],
      [0, 10, 0],
      [4, 0, 0],
      [10, 0, 0],
      [18, 0, 0],
      [28, 0, 0],
      [45, 0, 0],
      [0, 0, 25],
      [0, 5, 25],
      [8, 0, 25],
      [16, 0, 25],
      [24, 0, 25],
      [32, 0, 25],
      [40, 0, 25],
      [55, 0, 25],
    ];
    const tally = { performed: 0, closed: 0, inFlight: 0 };
    for (const [round, [workerLag, refundLag, callMs]] of rounds.entries()) {
      const { owner, paid, jobId } = await releasedReset({ gateway: 'PLATEGA' });
      const adminId = await newAdmin();
      const calls = callsFor(owner);
      panel.hold = callMs === 0 ? null : () => sleep(callMs);

      const [worked] = await Promise.all([
        sleep(workerLag).then(() => work(jobId)),
        sleep(refundLag).then(() => refundInFull(paid.id, adminId)),
      ]);
      assert.equal(worked, null, `round ${round}: the worker failed`);
      panel.hold = null;
      await fulfilment.settlePaidTrafficResets();

      const job = await jobById(jobId);
      const performed = callsFor(owner) - calls;
      const closed = payloadOf(job)['settledAs'] === 'CLOSED';
      assert.equal(performed + (closed ? 1 : 0), 1, `round ${round}: performed ${performed} time(s), closed: ${closed}`);
      const cards = refundCardsOf(paid.paymentId);
      assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED], `round ${round}`);
      const note = noteOf(cards[0]);
      const said = [PERFORMED_NOTE, CLOSED_NOTE, IN_FLIGHT_NOTE].find((line) => note.startsWith(line));
      if (closed) {
        assert.ok(said === CLOSED_NOTE || said === IN_FLIGHT_NOTE, `round ${round}: closed, and the card says ${note}`);
        assert.deepEqual(await resetsOf(paid.id), [], `round ${round}`);
      } else {
        assert.ok(said === PERFORMED_NOTE || said === IN_FLIGHT_NOTE, `round ${round}: performed, and the card says ${note}`);
        assert.equal(job.status, SyncJobStatus.COMPLETED, `round ${round}`);
        assert.equal(payloadOf(job)['settledAs'], 'APPLIED', `round ${round}`);
        assert.equal(payloadOf(job)['announcedAs'], 'NONE', `round ${round}`);
        assert.equal((await resetsOf(paid.id)).length, 1, `round ${round}`);
      }
      assert.deepEqual(tellingsOf(paid.paymentId), [], `round ${round}: a sale, or «Верните деньги», for a refunded payment`);
      assert.deepEqual(noticesOf(paid.paymentId), [], `round ${round}`);
      tally[closed ? 'closed' : 'performed'] += 1;
      if (said === IN_FLIGHT_NOTE) tally.inFlight += 1;
    }
    t.diagnostic(`performed ${tally.performed}, closed ${tally.closed}; the refund read «in flight» ${tally.inFlight} time(s)`);
  });

  it('a partial refund keeps the reset: performed when Remnawave is back, and the sale told once — the refund, before any sale, the operator’s alone (R5-01, R5-09)', async () => {
    const { owner, paid, jobId } = await releasedReset();

    await refundPartly(paid, '50.00');

    const kept = await jobById(jobId);
    assert.equal(payloadOf(kept)['settledAt'], undefined, 'closed by a partial refund');
    assert.equal(kept.supersededAt, null);
    const [partial] = refundCardsOf(paid.paymentId);
    assert.equal(partial?.type, EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED, 'a public refund of a sale nobody was told of');
    assert.equal(partial?.metadata['partial'], true);
    assert.equal(partial?.metadata['addOnSaleNotAnnounced'], true);
    assert.equal(await work(jobId), null);
    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets();

    assert.equal(callsFor(owner), 2, 'the capture’s attempt, and the worker’s');
    assert.deepEqual(
      cardsOf(paid.paymentId).map((event) => event.type),
      [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED, EVENT_TYPES.PAYMENT_COMPLETED],
    );
    assert.equal((await resetsOf(paid.id)).length, 1);
    assert.deepEqual(noticesOf(paid.paymentId), []);
  });

  it('a partial refund of a reset already performed and sold is told as any sale’s (R5-09)', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn());
    await fulfilment.applyCompletedTransaction(paid);
    assert.deepEqual(tellingsOf(paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED], 'fixture: performed and sold');

    await refundPartly(paid, '50.00');

    const cards = refundCardsOf(paid.paymentId);
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_REFUND_PARTIAL]);
    assert.equal(cards[0]!.metadata['addOnSaleNotAnnounced'], undefined);
  });

  it('performed and sold, then refunded in full: «уже выполнен», and the refund told as any sale’s is (R5-01)', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn(), '99', 'PLATEGA');
    await fulfilment.applyCompletedTransaction(paid);
    assert.deepEqual(tellingsOf(paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED], 'fixture: performed and sold');

    await refundInFull(paid.id);

    const cards = refundCardsOf(paid.paymentId);
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_REFUNDED]);
    assert.ok(noteOf(cards[0]).startsWith(PERFORMED_NOTE), noteOf(cards[0]));
    assert.equal(cards[0]!.metadata['addOnSaleNotAnnounced'], undefined);
    assert.equal(payloadOf(await jobOf(paid.id))['settledAs'], 'APPLIED');
  });

  // ── R5-07, R5-08: WHO HEARS OF THE REFUND ─────────────────────────────────

  it('refunded while the capture was inside Remnawave, the capture telling its sale before the payment turned CANCELED: the refund is public too (R5-07)', async () => {
    // R5's probe C: the refund closes nothing (the capture holds the job
    // RUNNING) and is held before its CANCELED; the capture then tells its sale.
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn(), '99', 'PLATEGA');
    const inside = door();
    panel.hold = inside.wait;
    const capturing = fulfilment.applyCompletedTransaction(paid);
    await within(inside.reached, 'Remnawave was never asked');
    const afterClose = door();
    const refunding = refundInFull(paid.id, undefined, refundsHeldAfterClose(afterClose));
    await within(afterClose.reached, 'the refund never came to its close');

    inside.open();
    await capturing;
    assert.deepEqual(tellingsOf(paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED], 'fixture: the sale told before the CANCELED');
    afterClose.open();
    await refunding;

    const cards = refundCardsOf(paid.paymentId);
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_REFUNDED], 'a public sale whose refund only the operator hears of');
    assert.ok(noteOf(cards[0]).startsWith(IN_FLIGHT_NOTE), noteOf(cards[0]));
    assert.equal(cards[0]!.metadata['addOnSaleNotAnnounced'], undefined);
    const job = await jobOf(paid.id);
    assert.equal(payloadOf(job)['announcedAs'], 'SALE');
    assert.equal(callsFor(owner), 1);
  });

  it('refunded while the capture was inside Remnawave, the refund held right at its CANCELED while the capture told its sale: who hears of the refund is read after the CANCELED — in public (R5-07)', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn(), '99', 'PLATEGA');
    const inside = door();
    panel.hold = inside.wait;
    const capturing = fulfilment.applyCompletedTransaction(paid);
    await within(inside.reached, 'Remnawave was never asked');
    const atCancel = door();
    const refunding = refundInFull(paid.id, undefined, refundsHeldAtCancel(atCancel));
    await within(atCancel.reached, 'the refund never came to its CANCELED');

    inside.open();
    await capturing;
    assert.deepEqual(tellingsOf(paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED], 'fixture: the sale told before the CANCELED');
    atCancel.open();
    await refunding;

    assert.deepEqual(refundCardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_REFUNDED]);
  });

  it('a telling that has decided holds the payment’s row: the refund waits for it, and answers for the sale in public (R5-07)', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn(), '99', 'PLATEGA');
    const hold = door();
    let tellerPid: number | null = null;
    const teller = fulfilmentWithTellingHeld(hold, (pid) => {
      tellerPid = pid;
    });
    const capturing = teller.applyCompletedTransaction(paid);
    await within(hold.reached, 'the telling never came to its decision');
    const adminId = await newAdmin();

    const refunding = refundInFull(paid.id, adminId);
    const waited = await waitUntilBlockedBy(tellerPid!);
    hold.open();
    await capturing;
    await refunding;

    assert.equal(waited, true, 'the refund went through a telling that had taken the payment row');
    assert.deepEqual(tellingsOf(paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED]);
    const cards = refundCardsOf(paid.paymentId);
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_REFUNDED]);
    assert.ok(noteOf(cards[0]).startsWith(PERFORMED_NOTE), noteOf(cards[0]));
  });

  it('the capture telling its sale and a full refund turning the payment CANCELED, truly concurrent: a sale told is refunded in public, none told is refunded to the operator alone (R5-07)', async (t) => {
    // [the capture's lag, the refund's lag] in ms, once the capture is inside
    // Remnawave and the refund has closed what it could.
    const rounds: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0, 10],
      [0, 20],
      [0, 30],
      [0, 45],
      [0, 60],
      [5, 0],
      [10, 0],
    ];
    const tally = { told: 0, notTold: 0 };
    for (const [round, [captureLag, refundLag]] of [...rounds, ...rounds].entries()) {
      const owner = await newOwner();
      const paid = await paidReset(owner, await resetAddOn(), '99', 'PLATEGA');
      const inside = door();
      panel.hold = inside.wait;
      const capturing = fulfilment.applyCompletedTransaction(paid);
      await within(inside.reached, 'Remnawave was never asked');
      const afterClose = door();
      const refunding = refundInFull(paid.id, undefined, refundsHeldAfterClose(afterClose));
      await within(afterClose.reached, 'the refund never came to its close');
      panel.hold = null;

      await Promise.all([sleep(captureLag).then(() => inside.open()), sleep(refundLag).then(() => afterClose.open())]);
      await capturing;
      await refunding;

      const told = tellingsOf(paid.paymentId);
      const cards = refundCardsOf(paid.paymentId).map((event) => event.type);
      const job = await jobOf(paid.id);
      if (told.length > 0) {
        assert.deepEqual(told, [EVENT_TYPES.PAYMENT_COMPLETED], `round ${round}`);
        assert.deepEqual(cards, [EVENT_TYPES.PAYMENT_REFUNDED], `round ${round}: a public sale whose refund only the operator hears of`);
        assert.equal(payloadOf(job)['announcedAs'], 'SALE', `round ${round}`);
        tally.told += 1;
      } else {
        assert.deepEqual(cards, [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED], `round ${round}: a public refund of a sale nobody heard of`);
        assert.equal(payloadOf(job)['announcedAs'], 'NONE', `round ${round}`);
        tally.notTold += 1;
      }
      assert.deepEqual(noticesOf(paid.paymentId), [], `round ${round}`);
    }
    t.diagnostic(`the sale told first ${tally.told} time(s), the CANCELED first ${tally.notTold} time(s)`);
  });

  it('a sale decided and told whose record failed, then refunded: the refund is public, and the next settle tells the sale again — at least once, as decided (R5-07)', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn(), '99', 'PLATEGA');
    // Performed at once and told; the record that it was told fails.
    await flakyFulfilment({ failFirstMark: true }).applyCompletedTransaction(paid);
    assert.deepEqual(tellingsOf(paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED], 'fixture: the sale told');
    const untold = payloadOf(await jobOf(paid.id));
    assert.equal(untold['announcedAs'], 'SALE', 'fixture: decided');
    assert.equal(untold['announcedAt'], undefined, 'fixture: its record failed');

    await refundInFull(paid.id);

    assert.deepEqual(refundCardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_REFUNDED]);
    // The payment is CANCELED now, and the decision still stands: the sale
    // the refund answers for is told again rather than risk not at all.
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 4 * MINUTE_MS));
    assert.deepEqual(tellingsOf(paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED, EVENT_TYPES.PAYMENT_COMPLETED]);
    const told = payloadOf(await jobOf(paid.id));
    assert.equal(told['announcedAs'], 'SALE');
    assert.equal(typeof told['announcedAt'], 'string');
  });

  it('refunded while the add-on refund could not reach the database: the card says the reset could not be checked, asks for review, and stays the operator’s (R5-08)', async () => {
    const { owner, paid, jobId } = await releasedReset({ gateway: 'PLATEGA' });
    const calls = callsFor(owner);

    await refundInFull(paid.id, undefined, refundsFailingOnce({ transactions: true }));

    const cards = refundCardsOf(paid.paymentId);
    assert.deepEqual(cards.map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED], 'a public refund of a sale nobody was told of');
    assert.ok(noteOf(cards[0]).startsWith(NOT_CHECKED_NOTE), noteOf(cards[0]));
    assert.doesNotMatch(noteOf(cards[0]), /уже выполнен/);
    assert.equal(cards[0]!.metadata['needsManualReview'], true);
    assert.equal(cards[0]!.metadata['addOnSaleNotAnnounced'], true);

    // The job the refund could not close: the worker takes it, finds the payment refunded, and closes it.
    assert.equal(await work(jobId), null);
    await fulfilment.settlePaidTrafficResets();
    assert.equal(callsFor(owner), calls, 'a refunded customer’s traffic reset');
    assert.equal(payloadOf(await jobById(jobId))['settledAs'], 'CLOSED');
    assert.deepEqual(tellingsOf(paid.paymentId), []);
    assert.deepEqual(noticesOf(paid.paymentId), []);
  });

  it('…and when whether the sale was told cannot be read either, the refund is still the operator’s (R5-08)', async () => {
    const { paid } = await releasedReset({ gateway: 'PLATEGA' });

    await refundInFull(paid.id, undefined, refundsFailingOnce({ transactions: true, saleReads: true }));

    assert.deepEqual(refundCardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED]);
  });

  // ── R5-02: ONE JOB'S FAILURE TAKES NO OTHER DOWN ───────────────────────────

  it('the capture’s own telling fails: the capture still succeeds, and the settle tells it once its claim is old (R5-02)', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn());

    await flakyFulfilment({ reads: [paid.id] }).applyCompletedTransaction(paid);

    assert.equal(callsFor(owner), 1, 'fixture: performed at once');
    assert.deepEqual(cardsOf(paid.paymentId), [], 'fixture: its telling failed');
    const untold = await jobOf(paid.id);
    assert.equal(payloadOf(untold)['settledAs'], 'APPLIED');
    assert.equal(payloadOf(untold)['announcedAt'], undefined, 'recorded as told before it was');

    // The settle right after: the telling may still be under way — left to it.
    await fulfilment.settlePaidTrafficResets();
    assert.deepEqual(cardsOf(paid.paymentId), [], 'told while its own telling was under way');

    // The next ticks.
    await Promise.all([
      fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS)),
      otherFulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS)),
    ]);
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 4 * MINUTE_MS));

    assert.deepEqual(cardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_COMPLETED]);
    const told = await jobOf(paid.id);
    assert.equal(payloadOf(told)['announcedAs'], 'SALE');
    assert.equal(callsFor(owner), 1, 'performed again');
  });

  it('one job the settle fails to settle, and one it fails to tell, take nothing else down: the others are told once, and those two by the next settle, once (R5-02)', async () => {
    // Two the worker performed, three it failed for good.
    const performed: Array<{ readonly paid: Transaction; readonly jobId: string }> = [];
    for (let index = 0; index < 2; index += 1) {
      const released = await releasedReset();
      assert.equal(await work(released.jobId), null, 'fixture: performed');
      performed.push(released);
    }
    const failedForGood: Array<{ readonly paid: Transaction; readonly jobId: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      const released = await releasedReset();
      await prisma.profileSyncJob.update({
        where: { id: released.jobId },
        data: { attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1 },
      });
      panel.answers = [REFUSED];
      assert.ok(await work(released.jobId), 'fixture: failed for good');
      failedForGood.push(released);
    }
    const [p1, p2] = performed as [(typeof performed)[number], (typeof performed)[number]];
    const [f1, f2, f3] = failedForGood as [
      (typeof failedForGood)[number],
      (typeof failedForGood)[number],
      (typeof failedForGood)[number],
    ];
    const told = (paid: Transaction) => ({
      cards: cardsOf(paid.paymentId).map((event) => event.type),
      notices: noticesOf(paid.paymentId).map((notice) => notice.type),
    });
    const SALE = { cards: [EVENT_TYPES.PAYMENT_COMPLETED], notices: [] };
    const NOT_APPLIED = { cards: [EVENT_TYPES.PAYMENT_WITHHELD], notices: ['addon_not_applied_other'] };
    const NOTHING = { cards: [], notices: [] };
    // The settles of p2 (performed) and f1 (failed for good), and the read of
    // f2's payment for its telling, fail — once each.
    const settler = flakyFulfilment({ settles: [p2.jobId, f1.jobId], reads: [f2.paid.id] });

    await settler.settlePaidTrafficResets();

    assert.deepEqual(told(p1.paid), SALE);
    assert.deepEqual(told(f3.paid), NOT_APPLIED, 'a job after the failed ones, lost with them');
    assert.deepEqual(told(p2.paid), NOTHING, 'fixture: its settle failed');
    assert.deepEqual(told(f1.paid), NOTHING, 'fixture: its settle failed');
    assert.deepEqual(told(f2.paid), NOTHING, 'fixture: its telling failed');
    for (const failed of [p2, f1]) {
      assert.equal(payloadOf(await jobById(failed.jobId))['settledAt'], undefined, 'settled by a transaction that rolled back');
    }
    assert.equal(await stampOf(f1.paid.id), undefined, 'stamped by a transaction that rolled back');
    const untold = payloadOf(await jobById(f2.jobId));
    assert.equal(untold['settledAs'], 'NOT_APPLIED');
    assert.equal(untold['announcedAt'], undefined, 'recorded as told before it was');
    assert.equal(await stampOf(f2.paid.id), 'RESET_NOT_PERFORMED');

    // The next ticks of the schedule.
    await settler.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));
    await settler.settlePaidTrafficResets(new Date(Date.now() + 4 * MINUTE_MS));

    assert.deepEqual(told(p2.paid), SALE);
    assert.deepEqual(told(f1.paid), NOT_APPLIED);
    assert.deepEqual(told(f2.paid), NOT_APPLIED);
    assert.match(
      String(cardsOf(f2.paid.paymentId)[0]!.metadata['note']),
      /сбросить трафик не удалось: Remnawave так и не выполнила сброс \(/,
      'told again in the words it was settled with',
    );
    for (const { paid } of [p1, f3]) {
      assert.equal(cardsOf(paid.paymentId).length, 1, `${paid.paymentId}: told again`);
    }
    assert.equal((await resetsOf(p2.paid.id)).length, 1);
  });

  it('a stranded hold whose payment cannot be read this time takes no other down: the other is performed now, it at its next attempt (R5-02)', async () => {
    const holds: Array<{ readonly owner: Owner; readonly paid: Transaction; readonly jobId: string }> = [];
    for (let index = 0; index < 2; index += 1) {
      const owner = await newOwner();
      const addOnId = await resetAddOn();
      const paid = await paidReset(owner, addOnId);
      const held = await heldByDeadCapture(owner, paid, addOnId, SyncJobStatus.PENDING);
      holds.push({ owner, paid, jobId: held.id });
    }
    const [first, second] = holds as [(typeof holds)[number], (typeof holds)[number]];
    const settler = flakyFulfilment({ reads: [first.paid.id] });

    await settler.settlePaidTrafficResets();

    assert.equal(callsFor(second.owner), 1, 'the hold after the failed one, left for later');
    assert.deepEqual(tellingsOf(second.paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED]);
    assert.equal(callsFor(first.owner), 0, 'fixture: its read failed');
    assert.equal(typeof payloadOf(await jobById(first.jobId))['attemptAt'], 'string', 'claimed for its next attempt');

    // Its attempt's claim is old at the tick after next.
    await settler.settlePaidTrafficResets(new Date(Date.now() + 11 * MINUTE_MS));
    await settler.settlePaidTrafficResets(new Date(Date.now() + 13 * MINUTE_MS));

    assert.equal(callsFor(first.owner), 1);
    assert.deepEqual(tellingsOf(first.paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED]);
    assert.equal(callsFor(second.owner), 1);
    assert.deepEqual(tellingsOf(second.paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED]);
  });

  it('a telling whose claim fails this time takes no other down: the other is told now, it by the next settle — each once (R5-02)', async () => {
    const untold: Array<{ readonly paid: Transaction; readonly jobId: string }> = [];
    for (let index = 0; index < 2; index += 1) {
      const owner = await newOwner();
      const paid = await paidReset(owner, await resetAddOn());
      await flakyFulfilment({ reads: [paid.id] }).applyCompletedTransaction(paid);
      untold.push({ paid, jobId: (await jobOf(paid.id)).id });
    }
    const [first, second] = untold as [(typeof untold)[number], (typeof untold)[number]];
    assert.deepEqual([...tellingsOf(first.paid.paymentId), ...tellingsOf(second.paid.paymentId)], [], 'fixture: both untold');
    const settler = flakyFulfilment({ claims: [first.jobId] });

    await settler.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));

    assert.deepEqual(tellingsOf(second.paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED]);
    assert.deepEqual(tellingsOf(first.paid.paymentId), [], 'fixture: its claim failed');

    await settler.settlePaidTrafficResets(new Date(Date.now() + 4 * MINUTE_MS));
    await settler.settlePaidTrafficResets(new Date(Date.now() + 6 * MINUTE_MS));

    assert.deepEqual(tellingsOf(first.paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED]);
    assert.deepEqual(tellingsOf(second.paid.paymentId), [EVENT_TYPES.PAYMENT_COMPLETED]);
  });

  // ── R5-04: A DUPLICATE MERGED WHILE IT OWES A PAID RESET ───────────────────

  it('a duplicate merged while its paid reset was being retried: the reset follows the payment to the survivor — performed once, the sale told once (R5-04)', async () => {
    const pair = await duplicatePair();
    const { paid, jobId } = await releasedReset({
      owner: { userId: pair.userId, subscriptionId: pair.duplicateId, panelId: pair.panelId },
    });

    await mergeDuplicate(pair);

    const moved = await jobById(jobId);
    assert.equal(moved.subscriptionId, pair.survivorId, 'left on the retired row');
    assert.equal(moved.cause, PAID_TRAFFIC_RESET_CAUSE, 'rewritten: out of the settle’s sight');
    assert.equal(moved.status, SyncJobStatus.PENDING, 'completed by the merge, never performed');
    assert.equal(moved.supersededAt, null, 'the sweep would never take it');
    // The duplicate's own queue stays with it, defused.
    const left = await prisma.profileSyncJob.findMany({ where: { subscriptionId: pair.duplicateId } });
    assert.ok(left.length > 0, 'fixture: the capture queued a push on the duplicate');
    for (const job of left) {
      assert.notEqual(job.supersededAt, null, `${job.id}: live on the retired row`);
      assert.notEqual(job.cause, PAID_TRAFFIC_RESET_CAUSE);
    }

    assert.equal(await work(jobId), null);
    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets();

    assert.equal(panel.calls.filter((userId) => userId === pair.panelId).length, 2, 'the capture’s attempt, then once — on the one profile');
    assert.deepEqual(cardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_COMPLETED]);
    const resets = await resetsOf(paid.id);
    assert.deepEqual(
      resets.map((reset) => reset.subscriptionId),
      [pair.survivorId],
    );
    assert.deepEqual(noticesOf(paid.paymentId), []);
  });

  it('a duplicate merged after its paid reset failed for good: the card and the notice, once (R5-04)', async () => {
    const pair = await duplicatePair();
    const { paid, jobId } = await releasedReset({
      owner: { userId: pair.userId, subscriptionId: pair.duplicateId, panelId: pair.panelId },
    });
    await prisma.profileSyncJob.update({ where: { id: jobId }, data: { attempts: PROFILE_SYNC_MAX_ATTEMPTS - 1 } });
    panel.answers = [REFUSED];
    assert.ok(await work(jobId), 'fixture: failed for good');

    await mergeDuplicate(pair);
    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets(new Date(Date.now() + 2 * MINUTE_MS));

    assert.deepEqual(cardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_WITHHELD]);
    assert.deepEqual(noticesOf(paid.paymentId).map((notice) => notice.type), ['addon_not_applied_other']);
    const settled = await jobById(jobId);
    assert.equal(settled.subscriptionId, pair.survivorId);
    assert.equal(payloadOf(settled)['settledAs'], 'NOT_APPLIED');
  });
});
