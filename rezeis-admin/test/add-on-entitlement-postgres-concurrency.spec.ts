import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { ensureLiveResetEpoch } from '../src/modules/add-on-entitlements/services/reset-epoch.util';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { SubscriptionDeletionService } from '../src/modules/subscriptions/services/subscription-deletion.service';

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `t003-${process.pid}-${Date.now()}`;
let prisma: PrismaService;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

run('add-on entitlement PostgreSQL concurrency', () => {
  const terms = new SubscriptionTermService();
  const entitlements = new AddOnEntitlementService();
  const userId = `${prefix}-user`;
  const subscriptionId = `${prefix}-sub`;
  const transactionId = `${prefix}-tx`;
  const dueAt = new Date('2026-08-01T00:00:00.000Z');

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId, referralCode: `${prefix}-ref`, name: 'T003' } });
    await prisma.subscription.create({
      data: { id: subscriptionId, userId, status: 'ACTIVE', planSnapshot: {}, deviceLimit: 2 },
    });
    await prisma.transaction.create({
      data: {
        id: transactionId,
        paymentId: `${prefix}-payment`,
        userId,
        subscriptionId,
        status: 'COMPLETED',
        purchaseType: 'ADDITIONAL',
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'USD',
        amount: new Prisma.Decimal('2.50'),
        planSnapshot: {},
      },
    });
  });

  after(async () => {
    if (prisma !== undefined) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  });

  it('serializes concurrent generation allocation on the subscription row', async () => {
    const input = {
      subscriptionId,
      planSnapshot: {},
      startsAt: dueAt,
      endsAt: new Date('2026-09-01T00:00:00.000Z'),
      baseTrafficLimitBytes: 1000n,
      baseDeviceLimit: 2,
      trafficResetStrategy: 'MONTH' as const,
      resetAnchorAt: dueAt,
    };
    const results = await Promise.all([
      prisma.$transaction((tx) => terms.createScheduledInTransaction(tx, input)),
      prisma.$transaction((tx) => terms.createScheduledInTransaction(tx, { ...input, startsAt: new Date('2026-09-01T00:00:00.000Z'), endsAt: new Date('2026-10-01T00:00:00.000Z') })),
    ]);
    assert.deepEqual(results.map((row) => row.generation).sort(), [1, 2]);
  });

  it('rejects skipped generation and preserves the current active term on rollback', async () => {
    const rows = await prisma.subscriptionTerm.findMany({
      where: { subscriptionId }, orderBy: { generation: 'asc' },
    });
    await prisma.subscriptionTerm.update({ where: { id: rows[0]!.id }, data: { status: 'ACTIVE' } });
    const third = await prisma.$transaction((tx) =>
      terms.createScheduledInTransaction(tx, {
        subscriptionId,
        planSnapshot: {},
        startsAt: dueAt,
        endsAt: new Date('2026-11-01T00:00:00.000Z'),
        baseTrafficLimitBytes: 1000n,
        baseDeviceLimit: 2,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: dueAt,
      }),
    );

    await assert.rejects(() =>
      prisma.$transaction((tx) => terms.activateInTransaction(tx, third.id, dueAt)),
    );
    const afterFailed = await prisma.subscriptionTerm.findMany({
      where: { subscriptionId }, orderBy: { generation: 'asc' }, select: { generation: true, status: true },
    });
    assert.deepEqual(afterFailed, [
      { generation: 1, status: 'ACTIVE' },
      { generation: 2, status: 'SCHEDULED' },
      { generation: 3, status: 'SCHEDULED' },
    ]);
  });

  it('deduplicates a source line and records refund without changing lifecycle state', async () => {
    const term = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId, generation: 1 },
    });
    const input = {
      subscriptionId,
      termId: term.id,
      sourceTransactionId: transactionId,
      sourceLineKey: 'line-1',
      addOnId: null,
      catalogRevision: 1,
      receiptName: 'Test device',
      type: 'EXTRA_DEVICES' as const,
      valuePerUnit: 1,
      totalValue: 1n,
      lifetime: 'UNTIL_SUBSCRIPTION_END' as const,
      applicabilitySnapshot: { test: true },
      unitAmount: '2.50',
      totalAmount: '2.50',
      currency: 'USD' as const,
      purchasedAt: dueAt,
      scheduledActivationAt: dueAt,
      expiresAt: new Date('2026-09-01T00:00:00.000Z'),
      expiryEpochId: null,
      correlationId: `${prefix}-corr`,
    };
    const [first, replay] = await Promise.all([
      prisma.$transaction((tx) => entitlements.createPendingInTransaction(tx, input)),
      prisma.$transaction((tx) => entitlements.createPendingInTransaction(tx, input)),
    ]);
    assert.equal(first.entitlementId, replay.entitlementId);
    assert.equal(await prisma.addOnEntitlement.count({ where: { sourceTransactionId: transactionId, sourceLineKey: 'line-1' } }), 1);
    assert.equal(await prisma.addOnEntitlementEvent.count({ where: { entitlementId: first.entitlementId, commandKey: `create:${transactionId}:line-1` } }), 1);

    const refund = await prisma.$transaction((tx) =>
      entitlements.recordRefundOrChargebackInTransaction(tx, {
        entitlementId: first.entitlementId,
        commandKey: `${prefix}-refund`,
        supportRef: `${prefix}-refund`,
        summaryCode: 'PAYMENT_REFUNDED',
        correlationId: `${prefix}-refund-corr`,
      }),
    );
    assert.equal(refund.state, 'PENDING_ACTIVATION');
    assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: first.entitlementId } })).state, 'PENDING_ACTIVATION');
  });

  it('rejects cross-subscription term and expiry-epoch references without ledger writes', async () => {
    const otherSubscriptionId = `${prefix}-other-sub`;
    await prisma.subscription.create({
      data: { id: otherSubscriptionId, userId, status: 'ACTIVE', planSnapshot: {}, deviceLimit: 2 },
    });
    const foreignTerm = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: otherSubscriptionId,
        generation: 1,
        planSnapshot: {},
        startsAt: dueAt,
        status: 'ACTIVE',
        baseDeviceLimit: 2,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: dueAt,
      },
    });
    const foreignEpoch = await prisma.subscriptionResetEpoch.create({
      data: {
        termId: foreignTerm.id,
        ordinal: 1,
        startsAt: dueAt,
        plannedEndsAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    const localTerm = await prisma.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId, generation: 1 },
    });
    const base = {
      subscriptionId,
      sourceTransactionId: transactionId,
      addOnId: null,
      catalogRevision: 1,
      receiptName: 'Identity guard',
      type: 'EXTRA_DEVICES' as const,
      valuePerUnit: 1,
      totalValue: 1n,
      lifetime: 'UNTIL_SUBSCRIPTION_END' as const,
      applicabilitySnapshot: {},
      unitAmount: '1',
      totalAmount: '1',
      currency: 'USD' as const,
      purchasedAt: dueAt,
      scheduledActivationAt: dueAt,
      expiresAt: null,
    };

    await assert.rejects(() => prisma.$transaction((tx) =>
      entitlements.createPendingInTransaction(tx, {
        ...base,
        termId: foreignTerm.id,
        sourceLineKey: 'line-foreign-term',
        expiryEpochId: null,
        correlationId: `${prefix}-foreign-term`,
      }),
    ));
    await assert.rejects(() => prisma.$transaction((tx) =>
      entitlements.createPendingInTransaction(tx, {
        ...base,
        termId: localTerm.id,
        sourceLineKey: 'line-foreign-epoch',
        expiryEpochId: foreignEpoch.id,
        correlationId: `${prefix}-foreign-epoch`,
      }),
    ));

    assert.equal(await prisma.addOnEntitlement.count({
      where: {
        sourceTransactionId: transactionId,
        sourceLineKey: { in: ['line-foreign-term', 'line-foreign-epoch'] },
      },
    }), 0);
  });

  it('rejects a cross-subscription term reference at the database boundary', async () => {
    const otherSubscriptionId = `${prefix}-db-other-sub`;
    await prisma.subscription.create({ data: { id: otherSubscriptionId, userId, status: 'ACTIVE', planSnapshot: {}, deviceLimit: 1 } });
    const foreignTerm = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: otherSubscriptionId,
        generation: 1,
        planSnapshot: {},
        startsAt: dueAt,
        status: 'ACTIVE',
        baseDeviceLimit: 1,
        trafficResetStrategy: 'NO_RESET',
      },
    });
    await assert.rejects(() => prisma.addOnEntitlement.create({
      data: {
        subscriptionId,
        termId: foreignTerm.id,
        sourceTransactionId: transactionId,
        sourceLineKey: 'line-db-cross-sub',
        catalogRevision: 1,
        receiptName: 'DB guard',
        type: 'EXTRA_DEVICES',
        valuePerUnit: 1,
        quantity: 1,
        totalValue: 1n,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        applicabilitySnapshot: {},
        unitAmount: new Prisma.Decimal('1'),
        totalAmount: new Prisma.Decimal('1'),
        currency: 'USD',
        purchasedAt: dueAt,
        scheduledActivationAt: dueAt,
      },
    }));
  });

  it('rejects a cross-term expiry epoch reference at the database boundary', async () => {
    const localTerm = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId, generation: 1 } });
    const localEpoch = await prisma.subscriptionResetEpoch.create({
      data: {
        termId: localTerm.id,
        ordinal: 1,
        startsAt: dueAt,
        plannedEndsAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    const foreignTerm = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId,
        generation: 99,
        planSnapshot: {},
        startsAt: dueAt,
        status: 'SCHEDULED',
        baseDeviceLimit: 1,
        trafficResetStrategy: 'NO_RESET',
      },
    });
    await assert.rejects(() => prisma.addOnEntitlement.create({
      data: {
        subscriptionId,
        termId: foreignTerm.id,
        sourceTransactionId: transactionId,
        sourceLineKey: 'line-db-cross-epoch',
        catalogRevision: 1,
        receiptName: 'DB epoch guard',
        type: 'EXTRA_DEVICES',
        valuePerUnit: 1,
        quantity: 1,
        totalValue: 1n,
        lifetime: 'UNTIL_NEXT_RESET',
        applicabilitySnapshot: {},
        unitAmount: new Prisma.Decimal('1'),
        totalAmount: new Prisma.Decimal('1'),
        currency: 'USD',
        purchasedAt: dueAt,
        scheduledActivationAt: dueAt,
        expiryEpochId: localEpoch.id,
      },
    }));
  });

  it('persists a DELETE job when a RUNNING CREATE commits after deletion', async () => {
    const id = `${prefix}-running-create-delete`;
    await prisma.subscription.create({
      data: { id, userId, status: 'ACTIVE', planSnapshot: {}, deviceLimit: 1 },
    });
    const createJob = await prisma.profileSyncJob.create({
      data: { subscriptionId: id, action: 'CREATE', status: 'PENDING', payload: {} },
    });
    const createStarted = deferred();
    const releaseCreate = deferred();
    const processor = new ProfileSyncProcessor(
      prisma,
      {
        getPanelUserByUsername: async () => null,
        createPanelUser: async () => {
          createStarted.resolve();
          await releaseCreate.promise;
          return { uuid: `${prefix}-rw-late`, subscriptionUrl: `https://sub.example/${prefix}-late` };
        },
      } as never,
      {
        generateProfileName: async () => ({ username: `${prefix}-profile`, description: 'race profile' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
    );
    const creating = processor.process({ data: { syncJobId: createJob.id } } as never);
    await createStarted.promise;

    const deletion = new SubscriptionDeletionService(
      prisma,
      { enqueue: async () => undefined } as never,
      entitlements,
      terms,
    );
    await deletion.deleteByOperator(id);
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id } })).status, 'DELETED');
    assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: id, action: 'DELETE' } }), 0);

    releaseCreate.resolve();
    await creating;

    const linked = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    assert.equal(linked.status, 'DELETED');
    assert.equal(linked.remnawaveId, `${prefix}-rw-late`);
    assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: id, action: 'DELETE' } }), 1);
  });

  it('supersedes a RUNNING UPDATE and retains one DELETE job after deletion wins', async () => {
    const id = `${prefix}-running-update-delete`;
    await prisma.subscription.create({
      data: { id, userId, status: 'ACTIVE', remnawaveId: `${prefix}-rw-update`, planSnapshot: {}, deviceLimit: 1 },
    });
    const updateJob = await prisma.profileSyncJob.create({
      data: { subscriptionId: id, action: 'UPDATE', status: 'PENDING', payload: {} },
    });
    const updateStarted = deferred();
    const releaseUpdate = deferred();
    const queueCalls: string[] = [];
    const processor = new ProfileSyncProcessor(
      prisma,
      {
        updatePanelUser: async () => {
          updateStarted.resolve();
          await releaseUpdate.promise;
        },
      } as never,
      {
        generateProfileName: async () => ({ username: `${prefix}-update-profile`, description: 'update race' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined } as never,
    );
    const updating = processor.process({ data: { syncJobId: updateJob.id } } as never);
    await updateStarted.promise;

    const deletion = new SubscriptionDeletionService(
      prisma,
      { enqueue: async (jobId: string) => queueCalls.push(jobId) } as never,
      entitlements,
      terms,
    );
    await deletion.deleteByOperator(id);
    assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: id, action: 'DELETE' } }), 1);

    releaseUpdate.resolve();
    await updating;

    const staleUpdate = await prisma.profileSyncJob.findUniqueOrThrow({ where: { id: updateJob.id } });
    assert.notEqual(staleUpdate.status, 'COMPLETED');
    assert.notEqual(staleUpdate.supersededAt, null);
    assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: id, action: 'DELETE' } }), 1);
    assert.equal(queueCalls.length, 1);
  });

  it('rolls back partial lifecycle work when subscription deletion fails', async () => {
    const queueCalls: string[] = [];
    const failingEntitlements = {
      terminateForSubscriptionDeletion: async (tx: Prisma.TransactionClient) => {
        await tx.subscriptionTerm.updateMany({
          where: { subscriptionId, status: 'ACTIVE' },
          data: { status: 'ENDED', endedAt: new Date() },
        });
        throw new Error('forced lifecycle failure');
      },
    };
    const deletion = new SubscriptionDeletionService(
      prisma,
      { enqueue: async (id: string) => queueCalls.push(id) } as never,
      failingEntitlements as never,
      terms,
    );

    await assert.rejects(() => deletion.deleteByOperator(subscriptionId), /forced lifecycle failure/);
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).status, 'ACTIVE');
    assert.equal((await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId, generation: 1 } })).status, 'ACTIVE');
    assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId } }), 0);
    assert.deepEqual(queueCalls, []);
  });

  it('serializes two deletes that both observed ACTIVE and creates one DELETE job', async () => {
    const id = `${prefix}-delete-race`;
    await prisma.subscription.create({
      data: { id, userId, status: 'ACTIVE', remnawaveId: `${prefix}-rw-delete-race`, planSnapshot: {} },
    });
    const bothRead = deferred();
    let reads = 0;
    const facade = {
      subscription: {
        findUnique: async (args: Parameters<typeof prisma.subscription.findUnique>[0]) => {
          const row = await prisma.subscription.findUnique(args);
          reads += 1;
          if (reads === 2) bothRead.resolve();
          await bothRead.promise;
          return row;
        },
      },
      $transaction: prisma.$transaction.bind(prisma),
    };
    const queueCalls: string[] = [];
    const deletion = new SubscriptionDeletionService(
      facade as never,
      { enqueue: async (jobId: string) => queueCalls.push(jobId) } as never,
      entitlements,
      terms,
    );

    await Promise.all([deletion.deleteByOperator(id), deletion.deleteByOperator(id)]);

    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id } })).status, 'DELETED');
    assert.equal(await prisma.profileSyncJob.count({ where: { subscriptionId: id, action: 'DELETE' } }), 1);
    assert.equal(queueCalls.length, 1);
  });

  it('rejects fulfillment that waits behind a committed subscription delete', async () => {
    const id = `${prefix}-delete-wins`;
    const txId = `${prefix}-delete-wins-tx`;
    await prisma.subscription.create({ data: { id, userId, status: 'ACTIVE', planSnapshot: {} } });
    const term = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id, generation: 1, planSnapshot: {}, startsAt: dueAt,
        status: 'ACTIVE', baseDeviceLimit: 2, trafficResetStrategy: 'MONTH', resetAnchorAt: dueAt,
      },
    });
    await prisma.transaction.create({
      data: {
        id: txId, paymentId: `${txId}-payment`, userId, subscriptionId: id,
        status: 'COMPLETED', purchaseType: 'ADDITIONAL', channel: 'WEB', gatewayType: 'YOOKASSA',
        currency: 'USD', amount: new Prisma.Decimal('1'), planSnapshot: {},
      },
    });
    const deleteLocked = deferred();
    const releaseDelete = deferred();
    const deleting = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${id} FOR UPDATE`);
      deleteLocked.resolve();
      await releaseDelete.promise;
      await tx.subscription.update({ where: { id }, data: { status: 'DELETED' } });
    });
    await deleteLocked.promise;
    const input = {
      subscriptionId: id, termId: term.id, sourceTransactionId: txId, sourceLineKey: 'line-1',
      addOnId: null, catalogRevision: 1, receiptName: 'Race device', type: 'EXTRA_DEVICES' as const,
      valuePerUnit: 1, totalValue: 1n, lifetime: 'UNTIL_SUBSCRIPTION_END' as const,
      applicabilitySnapshot: {}, unitAmount: '1', totalAmount: '1', currency: 'USD' as const,
      purchasedAt: dueAt, scheduledActivationAt: dueAt, expiresAt: null, expiryEpochId: null,
      correlationId: `${txId}-corr`,
    };
    const fulfilling = prisma.$transaction((tx) => entitlements.createPendingInTransaction(tx, input));
    releaseDelete.resolve();

    await deleting;
    await assert.rejects(() => fulfilling);
    assert.equal(await prisma.addOnEntitlement.count({ where: { subscriptionId: id } }), 0);
  });

  it('deletion waits behind fulfillment and reverses the newly committed entitlement', async () => {
    const id = `${prefix}-create-wins`;
    const txId = `${prefix}-create-wins-tx`;
    await prisma.subscription.create({ data: { id, userId, status: 'ACTIVE', planSnapshot: {} } });
    const term = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id, generation: 1, planSnapshot: {}, startsAt: dueAt,
        status: 'ACTIVE', baseDeviceLimit: 2, trafficResetStrategy: 'MONTH', resetAnchorAt: dueAt,
      },
    });
    await prisma.transaction.create({
      data: {
        id: txId, paymentId: `${txId}-payment`, userId, subscriptionId: id,
        status: 'COMPLETED', purchaseType: 'ADDITIONAL', channel: 'WEB', gatewayType: 'YOOKASSA',
        currency: 'USD', amount: new Prisma.Decimal('1'), planSnapshot: {},
      },
    });
    const createdButUncommitted = deferred();
    const releaseCreate = deferred();
    const input = {
      subscriptionId: id, termId: term.id, sourceTransactionId: txId, sourceLineKey: 'line-1',
      addOnId: null, catalogRevision: 1, receiptName: 'Race device', type: 'EXTRA_DEVICES' as const,
      valuePerUnit: 1, totalValue: 1n, lifetime: 'UNTIL_SUBSCRIPTION_END' as const,
      applicabilitySnapshot: {}, unitAmount: '1', totalAmount: '1', currency: 'USD' as const,
      purchasedAt: dueAt, scheduledActivationAt: dueAt, expiresAt: null, expiryEpochId: null,
      correlationId: `${txId}-corr`,
    };
    const creating = prisma.$transaction(async (tx) => {
      const result = await entitlements.createPendingInTransaction(tx, input);
      createdButUncommitted.resolve();
      await releaseCreate.promise;
      return result;
    });
    await createdButUncommitted.promise;
    let deleteSettled = false;
    const deletion = new SubscriptionDeletionService(
      prisma,
      { enqueue: async () => undefined } as never,
      entitlements,
      terms,
    );
    const deleting = deletion.deleteByOperator(id).finally(() => { deleteSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(deleteSettled, false);
    releaseCreate.resolve();

    const created = await creating;
    await deleting;
    assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: created.entitlementId } })).state, 'REVERSED');
    assert.equal(await prisma.addOnEntitlementEvent.count({ where: { entitlementId: created.entitlementId } }), 2);
  });

  it('grandfathers a subscription into an ACTIVE term + SHADOW projection equal to legacy limits (idempotent)', async () => {
    const gib = 1024n * 1024n * 1024n;
    const id = `${prefix}-cutover-finite`;
    await prisma.subscription.create({
      data: {
        id,
        userId,
        status: 'ACTIVE',
        planSnapshot: { id: 'plan-x', trafficLimitStrategy: 'MONTH' },
        trafficLimit: 100,
        deviceLimit: 3,
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    });
    const cutover = new EntitlementCutoverService(prisma, terms, new EffectiveProjectionService());
    const row = await prisma.subscription.findUniqueOrThrow({
      where: { id },
      select: {
        id: true, status: true, trafficLimit: true, deviceLimit: true,
        planSnapshot: true, createdAt: true, expiresAt: true,
      },
    });

    const result = await prisma.$transaction((tx) => cutover.cutoverSubscriptionInTransaction(tx, row));
    assert.equal(result.outcome, 'CREATED');
    assert.equal(result.classification, 'MATCHED');

    const term = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: id } });
    assert.equal(term.status, 'ACTIVE');
    assert.equal(term.generation, 1);
    assert.equal(term.baseTrafficLimitBytes, 100n * gib);
    assert.equal(term.baseDeviceLimit, 3);

    const proj = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId: id } });
    assert.equal(proj.state, 'SHADOW');
    assert.equal(proj.desiredRevision, 0n);
    assert.equal(proj.desiredTrafficLimitBytes, 100n * gib);
    assert.equal(proj.desiredDeviceLimit, 3);

    // Rerunnable: a second cutover for the same subscription is a no-op.
    const again = await prisma.$transaction((tx) => cutover.cutoverSubscriptionInTransaction(tx, row));
    assert.equal(again.outcome, 'SKIPPED_EXISTING');
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: id } }), 1);
    assert.equal(await prisma.subscriptionEffectiveProjection.count({ where: { subscriptionId: id } }), 1);
  });

  it('grandfathers legacy unlimited limits (trafficLimit null, deviceLimit 0) to canonical null baseline', async () => {
    const id = `${prefix}-cutover-unlimited`;
    await prisma.subscription.create({
      data: {
        id,
        userId,
        status: 'ACTIVE',
        planSnapshot: { trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: null,
        deviceLimit: 0,
      },
    });
    const cutover = new EntitlementCutoverService(prisma, terms, new EffectiveProjectionService());
    const row = await prisma.subscription.findUniqueOrThrow({
      where: { id },
      select: {
        id: true, status: true, trafficLimit: true, deviceLimit: true,
        planSnapshot: true, createdAt: true, expiresAt: true,
      },
    });

    const result = await prisma.$transaction((tx) => cutover.cutoverSubscriptionInTransaction(tx, row));
    assert.equal(result.outcome, 'CREATED');

    const term = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: id } });
    assert.equal(term.baseTrafficLimitBytes, null);
    assert.equal(term.baseDeviceLimit, null);

    const proj = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId: id } });
    assert.equal(proj.desiredTrafficLimitBytes, null);
    assert.equal(proj.desiredDeviceLimit, null);
  });

  it('direct-purchase flag: captures a paid add-on into an ACTIVE entitlement and mirrors the effective limit', async () => {
    const gib = 1024n * 1024n * 1024n;
    const id = `${prefix}-ledger-sub`;
    const addOnId = `${prefix}-ledger-addon`;
    const lineKey = `${prefix}-ledger-line`;
    await prisma.subscription.create({
      data: {
        id, userId, status: 'ACTIVE', planSnapshot: {},
        trafficLimit: 100, deviceLimit: 3, remnawaveId: `${prefix}-rw-ledger`,
      },
    });
    await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id, generation: 1, status: 'ACTIVE', planSnapshot: {},
        startsAt: new Date('2026-01-01T00:00:00.000Z'), endsAt: new Date('2030-01-01T00:00:00.000Z'),
        baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET', resetAnchorAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await prisma.addOn.create({
      data: {
        id: addOnId, name: 'Extra 50GB', type: 'EXTRA_TRAFFIC', value: 50,
        lifetime: 'UNTIL_SUBSCRIPTION_END', revision: 2,
        prices: { create: [{ currency: 'USD', price: new Prisma.Decimal('2.50') }] },
      },
    });
    const txn = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-ledger-pay`, userId, subscriptionId: null, status: 'COMPLETED',
        purchaseType: 'ADDITIONAL', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
        amount: new Prisma.Decimal('2.50'),
        planSnapshot: {
          snapshotSource: 'ADDON_PURCHASE', addOnId, addOnType: 'EXTRA_TRAFFIC', addOnValue: 50,
          name: 'Extra 50GB', targetSubscriptionId: id, purchaseType: 'ADDITIONAL',
          gatewayType: 'YOOKASSA', amount: '2.50', currency: 'USD',
          contractVersion: 2, addOnRevision: 2, lifetime: 'UNTIL_SUBSCRIPTION_END', sourceLineKey: lineKey,
        },
      },
    });

    const mutation = new PaymentSubscriptionMutationService(
      prisma, { info: () => undefined } as never, entitlements, new EffectiveProjectionService(), terms,
    );

    const prev = process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
    process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = 'true';
    try {
      const first = await mutation.applyCompletedTransaction(txn);
      assert.equal(first.syncJobs.length, 1);
      // Idempotent re-apply must not create a second entitlement or double the limit.
      await mutation.applyCompletedTransaction(txn);
    } finally {
      if (prev === undefined) delete process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
      else process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = prev;
    }

    assert.equal(await prisma.addOnEntitlement.count({ where: { sourceTransactionId: txn.id } }), 1);
    const ent = await prisma.addOnEntitlement.findFirstOrThrow({ where: { sourceTransactionId: txn.id } });
    assert.equal(ent.state, 'ACTIVE');
    assert.equal(ent.type, 'EXTRA_TRAFFIC');
    assert.equal(ent.totalValue, 50n * gib);
    assert.equal(ent.catalogRevision, 2);

    const proj = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId: id } });
    assert.equal(proj.desiredTrafficLimitBytes, 150n * gib);
    assert.equal(proj.state, 'PENDING');

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    assert.equal(sub.trafficLimit, 150, 'legacy column mirrors the ledger-backed effective limit (GB)');

    const finalTxn = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    assert.notEqual(finalTxn.fulfilledAt, null);
    assert.equal(finalTxn.subscriptionId, id);
  });

  it('expires a due entitlement exactly once under concurrent boundary runs (idempotent)', async () => {
    const gib = 1024n * 1024n * 1024n;
    const id = `${prefix}-boundary-sub`;
    const txId = `${prefix}-boundary-tx`;
    const lineKey = `${prefix}-boundary-line`;
    const past = new Date('2020-01-01T00:00:00.000Z');
    await prisma.subscription.create({
      data: {
        id, userId, status: 'ACTIVE', planSnapshot: {},
        trafficLimit: 150, deviceLimit: 3, remnawaveId: `${prefix}-rw-boundary`,
      },
    });
    const term = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id, generation: 1, status: 'ACTIVE', planSnapshot: {},
        startsAt: new Date('2019-01-01T00:00:00.000Z'), endsAt: past,
        baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET', resetAnchorAt: new Date('2019-01-01T00:00:00.000Z'),
      },
    });
    await prisma.transaction.create({
      data: {
        id: txId, paymentId: `${txId}-pay`, userId, subscriptionId: id, status: 'COMPLETED',
        purchaseType: 'ADDITIONAL', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
        amount: new Prisma.Decimal('2.50'), planSnapshot: {},
      },
    });

    // Create + activate an entitlement whose expiry boundary is already in the past.
    const created = await prisma.$transaction((tx) =>
      entitlements.createPendingInTransaction(tx, {
        subscriptionId: id, termId: term.id, sourceTransactionId: txId, sourceLineKey: lineKey,
        addOnId: null, catalogRevision: 1, receiptName: 'Boundary 50GB', type: 'EXTRA_TRAFFIC',
        valuePerUnit: 50, totalValue: 50n * gib, lifetime: 'UNTIL_SUBSCRIPTION_END',
        applicabilitySnapshot: {}, unitAmount: '2.50', totalAmount: '2.50', currency: 'USD',
        purchasedAt: new Date('2019-06-01T00:00:00.000Z'), scheduledActivationAt: new Date('2019-06-01T00:00:00.000Z'),
        expiresAt: past, expiryEpochId: null, correlationId: `${txId}-corr`,
      }),
    );
    await prisma.$transaction((tx) =>
      entitlements.transitionInTransaction(tx, {
        entitlementId: created.entitlementId, command: 'ACTIVATE', commandKey: `activate:${created.entitlementId}`,
        correlationId: `${txId}-corr`, actorType: 'SYSTEM', reason: 'TEST_ACTIVATION',
      }),
    );

    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, new EffectiveProjectionService());
    // Two concurrent boundary sweeps race on the same due entitlement.
    const results = await Promise.allSettled([
      boundary.expireDueForSubscription(id, new Date()),
      boundary.expireDueForSubscription(id, new Date()),
    ]);
    // At least one sweep succeeds; a loser may roll back on the optimistic
    // version conflict — that is acceptable and leaves no partial state.
    assert.equal(results.some((r) => r.status === 'fulfilled'), true);

    const ent = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: created.entitlementId } });
    assert.equal(ent.state, 'EXPIRED', 'the due traffic entitlement is expired exactly once');
    // Idempotent transitions: exactly one begin + one complete event by command key.
    assert.equal(
      await prisma.addOnEntitlementEvent.count({
        where: { entitlementId: created.entitlementId, commandKey: `boundary-begin:${created.entitlementId}` },
      }),
      1,
    );
    assert.equal(
      await prisma.addOnEntitlementEvent.count({
        where: { entitlementId: created.entitlementId, commandKey: `boundary-complete:${created.entitlementId}` },
      }),
      1,
    );
    // The projection dropped back to the term baseline (no ACTIVE contributions).
    const proj = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId: id } });
    assert.equal(proj.desiredTrafficLimitBytes, 100n * gib);
  });

  it('activates a due scheduled renewal term and its pending entitlements at the boundary', async () => {
    const gib = 1024n * 1024n * 1024n;
    const id = `${prefix}-activate-sub`;
    const txId = `${prefix}-activate-tx`;
    const past = new Date('2020-01-01T00:00:00.000Z');
    await prisma.subscription.create({
      data: { id, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 100, deviceLimit: 3, remnawaveId: `${prefix}-rw-act` },
    });
    // Current ACTIVE term (generation 1).
    await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id, generation: 1, status: 'ACTIVE', planSnapshot: {},
        startsAt: new Date('2019-01-01T00:00:00.000Z'), endsAt: past,
        baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET', resetAnchorAt: new Date('2019-01-01T00:00:00.000Z'),
      },
    });
    // Scheduled renewal term (generation 2), already due to start.
    const scheduled = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id, generation: 2, status: 'SCHEDULED', planSnapshot: {},
        startsAt: past, endsAt: new Date('2030-01-01T00:00:00.000Z'),
        baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET', resetAnchorAt: past,
      },
    });
    await prisma.transaction.create({
      data: {
        id: txId, paymentId: `${txId}-pay`, userId, subscriptionId: id, status: 'COMPLETED',
        purchaseType: 'RENEW', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
        amount: new Prisma.Decimal('2.50'), planSnapshot: {},
      },
    });
    // A PENDING renewal add-on bound to the scheduled term, due to activate now.
    const created = await prisma.$transaction((tx) =>
      entitlements.createPendingInTransaction(tx, {
        subscriptionId: id, termId: scheduled.id, sourceTransactionId: txId, sourceLineKey: `${prefix}-act-line`,
        addOnId: null, catalogRevision: 1, receiptName: 'Renewal 50GB', type: 'EXTRA_TRAFFIC',
        valuePerUnit: 50, totalValue: 50n * gib, lifetime: 'UNTIL_SUBSCRIPTION_END',
        applicabilitySnapshot: {}, unitAmount: '2.50', totalAmount: '2.50', currency: 'USD',
        purchasedAt: past, scheduledActivationAt: past, expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        expiryEpochId: null, correlationId: `${txId}-corr`,
      }),
    );

    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, new EffectiveProjectionService());
    const result = await boundary.activateDueScheduledTerm(id, new Date());
    assert.equal(result.activated, true);
    assert.equal(result.termId, scheduled.id);
    assert.equal(result.activatedEntitlements, 1);

    // Old term ended, scheduled term is now ACTIVE.
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: scheduled.id } })).status, 'ACTIVE');
    assert.equal((await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: id, generation: 1 } })).status, 'ENDED');
    // The renewal entitlement is ACTIVE and contributes to the projection.
    assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: created.entitlementId } })).state, 'ACTIVE');
    const proj = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId: id } });
    assert.equal(proj.desiredTrafficLimitBytes, 150n * gib);
    assert.equal(proj.baselineTermId, scheduled.id);
  });

  it('creates the term reset epoch on activation only when the strategy capability is ENABLED', async () => {
    const gib = 1024n * 1024n * 1024n;
    const anchor = new Date('2026-06-15T00:00:00.000Z');
    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, new EffectiveProjectionService());

    async function activateFreshTerm(suffix: string): Promise<string> {
      const id = `${prefix}-epoch-${suffix}`;
      await prisma.subscription.create({
        data: { id, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 100, deviceLimit: 3 },
      });
      await prisma.subscriptionTerm.create({
        data: {
          subscriptionId: id, generation: 1, status: 'ACTIVE', planSnapshot: {},
          startsAt: new Date('2019-01-01T00:00:00.000Z'), endsAt: new Date('2020-01-01T00:00:00.000Z'),
          baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
          trafficResetStrategy: 'MONTH', resetAnchorAt: anchor,
        },
      });
      const scheduled = await prisma.subscriptionTerm.create({
        data: {
          subscriptionId: id, generation: 2, status: 'SCHEDULED', planSnapshot: {},
          startsAt: anchor, endsAt: new Date('2027-06-15T00:00:00.000Z'),
          baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
          trafficResetStrategy: 'MONTH', resetAnchorAt: anchor,
        },
      });
      await boundary.activateDueScheduledTerm(id, new Date());
      return scheduled.id;
    }

    // Flag OFF (default) → no epoch created.
    const offTermId = await activateFreshTerm('off');
    assert.equal(await prisma.subscriptionResetEpoch.count({ where: { termId: offTermId } }), 0);

    // Flag ON for MONTH → the term's first epoch is created deterministically.
    const prev = process.env.ADDON_RESET_EXPIRY_MONTH;
    process.env.ADDON_RESET_EXPIRY_MONTH = 'true';
    try {
      const onTermId = await activateFreshTerm('on');
      const epochs = await prisma.subscriptionResetEpoch.findMany({ where: { termId: onTermId } });
      assert.equal(epochs.length, 1);
      assert.equal(epochs[0]!.ordinal, 1);
      // MONTH epoch starts at the UTC month start of the reference instant.
      assert.equal(epochs[0]!.plannedEndsAt.getTime() > epochs[0]!.startsAt.getTime(), true);
    } finally {
      if (prev === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH;
      else process.env.ADDON_RESET_EXPIRY_MONTH = prev;
    }
  });

  it('renewal producer: schedules a gen-2 SCHEDULED term after a committed renewal only when the shadow flag is on', async () => {
    const gib = 1024n * 1024n * 1024n;
    const planId = `${prefix}-renew-plan`;
    await prisma.plan.create({
      data: {
        id: planId,
        name: `${prefix}-renew-plan-name`,
        trafficLimit: 100,
        deviceLimit: 3,
        trafficLimitStrategy: 'NO_RESET',
      },
    });
    const mutation = new PaymentSubscriptionMutationService(
      prisma, { info: () => undefined } as never, entitlements, new EffectiveProjectionService(), terms,
    );

    // Renews a subscription that already has an ACTIVE durable term (cutover
    // done) and returns its id. The renewal itself commits regardless of the
    // flag — the flag only gates the best-effort SCHEDULED term production.
    async function renewWithActiveTerm(suffix: string, termEndsAt: Date): Promise<string> {
      const id = `${prefix}-renew-${suffix}`;
      await prisma.subscription.create({
        data: {
          id, userId, status: 'ACTIVE', planSnapshot: {},
          trafficLimit: 100, deviceLimit: 3, expiresAt: termEndsAt, remnawaveId: `${prefix}-rw-${suffix}`,
        },
      });
      await prisma.subscriptionTerm.create({
        data: {
          subscriptionId: id, generation: 1, status: 'ACTIVE', planSnapshot: {},
          startsAt: new Date('2020-01-01T00:00:00.000Z'), endsAt: termEndsAt,
          baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
          trafficResetStrategy: 'NO_RESET', resetAnchorAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      });
      const txn = await prisma.transaction.create({
        data: {
          paymentId: `${id}-pay`, userId, subscriptionId: id, status: 'COMPLETED',
          purchaseType: 'RENEW', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
          amount: new Prisma.Decimal('2.50'),
          planSnapshot: { id: planId, selectedDurationDays: 30 },
        },
      });
      await mutation.applyCompletedTransaction(txn);
      return id;
    }

    // Flag OFF (default): the renewal commits, but NO scheduled term is produced.
    const offId = await renewWithActiveTerm('off', new Date('2030-01-01T00:00:00.000Z'));
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: offId, status: 'SCHEDULED' } }), 0);
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: offId } })).status, 'ACTIVE');

    // Flag ON: a gen-2 SCHEDULED term starts at the current term end and runs
    // the renewal duration on the plan-derived baseline.
    const prev = process.env.ADDON_ENTITLEMENT_SHADOW;
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    let onId: string;
    try {
      const termEndsAt = new Date('2030-06-01T00:00:00.000Z');
      onId = await renewWithActiveTerm('on', termEndsAt);
      const scheduled = await prisma.subscriptionTerm.findFirstOrThrow({
        where: { subscriptionId: onId, status: 'SCHEDULED' },
      });
      assert.equal(scheduled.generation, 2);
      assert.equal(scheduled.startsAt.getTime(), termEndsAt.getTime());
      assert.equal(scheduled.endsAt!.getTime(), new Date('2030-07-01T00:00:00.000Z').getTime());
      assert.equal(scheduled.baseTrafficLimitBytes, 100n * gib);
      assert.equal(scheduled.baseDeviceLimit, 3);
      assert.equal(scheduled.trafficResetStrategy, 'NO_RESET');

      // A second paid renewal is a distinct commercial cycle: it must enqueue
      // its own generation rather than reusing the first transaction's term.
      const txn2 = await prisma.transaction.create({
        data: {
          paymentId: `${onId}-pay2`, userId, subscriptionId: onId, status: 'COMPLETED',
          purchaseType: 'RENEW', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
          amount: new Prisma.Decimal('2.50'), planSnapshot: { id: planId, selectedDurationDays: 30 },
        },
      });
      await mutation.applyCompletedTransaction(txn2);
      const queued = await prisma.subscriptionTerm.findMany({
        where: { subscriptionId: onId, status: 'SCHEDULED' },
        orderBy: { generation: 'asc' },
      });
      assert.deepEqual(queued.map((term) => term.generation), [2, 3]);
      assert.equal(queued[1]!.startsAt.getTime(), queued[0]!.endsAt!.getTime());
      assert.equal(queued[1]!.endsAt!.getTime(), new Date('2030-07-31T00:00:00.000Z').getTime());
    } finally {
      if (prev === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
      else process.env.ADDON_ENTITLEMENT_SHADOW = prev;
    }
  });

  it('direct-purchase UNTIL_NEXT_RESET: MINTS-and-binds the current-cycle reset epoch on demand when the capability is ENABLED, else falls back to legacy', async () => {
    const gib = 1024n * 1024n * 1024n;
    // Anchor in the past so the live cycle is a real calendar-MONTH window
    // relative to `now` (the money path reads `new Date()` internally, so the
    // bound epoch is minted for the CURRENT month, NOT this anchor). The term
    // has NO pre-existing epoch — this is the Phase 2 headline: a purchase
    // against a term that was already ACTIVE when the flag flipped mints the
    // current cycle's epoch on demand and binds to it.
    const past = new Date('2026-01-01T00:00:00.000Z');

    async function purchaseUntilNextReset(
      suffix: string,
      resetFlag: string | undefined,
      reapply: boolean,
    ): Promise<{ readonly subId: string; readonly txnId: string; readonly termId: string }> {
      const subId = `${prefix}-unr-${suffix}`;
      const addOnId = `${prefix}-unr-addon-${suffix}`;
      const lineKey = `${prefix}-unr-line-${suffix}`;
      await prisma.subscription.create({
        data: {
          id: subId, userId, status: 'ACTIVE', planSnapshot: {},
          trafficLimit: 100, deviceLimit: 3, remnawaveId: `${prefix}-rw-unr-${suffix}`,
        },
      });
      const term = await prisma.subscriptionTerm.create({
        data: {
          subscriptionId: subId, generation: 1, status: 'ACTIVE', planSnapshot: {},
          startsAt: past, endsAt: new Date('2031-01-01T00:00:00.000Z'),
          baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
          trafficResetStrategy: 'MONTH', resetAnchorAt: past,
        },
      });
      await prisma.addOn.create({
        data: {
          id: addOnId, name: `Extra 50GB cycle ${suffix}`, type: 'EXTRA_TRAFFIC', value: 50,
          lifetime: 'UNTIL_NEXT_RESET', revision: 1,
          prices: { create: [{ currency: 'USD', price: new Prisma.Decimal('2.50') }] },
        },
      });
      const txn = await prisma.transaction.create({
        data: {
          paymentId: `${prefix}-unr-pay-${suffix}`, userId, subscriptionId: null, status: 'COMPLETED',
          purchaseType: 'ADDITIONAL', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
          amount: new Prisma.Decimal('2.50'),
          planSnapshot: {
            snapshotSource: 'ADDON_PURCHASE', addOnId, addOnType: 'EXTRA_TRAFFIC', addOnValue: 50,
            name: 'Extra 50GB (this cycle)', targetSubscriptionId: subId, purchaseType: 'ADDITIONAL',
            gatewayType: 'YOOKASSA', amount: '2.50', currency: 'USD',
            contractVersion: 2, addOnRevision: 1, lifetime: 'UNTIL_NEXT_RESET', sourceLineKey: lineKey,
          },
        },
      });
      const mutation = new PaymentSubscriptionMutationService(
        prisma, { info: () => undefined } as never, entitlements, new EffectiveProjectionService(), terms,
      );
      const prevDirect = process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
      const prevReset = process.env.ADDON_RESET_EXPIRY_MONTH;
      process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = 'true';
      if (resetFlag === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH;
      else process.env.ADDON_RESET_EXPIRY_MONTH = resetFlag;
      try {
        await mutation.applyCompletedTransaction(txn);
        // Ledger path only: idempotent re-apply must not create a second
        // entitlement nor a duplicate epoch (find-path returns the just-minted
        // current window). The legacy column-increment path is NOT idempotent
        // under double-apply (out of Phase 2 scope) — apply it once.
        if (reapply) await mutation.applyCompletedTransaction(txn);
      } finally {
        if (prevDirect === undefined) delete process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
        else process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = prevDirect;
        if (prevReset === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH;
        else process.env.ADDON_RESET_EXPIRY_MONTH = prevReset;
      }
      return { subId, txnId: txn.id, termId: term.id };
    }

    // Reset capability ENABLED → ledger path mints the current-cycle epoch on
    // demand and binds the entitlement to it (offered == bound).
    const on = await purchaseUntilNextReset('on', 'true', true);
    assert.equal(await prisma.addOnEntitlement.count({ where: { sourceTransactionId: on.txnId } }), 1,
      'idempotent re-apply does not create a second entitlement');
    const ent = await prisma.addOnEntitlement.findFirstOrThrow({ where: { sourceTransactionId: on.txnId } });
    assert.equal(ent.state, 'ACTIVE');
    assert.equal(ent.lifetime, 'UNTIL_NEXT_RESET');
    assert.notEqual(ent.expiryEpochId, null, 'bound to a minted reset epoch');
    assert.equal(ent.totalValue, 50n * gib);

    // Exactly one epoch was minted on the term (no duplicate on re-apply).
    assert.equal(await prisma.subscriptionResetEpoch.count({ where: { termId: on.termId } }), 1,
      'the current-cycle epoch is minted once (idempotent find-or-create)');
    const boundEpoch = await prisma.subscriptionResetEpoch.findUniqueOrThrow({ where: { id: ent.expiryEpochId! } });
    // The bound epoch is a proper calendar-MONTH window (UTC month starts,
    // one month wide) that CONTAINS the purchase instant — boundary-safe, no
    // dependence on an independently-captured `now`.
    assert.equal(boundEpoch.startsAt.getUTCDate(), 1, 'epoch starts at a UTC month start');
    assert.equal(boundEpoch.startsAt.getUTCHours(), 0);
    assert.equal(boundEpoch.plannedEndsAt.getUTCDate(), 1, 'epoch ends at a UTC month start');
    assert.equal(boundEpoch.plannedEndsAt.getUTCHours(), 0);
    assert.ok(boundEpoch.plannedEndsAt.getTime() > boundEpoch.startsAt.getTime());
    assert.ok(
      ent.purchasedAt.getTime() >= boundEpoch.startsAt.getTime() &&
        ent.purchasedAt.getTime() < boundEpoch.plannedEndsAt.getTime(),
      'the purchase instant falls within the bound cycle window',
    );
    assert.equal(ent.expiresAt!.getTime(), boundEpoch.plannedEndsAt.getTime(),
      'entitlement expires exactly at the bound epoch boundary');
    const projOn = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId: on.subId } });
    assert.equal(projOn.desiredTrafficLimitBytes, 150n * gib);

    // Reset capability OFF (default) → no ledger entitlement, no epoch minted,
    // legacy increment on the traffic column.
    const off = await purchaseUntilNextReset('off', undefined, false);
    assert.equal(await prisma.addOnEntitlement.count({ where: { sourceTransactionId: off.txnId } }), 0);
    assert.equal(await prisma.subscriptionResetEpoch.count({ where: { termId: off.termId } }), 0,
      'the disabled path mints no epoch');
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: off.subId } })).trafficLimit, 150,
      'legacy path increments the traffic column directly');
  });

  it('ensureLiveResetEpoch: two concurrent same-window mints converge to one epoch without aborting the transaction (M1)', async () => {
    const gib = 1024n * 1024n * 1024n;
    const past = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(); // both callers compute the SAME calendar-month window
    const id = `${prefix}-epoch-race-sub`;
    await prisma.subscription.create({
      data: { id, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 100, deviceLimit: 3 },
    });
    const term = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id, generation: 1, status: 'ACTIVE', planSnapshot: {},
        startsAt: past, endsAt: new Date('2031-01-01T00:00:00.000Z'),
        baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
        trafficResetStrategy: 'MONTH', resetAnchorAt: past,
      },
    });

    const call = () =>
      prisma.$transaction((tx) =>
        ensureLiveResetEpoch(tx, {
          termId: term.id, strategy: 'MONTH', anchorAt: past, capability: 'ENABLED', now,
        }),
      );
    // Neither transaction aborts (upsert ON CONFLICT DO NOTHING, not create+catch).
    const [a, b] = await Promise.all([call(), call()]);
    assert.notEqual(a, null);
    assert.notEqual(b, null);
    assert.equal(a!.id, b!.id, 'both callers converge to the single winning epoch row');
    assert.equal(await prisma.subscriptionResetEpoch.count({ where: { termId: term.id } }), 1,
      'exactly one epoch row exists for the contended window');
  });

  it('combined renewal producer: schedules a durable term only for the renewed line that already has an active term (flag on)', async () => {
    const gib = 1024n * 1024n * 1024n;
    const planA = `${prefix}-comb-plan-a`;
    const planB = `${prefix}-comb-plan-b`;
    await prisma.plan.create({ data: { id: planA, name: `${prefix}-comb-a`, trafficLimit: 100, deviceLimit: 3, trafficLimitStrategy: 'NO_RESET' } });
    await prisma.plan.create({ data: { id: planB, name: `${prefix}-comb-b`, trafficLimit: 200, deviceLimit: 5, trafficLimitStrategy: 'NO_RESET' } });

    const withTerm = `${prefix}-comb-with-term`;
    const noTerm = `${prefix}-comb-no-term`;
    const termEndsAt = new Date('2030-03-01T00:00:00.000Z');
    await prisma.subscription.create({
      data: { id: withTerm, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 100, deviceLimit: 3, expiresAt: termEndsAt, remnawaveId: `${prefix}-rw-comb-1` },
    });
    await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: withTerm, generation: 1, status: 'ACTIVE', planSnapshot: {},
        startsAt: new Date('2020-01-01T00:00:00.000Z'), endsAt: termEndsAt,
        baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET', resetAnchorAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    await prisma.subscription.create({
      data: { id: noTerm, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 200, deviceLimit: 5, remnawaveId: `${prefix}-rw-comb-2` },
    });

    const txn = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-comb-pay`, userId, subscriptionId: null, status: 'COMPLETED',
        purchaseType: 'RENEW', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
         amount: new Prisma.Decimal('5.00'), planSnapshot: { combinedRenewal: true },
      },
    });
    await prisma.transactionItem.createMany({
      data: [
        { transactionId: txn.id, subscriptionId: withTerm, planId: planA, durationDays: 30, amount: new Prisma.Decimal('2.50'), currency: 'USD' },
        { transactionId: txn.id, subscriptionId: noTerm, planId: planB, durationDays: 30, amount: new Prisma.Decimal('2.50'), currency: 'USD' },
      ],
    });

    const mutation = new PaymentSubscriptionMutationService(
      prisma, { info: () => undefined } as never, entitlements, new EffectiveProjectionService(), terms,
    );
    const prev = process.env.ADDON_ENTITLEMENT_SHADOW;
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    try {
      await mutation.applyCompletedTransaction(txn);
    } finally {
      if (prev === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
      else process.env.ADDON_ENTITLEMENT_SHADOW = prev;
    }

    // Both lines renewed to ACTIVE.
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: withTerm } })).status, 'ACTIVE');
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: noTerm } })).status, 'ACTIVE');
    // Only the line that already has an ACTIVE durable term produces a gen-2 SCHEDULED term.
    const scheduled = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: withTerm, status: 'SCHEDULED' } });
    assert.equal(scheduled.generation, 2);
    assert.equal(scheduled.startsAt.getTime(), termEndsAt.getTime());
    assert.equal(scheduled.endsAt!.getTime(), new Date('2030-03-31T00:00:00.000Z').getTime());
    assert.equal(scheduled.baseTrafficLimitBytes, 100n * gib);
    assert.equal(scheduled.baseDeviceLimit, 3);
    // The line without a durable term stays legacy — no terms scheduled.
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: noTerm } }), 0);
  });

  it('createPending accepts a combined-renewal transaction bound via a line and rejects a target without a matching line', async () => {
    const gib = 1024n * 1024n * 1024n;
    const subX = `${prefix}-comb-ent-x`;
    const planX = `${prefix}-comb-ent-plan`;
    await prisma.plan.create({ data: { id: planX, name: `${prefix}-comb-ent-plan-name`, trafficLimit: 100, deviceLimit: 3 } });
    await prisma.subscription.create({ data: { id: subX, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 100, deviceLimit: 3 } });
    const term = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: subX, generation: 1, status: 'ACTIVE', planSnapshot: {},
        startsAt: dueAt, endsAt: new Date('2031-01-01T00:00:00.000Z'),
        baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET', resetAnchorAt: dueAt,
      },
    });
    // Combined renewal: subscriptionId = null, one TransactionItem line for subX.
    const combinedTx = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-comb-ent-pay`, userId, subscriptionId: null, status: 'COMPLETED',
        purchaseType: 'RENEW', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
        amount: new Prisma.Decimal('2.50'), planSnapshot: {},
      },
    });
    await prisma.transactionItem.create({
      data: { transactionId: combinedTx.id, subscriptionId: subX, planId: planX, durationDays: 30, amount: new Prisma.Decimal('2.50'), currency: 'USD' },
    });

    const base = {
      sourceTransactionId: combinedTx.id, addOnId: null, catalogRevision: 1,
      receiptName: 'Renewal add-on', applicabilitySnapshot: {}, unitAmount: '2.50', totalAmount: '2.50',
      currency: 'USD' as const, purchasedAt: dueAt, scheduledActivationAt: dueAt, expiryEpochId: null,
    };
    // Bound to the paying transaction via its renewal line → accepted.
    const created = await prisma.$transaction((tx) =>
      entitlements.createPendingInTransaction(tx, {
        ...base, subscriptionId: subX, termId: term.id, sourceLineKey: 'renew-addon-x',
        type: 'EXTRA_TRAFFIC', valuePerUnit: 50, totalValue: 50n * gib, lifetime: 'UNTIL_SUBSCRIPTION_END',
        expiresAt: new Date('2031-01-01T00:00:00.000Z'), correlationId: `${prefix}-comb-ent-corr`,
      }),
    );
    assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: created.entitlementId } })).state, 'PENDING_ACTIVATION');
    assert.equal(
      (await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: created.entitlementId } })).subscriptionId,
      subX,
    );

    // A target subscription with NO renewal line on this transaction → rejected.
    const subY = `${prefix}-comb-ent-y`;
    await prisma.subscription.create({ data: { id: subY, userId, status: 'ACTIVE', planSnapshot: {}, deviceLimit: 2 } });
    const termY = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: subY, generation: 1, status: 'ACTIVE', planSnapshot: {},
        startsAt: dueAt, baseDeviceLimit: 2, trafficResetStrategy: 'NO_RESET', resetAnchorAt: dueAt,
      },
    });
    await assert.rejects(() =>
      prisma.$transaction((tx) =>
        entitlements.createPendingInTransaction(tx, {
          ...base, subscriptionId: subY, termId: termY.id, sourceLineKey: 'renew-addon-y',
          type: 'EXTRA_DEVICES', valuePerUnit: 1, totalValue: 1n, lifetime: 'UNTIL_SUBSCRIPTION_END',
          expiresAt: null, correlationId: `${prefix}-comb-ent-corr-y`,
        }),
      ),
    /no renewal line/);
    assert.equal(await prisma.addOnEntitlement.count({ where: { subscriptionId: subY } }), 0);
  });

  it('renewal add-on fulfillment: mints a PENDING entitlement on the scheduled term atomically when renewalAddOns is on', async () => {
    const gib = 1024n * 1024n * 1024n;
    const planId = `${prefix}-radd-plan`;
    const addOnId = `${prefix}-radd-addon`;
    const id = `${prefix}-radd-sub`;
    const termEndsAt = new Date('2030-05-01T00:00:00.000Z');
    await prisma.plan.create({ data: { id: planId, name: `${prefix}-radd-plan-name`, trafficLimit: 100, deviceLimit: 3, trafficLimitStrategy: 'NO_RESET' } });
    await prisma.addOn.create({
      data: {
        id: addOnId, name: 'Renewal Extra 50GB', type: 'EXTRA_TRAFFIC', value: 50,
        lifetime: 'UNTIL_SUBSCRIPTION_END', revision: 3,
        prices: { create: [{ currency: 'USD', price: new Prisma.Decimal('2.50') }] },
      },
    });
    await prisma.subscription.create({
      data: { id, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 100, deviceLimit: 3, expiresAt: termEndsAt, remnawaveId: `${prefix}-rw-radd` },
    });
    await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id, generation: 1, status: 'ACTIVE', planSnapshot: {},
        startsAt: new Date('2020-01-01T00:00:00.000Z'), endsAt: termEndsAt,
        baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3,
        trafficResetStrategy: 'NO_RESET', resetAnchorAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    const lineKey = `renew:${id}:${addOnId}`;
    const txn = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-radd-pay`, userId, subscriptionId: null, status: 'COMPLETED',
        purchaseType: 'RENEW', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
         amount: new Prisma.Decimal('7.50'), planSnapshot: { combinedRenewal: true },
      },
    });
    await prisma.transactionItem.create({
      data: {
        transactionId: txn.id, subscriptionId: id, planId, durationDays: 30,
        amount: new Prisma.Decimal('7.50'), currency: 'USD',
        addOnLines: [
          {
            addOnId, catalogRevision: 3, type: 'EXTRA_TRAFFIC', value: 50,
            lifetime: 'UNTIL_SUBSCRIPTION_END', activation: 'TERM_START', sourceLineKey: lineKey,
            unitAmount: '2.50', receiptName: 'Renewal Extra 50GB',
          },
        ] as Prisma.InputJsonValue,
      },
    });

    const mutation = new PaymentSubscriptionMutationService(
      prisma, { info: () => undefined } as never, entitlements, new EffectiveProjectionService(), terms,
    );
    const prevShadow = process.env.ADDON_ENTITLEMENT_SHADOW;
    const prevRenewal = process.env.ADDON_RENEWAL_ADDONS;
    process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
    process.env.ADDON_RENEWAL_ADDONS = 'true';
    try {
      await mutation.applyCompletedTransaction(txn);
      // Idempotent replay: appliedAt guards, no second entitlement.
      await mutation.applyCompletedTransaction(await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } }));
    } finally {
      if (prevShadow === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW; else process.env.ADDON_ENTITLEMENT_SHADOW = prevShadow;
      if (prevRenewal === undefined) delete process.env.ADDON_RENEWAL_ADDONS; else process.env.ADDON_RENEWAL_ADDONS = prevRenewal;
    }

    // Scheduled gen-2 term produced (starts at the current term end).
    const scheduled = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: id, status: 'SCHEDULED' } });
    assert.equal(scheduled.generation, 2);
    assert.equal(scheduled.startsAt.getTime(), termEndsAt.getTime());
    // Exactly one PENDING entitlement, bound to the scheduled term, activating at term start.
    assert.equal(await prisma.addOnEntitlement.count({ where: { sourceTransactionId: txn.id } }), 1);
    const ent = await prisma.addOnEntitlement.findFirstOrThrow({ where: { sourceTransactionId: txn.id } });
    assert.equal(ent.state, 'PENDING_ACTIVATION');
    assert.equal(ent.termId, scheduled.id);
    assert.equal(ent.subscriptionId, id);
    assert.equal(ent.type, 'EXTRA_TRAFFIC');
    assert.equal(ent.totalValue, 50n * gib);
    assert.equal(ent.catalogRevision, 3);
    assert.equal(ent.sourceLineKey, lineKey);
    assert.equal(ent.scheduledActivationAt.getTime(), scheduled.startsAt.getTime());
    assert.equal(ent.expiresAt!.getTime(), scheduled.endsAt!.getTime());
  });

  it('renewal add-on fulfillment: PERSISTED (paid) add-on lines are fulfilled even when the flag is now OFF', async () => {
    const gib = 1024n * 1024n * 1024n;
    const planId = `${prefix}-raddoff-plan`;
    const addOnId = `${prefix}-raddoff-addon`;
    const id = `${prefix}-raddoff-sub`;
    await prisma.plan.create({ data: { id: planId, name: `${prefix}-raddoff-plan-name`, trafficLimit: 100, deviceLimit: 3, trafficLimitStrategy: 'NO_RESET' } });
    await prisma.addOn.create({
      data: { id: addOnId, name: 'Renewal Extra 50GB off', type: 'EXTRA_TRAFFIC', value: 50, lifetime: 'UNTIL_SUBSCRIPTION_END', revision: 1, prices: { create: [{ currency: 'USD', price: new Prisma.Decimal('2.50') }] } },
    });
    await prisma.subscription.create({ data: { id, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 100, deviceLimit: 3, expiresAt: new Date('2030-05-01T00:00:00.000Z') } });
    await prisma.subscriptionTerm.create({
      data: { subscriptionId: id, generation: 1, status: 'ACTIVE', planSnapshot: {}, startsAt: new Date('2020-01-01T00:00:00.000Z'), endsAt: new Date('2030-05-01T00:00:00.000Z'), baseTrafficLimitBytes: 100n * gib, baseDeviceLimit: 3, trafficResetStrategy: 'NO_RESET', resetAnchorAt: new Date('2020-01-01T00:00:00.000Z') },
    });
    const txn = await prisma.transaction.create({
      data: { paymentId: `${prefix}-raddoff-pay`, userId, subscriptionId: null, status: 'COMPLETED', purchaseType: 'RENEW', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD', amount: new Prisma.Decimal('7.50'), planSnapshot: {} },
    });
    await prisma.transactionItem.create({
      data: {
        transactionId: txn.id, subscriptionId: id, planId, durationDays: 30, amount: new Prisma.Decimal('7.50'), currency: 'USD',
        addOnLines: [{ addOnId, catalogRevision: 1, type: 'EXTRA_TRAFFIC', value: 50, lifetime: 'UNTIL_SUBSCRIPTION_END', activation: 'TERM_START', sourceLineKey: `renew:${id}:${addOnId}`, unitAmount: '2.50', receiptName: 'x' }] as Prisma.InputJsonValue,
      },
    });
    const mutation = new PaymentSubscriptionMutationService(prisma, { info: () => undefined } as never, entitlements, new EffectiveProjectionService(), terms);
    // renewalAddOns OFF (default): the FLAG only gates intake (whether new lines
    // get persisted at checkout). A line that is ALREADY persisted means the
    // customer paid for it, so fulfillment must mint it regardless — otherwise a
    // flag flipped off between checkout and the webhook would drop paid goods.
    await mutation.applyCompletedTransaction(txn);
    assert.equal(await prisma.addOnEntitlement.count({ where: { sourceTransactionId: txn.id } }), 1);
    const scheduled = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: id, status: 'SCHEDULED' } });
    const ent = await prisma.addOnEntitlement.findFirstOrThrow({ where: { sourceTransactionId: txn.id } });
    assert.equal(ent.state, 'PENDING_ACTIVATION');
    assert.equal(ent.termId, scheduled.id);
  });

  it('legacy add-on top-up: EXTRA_DEVICES on an UNLIMITED subscription is a no-op (never downgrades to finite)', async () => {
    const id = `${prefix}-unlim-dev-sub`;
    const addOnId = `${prefix}-unlim-dev-addon`;
    await prisma.subscription.create({
      // deviceLimit 0 = unlimited devices; remnawaveId present so a real profile.
      data: { id, userId, status: 'ACTIVE', planSnapshot: {}, trafficLimit: 100, deviceLimit: 0, remnawaveId: `${prefix}-rw-unlim-dev` },
    });
    await prisma.addOn.create({
      data: { id: addOnId, name: '+2 devices', type: 'EXTRA_DEVICES', value: 2, lifetime: 'UNTIL_SUBSCRIPTION_END', revision: 1, prices: { create: [{ currency: 'USD', price: new Prisma.Decimal('1.00') }] } },
    });
    const txn = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-unlim-dev-pay`, userId, subscriptionId: null, status: 'COMPLETED',
        purchaseType: 'ADDITIONAL', channel: 'WEB', gatewayType: 'YOOKASSA', currency: 'USD',
        amount: new Prisma.Decimal('1.00'),
        planSnapshot: {
          snapshotSource: 'ADDON_PURCHASE', addOnId, addOnType: 'EXTRA_DEVICES', addOnValue: 2,
          name: '+2 devices', targetSubscriptionId: id, purchaseType: 'ADDITIONAL',
          gatewayType: 'YOOKASSA', amount: '1.00', currency: 'USD',
        },
      },
    });
    const mutation = new PaymentSubscriptionMutationService(
      prisma, { info: () => undefined } as never, entitlements, new EffectiveProjectionService(), terms,
    );
    // directPurchase OFF (default) → legacy increment path. Must NOT do 0 + 2 = 2.
    await mutation.applyCompletedTransaction(txn);
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id } })).deviceLimit, 0,
      'unlimited device baseline stays unlimited (no legacy 0 + N downgrade)');
    const finalTxn = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    assert.notEqual(finalTxn.fulfilledAt, null, 'fulfillment still recorded (no reprocessing)');
  });

  it('fences device-expiry completion behind the subscription lock and supersedes a stale revision', async () => {
    const id = `${prefix}-device-completion-fence`;
    const oldTxId = `${id}-old-tx`;
    const newTxId = `${id}-new-tx`;
    const expiredAt = new Date('2020-01-01T00:00:00.000Z');
    await prisma.subscription.create({
      data: { id, userId, status: 'ACTIVE', planSnapshot: {}, deviceLimit: 1 },
    });
    const term = await prisma.subscriptionTerm.create({
      data: {
        subscriptionId: id,
        generation: 1,
        status: 'ACTIVE',
        planSnapshot: {},
        startsAt: new Date('2019-01-01T00:00:00.000Z'),
        baseDeviceLimit: 1,
        trafficResetStrategy: 'NO_RESET',
      },
    });
    for (const txId of [oldTxId, newTxId]) {
      await prisma.transaction.create({
        data: {
          id: txId,
          paymentId: `${txId}-payment`,
          userId,
          subscriptionId: id,
          status: 'COMPLETED',
          purchaseType: 'ADDITIONAL',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'USD',
          amount: new Prisma.Decimal('1.00'),
          planSnapshot: {},
        },
      });
    }
    const oldEntitlement = await prisma.addOnEntitlement.create({
      data: {
        subscriptionId: id,
        termId: term.id,
        sourceTransactionId: oldTxId,
        sourceLineKey: 'old-device-expiry',
        catalogRevision: 1,
        receiptName: 'Old device expiry',
        type: 'EXTRA_DEVICES',
        valuePerUnit: 1,
        totalValue: 1n,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        applicabilitySnapshot: {},
        unitAmount: new Prisma.Decimal('1.00'),
        totalAmount: new Prisma.Decimal('1.00'),
        currency: 'USD',
        purchasedAt: new Date('2019-06-01T00:00:00.000Z'),
        scheduledActivationAt: new Date('2019-06-01T00:00:00.000Z'),
        activatedAt: new Date('2019-06-01T00:00:00.000Z'),
        expiresAt: expiredAt,
        state: 'EXPIRING',
      },
    });
    await prisma.subscriptionEffectiveProjection.create({
      data: {
        subscriptionId: id,
        baselineTermId: term.id,
        desiredRevision: 4n,
        baseDeviceLimit: 1,
        activeDeviceContribution: 0,
        desiredDeviceLimit: 1,
      },
    });

    const writerLocked = deferred();
    const releaseWriter = deferred();
    let newerEntitlementId = '';
    const writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${id} FOR UPDATE`);
      writerLocked.resolve();
      await releaseWriter.promise;
      await tx.subscriptionEffectiveProjection.update({
        where: { subscriptionId: id },
        data: { desiredRevision: 5n },
      });
      const newer = await tx.addOnEntitlement.create({
        data: {
          subscriptionId: id,
          termId: term.id,
          sourceTransactionId: newTxId,
          sourceLineKey: 'new-device-expiry',
          catalogRevision: 1,
          receiptName: 'New device expiry',
          type: 'EXTRA_DEVICES',
          valuePerUnit: 1,
          totalValue: 1n,
          lifetime: 'UNTIL_SUBSCRIPTION_END',
          applicabilitySnapshot: {},
          unitAmount: new Prisma.Decimal('1.00'),
          totalAmount: new Prisma.Decimal('1.00'),
          currency: 'USD',
          purchasedAt: new Date('2019-07-01T00:00:00.000Z'),
          scheduledActivationAt: new Date('2019-07-01T00:00:00.000Z'),
          activatedAt: new Date('2019-07-01T00:00:00.000Z'),
          expiresAt: expiredAt,
          state: 'EXPIRING',
        },
      });
      newerEntitlementId = newer.id;
    });
    await writerLocked.promise;

    const boundary = new EntitlementBoundaryService(
      prisma,
      entitlements,
      terms,
      new EffectiveProjectionService(),
    );
    const complete = (
      boundary as unknown as {
        completeVerifiedDeviceExpiryForSubscription(
          subscriptionId: string,
          projectionRevision: bigint,
          now?: Date,
        ): Promise<{ status: 'COMPLETED' | 'SUPERSEDED'; completed: number }>;
      }
    ).completeVerifiedDeviceExpiryForSubscription.bind(boundary);
    let completionSettled = false;
    const completion = complete(id, 4n, new Date()).finally(() => {
      completionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(completionSettled, false, 'completion waits behind the projection writer lock');

    releaseWriter.resolve();
    await writer;
    const result = await completion;

    assert.deepStrictEqual(result, { status: 'SUPERSEDED', completed: 0 });
    assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: oldEntitlement.id } })).state, 'EXPIRING');
    assert.equal((await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: newerEntitlementId } })).state, 'EXPIRING');
  });
});
