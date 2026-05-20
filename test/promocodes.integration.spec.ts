import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import { AdminPromocodesController } from '../src/modules/promocodes/controllers/admin-promocodes.controller';
import { InternalPromocodesController } from '../src/modules/promocodes/controllers/internal-promocodes.controller';
import { PromocodeRewardsService } from '../src/modules/promocodes/services/promocode-rewards.service';

function createPromoCode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    code: 'SUMMER2024',
    codeNormalized: 'SUMMER2024',
    availability: 'ALL',
    rewardType: 'SUBSCRIPTION',
    rewardValue: 30,
    maxActivations: 10,
    expiresAt: null,
    allowedPlanIds: [],
    ...overrides,
  };
}

function createUser() {
  return { id: 'user-1' };
}

function createAdmin(role: UserRole) {
  return {
    id: 'admin-1',
    login: 'admin',
    email: 'admin@example.com',
    name: 'Admin',
    role,
    isActive: true,
    tokenVersion: 1,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-04-19T00:00:00.000Z'),
    lastLoginIp: '127.0.0.1',
  };
}

function createMetadata() {
  return {
    requestId: 'request-4',
    remoteAddress: '127.0.0.1',
    userAgent: 'promocodes-integration-spec',
  };
}

function createSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    userId: 'user-1',
    status: 'ACTIVE',
    planSnapshot: { id: 'plan-1', name: 'Starter' },
    trafficLimit: null,
    deviceLimit: null,
    expiresAt: null,
    ...overrides,
  };
}

function createTransactionalPrisma(overrides: {
  readonly createActivation?: (args: unknown) => Promise<unknown>;
  readonly updateSubscription?: (args: unknown) => Promise<unknown>;
  readonly updateUser?: (args: unknown) => Promise<unknown>;
} = {}) {
  return {
    $transaction: async <T>(callback: (tx: any) => Promise<T>): Promise<T> =>
      callback({
        promoCodeActivation: {
          create: overrides.createActivation ?? (async () => ({ id: 'activation-1' })),
        },
        subscription: {
          update: overrides.updateSubscription ?? (async () => undefined),
        },
        user: {
          update: overrides.updateUser ?? (async () => undefined),
        },
      }),
  };
}

describe('promocodes integration slice', () => {
  it('admin activate creates activation and records success metric', async () => {
    const metricCalls: unknown[] = [];
    const activationCreates: unknown[] = [];
    const subscriptionUpdates: unknown[] = [];
    const auditCalls: unknown[] = [];
    const controller = new AdminPromocodesController(
      {} as never,
      {
        getEligibleSubscriptions: async () => [{ id: 'sub-1', planId: 'plan-1', planName: 'Starter' }],
      } as never,
      {
        determineNextStep: () => 'NONE',
      } as never,
      {
        validateForActivation: () => null,
      } as never,
      {
        recordActivationFailure: (payload: unknown) => metricCalls.push(['fail', payload]),
        recordActivationSuccess: (payload: unknown) => metricCalls.push(['success', payload]),
      } as never,
      {
        promoCode: { findUnique: async () => createPromoCode() },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription()] },
        ...createTransactionalPrisma({
          createActivation: async (args: unknown) => {
            activationCreates.push(args);
            return { id: 'activation-1' };
          },
          updateSubscription: async (args: unknown) => {
            subscriptionUpdates.push(args);
            return undefined;
          },
        }),
        promoCodeActivation: {
          count: async () => 0,
          findUnique: async () => null,
          create: async () => ({ id: 'unused-outside-transaction' }),
        },
      } as never,
      {
        log: async (payload: unknown) => {
          auditCalls.push(payload);
        },
      } as never,
    );

    const result = await controller.activate(
      { code: 'summer2024', userId: 'user-1', targetSubscriptionId: 'sub-1' } as never,
      {
        user: { id: 'admin-777', role: 'ADMIN' },
        metadata: { requestId: 'request-1' },
      } as never,
    );

    assert.equal(result.success, true);
    assert.equal(result.nextStep, 'NONE');
    assert.deepStrictEqual(result.availableSubscriptions, []);
    assert.equal(activationCreates.length, 1);
    assert.deepStrictEqual(subscriptionUpdates, []);
    assert.deepStrictEqual(auditCalls, [
      {
        adminId: 'admin-777',
        action: 'PROMOCODE_ACTIVATE',
        metadata: {
          activationId: 'activation-1',
          promoCodeId: 'promo-1',
          code: 'SUMMER2024',
          rewardType: 'SUBSCRIPTION',
          rewardValue: 30,
          targetSubscriptionId: 'sub-1',
        },
      },
    ]);
    assert.deepStrictEqual(metricCalls, [
      ['success', { source: 'admin', codeNormalized: 'SUMMER2024', rewardType: 'SUBSCRIPTION', requestId: 'request-1' }],
    ]);
  });

  it('admin activate returns validation failure and records failure metric', async () => {
    const metricCalls: unknown[] = [];
    const controller = new AdminPromocodesController(
      {} as never,
      { getEligibleSubscriptions: async () => [] } as never,
      { determineNextStep: () => 'NONE' } as never,
      { validateForActivation: () => 'DEPLETED' } as never,
      {
        recordActivationFailure: (payload: unknown) => metricCalls.push(['fail', payload]),
        recordActivationSuccess: (payload: unknown) => metricCalls.push(['success', payload]),
      } as never,
      {
        promoCode: { findUnique: async () => createPromoCode() },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription()] },
        promoCodeActivation: {
          count: async () => 10,
          findUnique: async () => null,
          create: async () => ({ id: 'activation-1' }),
        },
      } as never,
      { log: async () => undefined } as never,
    );

    const result = await controller.activate(
      { code: 'summer2024', userId: 'user-1' } as never,
      {
        user: { role: 'ADMIN' },
        metadata: { requestId: 'request-2' },
      } as never,
    );

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'DEPLETED');
    assert.deepStrictEqual(metricCalls, [
      ['fail', { source: 'admin', codeNormalized: 'SUMMER2024', rewardType: 'SUBSCRIPTION', errorCode: 'DEPLETED', requestId: 'request-2' }],
    ]);
  });

  it('internal eligible subscriptions endpoint honors allowed plan filtering', async () => {
    const controller = new InternalPromocodesController(
      {
        promoCode: { findUnique: async () => createPromoCode({ allowedPlanIds: ['plan-1'] }) },
        subscription: {
          findMany: async () => [
            createSubscription({ id: 'sub-1', planSnapshot: { id: 'plan-1', name: 'Starter' } }),
            createSubscription({ id: 'sub-2', planSnapshot: { id: 'plan-2', name: 'Pro' } }),
          ],
        },
      } as never,
      {
        getEligibleSubscriptions: async (_userId: string, promoCode: any, subs: any[]) =>
          subs
            .filter((sub) => promoCode.allowedPlanIds.includes(sub.planSnapshot.id))
            .map((sub) => ({ id: sub.id, planId: sub.planSnapshot.id, planName: sub.planSnapshot.name })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.getEligibleSubscriptions('user-1', 'SUMMER2024');

    assert.deepStrictEqual(result, [{ id: 'sub-1', planId: 'plan-1', planName: 'Starter' }]);
  });

  it('admin activate stops on allowed-user validation failure', async () => {
    const metricCalls: unknown[] = [];
    const controller = new AdminPromocodesController(
      {} as never,
      { getEligibleSubscriptions: async () => [] } as never,
      { determineNextStep: () => 'NONE' } as never,
      { validateForActivation: () => 'NOT_AVAILABLE_FOR_USER' } as never,
      {
        recordActivationFailure: (payload: unknown) => metricCalls.push(['fail', payload]),
        recordActivationSuccess: (payload: unknown) => metricCalls.push(['success', payload]),
      } as never,
      {
        promoCode: { findUnique: async () => createPromoCode({ allowedUserIds: ['user-allowed'] }) },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription()] },
        promoCodeActivation: {
          count: async () => 0,
          findUnique: async () => null,
          create: async () => ({ id: 'activation-1' }),
        },
      } as never,
      { log: async () => undefined } as never,
    );

    const result = await controller.activate(
      { code: 'summer2024', userId: 'user-1' } as never,
      {
        user: { role: 'ADMIN' },
        metadata: { requestId: 'request-3' },
      } as never,
    );

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'NOT_AVAILABLE_FOR_USER');
    assert.deepStrictEqual(metricCalls, [
      ['fail', { source: 'admin', codeNormalized: 'SUMMER2024', rewardType: 'SUBSCRIPTION', errorCode: 'NOT_AVAILABLE_FOR_USER', requestId: 'request-3' }],
    ]);
  });

  it('admin activate returns SELECT_SUBSCRIPTION with available subscriptions when targetSubscriptionId is missing', async () => {
    const metricCalls: unknown[] = [];
    const activationCreates: unknown[] = [];
    const eligibleSubscriptions = [
      { id: 'sub-1', planId: 'plan-1', planName: 'Starter' },
      { id: 'sub-2', planId: 'plan-2', planName: 'Pro' },
    ];

    const controller = new AdminPromocodesController(
      {} as never,
      {
        getEligibleSubscriptions: async () => eligibleSubscriptions,
      } as never,
      {
        determineNextStep: () => 'SELECT_SUBSCRIPTION',
      } as never,
      {
        validateForActivation: () => null,
      } as never,
      {
        recordActivationFailure: (payload: unknown) => metricCalls.push(['fail', payload]),
        recordActivationSuccess: (payload: unknown) => metricCalls.push(['success', payload]),
      } as never,
      {
        promoCode: { findUnique: async () => createPromoCode() },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription()] },
        promoCodeActivation: {
          count: async () => 0,
          findUnique: async () => null,
          create: async (args: unknown) => {
            activationCreates.push(args);
            return { id: 'activation-1' };
          },
        },
      } as never,
      { log: async () => undefined } as never,
    );

    const result = await controller.activate(
      { code: 'summer2024', userId: 'user-1' } as never,
      {
        user: { role: 'ADMIN' },
        metadata: { requestId: 'request-5' },
      } as never,
    );

    assert.equal(result.success, false);
    assert.equal(result.nextStep, 'SELECT_SUBSCRIPTION');
    assert.equal(result.errorCode, null);
    assert.deepStrictEqual(result.availableSubscriptions, eligibleSubscriptions);
    assert.equal(activationCreates.length, 0);
    assert.deepStrictEqual(metricCalls, [
      ['fail', { source: 'admin', codeNormalized: 'SUMMER2024', rewardType: 'SUBSCRIPTION', errorCode: 'CREATE_NEW_REQUIRED', requestId: 'request-5' }],
    ]);
  });

  it('admin activate rejects non-eligible targetSubscriptionId and avoids activation creation', async () => {
    const metricCalls: unknown[] = [];
    const activationCreates: unknown[] = [];
    const eligibleSubscriptions = [{ id: 'sub-1', planId: 'plan-1', planName: 'Starter' }];

    const controller = new AdminPromocodesController(
      {} as never,
      {
        getEligibleSubscriptions: async () => eligibleSubscriptions,
      } as never,
      {
        determineNextStep: () => 'SELECT_SUBSCRIPTION',
      } as never,
      {
        validateForActivation: () => null,
      } as never,
      {
        recordActivationFailure: (payload: unknown) => metricCalls.push(['fail', payload]),
        recordActivationSuccess: (payload: unknown) => metricCalls.push(['success', payload]),
      } as never,
      {
        promoCode: { findUnique: async () => createPromoCode() },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription()] },
        promoCodeActivation: {
          count: async () => 0,
          findUnique: async () => null,
          create: async (args: unknown) => {
            activationCreates.push(args);
            return { id: 'activation-1' };
          },
        },
      } as never,
      { log: async () => undefined } as never,
    );

    const result = await controller.activate(
      { code: 'summer2024', userId: 'user-1', targetSubscriptionId: 'sub-999' } as never,
      {
        user: { role: 'ADMIN' },
        metadata: { requestId: 'request-6' },
      } as never,
    );

    assert.equal(result.success, false);
    assert.equal(result.nextStep, 'SELECT_SUBSCRIPTION');
    assert.equal(result.errorCode, 'PLAN_NOT_ELIGIBLE');
    assert.deepStrictEqual(result.availableSubscriptions, eligibleSubscriptions);
    assert.equal(activationCreates.length, 0);
    assert.deepStrictEqual(metricCalls, [
      ['fail', { source: 'admin', codeNormalized: 'SUMMER2024', rewardType: 'SUBSCRIPTION', errorCode: 'PLAN_NOT_ELIGIBLE', requestId: 'request-6' }],
    ]);
  });

  it('admin activate executes CREATE_NEW subscription reward when no target subscription is required', async () => {
    const metricCalls: unknown[] = [];
    const activationCreates: unknown[] = [];
    const rewardExecutions: unknown[] = [];

    const controller = new AdminPromocodesController(
      {} as never,
      {
        getEligibleSubscriptions: async () => [],
      } as never,
      {
        determineNextStep: () => 'CREATE_NEW',
        executeReward: async (...args: unknown[]) => rewardExecutions.push(args),
      } as never,
      {
        validateForActivation: () => null,
      } as never,
      {
        recordActivationFailure: (payload: unknown) => metricCalls.push(['fail', payload]),
        recordActivationSuccess: (payload: unknown) => metricCalls.push(['success', payload]),
      } as never,
      {
        promoCode: { findUnique: async () => createPromoCode() },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription()] },
        promoCodeActivation: {
          count: async () => 0,
          findUnique: async () => null,
          create: async (args: unknown) => {
            activationCreates.push(args);
            return { id: 'activation-1', userId: 'user-1', rewardType: 'SUBSCRIPTION', rewardValue: 30, promoCodeSnapshot: { planSnapshot: { id: 'plan-1', name: 'Gift plan', trafficLimit: 100, deviceLimit: 2 } } };
          },
        },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
          promoCode: { update: async () => undefined },
          promoCodeActivation: {
            create: async (args: unknown) => {
              activationCreates.push(args);
              return { id: 'activation-1', userId: 'user-1', rewardType: 'SUBSCRIPTION', rewardValue: 30, promoCodeSnapshot: { planSnapshot: { id: 'plan-1', name: 'Gift plan', trafficLimit: 100, deviceLimit: 2 } } };
            },
          },
        }),
      } as never,
      { log: async () => undefined } as never,
    );

    const result = await controller.activate(
      { code: 'summer2024', userId: 'user-1' } as never,
      {
        user: { role: 'ADMIN' },
        metadata: { requestId: 'request-7' },
      } as never,
    );

    assert.equal(result.success, true);
    assert.equal(result.nextStep, 'NONE');
    assert.equal(result.errorCode, null);
    assert.deepStrictEqual(result.availableSubscriptions, []);
    assert.equal(activationCreates.length, 1);
    assert.equal(rewardExecutions.length, 1);
    assert.deepStrictEqual(metricCalls, [
      ['success', { source: 'admin', codeNormalized: 'SUMMER2024', rewardType: 'SUBSCRIPTION', requestId: 'request-7' }],
    ]);
  });

  it('creates a subscription and profile sync job for SUBSCRIPTION rewards without a target subscription', async () => {
    const subscriptionCreates: unknown[] = [];
    const syncCreates: unknown[] = [];
    const activationUpdates: unknown[] = [];
    const enqueuedJobs: string[] = [];
    const service = new PromocodeRewardsService({
      subscription: {
        create: async (input: unknown) => {
          subscriptionCreates.push(input);
          return { id: 'created-subscription-1' };
        },
      },
      promoCodeActivation: { update: async (input: unknown) => activationUpdates.push(input) },
      profileSyncJob: { create: async (input: unknown) => { syncCreates.push(input); return { id: 'sync-job-1' }; } },
    } as never, undefined, { enqueueJob: async (jobId: string) => { enqueuedJobs.push(jobId); return { jobId, queueJobId: `profile-sync:${jobId}`, enqueued: true, alreadyQueued: false }; } } as never);

    await service.executeReward({
      id: 'activation-1',
      userId: 'user-1',
      rewardType: 'SUBSCRIPTION',
      rewardValue: 14,
      promoCodeSnapshot: { planSnapshot: { id: 'plan-1', name: 'Gift plan', trafficLimit: 1024, deviceLimit: 2, internalSquads: ['squad-a'], externalSquad: 'external-a' } },
    } as never, null);

    assert.equal(subscriptionCreates.length, 1);
    assert.equal(JSON.stringify(subscriptionCreates).includes('Gift plan'), true);
    assert.deepStrictEqual(activationUpdates, [{ where: { id: 'activation-1' }, data: { targetSubscriptionId: 'created-subscription-1' } }]);
    assert.deepStrictEqual(syncCreates, [{ data: { subscriptionId: 'created-subscription-1', action: 'CREATE' } }]);
    assert.deepStrictEqual(enqueuedJobs, ['sync-job-1']);
  });

  it('admin create delegates CRUD input for a permitted admin', async () => {
    const createCalls: unknown[] = [];
    const controller = new AdminPromocodesController(
      {
        create: async (...args: unknown[]) => {
          createCalls.push(args);
          return { id: 'promo-1', code: 'SUMMER2024' };
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const req = {
      user: createAdmin('ADMIN' as never),
      metadata: createMetadata(),
    } as never;

    const payload = {
      code: 'SUMMER2024',
      isActive: true,
      availability: 'ALL',
      rewardType: 'DURATION',
      rewardValue: 30,
      planSnapshot: null,
      maxActivations: 1,
      allowedUserIds: [],
      allowedPlanIds: [],
      expiresAt: null,
      lifetimeDays: null,
    };

    const result = await controller.create(payload as never, req);

    assert.deepStrictEqual(result, { id: 'promo-1', code: 'SUMMER2024' });
    assert.equal(createCalls.length, 1);
  });

  it('admin activate applies duration reward inside the activation transaction', async () => {
    const subscriptionUpdates: unknown[] = [];
    const baseExpiry = new Date('2099-05-01T00:00:00.000Z');

    const controller = new AdminPromocodesController(
      {} as never,
      { getEligibleSubscriptions: async () => [] } as never,
      { determineNextStep: () => 'NONE' } as never,
      { validateForActivation: () => null } as never,
      {
        recordActivationFailure: () => undefined,
        recordActivationSuccess: () => undefined,
      } as never,
      {
        promoCode: { findUnique: async () => createPromoCode({ rewardType: 'DURATION', rewardValue: 14 }) },
        user: { findUnique: async () => createUser() },
        subscription: {
          findMany: async () => [createSubscription({ id: 'sub-1', expiresAt: baseExpiry })],
        },
        ...createTransactionalPrisma({
          updateSubscription: async (args: unknown) => {
            subscriptionUpdates.push(args);
            return undefined;
          },
        }),
        promoCodeActivation: {
          count: async () => 0,
          findUnique: async () => null,
          create: async () => ({ id: 'unused-outside-transaction' }),
        },
      } as never,
      { log: async () => undefined } as never,
    );

    const result = await controller.activate(
      { code: 'summer2024', userId: 'user-1', targetSubscriptionId: 'sub-1' } as never,
      { user: { id: 'admin-1', role: 'ADMIN' }, metadata: { requestId: 'request-duration' } } as never,
    );

    assert.equal(result.success, true);
    assert.equal(subscriptionUpdates.length, 1);
    const update = subscriptionUpdates[0] as { where: { id: string }; data: { expiresAt: Date } };
    assert.equal(update.where.id, 'sub-1');
    assert.equal(update.data.expiresAt.toISOString().slice(0, 10), '2099-05-15');
  });

  it('admin activate applies traffic reward only for bounded traffic subscriptions', async () => {
    const boundedUpdates: unknown[] = [];
    const unlimitedUpdates: unknown[] = [];

    const boundedController = new AdminPromocodesController(
      {} as never,
      { getEligibleSubscriptions: async () => [] } as never,
      { determineNextStep: () => 'NONE' } as never,
      { validateForActivation: () => null } as never,
      { recordActivationFailure: () => undefined, recordActivationSuccess: () => undefined } as never,
      {
        promoCode: { findUnique: async () => createPromoCode({ rewardType: 'TRAFFIC', rewardValue: 50 }) },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription({ id: 'sub-1', trafficLimit: 100 })] },
        ...createTransactionalPrisma({
          updateSubscription: async (args: unknown) => {
            boundedUpdates.push(args);
            return undefined;
          },
        }),
        promoCodeActivation: { count: async () => 0, findUnique: async () => null, create: async () => ({ id: 'unused' }) },
      } as never,
      { log: async () => undefined } as never,
    );

    const unlimitedController = new AdminPromocodesController(
      {} as never,
      { getEligibleSubscriptions: async () => [] } as never,
      { determineNextStep: () => 'NONE' } as never,
      { validateForActivation: () => null } as never,
      { recordActivationFailure: () => undefined, recordActivationSuccess: () => undefined } as never,
      {
        promoCode: { findUnique: async () => createPromoCode({ rewardType: 'TRAFFIC', rewardValue: 50 }) },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription({ id: 'sub-2', trafficLimit: null })] },
        ...createTransactionalPrisma({
          updateSubscription: async (args: unknown) => {
            unlimitedUpdates.push(args);
            return undefined;
          },
        }),
        promoCodeActivation: { count: async () => 0, findUnique: async () => null, create: async () => ({ id: 'unused' }) },
      } as never,
      { log: async () => undefined } as never,
    );

    await boundedController.activate(
      { code: 'summer2024', userId: 'user-1', targetSubscriptionId: 'sub-1' } as never,
      { user: { id: 'admin-1', role: 'ADMIN' }, metadata: { requestId: 'request-traffic-1' } } as never,
    );
    await unlimitedController.activate(
      { code: 'summer2024', userId: 'user-1', targetSubscriptionId: 'sub-2' } as never,
      { user: { id: 'admin-1', role: 'ADMIN' }, metadata: { requestId: 'request-traffic-2' } } as never,
    );

    assert.deepStrictEqual(boundedUpdates, [{ where: { id: 'sub-1' }, data: { trafficLimit: 150 } }]);
    assert.deepStrictEqual(unlimitedUpdates, []);
  });

  it('admin activate never reduces a higher existing device limit', async () => {
    const subscriptionUpdates: unknown[] = [];

    const controller = new AdminPromocodesController(
      {} as never,
      { getEligibleSubscriptions: async () => [] } as never,
      { determineNextStep: () => 'NONE' } as never,
      { validateForActivation: () => null } as never,
      { recordActivationFailure: () => undefined, recordActivationSuccess: () => undefined } as never,
      {
        promoCode: { findUnique: async () => createPromoCode({ rewardType: 'DEVICES', rewardValue: 3 }) },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [createSubscription({ id: 'sub-1', deviceLimit: 5 })] },
        ...createTransactionalPrisma({
          updateSubscription: async (args: unknown) => {
            subscriptionUpdates.push(args);
            return undefined;
          },
        }),
        promoCodeActivation: { count: async () => 0, findUnique: async () => null, create: async () => ({ id: 'unused' }) },
      } as never,
      { log: async () => undefined } as never,
    );

    await controller.activate(
      { code: 'summer2024', userId: 'user-1', targetSubscriptionId: 'sub-1' } as never,
      { user: { id: 'admin-1', role: 'ADMIN' }, metadata: { requestId: 'request-devices' } } as never,
    );

    assert.deepStrictEqual(subscriptionUpdates, [{ where: { id: 'sub-1' }, data: { deviceLimit: 5 } }]);
  });

  it('admin activate applies user discount rewards inside the activation transaction', async () => {
    const userUpdates: unknown[] = [];

    const personalController = new AdminPromocodesController(
      {} as never,
      { getEligibleSubscriptions: async () => [] } as never,
      { determineNextStep: () => 'NONE' } as never,
      { validateForActivation: () => null } as never,
      { recordActivationFailure: () => undefined, recordActivationSuccess: () => undefined } as never,
      {
        promoCode: { findUnique: async () => createPromoCode({ rewardType: 'PERSONAL_DISCOUNT', rewardValue: 17 }) },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [] },
        ...createTransactionalPrisma({
          updateUser: async (args: unknown) => {
            userUpdates.push(args);
            return undefined;
          },
        }),
        promoCodeActivation: { count: async () => 0, findUnique: async () => null, create: async () => ({ id: 'unused' }) },
      } as never,
      { log: async () => undefined } as never,
    );

    const purchaseController = new AdminPromocodesController(
      {} as never,
      { getEligibleSubscriptions: async () => [] } as never,
      { determineNextStep: () => 'NONE' } as never,
      { validateForActivation: () => null } as never,
      { recordActivationFailure: () => undefined, recordActivationSuccess: () => undefined } as never,
      {
        promoCode: { findUnique: async () => createPromoCode({ rewardType: 'PURCHASE_DISCOUNT', rewardValue: 9 }) },
        user: { findUnique: async () => createUser() },
        subscription: { findMany: async () => [] },
        ...createTransactionalPrisma({
          updateUser: async (args: unknown) => {
            userUpdates.push(args);
            return undefined;
          },
        }),
        promoCodeActivation: { count: async () => 0, findUnique: async () => null, create: async () => ({ id: 'unused' }) },
      } as never,
      { log: async () => undefined } as never,
    );

    await personalController.activate(
      { code: 'summer2024', userId: 'user-1' } as never,
      { user: { id: 'admin-1', role: 'ADMIN' }, metadata: { requestId: 'request-personal' } } as never,
    );
    await purchaseController.activate(
      { code: 'summer2024', userId: 'user-1' } as never,
      { user: { id: 'admin-1', role: 'ADMIN' }, metadata: { requestId: 'request-purchase' } } as never,
    );

    assert.deepStrictEqual(userUpdates, [
      { where: { id: 'user-1' }, data: { personalDiscount: 17 } },
      { where: { id: 'user-1' }, data: { purchaseDiscount: 9 } },
    ]);
  });
});
