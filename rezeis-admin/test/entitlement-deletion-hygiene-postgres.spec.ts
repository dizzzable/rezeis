import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  DeviceReductionPlanState,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { AddOnEntitlementService } from '../src/modules/add-on-entitlements/services/add-on-entitlement.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import { EntitlementBoundarySchedulerService } from '../src/modules/add-on-entitlements/services/entitlement-boundary-scheduler.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { UserDeletionService } from '../src/modules/users/services/user-deletion.service';

/**
 * «УДАЛИТЬ ПОЛНОСТЬЮ» TELLS THE TERM MODEL — against PostgreSQL.
 *
 * A full deletion moves the account's subscriptions onto an anonymous holder
 * and marks them DELETED in one bulk update. It used to stop there: a live
 * add-on stayed ACTIVE on a DELETED row, its term stayed ACTIVE, and at the
 * add-on's end the boundary sweep picked it up, the projection recompute
 * refused the DELETED row, and the boundary transaction rolled back — every
 * tick, for good, one of the rows that could starve the sweep.
 *
 * Runs only with TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `d1del-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;

let prisma: PrismaService;
const users: string[] = [];

const panelDeletes: string[] = [];
const recordingPanel = {
  getPanelShape: async () => ({ shape: 'id' as const }),
  deletePanelUser: async (identity: { readonly remnawaveId?: string }) => {
    panelDeletes.push(identity.remnawaveId ?? 'unknown');
  },
} as never;

run('full user deletion retires the durable add-on rows — PostgreSQL', () => {
  const terms = new SubscriptionTermService();
  const entitlements = new AddOnEntitlementService();
  const projections = new EffectiveProjectionService();

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.$disconnect();
  });

  it('reverses the live add-ons, ends the term, deletes the projection and supersedes the plan — and the sweep has nothing left to trip on', async () => {
    const userId = `${prefix}-user`;
    await prisma.user.create({ data: { id: userId, referralCode: userId, name: userId } });
    users.push(userId);
    const subscriptionId = `${prefix}-sub`;
    await prisma.subscription.create({
      data: {
        id: subscriptionId,
        userId,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: { id: 'plan', trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: 100,
        deviceLimit: 3,
        expiresAt: new Date(Date.now() + 10 * DAY_MS),
        remnawaveId: '777001',
      },
    });
    // In the model, the way the background cutover puts it there.
    const cutover = new EntitlementCutoverService(prisma, terms, projections);
    const ensured = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscriptionId));
    assert.equal(ensured.outcome, 'CREATED');
    const termId = ensured.activeTermId!;
    const payment = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-pay`,
        userId,
        subscriptionId,
        status: 'COMPLETED',
        purchaseType: 'ADDITIONAL',
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'USD',
        amount: new Prisma.Decimal('1.00'),
        planSnapshot: {},
      },
    });
    const activatedAt = new Date(Date.now() - DAY_MS);
    const addOn = await prisma.addOnEntitlement.create({
      data: {
        subscriptionId,
        termId,
        sourceTransactionId: payment.id,
        sourceLineKey: 'line',
        catalogRevision: 1,
        receiptName: '+1 device',
        type: AddOnType.EXTRA_DEVICES,
        valuePerUnit: 1,
        totalValue: 1n,
        lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
        unitAmount: new Prisma.Decimal('1.00'),
        totalAmount: new Prisma.Decimal('1.00'),
        currency: 'USD',
        purchasedAt: activatedAt,
        scheduledActivationAt: activatedAt,
        activatedAt,
        // Due already: the moment the sweep would have tripped on the row.
        expiresAt: new Date(Date.now() - 60_000),
        state: AddOnEntitlementState.ACTIVE,
      },
    });
    const projection = await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId } });
    await prisma.deviceReductionPlan.create({
      data: {
        subscriptionId,
        projectionId: projection.id,
        projectionRevision: projection.desiredRevision,
        desiredLimit: 3,
        state: DeviceReductionPlanState.PENDING,
      },
    });

    const service = new UserDeletionService(prisma, recordingPanel, new AddOnEntitlementService(), new SubscriptionTermService());
    const summary = await service.deleteUser(userId, { mode: 'full' });
    if (summary.holderUserId !== null) users.push(summary.holderUserId);

    // Retired, before any sweep has run.
    const reversed = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOn.id } });
    assert.equal(reversed.state, AddOnEntitlementState.REVERSED);
    assert.equal(reversed.terminalReason, 'USER_DELETED');
    assert.equal(
      await prisma.addOnEntitlementEvent.count({ where: { entitlementId: addOn.id, toState: 'REVERSED' } }),
      1,
      'the reversal is audited',
    );
    assert.equal((await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: termId } })).status, 'ENDED');
    assert.equal(
      (await prisma.subscriptionEffectiveProjection.findUniqueOrThrow({ where: { subscriptionId } })).state,
      'DELETED',
    );
    assert.equal(
      (await prisma.deviceReductionPlan.findFirstOrThrow({ where: { subscriptionId } })).state,
      DeviceReductionPlanState.SUPERSEDED,
    );
    const moved = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal(moved.status, SubscriptionStatus.DELETED);
    assert.equal(moved.userId, summary.holderUserId);
    assert.deepEqual(panelDeletes, ['777001'], 'the panel profile is still removed');

    // And the sweep: nothing of this row is due, so nothing is selected, and
    // nothing throws.
    const warnings: string[] = [];
    const boundary = new EntitlementBoundaryService(prisma, entitlements, terms, projections);
    const scheduler = new EntitlementBoundarySchedulerService(
      prisma,
      boundary,
      { enqueue: async () => undefined } as never,
      { planForSubscription: async () => ({ status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' }) } as never,
      { executePlan: async () => ({ status: 'DEFERRED' }) } as never,
      terms,
    );
    (scheduler as unknown as { logger: { warn: (message: string) => void } }).logger.warn = (message: string) => {
      warnings.push(message);
    };
    await scheduler.runDueBoundaries(new Date());
    assert.deepEqual(warnings.filter((message) => message.includes(subscriptionId)), []);
    assert.equal(
      await prisma.addOnEntitlement.count({ where: { subscriptionId, state: { in: ['ACTIVE', 'EXPIRING'] } } }),
      0,
    );
  });

  it('the ORDINARY deletion of an account with no protected history is not blocked by the cutover term', async () => {
    // The background cutover gives EVERY live subscription a term, and a term
    // is `Restrict` on its subscription — so the cascade of an ordinary
    // deletion hit the foreign key and the operator was told "protected
    // history" about an account that has none.
    const userId = `${prefix}-plain-user`;
    await prisma.user.create({ data: { id: userId, referralCode: userId, name: userId } });
    users.push(userId);
    const subscriptionId = `${prefix}-plain-sub`;
    await prisma.subscription.create({
      data: {
        id: subscriptionId,
        userId,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: { id: 'plan', trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: 10,
        deviceLimit: 1,
        expiresAt: new Date(Date.now() + 3 * DAY_MS),
      },
    });
    const cutover = new EntitlementCutoverService(prisma, terms, projections);
    await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscriptionId));

    const summary = await new UserDeletionService(prisma, recordingPanel, new AddOnEntitlementService(), new SubscriptionTermService()).deleteUser(userId);

    assert.equal(summary.mode, 'protected');
    assert.equal(await prisma.user.count({ where: { id: userId } }), 0);
    assert.equal(await prisma.subscription.count({ where: { id: subscriptionId } }), 0);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId } }), 0);
  });

  it('the ORDINARY deletion still refuses an account whose subscription holds a term of money, and names it', async () => {
    const userId = `${prefix}-migrated-user`;
    await prisma.user.create({ data: { id: userId, referralCode: userId, name: userId } });
    users.push(userId);
    const subscriptionId = `${prefix}-migrated-sub`;
    await prisma.subscription.create({
      data: {
        id: subscriptionId,
        userId,
        status: SubscriptionStatus.ACTIVE,
        planSnapshot: { id: 'plan', trafficLimitStrategy: 'NO_RESET' },
        trafficLimit: 10,
        deviceLimit: 1,
        expiresAt: new Date(Date.now() + 3 * DAY_MS),
      },
    });
    const cutover = new EntitlementCutoverService(prisma, terms, projections);
    await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscriptionId));
    // A second term no plan change wrote — its source is not one of the
    // no-money plan changes (`NON_MONEY_TERM_SOURCES`), so it is read as a paid
    // one and never thrown away. (A plan change's terms go with the account:
    // `durable-disposal-postgres.spec.ts`.)
    await prisma.subscriptionTerm.create({
      data: {
        subscriptionId,
        generation: 2,
        status: 'SCHEDULED',
        planSnapshot: {},
        startsAt: new Date(Date.now() + 3 * DAY_MS),
        endsAt: new Date(Date.now() + 33 * DAY_MS),
        trafficResetStrategy: 'NO_RESET',
      },
    });

    await assert.rejects(
      () => new UserDeletionService(prisma, recordingPanel, new AddOnEntitlementService(), new SubscriptionTermService()).deleteUser(userId),
      (error: unknown) =>
        (error as { status?: number }).status === 409 &&
        // Named, not an unnamed foreign-key refusal.
        ((error as { getResponse(): { blockedBy?: { paidTerms?: number } } }).getResponse().blockedBy?.paidTerms ?? 0) === 1,
    );
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId } }), 2, 'nothing was discarded');
  });
});
