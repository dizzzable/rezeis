import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma, SubscriptionStatus, TrafficLimitStrategy } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { OfflineBullMqQueue } from './helpers/bullmq-offline-queue';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { ADD_ON_CUTOVER_QUEUE } from '../src/modules/add-on-entitlements/add-on-cutover.constants';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import {
  CUTOVER_FAILED,
  EntitlementCutoverService,
} from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { EntitlementCutoverJobService } from '../src/modules/add-on-entitlements/services/entitlement-cutover-job.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * THE BACKGROUND CUTOVER, AGAINST POSTGRESQL.
 *
 * What only a real database can say: that the term window satisfies
 * `subscription_terms_generation_check`, that a paid renewal after the cutover
 * of a lapsed import is FULFILLED (it used to throw on an open-ended term),
 * that two passes or a pass beside a payment leave exactly one first term,
 * that a pass stopped at its budget is finished by the next one with nothing
 * remembered, and that a row that throws is held out behind ONE incident.
 *
 * Every pass is scoped to this file's rows (`onlySubscriptionIds`) except the
 * one that drives the job itself, which runs over the whole candidate set
 * exactly as the worker does — that is its point.
 *
 * Runs only with TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `d1cut-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const GIB = 1024n * 1024n * 1024n;
/** Rows in the mixed paging case. CUTOVER_PG_ROWS=10000 measures a large install. */
const MIXED_ROWS = Number(process.env.CUTOVER_PG_ROWS ?? 300);

let prisma: PrismaService;
const users: string[] = [];
const plans: string[] = [];

async function newUser(tag: string): Promise<string> {
  const id = `${prefix}-${tag}`;
  await prisma.user.create({ data: { id, referralCode: id, name: id } });
  users.push(id);
  return id;
}

function withShadowFlag<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
  if (value === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
  else process.env.ADDON_ENTITLEMENT_SHADOW = value;
  return body().finally(() => {
    if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
    else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
  });
}

/** The legacy columns as the projection spells them: bytes, canonical unlimited `null`. */
function expectedDesired(row: { trafficLimit: number | null; deviceLimit: number }) {
  return {
    traffic: row.trafficLimit === null ? null : BigInt(row.trafficLimit) * GIB,
    devices: row.deviceLimit <= 0 ? null : row.deviceLimit,
  };
}

run('add-on cutover — PostgreSQL', () => {
  const terms = new SubscriptionTermService();
  const projections = new EffectiveProjectionService();
  const entitlements = new AddOnEntitlementService();
  let cutover: EntitlementCutoverService;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    cutover = new EntitlementCutoverService(prisma, terms, projections);
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.plan.deleteMany({ where: { id: { in: plans } } });
    await prisma.$disconnect();
  });

  it('closes a lapsed import at its expiry, and a paid renewal after the cutover is fulfilled', async () => {
    const userId = await newUser('f3');
    const planId = `${prefix}-f3-plan`;
    await prisma.plan.create({
      data: { id: planId, name: planId, trafficLimit: 100, deviceLimit: 3, trafficLimitStrategy: 'NO_RESET' },
    });
    plans.push(planId);
    // The import shape: created now, already expired a month ago.
    const lapsedAt = new Date(Date.now() - 30 * DAY_MS);
    const subscription = await prisma.subscription.create({
      data: {
        id: `${prefix}-f3-sub`,
        userId,
        status: SubscriptionStatus.EXPIRED,
        planSnapshot: { id: planId, trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: 100,
        deviceLimit: 3,
        expiresAt: lapsedAt,
        remnawaveId: `${prefix}-f3-rw`,
      },
    });

    const ensured = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscription.id));
    assert.equal(ensured.outcome, 'CREATED');
    assert.deepEqual(ensured.ambiguousReasons, ['NON_POSITIVE_TERM_WINDOW']);
    const first = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    assert.equal(first.endsAt?.getTime(), lapsedAt.getTime(), 'the window ends where the subscription did');
    assert.equal(first.startsAt.getTime(), lapsedAt.getTime() - 1_000);

    // The customer pays to come back, with stage 1 on — the renewal producer
    // appends a term after the cutover's. Before the fix it threw "Cannot
    // append a renewal term after an open-ended term" and the payment stayed
    // taken and unfulfilled.
    const mutation = new PaymentSubscriptionMutationService(
      prisma,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      entitlements,
      projections,
      terms,
      {} as never,
    );
    const payment = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-f3-pay`,
        userId,
        subscriptionId: subscription.id,
        status: 'COMPLETED',
        purchaseType: 'RENEW',
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'USD',
        amount: new Prisma.Decimal('2.50'),
        planSnapshot: { id: planId, selectedDurationDays: 30 },
      },
    });
    const paidAt = Date.now();
    await withShadowFlag('true', () => mutation.applyCompletedTransaction(payment));

    const renewed = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(renewed.status, SubscriptionStatus.ACTIVE);
    assert.ok(renewed.expiresAt !== null && renewed.expiresAt.getTime() >= paidAt + 30 * DAY_MS - 1_000);
    const queued = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: subscription.id, status: 'SCHEDULED' },
    });
    assert.equal(queued.generation, 2);
    assert.ok(queued.startsAt.getTime() >= paidAt - 1_000, 'a lapsed tail is followed from now');
    assert.ok(queued.startsAt.getTime() <= Date.now());

    // And the boundary sweep takes it from there.
    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projections);
    const activation = await boundary.activateDueScheduledTerm(subscription.id, new Date());
    assert.equal(activation.activated, true);
    const chain = await prisma.subscriptionTerm.findMany({
      where: { subscriptionId: subscription.id },
      orderBy: { generation: 'asc' },
      select: { generation: true, status: true },
    });
    assert.deepEqual(chain, [
      { generation: 1, status: 'ENDED' },
      { generation: 2, status: 'ACTIVE' },
    ]);
  });

  it('ensure is idempotent: a second call and a concurrent call create nothing more', async () => {
    const userId = await newUser('idem');
    const id = `${prefix}-idem-sub`;
    await prisma.subscription.create({
      data: {
        id,
        userId,
        status: 'ACTIVE',
        planSnapshot: { id: 'p', trafficLimitStrategy: 'MONTH' },
        trafficLimit: 55,
        deviceLimit: 4,
        expiresAt: new Date(Date.now() + 20 * DAY_MS),
      },
    });

    const [left, right] = await Promise.all([
      prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, id)),
      prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, id)),
    ]);
    assert.deepEqual([left.outcome, right.outcome].sort(), ['CREATED', 'EXISTING']);
    assert.equal(left.activeTermId, right.activeTermId, 'both callers are handed the same ACTIVE term');
    const again = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, id));
    assert.equal(again.outcome, 'EXISTING');
    assert.equal(again.activeTermId, left.activeTermId);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: id } }), 1);
    assert.equal(await prisma.subscriptionEffectiveProjection.count({ where: { subscriptionId: id } }), 1);
    const created = left.outcome === 'CREATED' ? left : right;
    assert.equal(created.shadowMatchesColumns, true);
  });

  it('ensure beside a paid renewal on the same row: exactly one first term, and the renewal is kept', async () => {
    const userId = await newUser('race');
    const planId = `${prefix}-race-plan`;
    await prisma.plan.create({
      data: { id: planId, name: planId, trafficLimit: 80, deviceLimit: 2, trafficLimitStrategy: 'NO_RESET' },
    });
    plans.push(planId);
    const mutation = new PaymentSubscriptionMutationService(
      prisma,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      entitlements,
      projections,
      terms,
      {} as never,
    );

    for (let round = 0; round < 4; round += 1) {
      const id = `${prefix}-race-sub-${round}`;
      const liveUntil = new Date(Date.now() + 10 * DAY_MS);
      await prisma.subscription.create({
        data: {
          id,
          userId,
          status: 'ACTIVE',
          planSnapshot: { id: planId, trafficLimitStrategy: 'NO_RESET' },
          trafficLimit: 80,
          deviceLimit: 2,
          expiresAt: liveUntil,
          remnawaveId: `${prefix}-race-rw-${round}`,
        },
      });
      const payment = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-race-pay-${round}`,
          userId,
          subscriptionId: id,
          status: 'COMPLETED',
          purchaseType: 'RENEW',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'USD',
          amount: new Prisma.Decimal('2.50'),
          planSnapshot: { id: planId, selectedDurationDays: 30 },
        },
      });

      // Both wait on the same row lock, held by a third transaction, and are
      // released together — the order they then take it in is PostgreSQL's.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${id} FOR UPDATE`);
          await gate;
        },
        { timeout: 20_000 },
      );
      const racing = withShadowFlag('true', () =>
        Promise.all([
          prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, id)),
          mutation.applyCompletedTransaction(payment),
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      await holder;
      await racing;

      const rows = await prisma.subscriptionTerm.findMany({
        where: { subscriptionId: id },
        orderBy: { generation: 'asc' },
        select: { generation: true, status: true },
      });
      assert.equal(rows.filter((row) => row.generation === 1).length, 1, `round ${round}: one first term`);
      assert.equal(rows[0]!.status, 'ACTIVE');
      // Whichever came first, the paid time is on the row.
      const renewed = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      assert.ok(renewed.expiresAt!.getTime() >= liveUntil.getTime() + 30 * DAY_MS - 1_000);
      if (rows.length === 2) {
        // Ensure first: the renewal appended its own term after it.
        assert.deepEqual(rows[1], { generation: 2, status: 'SCHEDULED' });
      } else {
        // Renewal first (no term yet, column path): the cutover minted the
        // first term from the RENEWED row, so it ends at the new expiry.
        const only = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: id } });
        assert.equal(only.endsAt?.getTime(), renewed.expiresAt?.getTime());
      }
    }
  });

  it('pages a mixed install to completion across a stopped pass and a restart, and a rerun does nothing', async () => {
    const userId = await newUser('mixed');
    const kinds = ['finite', 'unlimited', 'lifetime', 'lapsed', 'noStrategy', 'deleted', 'limited'] as const;
    const now = Date.now();
    const rows = Array.from({ length: MIXED_ROWS }, (_, index) => {
      const kind = kinds[index % kinds.length]!;
      return {
        id: `${prefix}-mixed-${String(index).padStart(6, '0')}`,
        userId,
        status:
          kind === 'deleted'
            ? SubscriptionStatus.DELETED
            : kind === 'limited'
              ? SubscriptionStatus.LIMITED
              : SubscriptionStatus.ACTIVE,
        planSnapshot:
          kind === 'noStrategy' ? { id: 'p' } : { id: 'p', trafficLimitStrategy: TrafficLimitStrategy.MONTH },
        trafficLimit: kind === 'unlimited' ? null : 10 + (index % 90),
        deviceLimit: kind === 'unlimited' ? 0 : 1 + (index % 5),
        createdAt: new Date(now - (MIXED_ROWS - index) * 1_000),
        expiresAt:
          kind === 'lifetime'
            ? null
            : kind === 'lapsed'
              ? new Date(now - (MIXED_ROWS - index) * 1_000 - 7 * DAY_MS)
              : new Date(now + 30 * DAY_MS),
      };
    });
    for (let offset = 0; offset < rows.length; offset += 1_000) {
      await prisma.subscription.createMany({ data: rows.slice(offset, offset + 1_000) });
    }
    const ids = rows.map((row) => row.id);
    const live = rows.filter((row) => row.status !== SubscriptionStatus.DELETED);

    // A dry run classifies and writes nothing.
    const dry = await cutover.runCutover({ dryRun: true, onlySubscriptionIds: ids, batchSize: 50 });
    assert.equal(dry.candidates, live.length);
    assert.ok(dry.ambiguous > 0 && dry.matched > 0);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: { in: ids } } }), 0);

    // A pass that stops at its budget…
    const startedAt = Date.now();
    const first = await cutover.runCutover({
      dryRun: false,
      onlySubscriptionIds: ids,
      batchSize: 17,
      maxRows: Math.floor(live.length / 3),
    });
    assert.equal(first.truncated, true);
    assert.equal(first.created, Math.floor(live.length / 3));
    // …and a "restarted" process: a new service instance, no cursor carried.
    const restarted = new EntitlementCutoverService(prisma, terms, projections);
    const second = await restarted.runCutover({ dryRun: false, onlySubscriptionIds: ids, batchSize: 17 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(second.truncated, false);
    assert.equal(first.created + second.created, live.length);
    assert.equal(first.shadowMismatches + second.shadowMismatches, 0, 'the stage-1 go/no-go');
    assert.equal(first.failed + second.failed + first.deferred + second.deferred, 0);
    // The measurement the runbook quotes.
    console.log(`cutover of ${live.length} subscriptions took ${elapsedMs} ms`);

    // Every live row: exactly one term, generation 1, ACTIVE, and a SHADOW
    // projection equal to its columns. Every DELETED row: nothing.
    const termRows = await prisma.subscriptionTerm.findMany({
      where: { subscriptionId: { in: ids } },
      select: { subscriptionId: true, generation: true, status: true, startsAt: true, endsAt: true },
    });
    const projectionRows = await prisma.subscriptionEffectiveProjection.findMany({
      where: { subscriptionId: { in: ids } },
      select: { subscriptionId: true, state: true, desiredTrafficLimitBytes: true, desiredDeviceLimit: true },
    });
    assert.equal(termRows.length, live.length);
    assert.equal(projectionRows.length, live.length);
    const termBy = new Map(termRows.map((row) => [row.subscriptionId, row]));
    const projectionBy = new Map(projectionRows.map((row) => [row.subscriptionId, row]));
    for (const row of live) {
      const term = termBy.get(row.id);
      assert.ok(term, row.id);
      assert.equal(term.generation, 1);
      assert.equal(term.status, 'ACTIVE');
      assert.equal(term.endsAt?.getTime() ?? null, row.expiresAt?.getTime() ?? null, `${row.id} ends at its expiry`);
      assert.ok(term.endsAt === null || term.endsAt.getTime() > term.startsAt.getTime());
      const projection = projectionBy.get(row.id)!;
      const expected = expectedDesired(row);
      assert.equal(projection.state, 'SHADOW');
      assert.equal(projection.desiredTrafficLimitBytes, expected.traffic, row.id);
      assert.equal(projection.desiredDeviceLimit, expected.devices, row.id);
    }

    // Rerun: nothing left to do.
    const third = await cutover.runCutover({ dryRun: false, onlySubscriptionIds: ids });
    assert.equal(third.candidates, 0);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: { in: ids } } }), live.length);
  });

  it('two passes at once leave one first term per row and fail nothing', async () => {
    const userId = await newUser('twin');
    const ids = Array.from({ length: 40 }, (_, index) => `${prefix}-twin-${String(index).padStart(3, '0')}`);
    await prisma.subscription.createMany({
      data: ids.map((id, index) => ({
        id,
        userId,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: { id: 'p', trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: 20 + index,
        deviceLimit: 2,
        expiresAt: new Date(Date.now() + 5 * DAY_MS),
      })),
    });
    const other = new EntitlementCutoverService(prisma, terms, projections);
    const [left, right] = await Promise.all([
      cutover.runCutover({ dryRun: false, onlySubscriptionIds: ids, batchSize: 5 }),
      other.runCutover({ dryRun: false, onlySubscriptionIds: ids, batchSize: 5 }),
    ]);
    assert.equal(left.created + right.created, ids.length);
    assert.equal(left.failed + right.failed, 0);
    const counts = await prisma.subscriptionTerm.groupBy({
      by: ['subscriptionId'],
      where: { subscriptionId: { in: ids } },
      _count: { _all: true },
    });
    assert.equal(counts.length, ids.length);
    assert.ok(counts.every((row) => row._count._all === 1));
  });

  it('a row that throws raises ONE incident, the rest complete, and it is held out until acknowledged', async () => {
    const userId = await newUser('fail');
    const ids = ['a', 'b', 'c'].map((tag) => `${prefix}-fail-${tag}`);
    await prisma.subscription.createMany({
      data: ids.map((id, index) => ({
        id,
        userId,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: { id: 'p', trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: 10,
        deviceLimit: 1,
        createdAt: new Date(Date.now() - (3 - index) * 1_000),
        expiresAt: new Date(Date.now() + 5 * DAY_MS),
      })),
    });
    const poisoned = ids[0]!;
    // The injected fault: the recompute throws for ONE row, the first in the
    // cutover's order, so a pass that stalled on it would do nothing at all.
    class FailingFor extends EffectiveProjectionService {
      public failing = true;
      public override async recomputeInTransaction(
        tx: Prisma.TransactionClient,
        input: Parameters<EffectiveProjectionService['recomputeInTransaction']>[1],
      ) {
        if (this.failing && input.subscriptionId === poisoned) throw new Error('injected recompute fault');
        return super.recomputeInTransaction(tx, input);
      }
    }
    const faulty = new FailingFor();
    const service = new EntitlementCutoverService(prisma, terms, faulty);

    const report = await service.runCutover({ dryRun: false, onlySubscriptionIds: ids });
    assert.equal(report.failed, 1);
    assert.equal(report.created, 2);
    assert.deepEqual(report.failedSamples.map((sample) => sample.subscriptionId), [poisoned]);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: poisoned } }), 0, 'rolled back whole');
    const incidents = await prisma.entitlementIncident.findMany({ where: { subscriptionId: poisoned } });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.summaryCode, CUTOVER_FAILED);
    assert.equal(incidents[0]!.kind, 'RECONCILIATION_REQUIRED');
    assert.equal(incidents[0]!.supportRef, `cutover-failed:${poisoned}:1`);

    // Held out: the next pass does not retry it, and does not raise another.
    const held = await service.runCutover({ dryRun: false, onlySubscriptionIds: ids });
    assert.equal(held.candidates, 0);
    assert.equal(await prisma.entitlementIncident.count({ where: { subscriptionId: poisoned } }), 1);
    assert.equal((await cutover.progress()).needAttention >= 1, true);

    // Acknowledged — «Принять», the one action an operator has on an incident —
    // and still failing: a NEW episode, a new incident.
    await prisma.entitlementIncident.update({ where: { id: incidents[0]!.id }, data: { state: 'ACKNOWLEDGED' } });
    const again = await service.runCutover({ dryRun: false, onlySubscriptionIds: ids });
    assert.equal(again.failed, 1);
    assert.deepEqual(
      (await prisma.entitlementIncident.findMany({ where: { subscriptionId: poisoned }, orderBy: { createdAt: 'asc' } })).map(
        (row) => row.supportRef,
      ),
      [`cutover-failed:${poisoned}:1`, `cutover-failed:${poisoned}:2`],
    );

    // Acknowledged and fixed: it comes in.
    await prisma.entitlementIncident.updateMany({ where: { subscriptionId: poisoned }, data: { state: 'ACKNOWLEDGED' } });
    faulty.failing = false;
    const healed = await service.runCutover({ dryRun: false, onlySubscriptionIds: ids });
    assert.equal(healed.created, 1);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: poisoned } }), 1);
  });

  it('a lock conflict that keeps recurring is deferred, not reported as a failure', async () => {
    const userId = await newUser('conflict');
    const id = `${prefix}-conflict-sub`;
    await prisma.subscription.create({
      data: {
        id,
        userId,
        status: 'ACTIVE',
        planSnapshot: { id: 'p', trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: 10,
        deviceLimit: 1,
        expiresAt: new Date(Date.now() + 5 * DAY_MS),
      },
    });
    let attempts = 0;
    class Conflicting extends EffectiveProjectionService {
      public override async recomputeInTransaction(): Promise<never> {
        attempts += 1;
        throw new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock', {
          code: 'P2034',
          clientVersion: 'test',
        });
      }
    }
    const service = new EntitlementCutoverService(prisma, terms, new Conflicting());
    const report = await service.runCutover({ dryRun: false, onlySubscriptionIds: [id] });
    assert.equal(report.deferred, 1);
    assert.equal(report.failed, 0);
    assert.equal(attempts, 3, 'retried in place before deferring');
    assert.equal(await prisma.entitlementIncident.count({ where: { subscriptionId: id } }), 0);
    // Still a candidate: the next pass tries again.
    const next = await cutover.runCutover({ dryRun: false, onlySubscriptionIds: [id] });
    assert.equal(next.created, 1);
  });

  it('the job, with stage 1 on, brings rows in through the worker path; with it off, it does nothing', async () => {
    const userId = await newUser('job');
    const id = `${prefix}-job-sub`;
    await prisma.subscription.create({
      data: {
        id,
        userId,
        status: 'ACTIVE',
        planSnapshot: { id: 'p', trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: 12,
        deviceLimit: 2,
        expiresAt: new Date(Date.now() + 9 * DAY_MS),
      },
    });
    const job = new EntitlementCutoverJobService(
      cutover,
      new OfflineBullMqQueue<unknown>(ADD_ON_CUTOVER_QUEUE).asQueue(),
    );

    // OFF spelled out: unset is ON since the 24.09.2026 flip.
    assert.equal(await withShadowFlag('false', () => job.runTick()), null);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: id } }), 0);

    const report = await withShadowFlag('true', () => job.runTick());
    assert.ok(report !== null && report.created >= 1);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: id, status: 'ACTIVE' } }), 1);
  });
});
