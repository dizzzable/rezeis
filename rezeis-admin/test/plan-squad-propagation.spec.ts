import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PlanAvailability, PlanType, SubscriptionStatus, SyncJobStatus } from '@prisma/client';

import { AdminPlansController } from '../src/modules/plans/controllers/admin-plans.controller';
import { CreatePlanDto } from '../src/modules/plans/dto/create-plan.dto';
import { UpdatePlanDto } from '../src/modules/plans/dto/update-plan.dto';
import { PlansModule } from '../src/modules/plans/plans.module';
import { ProfileSyncModule } from '../src/modules/profile-sync/profile-sync.module';
import {
  PLAN_SQUAD_PROPAGATION_CAUSE,
  PLAN_SQUAD_PROPAGATION_ENQUEUE_LIMIT,
  PlanSquadPropagationService,
} from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import { isUpstreamTagForTest } from './helpers/remnawave-tag-contract';

const SQUAD_A = '11111111-1111-1111-1111-111111111111';
const SQUAD_B = '22222222-2222-2222-2222-222222222222';
const SQUAD_C = '33333333-3333-3333-3333-333333333333';
const EXTERNAL_OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXTERNAL_NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ── (1) A plan squad edit must reach the subscriptions already sold ─────────

describe('a plan squad edit reaches existing subscriptions', () => {
  it('rewrites each tracking subscription and queues a panel push for it', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B, SQUAD_C],
      subscriptions: [
        activeSubscription('sub-1', [SQUAD_A]),
        activeSubscription('sub-2', [SQUAD_A]),
      ],
    });

    const result = await harness.updatePlan({ internalSquads: [SQUAD_B, SQUAD_C] });

    // The columns the sync processor actually reads (`profile-sync.processor.ts`
    // reads `subscription.internalSquads`, NOT the snapshot) must now hold the
    // new selection for both subscribers.
    assert.deepStrictEqual(harness.subscriptionUpdates, [
      {
        ids: ['sub-1', 'sub-2'],
        data: { internalSquads: [SQUAD_B, SQUAD_C], externalSquad: null },
      },
    ]);
    // …and a push must actually be queued, otherwise the panel never learns.
    assert.deepStrictEqual(
      harness.createdJobs.map((job) => ({
        subscriptionId: job.subscriptionId,
        action: job.action,
        status: job.status,
        cause: job.cause,
      })),
      [
        {
          subscriptionId: 'sub-1',
          action: 'UPDATE',
          status: SyncJobStatus.PENDING,
          cause: PLAN_SQUAD_PROPAGATION_CAUSE,
        },
        {
          subscriptionId: 'sub-2',
          action: 'UPDATE',
          status: SyncJobStatus.PENDING,
          cause: PLAN_SQUAD_PROPAGATION_CAUSE,
        },
      ],
    );
    assert.deepStrictEqual(harness.enqueued, harness.createdJobs.map((job) => job.id));
    assert.equal(result.squadPropagation.subscriptionsUpdated, 2);
    assert.equal(result.squadPropagation.syncJobsCreated, 2);
    assert.equal(typeof result.squadPropagation.propagationId, 'string');
    // Every queued job carries the same propagation id, which is what makes the
    // status endpoint able to report on THIS edit rather than on all history.
    const propagationIds = new Set(
      harness.createdJobs.map((job) => (job.payload as { propagationId: string }).propagationId),
    );
    assert.deepStrictEqual([...propagationIds], [result.squadPropagation.propagationId]);
  });

  it('propagates an external-squad-only change', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_A],
      previousExternalSquad: EXTERNAL_OLD,
      nextExternalSquad: EXTERNAL_NEW,
      subscriptions: [activeSubscription('sub-1', [SQUAD_A], EXTERNAL_OLD)],
    });

    await harness.updatePlan({ externalSquad: EXTERNAL_NEW });

    assert.deepStrictEqual(harness.subscriptionUpdates, [
      { ids: ['sub-1'], data: { internalSquads: [SQUAD_A], externalSquad: EXTERNAL_NEW } },
    ]);
    assert.equal(harness.createdJobs.length, 1);
  });

  it('costs nothing when the edit does not touch squads', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_A],
      subscriptions: [activeSubscription('sub-1', [SQUAD_A])],
    });

    const result = await harness.updatePlan({ name: 'Renamed' });

    // No scan, no writes, no queue traffic — a plan has many subscribers and a
    // price edit must not fan out over all of them.
    assert.equal(harness.candidateScans, 0);
    assert.deepStrictEqual(harness.subscriptionUpdates, []);
    assert.deepStrictEqual(harness.createdJobs, []);
    assert.deepStrictEqual(harness.enqueued, []);
    assert.deepStrictEqual(result.squadPropagation, {
      propagationId: null,
      subscriptionsUpdated: 0,
      syncJobsCreated: 0,
    });
  });

  it('treats a reordered squad list as unchanged', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A, SQUAD_B],
      nextInternalSquads: [SQUAD_B, SQUAD_A],
      subscriptions: [activeSubscription('sub-1', [SQUAD_A, SQUAD_B])],
    });

    await harness.updatePlan({ internalSquads: [SQUAD_B, SQUAD_A] });

    assert.equal(harness.candidateScans, 0);
    assert.deepStrictEqual(harness.createdJobs, []);
  });

  it('leaves a subscription that deliberately diverged from the plan alone', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B],
      subscriptions: [
        activeSubscription('sub-tracking', [SQUAD_A]),
        // Moved off the plan's squads on purpose (add-on grant, manual fix, or
        // an import that read live panel membership).
        activeSubscription('sub-overridden', [SQUAD_C]),
      ],
    });

    await harness.updatePlan({ internalSquads: [SQUAD_B] });

    assert.deepStrictEqual(harness.subscriptionUpdates, [
      { ids: ['sub-tracking'], data: { internalSquads: [SQUAD_B], externalSquad: null } },
    ]);
    assert.deepStrictEqual(
      harness.createdJobs.map((job) => job.subscriptionId),
      ['sub-tracking'],
    );
  });

  it('fixes the columns of a non-pushable subscription without queueing a panel write', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B],
      subscriptions: [
        activeSubscription('sub-active', [SQUAD_A]),
        { ...activeSubscription('sub-expired', [SQUAD_A]), status: SubscriptionStatus.EXPIRED },
        { ...activeSubscription('sub-unprovisioned', [SQUAD_A]), remnawaveId: null },
      ],
    });

    const result = await harness.updatePlan({ internalSquads: [SQUAD_B] });

    assert.deepStrictEqual(harness.subscriptionUpdates, [
      {
        ids: ['sub-active', 'sub-expired', 'sub-unprovisioned'],
        data: { internalSquads: [SQUAD_B], externalSquad: null },
      },
    ]);
    assert.deepStrictEqual(
      harness.createdJobs.map((job) => job.subscriptionId),
      ['sub-active'],
    );
    assert.equal(result.squadPropagation.subscriptionsUpdated, 3);
    assert.equal(result.squadPropagation.syncJobsCreated, 1);
  });

  it('persists every job but only nudges the queue up to the enqueue cap', async () => {
    const overflow = PLAN_SQUAD_PROPAGATION_ENQUEUE_LIMIT + 7;
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B],
      subscriptions: Array.from({ length: overflow }, (_unused, index) =>
        activeSubscription(`sub-${index}`, [SQUAD_A]),
      ),
    });

    const result = await harness.updatePlan({ internalSquads: [SQUAD_B] });

    assert.equal(harness.createdJobs.length, overflow);
    assert.equal(result.squadPropagation.syncJobsCreated, overflow);
    // The tail is left PENDING for `ProfileSyncQueueService.sweepAndRecover` —
    // durable, but it must not be dumped on the panel inside the HTTP request.
    assert.equal(harness.enqueued.length, PLAN_SQUAD_PROPAGATION_ENQUEUE_LIMIT);
  });

  it('keeps the propagation when the queue is down — the row is the durable record', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B],
      subscriptions: [activeSubscription('sub-1', [SQUAD_A])],
      enqueue: async () => {
        throw new Error('redis unreachable');
      },
    });

    const result = await harness.updatePlan({ internalSquads: [SQUAD_B] });

    assert.equal(harness.createdJobs.length, 1);
    assert.equal(result.squadPropagation.syncJobsCreated, 1);
  });

  it('enqueues only after the transaction has committed', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B],
      subscriptions: [activeSubscription('sub-1', [SQUAD_A])],
    });

    await harness.updatePlan({ internalSquads: [SQUAD_B] });

    assert.deepStrictEqual(harness.order.slice(-2), ['commit', 'enqueue']);
  });
});

describe('a running plan squad propagation is visible to the operator', () => {
  it('reports the latest propagation as incomplete while work remains', async () => {
    const service = new PlanSquadPropagationService(
      {
        profileSyncJob: {
          findFirst: async () => ({
            createdAt: new Date('2026-08-06T10:00:00.000Z'),
            payload: { planId: 'plan-1', propagationId: 'prop-2' },
          }),
          groupBy: async (args: { readonly where: { readonly payload: { readonly equals: string } } }) => {
            assert.equal(args.where.payload.equals, 'prop-2');
            return [
              { status: SyncJobStatus.COMPLETED, _count: { _all: 4 } },
              { status: SyncJobStatus.PENDING, _count: { _all: 2 } },
              { status: SyncJobStatus.FAILED, _count: { _all: 1 } },
            ];
          },
        },
      } as never,
      { enqueue: async () => undefined } as never,
    );

    const status = await service.getStatus('plan-1');

    assert.deepStrictEqual(status, {
      planId: 'plan-1',
      propagationId: 'prop-2',
      queuedAt: '2026-08-06T10:00:00.000Z',
      total: 7,
      pending: 2,
      running: 0,
      failed: 1,
      completed: 4,
      isComplete: false,
    });
  });

  it('does not call a propagation finished while a job is still FAILED', async () => {
    const service = new PlanSquadPropagationService(
      {
        profileSyncJob: {
          findFirst: async () => ({
            createdAt: new Date('2026-08-06T10:00:00.000Z'),
            payload: { planId: 'plan-1', propagationId: 'prop-1' },
          }),
          groupBy: async () => [
            { status: SyncJobStatus.COMPLETED, _count: { _all: 9 } },
            { status: SyncJobStatus.FAILED, _count: { _all: 1 } },
          ],
        },
      } as never,
      { enqueue: async () => undefined } as never,
    );

    const status = await service.getStatus('plan-1');

    assert.equal(status.failed, 1);
    assert.equal(status.isComplete, false);
  });

  it('reports complete when every queued job finished', async () => {
    const service = new PlanSquadPropagationService(
      {
        profileSyncJob: {
          findFirst: async () => ({
            createdAt: new Date('2026-08-06T10:00:00.000Z'),
            payload: { planId: 'plan-1', propagationId: 'prop-1' },
          }),
          groupBy: async () => [{ status: SyncJobStatus.COMPLETED, _count: { _all: 3 } }],
        },
      } as never,
      { enqueue: async () => undefined } as never,
    );

    const status = await service.getStatus('plan-1');

    assert.equal(status.total, 3);
    assert.equal(status.isComplete, true);
  });

  it('reports an empty, complete status for a plan that never propagated', async () => {
    const service = new PlanSquadPropagationService(
      {
        profileSyncJob: {
          findFirst: async () => null,
          groupBy: async () => {
            throw new Error('must not be reached when there is no propagation');
          },
        },
      } as never,
      { enqueue: async () => undefined } as never,
    );

    assert.deepStrictEqual(await service.getStatus('plan-1'), {
      planId: 'plan-1',
      propagationId: null,
      queuedAt: null,
      total: 0,
      pending: 0,
      running: 0,
      failed: 0,
      completed: 0,
      isComplete: true,
    });
  });
});

describe('the propagation is actually wired into the running application', () => {
  // Nothing in the suite boots the Nest container, so every test above would
  // stay green with the service unreachable from DI — the failure would appear
  // only at container start in production. These read the module metadata the
  // container itself reads.
  it('provides the propagation service from the plans module', () => {
    const providers = Reflect.getMetadata('providers', PlansModule) as readonly unknown[];

    assert.equal(providers.includes(PlanSquadPropagationService), true);
  });

  it('imports the module that owns the profile-sync queue', () => {
    const imports = Reflect.getMetadata('imports', PlansModule) as readonly unknown[];

    assert.equal(imports.includes(ProfileSyncModule), true);
  });

  it('injects the propagation service into the plans admin service', () => {
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      PlansAdminService,
    ) as readonly unknown[];

    assert.equal(paramTypes.includes(PlanSquadPropagationService), true);
  });

  it('exposes the propagation status route the operator polls', () => {
    assert.equal(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminPlansController.prototype.getSquadPropagationStatus,
      ),
      ':planId/squad-propagation',
    );
    assert.equal(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminPlansController.prototype.getSquadPropagationStatus,
      ),
      RequestMethod.GET,
    );
  });
});

// ── (2) A panel outage must not silently pass squad validation ──────────────

describe('a Remnawave outage during a plan save does not pass validation silently', () => {
  it('refuses a squad change it could not verify, and persists nothing', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B],
      subscriptions: [activeSubscription('sub-1', [SQUAD_A])],
      squadOptions: () => {
        throw new Error('Remnawave is unreachable');
      },
    });

    await assert.rejects(() => harness.updatePlan({ internalSquads: [SQUAD_B] }), {
      name: 'ServiceUnavailableException',
    });
    assert.equal(harness.planUpdates, 0);
    assert.deepStrictEqual(harness.createdJobs, []);
  });

  it('names the outage in the operator-visible message', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B],
      subscriptions: [],
      squadOptions: () => {
        throw new Error('Remnawave is unreachable');
      },
    });

    await assert.rejects(
      () => harness.updatePlan({ internalSquads: [SQUAD_B] }),
      (error: Error) => {
        assert.match(error.message, /Remnawave panel could not be reached/);
        assert.match(error.message, /not saved/);
        return true;
      },
    );
  });

  it('refuses a contract-shaped failure the same way as an outage', async () => {
    // `getInternalSquadOptions` turns a zod parse failure into
    // ServiceUnavailableException — that is still "we could not ask", and the
    // old blanket catch swallowed it too.
    const harness = createUpdateHarness({
      previousInternalSquads: [],
      nextInternalSquads: [SQUAD_B],
      subscriptions: [],
      squadOptions: () => {
        const error = new Error('Remnawave internal squads are unavailable');
        error.name = 'ServiceUnavailableException';
        throw error;
      },
    });

    await assert.rejects(
      () => harness.updatePlan({ internalSquads: [SQUAD_B] }),
      (error: Error) => {
        assert.equal(error.name, 'ServiceUnavailableException');
        // Asserting the name alone would also pass if the code simply rethrew
        // the upstream error, which is not the same as refusing the write. The
        // message pins that this refusal came from the validator.
        assert.match(error.message, /could not be reached to verify them/);
        return true;
      },
    );
    assert.equal(harness.planUpdates, 0);
  });

  it('lets an unrelated edit through while the panel is down', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_A],
      subscriptions: [activeSubscription('sub-1', [SQUAD_A])],
      squadOptions: () => {
        throw new Error('Remnawave is unreachable');
      },
    });

    const result = await harness.updatePlan({ name: 'Renamed during an outage' });

    assert.equal(harness.planUpdates, 1);
    assert.equal(result.squadPropagation.subscriptionsUpdated, 0);
  });

  it('still rejects a squad the panel says does not exist', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_C],
      subscriptions: [],
      squadOptions: () => [{ uuid: SQUAD_A, name: 'Core' }, { uuid: SQUAD_B, name: 'Extra' }],
    });

    await assert.rejects(() => harness.updatePlan({ internalSquads: [SQUAD_C] }), {
      name: 'BadRequestException',
      message: `Internal squads not found: ${SQUAD_C}`,
    });
    assert.equal(harness.planUpdates, 0);
  });

  it('refuses a create that names squads it could not verify', async () => {
    let planCreates = 0;
    const prismaService = {
      plan: { findFirst: async () => null },
      user: { findMany: async () => [] },
      $transaction: async <T>(callback: (client: never) => Promise<T>): Promise<T> =>
        callback({
          plan: {
            findFirst: async () => null,
            create: async () => {
              planCreates += 1;
              return persistablePlanRow();
            },
          },
          adminAuditLog: { create: async () => undefined },
          subscription: { findMany: async () => [] },
        } as never),
    };
    const service = new PlansAdminService(
      prismaService as never,
      {} as never,
      { syncPlanSnapshotMetadata: async () => 0 } as never,
      new PlansAdminValidators(
        prismaService as never,
        {
          getInternalSquadOptions: async () => {
            throw new Error('Remnawave is unreachable');
          },
          getExternalSquadOptions: async () => [],
        } as never,
      ),
      new PlanSquadPropagationService(prismaService as never, {} as never),
    );

    await assert.rejects(
      () =>
        service.createPlan(
          {
            name: 'Created during an outage',
            type: PlanType.BOTH,
            availability: PlanAvailability.ALL,
            deviceLimit: 1,
            internalSquads: [SQUAD_B],
            durations: [{ days: 30, prices: [{ currency: 'USD', price: '9.99' }] }],
          },
          {
            currentAdmin: { id: 'admin-1' } as never,
            requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
          },
        ),
      { name: 'ServiceUnavailableException' },
    );
    assert.equal(planCreates, 0);
  });

  it('leaves a healthy save untouched', async () => {
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_B],
      subscriptions: [activeSubscription('sub-1', [SQUAD_A])],
      squadOptions: () => [{ uuid: SQUAD_A, name: 'Core' }, { uuid: SQUAD_B, name: 'Extra' }],
    });

    const result = await harness.updatePlan({ internalSquads: [SQUAD_B] });

    assert.equal(harness.planUpdates, 1);
    assert.equal(result.squadPropagation.syncJobsCreated, 1);
  });
});

// ── (3) The tag boundary must match the panel's own rule ────────────────────

describe('a plan tag the Remnawave panel would reject is refused at the boundary', () => {
  const rejected = ['lowercase', 'HAS SPACE', 'HAS-DASH', 'SEVENTEEN_CHARS_X', 'ПРОМО', 'a'];
  const accepted = ['VIP', 'PROMO_2026', 'A', 'SIXTEEN_CHARS_XY', '0'];

  for (const dtoType of [CreatePlanDto, UpdatePlanDto] as const) {
    for (const tag of rejected) {
      it(`${dtoType.name} rejects ${JSON.stringify(tag)}`, async () => {
        // Self-check: the fixture must genuinely be one the panel refuses,
        // otherwise this test could pass against a rule that is simply wrong.
        assert.equal(isUpstreamTagForTest(tag), false, `${tag} must violate the panel rule`);

        const errors = await validate(plainToInstance(dtoType, { tag } as never));

        // `CreatePlanDto` also complains about its required fields here, so
        // isolate the tag's own verdict rather than the whole error list.
        const tagErrors = errors.filter((error) => error.property === 'tag');
        assert.equal(tagErrors.length, 1);
        assert.notDeepStrictEqual(tagErrors[0]?.constraints, {});
      });
    }

    for (const tag of accepted) {
      it(`${dtoType.name} accepts ${JSON.stringify(tag)}`, async () => {
        assert.equal(isUpstreamTagForTest(tag), true, `${tag} must satisfy the panel rule`);

        const errors = await validate(plainToInstance(dtoType, { tag } as never));

        assert.deepStrictEqual(errors.filter((error) => error.property === 'tag'), []);
      });
    }
  }

  it('still accepts clearing the tag', async () => {
    for (const tag of [null, '']) {
      const errors = await validate(plainToInstance(UpdatePlanDto, { tag } as never));
      assert.deepStrictEqual(errors.filter((error) => error.property === 'tag'), []);
    }
  });

  it('trims before judging, matching what would be stored', async () => {
    const dto = plainToInstance(UpdatePlanDto, { tag: '  VIP  ' } as object) as UpdatePlanDto;

    assert.deepStrictEqual(await validate(dto), []);
    assert.equal(dto.tag, 'VIP');
  });

  it('keeps a plan whose stored tag already violates the rule editable', async () => {
    // A plan cloned from a donor backup can hold a non-conforming tag
    // (`backup-plan-cloner.service.ts` copies `tag` verbatim). A patch that does
    // not mention `tag` must still save, and must carry the old value through.
    const harness = createUpdateHarness({
      previousInternalSquads: [SQUAD_A],
      nextInternalSquads: [SQUAD_A],
      subscriptions: [],
      currentTag: 'legacy tag from donor',
    });

    const errors = await validate(plainToInstance(UpdatePlanDto, { isArchived: true } as never));
    assert.deepStrictEqual(errors, []);

    const result = await harness.updatePlan({ isArchived: true });

    assert.equal(harness.planUpdates, 1);
    assert.equal((harness.lastPlanWriteData as { readonly tag: string }).tag, 'legacy tag from donor');
    assert.equal(result.tag, 'legacy tag from donor');
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

interface HarnessSubscription {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly remnawaveId: string | null;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

/**
 * A plan row complete enough for `mapAdminPlan` to render. Used where the test
 * asserts a REFUSAL: without it the write path dies on an incomplete mock and
 * the red would come from a TypeError rather than from the missing refusal.
 */
function persistablePlanRow(): Record<string, unknown> {
  return {
    id: 'plan-new',
    orderIndex: 1,
    name: 'Created during an outage',
    description: null,
    tag: null,
    icon: null,
    isActive: true,
    isArchived: false,
    archivedRenewMode: 'SELF_RENEW',
    type: PlanType.BOTH,
    availability: PlanAvailability.ALL,
    trafficLimit: null,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [SQUAD_B],
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
}

function activeSubscription(
  id: string,
  internalSquads: readonly string[],
  externalSquad: string | null = null,
): HarnessSubscription {
  return {
    id,
    status: SubscriptionStatus.ACTIVE,
    remnawaveId: `panel-${id}`,
    internalSquads,
    externalSquad,
  };
}

interface CreatedJob {
  readonly id: string;
  readonly subscriptionId: string;
  readonly action: string;
  readonly status: string;
  readonly cause: string;
  readonly payload: unknown;
}

function createUpdateHarness(options: {
  readonly previousInternalSquads: readonly string[];
  readonly nextInternalSquads: readonly string[];
  readonly previousExternalSquad?: string | null;
  readonly nextExternalSquad?: string | null;
  readonly subscriptions: readonly HarnessSubscription[];
  readonly squadOptions?: () => readonly { readonly uuid: string; readonly name: string }[];
  readonly enqueue?: (syncJobId: string) => Promise<void>;
  readonly currentTag?: string | null;
}) {
  const previousExternalSquad = options.previousExternalSquad ?? null;
  const nextExternalSquad =
    options.nextExternalSquad === undefined ? previousExternalSquad : options.nextExternalSquad;

  const state = {
    candidateScans: 0,
    planUpdates: 0,
    lastPlanWriteData: undefined as unknown,
    subscriptionUpdates: [] as Array<{ readonly ids: readonly string[]; readonly data: unknown }>,
    createdJobs: [] as CreatedJob[],
    enqueued: [] as string[],
    order: [] as string[],
  };

  const planRow = (internalSquads: readonly string[], externalSquad: string | null) => ({
    id: 'plan-1',
    orderIndex: 1,
    name: 'Starter',
    description: null,
    tag: options.currentTag ?? null,
    icon: null,
    isActive: true,
    isArchived: false,
    archivedRenewMode: 'SELF_RENEW',
    type: PlanType.UNLIMITED,
    availability: PlanAvailability.ALL,
    trafficLimit: null,
    deviceLimit: -1,
    trafficLimitStrategy: 'MONTH',
    internalSquads: [...internalSquads],
    externalSquad,
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
  });

  const transactionClient = {
    plan: {
      update: async (args: { readonly data: Record<string, unknown> }) => {
        state.planUpdates += 1;
        state.lastPlanWriteData = args.data;
        return planRow(options.nextInternalSquads, nextExternalSquad);
      },
    },
    adminAuditLog: { create: async () => undefined },
    subscription: {
      findMany: async () => {
        state.candidateScans += 1;
        return options.subscriptions.map((subscription) => ({ ...subscription }));
      },
      updateMany: async (args: {
        readonly where: { readonly id: { readonly in: readonly string[] } };
        readonly data: unknown;
      }) => {
        state.subscriptionUpdates.push({ ids: [...args.where.id.in], data: args.data });
        return { count: args.where.id.in.length };
      },
      update: async () => undefined,
    },
    profileSyncJob: {
      createManyAndReturn: async (args: {
        readonly data: ReadonlyArray<Record<string, unknown>>;
      }) => {
        const created = args.data.map((row, index) => ({
          id: `job-${state.createdJobs.length + index}`,
          subscriptionId: row['subscriptionId'] as string,
          action: row['action'] as string,
          status: row['status'] as string,
          cause: row['cause'] as string,
          payload: row['payload'],
        }));
        state.createdJobs.push(...created);
        return created.map((row) => ({ id: row.id }));
      },
    },
    $queryRaw: async () => [],
  };

  const prismaService = {
    plan: {
      findUnique: async () => planRow(options.previousInternalSquads, previousExternalSquad),
      findFirst: async () => ({ id: 'plan-1' }),
    },
    user: { findMany: async () => [] },
    $transaction: async <T>(callback: (client: never) => Promise<T>): Promise<T> => {
      const value = await callback(transactionClient as never);
      state.order.push('commit');
      return value;
    },
  };

  const squadOptions =
    options.squadOptions ??
    (() => [
      { uuid: SQUAD_A, name: 'A' },
      { uuid: SQUAD_B, name: 'B' },
      { uuid: SQUAD_C, name: 'C' },
      { uuid: EXTERNAL_OLD, name: 'External old' },
      { uuid: EXTERNAL_NEW, name: 'External new' },
    ]);
  const remnawaveApiService = {
    getInternalSquadOptions: async () => squadOptions(),
    getExternalSquadOptions: async () => squadOptions(),
  };

  const profileSyncQueueService = {
    enqueue: async (syncJobId: string) => {
      if (options.enqueue !== undefined) {
        await options.enqueue(syncJobId);
        return;
      }
      state.order.push('enqueue');
      state.enqueued.push(syncJobId);
    },
  };

  const service = new PlansAdminService(
    prismaService as never,
    remnawaveApiService as never,
    { syncPlanSnapshotMetadata: async () => 0 } as never,
    new PlansAdminValidators(prismaService as never, remnawaveApiService as never),
    new PlanSquadPropagationService(prismaService as never, profileSyncQueueService as never),
  );

  return {
    get candidateScans() {
      return state.candidateScans;
    },
    get planUpdates() {
      return state.planUpdates;
    },
    get lastPlanWriteData() {
      return state.lastPlanWriteData;
    },
    get subscriptionUpdates() {
      return state.subscriptionUpdates;
    },
    get createdJobs() {
      return state.createdJobs;
    },
    get enqueued() {
      return state.enqueued;
    },
    get order() {
      return state.order;
    },
    updatePlan: (input: Record<string, unknown>) =>
      service.updatePlan('plan-1', input as never, {
        currentAdmin: { id: 'admin-1' } as never,
        requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
      }),
  };
}
