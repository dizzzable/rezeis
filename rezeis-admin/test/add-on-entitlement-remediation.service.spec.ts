import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';

import { AddOnEntitlementRemediationService } from '../src/modules/add-on-entitlements/services/add-on-entitlement-remediation.service';

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
