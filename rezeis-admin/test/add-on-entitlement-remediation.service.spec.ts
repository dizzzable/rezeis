import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';

import { AddOnEntitlementRemediationService } from '../src/modules/add-on-entitlements/services/add-on-entitlement-remediation.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';

const ACTOR = { actorId: 'admin-1', commandKey: 'cmd-1', reason: 'ops fix' };

function build(overrides: Record<string, unknown> = {}) {
  const enqueued: string[] = [];
  const state = {
    failedJobs: [{ id: 'job-1' }] as Array<{ id: string }>,
    resetCount: 1,
    ackCount: 1,
    incidentExists: true as boolean,
    entitlement: { subscriptionId: 'sub-1' } as { subscriptionId: string } | null,
    projectionChanged: true,
    transitionChanged: true,
    ...overrides,
  };
  const tx = {
    subscription: { update: async () => ({ id: 'sub-1', remnawaveId: 'rem-1' }) },
    profileSyncJob: { create: async () => ({ id: 'job-new' }) },
  };
  const prisma = {
    profileSyncJob: {
      findMany: async () => state.failedJobs,
      updateMany: async () => ({ count: state.resetCount }),
    },
    entitlementIncident: {
      updateMany: async () => ({ count: state.ackCount }),
      findUnique: async () => (state.incidentExists ? { id: 'inc-1' } : null),
    },
    addOnEntitlement: { findUnique: async () => state.entitlement },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  const entitlements = {
    transitionInTransaction: async () => ({ state: 'REVERSED', changed: state.transitionChanged, eventId: 'e' }),
  };
  const projection = {
    recomputeInTransaction: async () => ({
      desiredRevision: 9n,
      changed: state.projectionChanged,
      desiredTrafficLimitBytes: null,
      desiredDeviceLimit: 0,
    }),
  };
  const queue = { enqueue: async (id: string) => { enqueued.push(id); } };
  const deviceExec = { executePlan: async (_id: string, opts: { force?: boolean }) => ({ status: opts.force ? 'APPLIED' : 'AUTO_DISABLED' }) };
  const service = new AddOnEntitlementRemediationService(
    prisma as never, entitlements as never, projection as never, queue as never, deviceExec as never,
  );
  return { service, enqueued, state };
}

describe('AddOnEntitlementRemediationService (T-013)', () => {
  it('retryProfileSync resets FAILED jobs to PENDING and force re-enqueues', async () => {
    const { service, enqueued } = build();
    const result = await service.retryProfileSync('sub-1');
    assert.equal(result.retried, 1);
    assert.deepEqual(result.jobIds, ['job-1']);
    assert.deepEqual(enqueued, ['job-1']);
  });

  it('retryProfileSync skips a job that lost the reset race (count 0)', async () => {
    const { service, enqueued } = build({ resetCount: 0 });
    const result = await service.retryProfileSync('sub-1');
    assert.equal(result.retried, 0);
    assert.deepEqual(enqueued, []);
  });

  it('forceReconcile emits + enqueues a versioned job when the projection changed', async () => {
    const { service, enqueued } = build({ projectionChanged: true });
    const result = await service.forceReconcile('sub-1');
    assert.equal(result.changed, true);
    assert.equal(result.desiredRevision, '9');
    assert.equal(result.syncJobId, 'job-new');
    assert.deepEqual(enqueued, ['job-new']);
  });

  it('forceReconcile is a no-op push when the projection is unchanged', async () => {
    const { service, enqueued } = build({ projectionChanged: false });
    const result = await service.forceReconcile('sub-1');
    assert.equal(result.changed, false);
    assert.equal(result.syncJobId, null);
    assert.deepEqual(enqueued, []);
  });

  it('acknowledgeIncident flips OPEN → ACKNOWLEDGED (idempotent when already acked)', async () => {
    const acked = await build().service.acknowledgeIncident('inc-1', ACTOR);
    assert.equal(acked.changed, true);
    const already = await build({ ackCount: 0, incidentExists: true }).service.acknowledgeIncident('inc-1', ACTOR);
    assert.equal(already.changed, false);
  });

  it('acknowledgeIncident throws NotFound for a missing incident', async () => {
    const { service } = build({ ackCount: 0, incidentExists: false });
    await assert.rejects(() => service.acknowledgeIncident('missing', ACTOR), (e: unknown) => e instanceof NotFoundException);
  });

  it('reverseEntitlement transitions REVERSE, recomputes and enqueues', async () => {
    const { service, enqueued } = build({ transitionChanged: true });
    const result = await service.reverseEntitlement('ent-1', ACTOR);
    assert.equal(result.state, 'REVERSED');
    assert.equal(result.changed, true);
    assert.deepEqual(enqueued, ['job-new']);
  });

  it('reverseEntitlement throws NotFound for a missing entitlement', async () => {
    const { service } = build({ entitlement: null });
    await assert.rejects(() => service.reverseEntitlement('missing', ACTOR), (e: unknown) => e instanceof NotFoundException);
  });

  it('approveDevicePlan executes with the operator force override', async () => {
    const { service } = build();
    const result = await service.approveDevicePlan('plan-1');
    assert.equal(result.status, 'APPLIED');
  });
});

/**
 * `forceReconcile` exists to repair a subscription whose effective limits
 * drifted away from `baseline + ACTIVE entitlements`. The baseline now honours
 * an operator's individual configuration
 * (`src/modules/add-on-entitlements/domain/entitlement-baseline.ts`), and the
 * obvious way to get that wrong is to make remediation skip anything that
 * differs from the plan — which would disarm it completely.
 *
 * It does not, and these two tests pin both halves of the distinction with the
 * REAL {@link EffectiveProjectionService}: the add-on share of the mirrored
 * column is re-derived from the live ledger every time and is still taken back,
 * while the remainder that disagrees with the stored `planSnapshot` is the
 * operator's and is left alone. Plan 3, live add-on 5, drifted column 8,
 * operator 12 — four values, and no two outcomes below can read the same.
 */
describe('AddOnEntitlementRemediationService forceReconcile still repairs drift', () => {
  function createStore(options: {
    readonly deviceLimit: number;
    readonly activeDeviceContribution: number;
    readonly liveAddOnDevices: readonly bigint[];
  }) {
    const subscription: Record<string, unknown> = {
      id: 'sub-1',
      status: 'ACTIVE',
      remnawaveId: 'rw-1',
      trafficLimit: null,
      deviceLimit: options.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      planSnapshot: {
        id: 'plan-1',
        trafficLimit: null,
        deviceLimit: 3,
        internalSquads: [],
        externalSquad: null,
      },
    };
    const projections: Record<string, Record<string, unknown>> = {
      'sub-1': {
        baselineTermId: 'term-1',
        desiredRevision: 6n,
        baseTrafficLimitBytes: null,
        baseDeviceLimit: 3,
        activeTrafficContributionBytes: 0n,
        activeDeviceContribution: options.activeDeviceContribution,
        desiredTrafficLimitBytes: null,
        desiredDeviceLimit: options.deviceLimit,
        state: 'PENDING',
      },
    };
    const syncJobs: Array<Record<string, unknown>> = [];
    const enqueued: string[] = [];

    const tx = {
      $queryRaw: async (query: { readonly sql?: string }) => {
        const sql = String(query?.sql ?? query).replace(/\s+/g, ' ');
        if (sql.includes('base_traffic_limit_bytes')) {
          return [{ id: 'term-1', baseTrafficLimitBytes: null, baseDeviceLimit: 3 }];
        }
        assert.match(sql, /FROM "subscriptions"/, 'unexpected raw query');
        return [{ id: 'sub-1', status: 'ACTIVE' }];
      },
      subscription: {
        findUnique: async () => ({ ...subscription }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(subscription, data);
          return { id: 'sub-1', remnawaveId: subscription.remnawaveId };
        },
      },
      addOnEntitlement: {
        findMany: async () =>
          options.liveAddOnDevices.map((totalValue) => ({ type: 'EXTRA_DEVICES', totalValue })),
      },
      subscriptionEffectiveProjection: {
        findUnique: async () => ({ ...projections['sub-1'], id: 'proj-1' }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          projections['sub-1'] = { ...data };
          return { ...data };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          projections['sub-1'] = { ...projections['sub-1'], ...data };
          return { ...projections['sub-1'] };
        },
      },
      profileSyncJob: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          syncJobs.push(data);
          return { id: `job-${syncJobs.length}` };
        },
      },
    };

    const service = new AddOnEntitlementRemediationService(
      { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) } as never,
      {} as never,
      new EffectiveProjectionService() as never,
      { enqueue: async (id: string) => { enqueued.push(id); } } as never,
      {} as never,
    );

    return { service, subscription, projections, syncJobs, enqueued };
  }

  it('takes back a column still carrying an expired entitlement contribution', async () => {
    // The ledger holds nothing; the column and the previous projection still
    // carry the 5 the expired add-on granted. That is drift.
    const store = createStore({ deviceLimit: 8, activeDeviceContribution: 5, liveAddOnDevices: [] });

    const result = await store.service.forceReconcile('sub-1');

    assert.equal(result.changed, true);
    assert.equal(store.projections['sub-1']!.baseDeviceLimit, 3);
    assert.equal(
      store.projections['sub-1']!.desiredDeviceLimit,
      3,
      'the stale add-on share must still be corrected',
    );
    assert.notEqual(store.projections['sub-1']!.desiredDeviceLimit, 8, 'remediation was disarmed');
    assert.equal(store.subscription.deviceLimit, 3);
    assert.deepStrictEqual(store.enqueued, ['job-1']);
    assert.equal(store.syncJobs[0]!.desiredRevision, store.projections['sub-1']!.desiredRevision);
  });

  it('does not "correct" an operator-configured limit, and still layers the live add-on on it', async () => {
    // Column 12 with no contribution recorded: an operator set it. The live
    // +5 belongs on top of it, so the answer is 17 — not the plan's 3, and not
    // a bare 12.
    const store = createStore({ deviceLimit: 12, activeDeviceContribution: 0, liveAddOnDevices: [5n] });

    const result = await store.service.forceReconcile('sub-1');

    assert.equal(result.changed, true);
    assert.equal(store.projections['sub-1']!.baseDeviceLimit, 12);
    assert.equal(store.projections['sub-1']!.desiredDeviceLimit, 17);
    assert.notEqual(store.projections['sub-1']!.desiredDeviceLimit, 8, 'remediation reverted the operator');
    assert.equal(store.subscription.deviceLimit, 17);
  });
});
