import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanAvailability, PlanType } from '@prisma/client';

import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';

describe('PlansAdminService', () => {
  it('rejects creating a second active trial plan before persisting', async () => {
    const prismaService = {
      plan: {
        findFirst: async (...args: readonly unknown[]) => {
          const where = (args[0] as { readonly where: { readonly name?: string } }).where;
          if (where.name === 'Trial Plan') {
            return null;
          }
          return { id: 'existing-trial' };
        },
      },
      user: { findMany: async () => [] },
    };
    const service = createService(prismaService, {
      getInternalSquadOptions: async () => [],
      getExternalSquadOptions: async () => [],
    });

    await assert.rejects(
      async () => {
        await service.createPlan(
          {
            name: 'Trial Plan',
            type: PlanType.BOTH,
            availability: PlanAvailability.TRIAL,
            deviceLimit: 1,
            durations: [{ days: 30, prices: [{ currency: 'USD', price: '0.99' }] }],
          },
          {
            currentAdmin: { id: 'admin-1' } as never,
            requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
          },
        );
      },
      {
        name: 'BadRequestException',
        message: 'Only one active trial plan is allowed',
      },
    );
  });

  it('blocks deletion when a subscription snapshot still references the plan', async () => {
    const prismaService = {
      $transaction: async <T>(callback: (client: any) => Promise<T>): Promise<T> =>
        callback({
          plan: {
            findUnique: async () => ({ id: 'plan-1', name: 'Starter', orderIndex: 1 }),
            findFirst: async () => null,
            delete: async () => undefined,
            findMany: async () => [],
            update: async () => undefined,
          },
          $queryRaw: async () => [{ id: 'subscription-1' }],
        }),
    };
    const service = createService(
      prismaService,
      { getInternalSquadOptions: async () => [], getExternalSquadOptions: async () => [] },
    );

    await assert.rejects(
      async () => {
        await service.deletePlan('plan-1', {
          currentAdmin: { id: 'admin-1' } as never,
          requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
        });
      },
      {
        name: 'BadRequestException',
        message: 'Plan is referenced by subscriptions or transition rules. Archive it instead.',
      },
    );
  });

  it('persists paid trial plans with one priced duration and current trial settings', async () => {
    let actualCreateData: unknown;
    const prismaService =
      {
        plan: {
          findFirst: async (...args: readonly unknown[]) => {
            const where = (args[0] as { readonly where: { readonly name?: string } }).where;
            if (where.name === 'Trial Plan') {
              return null;
            }
            return null;
          },
        },
        user: { findMany: async () => [] },
        $transaction: async <T>(callback: (client: any) => Promise<T>): Promise<T> =>
          callback({
            plan: {
              findFirst: async () => ({ orderIndex: 3 }),
              create: async (...args: readonly unknown[]) => {
                actualCreateData = (args[0] as { readonly data: unknown }).data;
                return {
                  id: 'plan-1',
                  orderIndex: 4,
                  name: 'Trial Plan',
                  description: null,
                  tag: null,
                  icon: null,
                  isActive: true,
                  isArchived: false,
                  archivedRenewMode: 'SELF_RENEW',
                  type: PlanType.BOTH,
                  availability: PlanAvailability.TRIAL,
                  trafficLimit: 1024,
                  deviceLimit: 1,
                  trafficLimitStrategy: 'NO_RESET',
                  internalSquads: ['11111111-1111-1111-1111-111111111111'],
                  externalSquad: null,
                  upgradeToPlanIds: [],
                  replacementPlanIds: [],
                  allowedUserIds: [],
                  trialSettings: { maxClaims: 2, free: false, availabilityScope: 'INVITED' },
                  createdAt: new Date('2026-04-19T12:00:00.000Z'),
                  updatedAt: new Date('2026-04-19T12:00:00.000Z'),
                  durations: [
                    {
                      id: 'duration-1',
                      days: 30,
                      prices: [{ id: 'price-1', currency: 'USD', price: { toString: (): string => '0' } }],
                    },
                  ],
                };
              },
            },
            adminAuditLog: { create: async () => undefined },
            subscription: { update: async () => undefined },
            $queryRaw: async () => [],
          }),
      };
    const service = createService(
      prismaService,
      {
        getInternalSquadOptions: async () => [{ uuid: '11111111-1111-1111-1111-111111111111', name: 'Core' }],
        getExternalSquadOptions: async () => [],
      },
    );

    await service.createPlan(
      {
        name: 'Trial Plan',
        type: PlanType.BOTH,
        availability: PlanAvailability.TRIAL,
        deviceLimit: 1,
        trafficLimit: 1024,
        internalSquads: ['11111111-1111-1111-1111-111111111111'],
        trialSettings: { maxClaims: 2, free: false, availabilityScope: 'INVITED' },
        durations: [{ days: 30, prices: [{ currency: 'USD', price: '9.99' }] }],
      },
      {
        currentAdmin: { id: 'admin-1' } as never,
        requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
      },
    );

    assert.deepStrictEqual(actualCreateData, {
      name: 'Trial Plan',
      description: null,
      tag: null,
      icon: null,
      isActive: true,
      isArchived: false,
      archivedRenewMode: 'SELF_RENEW',
      type: PlanType.BOTH,
      availability: PlanAvailability.TRIAL,
      trafficLimit: 1024,
      deviceLimit: 1,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: ['11111111-1111-1111-1111-111111111111'],
      externalSquad: null,
      upgradeToPlanIds: [],
      replacementPlanIds: [],
      allowedUserIds: [],
      trialSettings: { maxClaims: 2, free: false, availabilityScope: 'INVITED' },
      orderIndex: 4,
      durations: {
        create: [
          {
            days: 30,
            prices: {
              create: [{ currency: 'USD', price: '9.99' }],
            },
          },
        ],
      },
    });
  });

  it('clears allowed users and archived replacement state during normalization before update', async () => {
    let actualUpdateData: unknown;
    let actualSyncPlan: unknown;
    const prismaService =
      {
        plan: {
          findFirst: async (...args: readonly unknown[]) => {
            const where = (args[0] as { readonly where: { readonly name?: string } }).where;
            if (where.name === 'Starter') {
              return { id: 'plan-1' };
            }
            return null;
          },
          findUnique: async () => ({
            id: 'plan-1',
            orderIndex: 1,
            name: 'Starter',
            description: null,
            tag: null,
            icon: null,
            isActive: true,
            isArchived: true,
            archivedRenewMode: 'REPLACE_ON_RENEW',
            type: PlanType.BOTH,
            availability: PlanAvailability.ALLOWED,
            trafficLimit: 1024,
            deviceLimit: 1,
            trafficLimitStrategy: 'MONTH',
            internalSquads: ['11111111-1111-1111-1111-111111111111'],
            externalSquad: '22222222-2222-2222-2222-222222222222',
            upgradeToPlanIds: [],
            replacementPlanIds: ['33333333-3333-3333-3333-333333333333'],
            allowedUserIds: ['44444444-4444-4444-4444-444444444444'],
            trialSettings: { maxClaims: 1, free: true, availabilityScope: 'ALL' },
            createdAt: new Date('2026-04-19T12:00:00.000Z'),
            updatedAt: new Date('2026-04-19T12:00:00.000Z'),
            durations: [
              {
                id: 'duration-1',
                days: 30,
                prices: [{ currency: 'USD', price: { toString: (): string => '9.99' } }],
              },
            ],
          }),
        },
        user: { findMany: async () => [] },
        $transaction: async <T>(callback: (client: any) => Promise<T>): Promise<T> =>
          callback({
            plan: {
              update: async (...args: readonly unknown[]) => {
                actualUpdateData = (args[0] as { readonly data: unknown }).data;
                return {
                  id: 'plan-1',
                  orderIndex: 1,
                  name: 'Starter',
                  description: null,
                  tag: null,
                  icon: null,
                  isActive: true,
                  isArchived: false,
                  archivedRenewMode: 'SELF_RENEW',
                  type: PlanType.UNLIMITED,
                  availability: PlanAvailability.ALL,
                  trafficLimit: null,
                  deviceLimit: -1,
                  trafficLimitStrategy: 'MONTH',
                  internalSquads: ['11111111-1111-1111-1111-111111111111'],
                  externalSquad: '22222222-2222-2222-2222-222222222222',
                  upgradeToPlanIds: [],
                  replacementPlanIds: [],
                  allowedUserIds: [],
                  trialSettings: { maxClaims: 1, free: true, availabilityScope: 'ALL' },
                  createdAt: new Date('2026-04-19T12:00:00.000Z'),
                  updatedAt: new Date('2026-04-19T12:00:00.000Z'),
                  durations: [
                    {
                      id: 'duration-1',
                      days: 30,
                      prices: [{ currency: 'USD', price: { toString: (): string => '9.99' } }],
                    },
                  ],
                };
              },
            },
            adminAuditLog: { create: async () => undefined },
            subscription: { update: async () => undefined },
            $queryRaw: async () => [],
          }),
      };
    const service = createService(
      prismaService,
      {
        getInternalSquadOptions: async () => [{ uuid: '11111111-1111-1111-1111-111111111111', name: 'Core' }],
        getExternalSquadOptions: async () => [{ uuid: '22222222-2222-2222-2222-222222222222', name: 'Public' }],
      },
      {
        syncPlanSnapshotMetadata: async (_client: unknown, plan: unknown) => {
          actualSyncPlan = plan;
          return 0;
        },
      },
    );

    await service.updatePlan(
      'plan-1',
      {
        isArchived: false,
        type: PlanType.UNLIMITED,
        availability: PlanAvailability.ALL,
      },
      {
        currentAdmin: { id: 'admin-1' } as never,
        requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
      },
    );

    assert.deepStrictEqual(actualUpdateData, {
      name: 'Starter',
      description: null,
      tag: null,
      icon: null,
      isActive: true,
      isArchived: false,
      archivedRenewMode: 'SELF_RENEW',
      type: PlanType.UNLIMITED,
      availability: PlanAvailability.ALL,
      trafficLimit: null,
      deviceLimit: -1,
      trafficLimitStrategy: 'MONTH',
      internalSquads: ['11111111-1111-1111-1111-111111111111'],
      externalSquad: '22222222-2222-2222-2222-222222222222',
      upgradeToPlanIds: [],
      replacementPlanIds: [],
      allowedUserIds: [],
      trialSettings: { maxClaims: 1, free: true, availabilityScope: 'ALL' },
      durations: {
        deleteMany: {},
        create: [
          {
            days: 30,
            prices: {
              create: [{ currency: 'USD', price: '9.99' }],
            },
          },
        ],
      },
    });
    assert.deepStrictEqual(actualSyncPlan, {
      id: 'plan-1',
      name: 'Starter',
      tag: null,
      type: PlanType.UNLIMITED,
      trafficLimit: null,
      deviceLimit: -1,
      trafficLimitStrategy: 'MONTH',
      internalSquads: ['11111111-1111-1111-1111-111111111111'],
      externalSquad: '22222222-2222-2222-2222-222222222222',
    });
  });
});

function createService(
  prismaService: object,
  remnawaveApiService: object,
  planSnapshotSyncService: object = { syncPlanSnapshotMetadata: async () => 0 },
): PlansAdminService {
  return new PlansAdminService(
    prismaService as never,
    remnawaveApiService as never,
    planSnapshotSyncService as never,
    new PlansAdminValidators(prismaService as never, remnawaveApiService as never),
  );
}
