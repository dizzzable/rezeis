import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanAvailability, PlanType, PointsCashbackMode } from '@prisma/client';

import { CreatePlanDto } from '../src/modules/plans/dto/create-plan.dto';
import { PlanSquadPropagationService } from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';

describe('PlansAdminService', () => {
  for (const transition of ['upgrade', 'replacement'] as const) {
    it(`rejects a TRIAL plan as a ${transition} target`, async () => {
      const trialTargetId = '22222222-2222-4222-8222-222222222222';
      const prismaService = {
        plan: {
          findFirst: async () => null,
          findMany: async () => [
            {
              id: trialTargetId,
              isActive: true,
              isArchived: false,
              availability: PlanAvailability.TRIAL,
            },
          ],
        },
        user: { findMany: async () => [] },
      };
      const service = createService(prismaService, {
        getInternalSquadOptions: async () => [],
        getExternalSquadOptions: async () => [],
      });

      await assert.rejects(
        () =>
          service.createPlan(
            {
              name: `${transition} source`,
              type: PlanType.BOTH,
              availability: PlanAvailability.ALL,
              deviceLimit: 1,
              isArchived: transition === 'replacement',
              archivedRenewMode: transition === 'replacement' ? 'REPLACE_ON_RENEW' : 'SELF_RENEW',
              upgradeToPlanIds: transition === 'upgrade' ? [trialTargetId] : [],
              replacementPlanIds: transition === 'replacement' ? [trialTargetId] : [],
              durations: [{ days: 30, prices: [{ currency: 'USD', price: '9.99' }] }],
            },
            {
              currentAdmin: { id: 'admin-1' } as never,
              requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
            },
          ),
        {
          name: 'BadRequestException',
          message: `Replacement and upgrade plans must be active non-trial public plans: ${trialTargetId}`,
        },
      );
    });
  }

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

  it('rejects converting an existing regular plan into a TRIAL plan', async () => {
    const currentPlan = {
      id: 'plan-regular',
      orderIndex: 1,
      name: 'Regular',
      description: null,
      tag: null,
      icon: null,
      isActive: true,
      isArchived: false,
      archivedRenewMode: 'SELF_RENEW',
      type: PlanType.BOTH,
      availability: PlanAvailability.ALL,
      trafficLimit: 1024,
      deviceLimit: 1,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      externalSquad: null,
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
    const prismaService = {
      plan: {
        findUnique: async () => currentPlan,
        findFirst: async () => ({ id: currentPlan.id }),
      },
      user: { findMany: async () => [] },
    };
    const service = createService(prismaService, {
      getInternalSquadOptions: async () => [],
      getExternalSquadOptions: async () => [],
    });

    await assert.rejects(
      () =>
        service.updatePlan(
          currentPlan.id,
          { availability: PlanAvailability.TRIAL },
          {
            currentAdmin: { id: 'admin-1' } as never,
            requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
          },
        ),
      {
        name: 'BadRequestException',
        message:
          'Existing non-trial plans cannot be converted to TRIAL; create a dedicated trial plan.',
      },
    );
  });

  it('reorders plans by writing orderIndex to each plan position', async () => {
    const updates: Array<{ id: string; orderIndex: number }> = [];
    const prismaService = {
      $transaction: async <T>(cb: (client: any) => Promise<T>): Promise<T> =>
        cb({
          plan: {
            findMany: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            update: async ({
              where,
              data,
            }: {
              where: { id: string };
              data: { orderIndex: number };
            }) => {
              updates.push({ id: where.id, orderIndex: data.orderIndex });
              return undefined;
            },
          },
          adminAuditLog: { create: async () => undefined },
        }),
      plan: { findMany: async () => [] },
    };
    const service = createService(prismaService, {});
    const result = await service.reorderPlans(['c', 'a', 'b'], {
      currentAdmin: { id: 'admin-1' } as never,
      requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
    });
    assert.deepStrictEqual(updates, [
      { id: 'c', orderIndex: 0 },
      { id: 'a', orderIndex: 1 },
      { id: 'b', orderIndex: 2 },
    ]);
    assert.deepStrictEqual(result, []);
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
      trialSettings: { maxClaims: 2, free: false, availabilityScope: 'INVITED', requireTelegramLink: false },
      cashbackMode: PointsCashbackMode.INHERIT,
      cashbackPercent: null,
      orderIndex: 4,
      durations: {
        create: [
          {
            days: 30,
            cashbackPoints: null,
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
            cashbackMode: PointsCashbackMode.INHERIT,
            cashbackPercent: null,
            createdAt: new Date('2026-04-19T12:00:00.000Z'),
            updatedAt: new Date('2026-04-19T12:00:00.000Z'),
            durations: [
              {
                id: 'duration-1',
                days: 30,
                cashbackPoints: null,
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
      trialSettings: { maxClaims: 1, free: true, availabilityScope: 'ALL', requireTelegramLink: false },
      cashbackMode: PointsCashbackMode.INHERIT,
      cashbackPercent: null,
      durations: {
        deleteMany: {},
        create: [
          {
            days: 30,
            cashbackPoints: null,
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

  // ── Points cashback ────────────────────────────────────────────────────────
  //
  // The rule is two columns on the plan (`cashbackMode`, `cashbackPercent`)
  // and one on each DURATION (`cashbackPoints`): FIXED pays the purchased
  // duration, so a year and a month may differ. What these pin is the
  // normaliser's invariant that only the field the mode reads is stored — a
  // percent typed under PERCENT and then switched to NONE must not survive as
  // a stale value the next mode switch resurrects, because the catalogue reads
  // these columns live. `actualSyncPlan` above stays as it is on purpose: the
  // rule is never copied into a subscription's plan snapshot.
  it('persists the own percent under PERCENT and nulls the per-duration points', async () => {
    const harness = createWriteHarness();

    await harness.service.createPlan(
      {
        ...CASHBACK_PLAN_INPUT,
        cashbackMode: PointsCashbackMode.PERCENT,
        cashbackPercent: 15,
        durations: [{ days: 30, cashbackPoints: 50, prices: [{ currency: 'USD', price: '9.99' }] }],
      },
      MUTATION_CONTEXT,
    );

    assert.deepStrictEqual(cashbackOf(harness.createData()), {
      cashbackMode: PointsCashbackMode.PERCENT,
      cashbackPercent: 15,
      points: [null],
    });
  });

  it('persists the points of each duration under FIXED and nulls the percent', async () => {
    const harness = createWriteHarness();

    await harness.service.createPlan(
      {
        ...CASHBACK_PLAN_INPUT,
        cashbackMode: PointsCashbackMode.FIXED,
        cashbackPercent: 15,
        durations: [
          { days: 30, cashbackPoints: 40, prices: [{ currency: 'USD', price: '9.99' }] },
          { days: 365, cashbackPoints: 600, prices: [{ currency: 'USD', price: '99' }] },
          // Omitted is NULL, which the payout reads as zero.
          { days: 7, prices: [{ currency: 'USD', price: '2.99' }] },
        ],
      },
      MUTATION_CONTEXT,
    );

    assert.deepStrictEqual(cashbackOf(harness.createData()), {
      cashbackMode: PointsCashbackMode.FIXED,
      cashbackPercent: null,
      points: [40, 600, null],
    });
  });

  it('stores neither the percent nor the points under NONE', async () => {
    const harness = createWriteHarness();

    await harness.service.createPlan(
      {
        ...CASHBACK_PLAN_INPUT,
        cashbackMode: PointsCashbackMode.NONE,
        cashbackPercent: 15,
        durations: [{ days: 30, cashbackPoints: 40, prices: [{ currency: 'USD', price: '9.99' }] }],
      },
      MUTATION_CONTEXT,
    );

    assert.deepStrictEqual(cashbackOf(harness.createData()), {
      cashbackMode: PointsCashbackMode.NONE,
      cashbackPercent: null,
      points: [null],
    });
  });

  it('defaults a create that says nothing about cashback to INHERIT', async () => {
    const harness = createWriteHarness();

    await harness.service.createPlan(CASHBACK_PLAN_INPUT, MUTATION_CONTEXT);

    assert.deepStrictEqual(cashbackOf(harness.createData()), {
      cashbackMode: PointsCashbackMode.INHERIT,
      cashbackPercent: null,
      points: [null],
    });
  });

  // Durations are delete-and-recreate on update. An update that omits them
  // rebuilds them from the current rows, and that rebuild has to carry the
  // points — otherwise renaming a FIXED plan would silently zero its payout.
  it('keeps the current FIXED points, duration by duration, when an update omits the cashback fields', async () => {
    const harness = createWriteHarness(
      persistedPlanRow({
        cashbackMode: PointsCashbackMode.FIXED,
        durations: [
          persistedDurationRow({ id: 'duration-30', days: 30, cashbackPoints: 40 }),
          persistedDurationRow({ id: 'duration-365', days: 365, cashbackPoints: 600 }),
        ],
      }),
    );

    await harness.service.updatePlan('plan-1', { description: 'Renamed nothing else' }, MUTATION_CONTEXT);

    assert.deepStrictEqual(cashbackOf(harness.updateData()), {
      cashbackMode: PointsCashbackMode.FIXED,
      cashbackPercent: null,
      points: [40, 600],
    });
  });

  it('keeps the current own percent when an update omits the cashback fields', async () => {
    const harness = createWriteHarness(
      persistedPlanRow({ cashbackMode: PointsCashbackMode.PERCENT, cashbackPercent: 7 }),
    );

    await harness.service.updatePlan('plan-1', { isActive: false }, MUTATION_CONTEXT);

    assert.deepStrictEqual(cashbackOf(harness.updateData()), {
      cashbackMode: PointsCashbackMode.PERCENT,
      cashbackPercent: 7,
      points: [null],
    });
  });

  it('clears the persisted percent and points when an update switches the plan to NONE', async () => {
    const harness = createWriteHarness(
      persistedPlanRow({
        cashbackMode: PointsCashbackMode.PERCENT,
        cashbackPercent: 7,
        durations: [persistedDurationRow({ id: 'duration-30', days: 30, cashbackPoints: 40 })],
      }),
    );

    await harness.service.updatePlan(
      'plan-1',
      { cashbackMode: PointsCashbackMode.NONE },
      MUTATION_CONTEXT,
    );

    assert.deepStrictEqual(cashbackOf(harness.updateData()), {
      cashbackMode: PointsCashbackMode.NONE,
      cashbackPercent: null,
      points: [null],
    });
  });
});

const MUTATION_CONTEXT = {
  currentAdmin: { id: 'admin-1' } as never,
  requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
};

/** The smallest plan the write path accepts, with nothing said about cashback. */
const CASHBACK_PLAN_INPUT: CreatePlanDto = {
  name: 'Cashback plan',
  type: PlanType.BOTH,
  availability: PlanAvailability.ALL,
  deviceLimit: 1,
  durations: [{ days: 30, prices: [{ currency: 'USD', price: '9.99' }] }],
};

/** The cashback columns of a captured `plan.create` / `plan.update` payload. */
function cashbackOf(data: unknown): {
  readonly cashbackMode: unknown;
  readonly cashbackPercent: unknown;
  readonly points: readonly unknown[];
} {
  const row = data as {
    readonly cashbackMode: unknown;
    readonly cashbackPercent: unknown;
    readonly durations: { readonly create: ReadonlyArray<{ readonly cashbackPoints: unknown }> };
  };
  return {
    cashbackMode: row.cashbackMode,
    cashbackPercent: row.cashbackPercent,
    points: row.durations.create.map((duration) => duration.cashbackPoints),
  };
}

function persistedDurationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'duration-30',
    days: 30,
    isActive: true,
    cashbackPoints: null,
    prices: [{ id: 'price-1', currency: 'USD', price: { toString: (): string => '9.99' } }],
    ...overrides,
  };
}

/** A plan row complete enough for `mapAdminPlan` to render, with no squads so no propagation runs. */
function persistedPlanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1',
    orderIndex: 1,
    name: 'Cashback plan',
    description: null,
    tag: null,
    icon: null,
    isActive: true,
    isArchived: false,
    archivedRenewMode: 'SELF_RENEW',
    type: PlanType.BOTH,
    availability: PlanAvailability.ALL,
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [],
    externalSquad: null,
    upgradeToPlanIds: [],
    replacementPlanIds: [],
    allowedUserIds: [],
    trialSettings: {},
    cashbackMode: PointsCashbackMode.INHERIT,
    cashbackPercent: null,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
    durations: [persistedDurationRow()],
    ...overrides,
  };
}

/**
 * The service over a Prisma fake that records what `plan.create` and
 * `plan.update` were asked to write. `currentPlan` is what `findUnique`
 * answers for an update; the rows the writes return only need to be mappable.
 */
function createWriteHarness(currentPlan: Record<string, unknown> | null = null): {
  readonly service: PlansAdminService;
  readonly createData: () => unknown;
  readonly updateData: () => unknown;
} {
  let createData: unknown;
  let updateData: unknown;
  const prismaService = {
    plan: {
      findFirst: async () => null,
      findUnique: async () => currentPlan,
    },
    user: { findMany: async () => [] },
    $transaction: async <T>(callback: (client: any) => Promise<T>): Promise<T> =>
      callback({
        plan: {
          findFirst: async () => ({ orderIndex: 0 }),
          create: async (...args: readonly unknown[]) => {
            createData = (args[0] as { readonly data: unknown }).data;
            return persistedPlanRow();
          },
          update: async (...args: readonly unknown[]) => {
            updateData = (args[0] as { readonly data: unknown }).data;
            return currentPlan ?? persistedPlanRow();
          },
        },
        adminAuditLog: { create: async () => undefined },
        subscription: { update: async () => undefined },
        $queryRaw: async () => [],
      }),
  };
  const service = createService(prismaService, {
    getInternalSquadOptions: async () => [],
    getExternalSquadOptions: async () => [],
  });
  return {
    service,
    createData: () => createData,
    updateData: () => updateData,
  };
}

function createService(
  prismaService: object,
  remnawaveApiService: object,
  planSnapshotSyncService: object = { syncPlanSnapshotMetadata: async () => 0 },
  profileSyncQueueService: object = { enqueue: async () => undefined },
): PlansAdminService {
  return new PlansAdminService(
    prismaService as never,
    remnawaveApiService as never,
    planSnapshotSyncService as never,
    new PlansAdminValidators(prismaService as never, remnawaveApiService as never),
    new PlanSquadPropagationService(prismaService as never, profileSyncQueueService as never),
  );
}
