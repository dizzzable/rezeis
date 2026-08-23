import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import 'reflect-metadata';

import { ConflictException } from '@nestjs/common';
import type { Request } from 'express';

import { AdminAddOnEntitlementsController } from '../src/modules/add-on-entitlements/controllers/admin-add-on-entitlements.controller';
import { AddOnEntitlementRemediationService } from '../src/modules/add-on-entitlements/services/add-on-entitlement-remediation.service';

/**
 * `commandKey` is documented on `RemediationCommandDto` as an idempotency key:
 * "a replayed request resolves to the same effect". Three of the five mutating
 * remediation commands accepted it and never looked at it again, which is worse
 * than not accepting one — the panel promises deduplication and does not
 * deduplicate, and the moment the SPA grew buttons an impatient retry became a
 * second remediation command.
 *
 * These tests drive the real service (and, for approve, the real controller on
 * top of it) against an in-memory store that reproduces the CONDITIONAL
 * semantics the production code depends on — `updateMany` only writes when its
 * `where` still matches, and `executePlan` replaces `postconditionMetadata`
 * wholesale on the APPLIED path. What is asserted is the observable outcome:
 * how many times the executor ran, and what the two calls answered. Nothing
 * here asserts that a lookup happened.
 */

interface IncidentRow {
  id: string;
  state: string;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  metadata: Record<string, unknown>;
}

interface PlanRow {
  id: string;
  state: string;
  startedAt: Date | null;
  attempts: number;
  postconditionMetadata: Record<string, unknown>;
}

interface SyncJobRow {
  id: string;
  subscriptionId: string;
  status: string;
  supersededAt: Date | null;
}

interface Harness {
  readonly service: AddOnEntitlementRemediationService;
  readonly controller: AdminAddOnEntitlementsController;
  readonly incidents: Map<string, IncidentRow>;
  readonly plans: Map<string, PlanRow>;
  readonly audit: Array<Record<string, unknown>>;
  readonly enqueued: string[];
  /** Every `executePlan` call, in order — the effect a replay must not repeat. */
  readonly executions: string[];
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(where)) {
    if (field === 'id') continue;
    if (expected === undefined) continue;
    const actual = row[field];
    // Prisma compares a timestamp by VALUE. Leaving this on `!==` would make
    // the `startedAt` compare-and-swap pass on object identity alone.
    if (actual instanceof Date && expected instanceof Date) {
      if (actual.getTime() !== expected.getTime()) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function build(
  seed: {
    readonly incidents?: readonly IncidentRow[];
    readonly plans?: readonly PlanRow[];
    readonly syncJobs?: readonly SyncJobRow[];
  } = {},
): Harness {
  const incidents = new Map<string, IncidentRow>((seed.incidents ?? []).map((r) => [r.id, { ...r }]));
  const plans = new Map<string, PlanRow>((seed.plans ?? []).map((r) => [r.id, { ...r }]));
  const syncJobs = (seed.syncJobs ?? []).map((r) => ({ ...r }));
  const audit: Array<Record<string, unknown>> = [];
  const enqueued: string[] = [];
  const executions: string[] = [];

  const prisma = {
    entitlementIncident: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = incidents.get(where.id);
        return row === undefined ? null : { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown> & { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = incidents.get(where.id);
        if (row === undefined || !matches(row as unknown as Record<string, unknown>, where)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    deviceReductionPlan: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = plans.get(where.id);
        return row === undefined ? null : { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown> & { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = plans.get(where.id);
        if (row === undefined || !matches(row as unknown as Record<string, unknown>, where)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = plans.get(where.id);
        if (row === undefined) throw new Error('plan not found');
        Object.assign(row, data);
        return { ...row };
      },
    },
    profileSyncJob: {
      findMany: async ({ where }: { where: { subscriptionId: string; status: string } }) =>
        syncJobs
          .filter(
            (j) =>
              j.subscriptionId === where.subscriptionId &&
              j.status === where.status &&
              j.supersededAt === null,
          )
          .map((j) => ({ id: j.id })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Record<string, unknown>;
      }) => {
        const row = syncJobs.find((j) => j.id === where.id && j.status === where.status);
        if (row === undefined) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return { id: `audit-${audit.length}` };
      },
    },
  };

  // Mirrors the real executor closely enough to be worth asserting against: it
  // refuses a plan that is not PENDING/IN_PROGRESS, and on the APPLIED path it
  // REPLACES `postconditionMetadata` with its post-condition proof — which is
  // exactly what would silently eat a command key recorded before execution.
  const deviceExec = {
    executePlan: async (planId: string, options: { force?: boolean }) => {
      executions.push(planId);
      const row = plans.get(planId);
      if (row === undefined) return { status: 'REFUSED', reason: 'PLAN_NOT_FOUND' };
      // Mirrors `OPERATOR_OVERRIDE_STARTABLE_STATES` under `force`, and the
      // REFUSED (not SKIPPED) answer an override gets when it is declined.
      if (!['PENDING', 'IN_PROGRESS', 'BLOCKED', 'REMEDIATION_REQUIRED'].includes(row.state)) {
        return { status: 'REFUSED', reason: `PLAN_STATE_${row.state}` };
      }
      row.attempts += 1;
      row.state = 'APPLIED';
      row.postconditionMetadata = { finalCount: 2, deleted: 1, desiredLimit: 2 };
      return { status: options.force === true ? 'APPLIED' : 'AUTO_DISABLED' };
    },
  };

  const queue = {
    enqueue: async (id: string) => {
      enqueued.push(id);
    },
  };
  const entitlements = { transitionInTransaction: async () => ({ state: 'REVERSED', changed: true }) };
  const projection = { recomputeInTransaction: async () => ({ changed: false, desiredRevision: 1n }) };

  const service = new AddOnEntitlementRemediationService(
    prisma as never,
    entitlements as never,
    projection as never,
    queue as never,
    deviceExec as never,
  );
  const controller = new AdminAddOnEntitlementsController(
    prisma as never,
    {} as never,
    {} as never,
    service,
  );
  return { service, controller, incidents, plans, audit, enqueued, executions };
}

const ADMIN = { id: 'admin-1' } as never;
const REQ = { headers: {}, ip: '127.0.0.1', socket: {} } as unknown as Request;

function openIncident(id: string): IncidentRow {
  return { id, state: 'OPEN', acknowledgedBy: null, acknowledgedAt: null, metadata: {} };
}

function pendingPlan(id: string): PlanRow {
  return { id, state: 'PENDING', startedAt: null, attempts: 0, postconditionMetadata: {} };
}

describe('add-on remediation commandKey (idempotency)', () => {
  it('acknowledgeIncident: a replayed key acknowledges once and answers the same both times', async () => {
    const h = build({ incidents: [openIncident('inc-1')] });
    const actor = { actorId: 'admin-1', commandKey: 'cmd-A', reason: 'ops' };

    const first = await h.service.acknowledgeIncident('inc-1', actor);
    const stamped = h.incidents.get('inc-1')!.acknowledgedAt;
    const second = await h.service.acknowledgeIncident('inc-1', actor);

    assert.equal(first.changed, true);
    // Before this fix the replay answered `changed: false` — "someone else got
    // there first" — which is the opposite of what an idempotency key promises.
    assert.equal(second.changed, true);
    // One effect, not two: the acknowledgement stamp was not rewritten.
    assert.equal(h.incidents.get('inc-1')!.acknowledgedAt, stamped);
    assert.equal(h.incidents.get('inc-1')!.acknowledgedBy, 'admin-1');
    assert.equal(h.incidents.get('inc-1')!.state, 'ACKNOWLEDGED');
  });

  it('acknowledgeIncident: a DIFFERENT key on an already-acknowledged incident still reports no change', async () => {
    // Anti-vacuity control. If the replay path answered `changed: true` for any
    // caller, the test above would pass while the endpoint told every operator
    // their command took effect.
    const h = build({ incidents: [openIncident('inc-1')] });
    await h.service.acknowledgeIncident('inc-1', {
      actorId: 'admin-1',
      commandKey: 'cmd-A',
      reason: 'ops',
    });

    const other = await h.service.acknowledgeIncident('inc-1', {
      actorId: 'admin-2',
      commandKey: 'cmd-B',
      reason: 'ops',
    });

    assert.equal(other.changed, false);
    assert.equal(h.incidents.get('inc-1')!.acknowledgedBy, 'admin-1');
  });

  it('approveDevicePlan: a replayed key runs the executor once', async () => {
    const h = build({ plans: [pendingPlan('plan-1')] });
    const actor = { actorId: 'admin-1', commandKey: 'cmd-A', reason: 'ops' };

    const first = await h.service.approveDevicePlan('plan-1', actor);
    const second = await h.service.approveDevicePlan('plan-1', actor);

    assert.deepEqual(h.executions, ['plan-1']);
    assert.equal(first.status, 'APPLIED');
    assert.equal(second.status, 'APPLIED');
    assert.equal(h.plans.get('plan-1')!.attempts, 1);
    // The executor overwrote `postconditionMetadata` with its post-condition
    // proof; the recorded command was merged back on top of it, not instead.
    assert.equal(h.plans.get('plan-1')!.postconditionMetadata['finalCount'], 2);
  });

  it('approveDevicePlan: a FRESH key still reaches the executor', async () => {
    // Anti-vacuity control for the guard above — it must key off the command,
    // not simply refuse every second approval of a plan.
    const h = build({ plans: [pendingPlan('plan-1')] });
    await h.service.approveDevicePlan('plan-1', {
      actorId: 'admin-1',
      commandKey: 'cmd-A',
      reason: 'ops',
    });

    const retried = await h.service.approveDevicePlan('plan-1', {
      actorId: 'admin-1',
      commandKey: 'cmd-B',
      reason: 'second look',
    });

    assert.deepEqual(h.executions, ['plan-1', 'plan-1']);
    // The plan finished on the first command, so the executor refuses it —
    // and a refusal is legible, not folded into the sweep's routine SKIPPED.
    assert.equal(retried.status, 'REFUSED');
  });

  it('approveDevicePlan: a replay while the first run is unfinished refuses instead of starting a second', async () => {
    const h = build({
      plans: [
        {
          id: 'plan-1',
          state: 'IN_PROGRESS',
          startedAt: new Date('2026-08-21T10:00:00.000Z'),
          attempts: 1,
          // Claimed, no outcome recorded yet: the first run is still in flight.
          postconditionMetadata: { operatorCommand: { key: 'cmd-A' } },
        },
      ],
    });

    await assert.rejects(
      () =>
        h.service.approveDevicePlan('plan-1', {
          actorId: 'admin-1',
          commandKey: 'cmd-A',
          reason: 'ops',
        }),
      (e: unknown) => e instanceof ConflictException,
    );
    assert.deepEqual(h.executions, []);
  });

  it('POST device-plans/:id/approve: the controller carries the key through, so a replayed request executes once', async () => {
    // The controller used to read `body.commandKey` only to write it into the
    // audit log — the service never saw it. Driving the real handler is the
    // only way that regression shows up.
    const h = build({ plans: [pendingPlan('plan-1')] });
    const body = { commandKey: 'cmd-A', reason: 'operator override' };

    const first = await h.controller.approveDevicePlan('plan-1', body, ADMIN, REQ);
    const second = await h.controller.approveDevicePlan('plan-1', body, ADMIN, REQ);

    assert.deepEqual(h.executions, ['plan-1']);
    assert.equal(first.status, 'APPLIED');
    assert.equal(second.status, 'APPLIED');
    // Both attempts are still audited — deduplicating the effect must not
    // silence the record that an operator asked for it twice.
    assert.equal(h.audit.length, 2);
    for (const row of h.audit) {
      assert.equal(row['action'], 'add_on_entitlements.approve_device_plan');
      assert.equal((row['metadata'] as Record<string, unknown>)['commandKey'], 'cmd-A');
    }
  });

  it('retryProfileSync: the key is ADVISORY — a replay answers differently', async () => {
    // Not a wish: a statement of the remaining gap, so nobody upgrades the
    // docs without upgrading the code. `retry-sync` and `reconcile` address a
    // subscription and have no row to claim a key against; honouring them needs
    // a migration (see the service doc). The effect does not double-apply —
    // only jobs still FAILED are claimed — but the answer is not stable.
    const h = build({
      syncJobs: [{ id: 'job-1', subscriptionId: 'sub-1', status: 'FAILED', supersededAt: null }],
    });

    const first = await h.service.retryProfileSync('sub-1');
    const second = await h.service.retryProfileSync('sub-1');

    assert.equal(first.retried, 1);
    assert.equal(second.retried, 0);
    assert.deepEqual(h.enqueued, ['job-1']);
  });
});
