import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

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
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PAID_TRAFFIC_RESET_CAUSE } from '../src/modules/payments/utils/add-on-not-applied.util';
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
 * announce it once. Rows are this spec's own (the `prefix`), removed after.
 * Skipped without TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `paidreset-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

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
}

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

let prisma: PrismaService;
let cutover: EntitlementCutoverService;
let fulfilment: PaymentSubscriptionMutationService;
/** A second fulfilment over the same database: the other worker, the other tick. */
let otherFulfilment: PaymentSubscriptionMutationService;
let worker: ProfileSyncProcessor;
const emitted: Emitted[] = [];
const notices: Notice[] = [];
/** What Remnawave answers to each reset, in order; `OK` once they run out. */
const panel = { answers: [] as PanelAnswer[], calls: [] as number[] };
const created = { users: [] as string[], addOns: [] as string[] };
let counter = 0;
const next = (): number => ++counter;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

function recorder(severity: string) {
  return (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
    emitted.push({ severity, type, message, metadata });
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
  return { userId, subscriptionId: row.id };
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
async function paidReset(owner: Owner, addOnId: string, amount = '99'): Promise<Transaction> {
  return prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${next()}`,
      userId: owner.userId,
      subscriptionId: null,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
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

async function jobOf(transactionId: string) {
  const job = await prisma.profileSyncJob.findFirst({
    where: { cause: PAID_TRAFFIC_RESET_CAUSE, payload: { path: ['transactionId'], equals: transactionId } },
  });
  assert.ok(job, `no paid reset job for ${transactionId}`);
  return job;
}

function payloadOf(job: { readonly payload: unknown }): Record<string, unknown> {
  return job.payload as Record<string, unknown>;
}

async function resetsOf(transactionId: string) {
  return prisma.subscriptionTrafficReset.findMany({ where: { transactionId } });
}

/** Every card this payment raised: a sale, a sale with a note, or not applied. */
function cardsOf(paymentId: string): Emitted[] {
  return emitted.filter((event) => event.metadata['paymentId'] === paymentId);
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
async function work(jobId: string): Promise<unknown> {
  return worker.process({ data: { syncJobId: jobId } } as never).then(
    () => null,
    (error: unknown) => error,
  );
}

run('a paid «Обнулить трафик» is never a log line (PostgreSQL)', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '6';
    prisma = new PrismaService();
    await prisma.$connect();
    const terms = new SubscriptionTermService();
    const projection = new EffectiveProjectionService();
    cutover = new EntitlementCutoverService(prisma, terms, projection);
    const events = { info: recorder('INFO'), warn: recorder('WARNING'), error: recorder('ERROR'), emit: () => undefined };
    const panelUsers = {
      resetTraffic: async (userId: number) => {
        panel.calls.push(userId);
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
    const build = () =>
      new PaymentSubscriptionMutationService(
        prisma,
        events as never,
        new AddOnEntitlementService(),
        projection,
        terms,
        new TrafficResetService(prisma, panelUsers as never),
        cutover,
        switches as never,
        userNotifications as never,
      );
    fulfilment = build();
    otherFulfilment = build();
    worker = new ProfileSyncProcessor(prisma, panelUsers as never, {} as never, events as never);
  });

  beforeEach(() => {
    panel.answers = [];
    panel.calls = [];
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, created.users).catch((error: unknown) => {
      console.error('paid reset cleanup failed', error);
    });
    await prisma.addOn.deleteMany({ where: { id: { in: created.addOns } } }).catch(() => undefined);
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
    assert.notEqual(job.supersededAt, null, 'it never stands for the subscription’s sync state');
    assert.deepEqual(noticesOf(paid.paymentId), []);

    await fulfilment.settlePaidTrafficResets();
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
    const performed = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: released.id } });
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
    const failed = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: job.id } });
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
    const settled = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(payloadOf(settled)['settledAs'], 'NOT_APPLIED');
    assert.notEqual(settled.supersededAt, null, 'no late retry resets it after the customer was told');

    // Its refund takes nothing back and says so.
    const refunds = new AddOnRefundService(
      prisma,
      new AddOnEntitlementService(),
      new EffectiveProjectionService(),
      { enqueue: async () => undefined } as never,
    );
    const outcome = await refunds.endForRefund(await prisma.transaction.findUniqueOrThrow({ where: { id: paid.id } }), 'REFUND');
    assert.equal(outcome?.note, 'Докупка «сброс трафика» не была применена — отключать нечего.');
  });

  it('a refusal with the worker’s retries still to come is not told yet: only the last attempt is final', async () => {
    const owner = await newOwner();
    const paid = await paidReset(owner, await resetAddOn());
    panel.answers = [UNREACHABLE, REFUSED];
    await fulfilment.applyCompletedTransaction(paid);
    const job = await jobOf(paid.id);

    assert.ok(await work(job.id), 'fixture: the first attempt failed');
    const first = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(first.attempts, 1);
    assert.equal((first.recoveryData as Record<string, unknown>)['classification'], 'TERMINAL');
    await fulfilment.settlePaidTrafficResets();

    assert.deepEqual(cardsOf(paid.paymentId), [], 'told before the worker’s own retries were spent');
    assert.deepEqual(noticesOf(paid.paymentId), []);
    assert.equal(payloadOf(await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: job.id } }))['settledAt'], undefined);

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
    // What a crash between the capture's commit and its reset leaves behind,
    // written as the capture writes it: the payment fulfilled, the job HELD,
    // no attempt, no reset recorded, no card.
    const owner = await newOwner();
    const addOnId = await resetAddOn();
    const paid = await paidReset(owner, addOnId);
    const committedAt = new Date(Date.now() - 20 * MINUTE_MS);
    await prisma.transaction.update({
      where: { id: paid.id },
      data: { subscriptionId: owner.subscriptionId, fulfilledAt: committedAt },
    });
    const held = await prisma.profileSyncJob.create({
      data: {
        subscriptionId: owner.subscriptionId,
        action: SyncAction.TRAFFIC_RESET,
        status: SyncJobStatus.PENDING,
        cause: PAID_TRAFFIC_RESET_CAUSE,
        supersededAt: committedAt,
        createdAt: committedAt,
        payload: {
          source: PAID_TRAFFIC_RESET_CAUSE,
          paymentId: paid.paymentId,
          transactionId: paid.id,
          addOnId,
          held: true,
        },
      },
    });

    await fulfilment.settlePaidTrafficResets();
    await fulfilment.settlePaidTrafficResets();

    assert.equal(panel.calls.length, 1, 'performed once');
    assert.deepEqual(cardsOf(paid.paymentId).map((event) => event.type), [EVENT_TYPES.PAYMENT_COMPLETED]);
    assert.equal((await resetsOf(paid.id)).length, 1);
    const settled = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: held.id } });
    assert.equal(settled.status, SyncJobStatus.COMPLETED);
    assert.equal(payloadOf(settled)['settledAs'], 'APPLIED');
    assert.equal(typeof payloadOf(settled)['attemptAt'], 'string');
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
    const untouched = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: held.id } });
    assert.equal(payloadOf(untouched)['attemptAt'], undefined);
  });

  it('two settles started together on one COMPLETED job: one claim, one sale', async () => {
    for (let round = 0; round < 5; round += 1) {
      const owner = await newOwner();
      const paid = await paidReset(owner, await resetAddOn());
      panel.answers = [UNREACHABLE];
      await fulfilment.applyCompletedTransaction(paid);
      const job = await jobOf(paid.id);
      assert.equal(await work(job.id), null, 'fixture: the worker performed it');

      await Promise.all([fulfilment.settlePaidTrafficResets(), otherFulfilment.settlePaidTrafficResets()]);

      assert.deepEqual(
        cardsOf(paid.paymentId).map((event) => event.type),
        [EVENT_TYPES.PAYMENT_COMPLETED],
        `round ${round}: the sale announced twice`,
      );
      assert.equal((await resetsOf(paid.id)).length, 1, `round ${round}: the claim ran twice`);
      const settled = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(payloadOf(settled)['settledAs'], 'APPLIED');
    }
  });
});
