import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import 'reflect-metadata';

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { DeviceReductionPlanState } from '@prisma/client';
import type { Request } from 'express';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { AdminAddOnEntitlementsController } from '../src/modules/add-on-entitlements/controllers/admin-add-on-entitlements.controller';
import { AddOnEntitlementRemediationService } from '../src/modules/add-on-entitlements/services/add-on-entitlement-remediation.service';
import {
  DeviceReductionExecutionService,
  OPERATOR_OVERRIDE_STARTABLE_STATES,
} from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';

/**
 * `POST /admin/add-on-entitlements/device-plans/:planId/approve` is documented
 * as "approve blocked device plan" and gated on `add_on_entitlements:moderate`.
 * It force-executes the plan — the only path in the system that deletes a
 * paying customer's devices off the panel.
 *
 * It could not do the thing it is named after. `executePlan` refused anything
 * that was not `PENDING`/`IN_PROGRESS`, and `force` only bypassed the
 * `deviceCleanupAuto` rollout flag, never that guard. So approving a `BLOCKED`
 * or `REMEDIATION_REQUIRED` plan — the two states that RAISE the
 * `DEVICE_REDUCTION_BLOCKED` incidents the Delivery tab counts, and the only
 * reason an operator opens this route at all — answered
 * `200 {status:'SKIPPED'}` and did nothing.
 *
 * These specs drive the REAL `DeviceReductionExecutionService` (and, for the
 * operator-command cases, the real remediation service and the real controller
 * stacked on it) against an in-memory Postgres and a STATEFUL panel: devices
 * really disappear from the panel's set, `updateMany` really only writes when
 * its `where` still matches, and a list issued before a concurrent delete
 * answers with the world as it is when it ANSWERS. What is asserted is what
 * happened to the plan row and to the customer's devices — never that a branch
 * was taken or a method was called.
 */

const ORIGINAL_AUTO_FLAG = process.env['ADDON_DEVICE_CLEANUP_AUTO'];
afterEach(() => {
  if (ORIGINAL_AUTO_FLAG === undefined) delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
  else process.env['ADDON_DEVICE_CLEANUP_AUTO'] = ORIGINAL_AUTO_FLAG;
});
/** The automatic sweep's rollout gate. The operator override never consults it. */
function enableAutoSweep(): void {
  process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
}

const PLAN_ID = 'plan-ov-1';
const SUBSCRIPTION_ID = 'sub-ov-1';
/**
 * Every number here is deliberately distinct from every other and from the
 * zero/one/null a bug would leave behind, so no two opposite assertions can
 * read the same. `desiredLimit` 3 with 3 keepers and 2 targets gives
 * deleted=2, finalCount=3, attempts 7 → 8: five values, no collisions.
 */
const PLAN_REVISION = 41n;
const DESIRED_LIMIT = 3;
const INITIAL_ATTEMPTS = 7;
/** A prior run's start, so `startedAt` is a real value and not the null default. */
const PRIOR_START = new Date('2026-08-20T09:00:00.000Z');
const KEEPERS = ['keep-a', 'keep-b', 'keep-c'] as const;
const TARGETS = ['doomed-1', 'doomed-2'] as const;

const ADMIN = { id: 'admin-ov' } as never;
const REQ = {
  headers: {},
  ip: '127.0.0.1',
  socket: {},
  originalUrl: `/admin/add-on-entitlements/device-plans/${PLAN_ID}/approve`,
  url: `/admin/add-on-entitlements/device-plans/${PLAN_ID}/approve`,
} as unknown as Request;

interface PlanRow {
  id: string;
  subscriptionId: string;
  projectionId: string;
  projectionRevision: bigint;
  desiredLimit: number;
  selectedDevices: Array<{ hwid: string; createdAt: string }>;
  state: string;
  attempts: number;
  lastErrorCode: string | null;
  postconditionMetadata: Record<string, unknown>;
  startedAt: Date | null;
  completedAt: Date | null;
}

function planRow(patch: Partial<PlanRow> = {}): PlanRow {
  return {
    id: PLAN_ID,
    subscriptionId: SUBSCRIPTION_ID,
    projectionId: 'proj-ov-1',
    projectionRevision: PLAN_REVISION,
    desiredLimit: DESIRED_LIMIT,
    selectedDevices: TARGETS.map((hwid) => ({ hwid, createdAt: '2026-07-02T00:00:00.000Z' })),
    state: DeviceReductionPlanState.PENDING,
    attempts: INITIAL_ATTEMPTS,
    lastErrorCode: null,
    postconditionMetadata: {},
    startedAt: null,
    completedAt: null,
    ...patch,
  };
}

/** A plan the strict adapter refused: the headline case this route exists for. */
function blockedPlan(): PlanRow {
  return planRow({
    state: DeviceReductionPlanState.BLOCKED,
    startedAt: PRIOR_START,
    lastErrorCode: 'STRICT_DELETE_INVALIDCONTRACT',
  });
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Apply a Prisma `data` payload, honouring `{ increment: n }`. */
function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in (value as object)) {
      const by = (value as { increment: number }).increment;
      row[field] = ((row[field] as number | undefined) ?? 0) + by;
      continue;
    }
    row[field] = value;
  }
}

/**
 * A conditional `where`, as Postgres evaluates it. Timestamps compare by VALUE
 * — on `!==` the whole `startedAt` compare-and-swap would pass on object
 * identity alone, which is exactly the assertion these specs rest on.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(where)) {
    if (field === 'id' || expected === undefined) continue;
    const actual = row[field];
    if (actual instanceof Date && expected instanceof Date) {
      if (actual.getTime() !== expected.getTime()) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

interface Harness {
  readonly executor: DeviceReductionExecutionService;
  readonly service: AddOnEntitlementRemediationService;
  readonly controller: AdminAddOnEntitlementsController;
  readonly plans: Map<string, PlanRow>;
  /** The panel's live device set. A delete really removes one. */
  readonly devices: Set<string>;
  readonly listCalls: number[];
  readonly deleteCalls: string[];
  readonly incidents: Array<Record<string, unknown>>;
  readonly audit: Array<Record<string, unknown>>;
  readonly completionFence: bigint[];
  /** Resolves once the gated list call has been reached and parked. */
  readonly gateEntered: Promise<void>;
  releaseGate(): void;
  plan(): PlanRow;
}

function build(
  opts: { readonly plan?: PlanRow | null; readonly gateListCall?: number } = {},
): Harness {
  const seed = opts.plan === undefined ? planRow() : opts.plan;
  const plans = new Map<string, PlanRow>(seed === null ? [] : [[seed.id, { ...seed }]]);
  const devices = new Set<string>([...KEEPERS, ...TARGETS]);
  const listCalls: number[] = [];
  const deleteCalls: string[] = [];
  const incidents: Array<Record<string, unknown>> = [];
  const audit: Array<Record<string, unknown>> = [];
  const completionFence: bigint[] = [];
  const entered = deferred();
  const release = deferred();
  let listIndex = 0;

  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    deviceReductionPlan: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = plans.get(where.id);
        return row === undefined ? null : { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = plans.get(where.id);
        if (row === undefined) throw new Error(`plan ${where.id} not found`);
        applyData(row as unknown as Record<string, unknown>, data);
        return { ...row };
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
        applyData(row as unknown as Record<string, unknown>, data);
        return { count: 1 };
      },
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => ({
        desiredRevision: PLAN_REVISION,
        desiredDeviceLimit: DESIRED_LIMIT,
      }),
    },
    subscription: {
      findUnique: async () => ({
        remnawaveId: 'rem-ov-1',
        remnawavePanelId: 8123,
        remnawavePanelUsername: 'rz_ov_sub',
        configUrl: null,
        status: 'ACTIVE',
      }),
      // A SIBLING lookup: `loadGuard` asks, on every pass, whether a second
      // non-deleted subscription points at the same panel profile. `null` is
      // "no twin", the ordinary case these tests are about; the shared-profile
      // case is driven explicitly in drs-device-reduction-invariants.spec.ts.
      findFirst: async () => null,
    },
    entitlementIncident: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        incidents.push(create);
        return { id: 'inc-ov-1' };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return { id: `audit-${audit.length}` };
      },
    },
  };

  const remnawave = {
    strictListUserDevices: async () => {
      listIndex += 1;
      listCalls.push(listIndex);
      if (opts.gateListCall === listIndex) {
        entered.resolve();
        await release.promise;
      }
      // Answered AFTER the gate, from the live set: a panel replies with the
      // world as it is when it replies, not as it was when it was asked. That
      // is what lets a concurrent run's deletes be visible to a parked one.
      const hwids = [...devices];
      return {
        kind: 'ok' as const,
        value: {
          devices: hwids.map((hwid) => ({ hwid, createdAt: '2026-07-02T00:00:00.000Z' })),
          total: hwids.length,
        },
        detectedVersion: '3.2.1',
      };
    },
    strictDeleteUserDevice: async (_ref: unknown, hwid: string) => {
      deleteCalls.push(hwid);
      if (!devices.has(hwid)) return { kind: 'notFound' as const };
      devices.delete(hwid);
      return { kind: 'ok' as const, value: { total: devices.size }, detectedVersion: '3.2.1' };
    },
  };

  const boundary = {
    completeVerifiedDeviceExpiryInTransaction: async (
      _tx: unknown,
      _subscriptionId: string,
      projectionRevision: bigint,
    ) => {
      completionFence.push(projectionRevision);
      return { status: 'COMPLETED' as const, completed: 1 };
    },
  };

  const executor = new DeviceReductionExecutionService(
    prisma as never,
    remnawave as never,
    boundary as never,
  );
  const service = new AddOnEntitlementRemediationService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    executor,
  );
  const controller = new AdminAddOnEntitlementsController(
    prisma as never,
    {} as never,
    {} as never,
    service,
  );

  return {
    executor,
    service,
    controller,
    plans,
    devices,
    listCalls,
    deleteCalls,
    incidents,
    audit,
    completionFence,
    gateEntered: entered.promise,
    releaseGate: () => release.resolve(),
    plan: () => {
      const row = plans.get(PLAN_ID);
      if (row === undefined) throw new Error('plan row missing');
      return row;
    },
  };
}

/**
 * What an operator override does with each member of `DeviceReductionPlanState`
 * — read off the enum itself below, so a seventh member cannot be added without
 * somebody deciding which half of this table it belongs in.
 */
const OVERRIDE_TABLE: ReadonlyArray<{
  readonly state: DeviceReductionPlanState;
  readonly runs: boolean;
  readonly reason: string;
}> = [
  { state: DeviceReductionPlanState.PENDING, runs: true, reason: '' },
  { state: DeviceReductionPlanState.IN_PROGRESS, runs: true, reason: '' },
  { state: DeviceReductionPlanState.BLOCKED, runs: true, reason: '' },
  { state: DeviceReductionPlanState.REMEDIATION_REQUIRED, runs: true, reason: '' },
  { state: DeviceReductionPlanState.APPLIED, runs: false, reason: 'PLAN_STATE_APPLIED' },
  { state: DeviceReductionPlanState.SUPERSEDED, runs: false, reason: 'PLAN_STATE_SUPERSEDED' },
];

/** Push a thrown exception through the filter every admin response passes. */
function throughSafeFilter(error: unknown): {
  readonly statusCode: number;
  readonly message: string | string[];
} {
  let body: { statusCode: number; message: string | string[] } | undefined;
  const response = {
    status: () => ({
      json: (payload: { statusCode: number; message: string | string[] }) => {
        body = payload;
      },
    }),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => REQ }),
  } as unknown as ArgumentsHost;
  new AdminSafeExceptionFilter().catch(error, host);
  if (body === undefined) throw new Error('filter wrote no body');
  return body;
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the command to be refused, it was not');
}

describe('device-plan approve — the operator override (T-011c/T-013)', () => {
  it('a BLOCKED plan approved by an operator ACTUALLY EXECUTES', async () => {
    // The headline. Before the widening this returned `{status:'SKIPPED'}` with
    // a 200, deleted nothing, and left the plan BLOCKED — on the exact state
    // the route is named for and the panel now has a button for.
    const h = build({ plan: blockedPlan() });

    const outcome = await h.executor.executePlan(PLAN_ID, { force: true });

    assert.deepEqual(outcome, { status: 'APPLIED', deleted: 2 });
    // The customer's devices really went, and only the planned ones.
    assert.deepEqual(h.deleteCalls, ['doomed-1', 'doomed-2']);
    assert.deepEqual([...h.devices].sort(), ['keep-a', 'keep-b', 'keep-c']);
    // And the plan row carries the proof, not just a status the caller printed.
    const plan = h.plan();
    assert.equal(plan.state, DeviceReductionPlanState.APPLIED);
    assert.equal(plan.attempts, INITIAL_ATTEMPTS + 1);
    assert.deepEqual(plan.postconditionMetadata, {
      finalCount: 3,
      deleted: 2,
      desiredLimit: DESIRED_LIMIT,
    });
    assert.notEqual(plan.completedAt, null);
    // The completion fence ran once, against the plan's own revision.
    assert.deepEqual(h.completionFence, [PLAN_REVISION]);
    // The rollout flag was never set in this test: `force` is an operator
    // override, not a flag bypass dressed up as one.
    assert.equal(process.env['ADDON_DEVICE_CLEANUP_AUTO'], ORIGINAL_AUTO_FLAG);
  });

  it('a REMEDIATION_REQUIRED plan approved by an operator also executes', async () => {
    // The second widened state. Its targets are immutable but the PANEL is not:
    // once the customer removed something, the same plan can reach its
    // post-condition. `keep-c` is gone before the run, so the two targets bring
    // the profile to 2 — under the limit, and still a real execution.
    const h = build({
      plan: planRow({
        state: DeviceReductionPlanState.REMEDIATION_REQUIRED,
        startedAt: PRIOR_START,
        lastErrorCode: 'STILL_OVER_LIMIT',
      }),
    });
    h.devices.delete('keep-c');

    const outcome = await h.executor.executePlan(PLAN_ID, { force: true });

    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(h.deleteCalls, ['doomed-1']);
    assert.equal(h.plan().state, DeviceReductionPlanState.APPLIED);
  });

  it('an APPLIED plan is still REFUSED, and its post-condition proof is left alone', async () => {
    // The negative half. Without it, a "fix" that simply deleted the state
    // guard passes every positive case above.
    const proof = { finalCount: 3, deleted: 2, desiredLimit: DESIRED_LIMIT };
    const h = build({
      plan: planRow({
        state: DeviceReductionPlanState.APPLIED,
        startedAt: PRIOR_START,
        completedAt: new Date('2026-08-20T09:00:04.000Z'),
        postconditionMetadata: { ...proof },
      }),
    });

    const outcome = await h.executor.executePlan(PLAN_ID, { force: true });

    assert.deepEqual(outcome, { status: 'REFUSED', reason: 'PLAN_STATE_APPLIED' });
    // Not one panel call, let alone a delete: re-running an APPLIED plan would
    // re-enter the completion fence for work already proved done.
    assert.deepEqual(h.listCalls, []);
    assert.deepEqual(h.deleteCalls, []);
    assert.deepEqual(h.completionFence, []);
    const plan = h.plan();
    assert.equal(plan.state, DeviceReductionPlanState.APPLIED);
    assert.equal(plan.attempts, INITIAL_ATTEMPTS);
    assert.equal(plan.startedAt, PRIOR_START);
    assert.deepEqual(plan.postconditionMetadata, proof);
  });

  it('a SUPERSEDED plan is still REFUSED', async () => {
    // A plan built against a world that no longer exists — an advanced
    // revision, a deleted subscription, a RELINKED panel profile. Running it is
    // what the relink and revision guards exist to prevent.
    const h = build({
      plan: planRow({
        state: DeviceReductionPlanState.SUPERSEDED,
        startedAt: PRIOR_START,
        lastErrorCode: 'PANEL_PROFILE_RELINKED',
      }),
    });

    const outcome = await h.executor.executePlan(PLAN_ID, { force: true });

    assert.deepEqual(outcome, { status: 'REFUSED', reason: 'PLAN_STATE_SUPERSEDED' });
    assert.deepEqual(h.deleteCalls, []);
    assert.equal(h.plan().state, DeviceReductionPlanState.SUPERSEDED);
  });

  it('the table below names every member of DeviceReductionPlanState, and matches the exported set', () => {
    assert.deepEqual(
      Object.values(DeviceReductionPlanState).slice().sort(),
      OVERRIDE_TABLE.map((row) => row.state).slice().sort(),
    );
    assert.deepEqual(
      OPERATOR_OVERRIDE_STARTABLE_STATES.slice().sort(),
      OVERRIDE_TABLE.filter((row) => row.runs)
        .map((row) => row.state)
        .slice()
        .sort(),
    );
  });

  for (const row of OVERRIDE_TABLE) {
    it(`override on a ${row.state} plan ${row.runs ? 'executes' : `is REFUSED (${row.reason})`}`, async () => {
      const h = build({
        plan: planRow({
          state: row.state,
          startedAt: row.state === DeviceReductionPlanState.PENDING ? null : PRIOR_START,
        }),
      });

      const outcome = await h.executor.executePlan(PLAN_ID, { force: true });

      if (row.runs) {
        assert.equal(outcome.status, 'APPLIED');
        assert.deepEqual(h.deleteCalls, ['doomed-1', 'doomed-2']);
        assert.equal(h.plan().attempts, INITIAL_ATTEMPTS + 1);
      } else {
        assert.deepEqual(outcome, { status: 'REFUSED', reason: row.reason });
        assert.deepEqual(h.deleteCalls, []);
        assert.equal(h.plan().attempts, INITIAL_ATTEMPTS);
      }
    });
  }

  it('a missing plan is REFUSED, not silently SKIPPED', async () => {
    const h = build({ plan: null });

    const outcome = await h.executor.executePlan(PLAN_ID, { force: true });

    assert.deepEqual(outcome, { status: 'REFUSED', reason: 'PLAN_NOT_FOUND' });
  });

  // ── The automatic sweep is unchanged ─────────────────────────────────────
  //
  // Anti-vacuity for everything above: the widening is the OPERATOR override,
  // not a deleted guard. A fix that removed the state check would make the
  // unattended sweep run a BLOCKED plan, and the second control below is the
  // only thing that notices.

  it('control: the automatic sweep still runs a PENDING plan (so the flag really is on)', async () => {
    enableAutoSweep();
    const h = build({ plan: planRow() });

    const outcome = await h.executor.executePlan(PLAN_ID);

    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(h.deleteCalls, ['doomed-1', 'doomed-2']);
  });

  it('control: the automatic sweep still SKIPS a BLOCKED plan and touches nothing', async () => {
    enableAutoSweep();
    const h = build({ plan: blockedPlan() });

    const outcome = await h.executor.executePlan(PLAN_ID);

    // `SKIPPED`, not `REFUSED`: the unattended sweep passing over a plan it has
    // nothing to do with is routine, and must not read as a human's command
    // being turned down.
    assert.deepEqual(outcome, { status: 'SKIPPED', reason: 'PLAN_STATE_BLOCKED' });
    assert.deepEqual(h.listCalls, []);
    assert.deepEqual(h.deleteCalls, []);
    const plan = h.plan();
    assert.equal(plan.state, DeviceReductionPlanState.BLOCKED);
    assert.equal(plan.attempts, INITIAL_ATTEMPTS);
    assert.equal(plan.startedAt, PRIOR_START);
  });

  // ── The claim: two clicks must not become two runs ───────────────────────

  it('a second click while the run is in flight is refused WITHOUT reaching the panel', async () => {
    // `executePlan` accepts a plan that is already `IN_PROGRESS`, which is what
    // made a double-click a second concurrent run deleting the same customer's
    // devices. The operator command key is claimed on the plan row before
    // execution, and the claim covers every state the override can start from —
    // `BLOCKED` included, which is the state nobody would have thought to cover
    // if the claim had been written before the widening.
    const h = build({ plan: blockedPlan(), gateListCall: 1 });
    const body = { commandKey: 'cmd-ov-A', reason: 'ticket 91: panel fixed' };

    const first = h.controller.approveDevicePlan(PLAN_ID, body, ADMIN, REQ);
    await h.gateEntered; // the first run is parked inside the panel

    const error = await refusal(() => h.controller.approveDevicePlan(PLAN_ID, body, ADMIN, REQ));

    assert.ok(error instanceof ConflictException);
    // The decisive assertion: the second command never got as far as a panel
    // call, so it cannot have deleted anything.
    assert.deepEqual(h.listCalls, [1]);
    assert.deepEqual(h.deleteCalls, []);

    h.releaseGate();
    const outcome = await first;

    assert.equal(outcome.status, 'APPLIED');
    // One run, one set of deletes, one attempt claimed.
    assert.deepEqual(h.deleteCalls, ['doomed-1', 'doomed-2']);
    assert.equal(h.plan().attempts, INITIAL_ATTEMPTS + 1);
    assert.deepEqual(h.completionFence, [PLAN_REVISION]);
  });

  it('a replayed key after the run finished answers from the record instead of re-running', async () => {
    const h = build({ plan: blockedPlan() });
    const body = { commandKey: 'cmd-ov-A', reason: 'ticket 91: panel fixed' };

    const first = await h.controller.approveDevicePlan(PLAN_ID, body, ADMIN, REQ);
    const second = await h.controller.approveDevicePlan(PLAN_ID, body, ADMIN, REQ);

    assert.equal(first.status, 'APPLIED');
    assert.equal(second.status, 'APPLIED');
    assert.deepEqual(h.deleteCalls, ['doomed-1', 'doomed-2']);
    assert.equal(h.plan().attempts, INITIAL_ATTEMPTS + 1);
    // Both attempts are audited: deduplicating the effect must not silence the
    // record that an operator asked for it twice.
    assert.equal(h.audit.length, 2);
  });

  it('anti-vacuity: the refusal keys off the COMMAND, not on "second call"', async () => {
    // If the guard above simply refused every second approval, the test above
    // would pass while the panel refused legitimate re-drives forever. A fresh
    // key on a plan the first command left APPLIED reaches the executor and is
    // turned down by the STATE guard — a different refusal, with a reason.
    const h = build({ plan: blockedPlan() });

    await h.controller.approveDevicePlan(
      PLAN_ID,
      { commandKey: 'cmd-ov-A', reason: 'ticket 91: panel fixed' },
      ADMIN,
      REQ,
    );
    const error = await refusal(() =>
      h.controller.approveDevicePlan(
        PLAN_ID,
        { commandKey: 'cmd-ov-B', reason: 'ticket 91: second look' },
        ADMIN,
        REQ,
      ),
    );

    assert.ok(error instanceof ConflictException);
    assert.equal(h.plan().state, DeviceReductionPlanState.APPLIED);
    assert.deepEqual(h.deleteCalls, ['doomed-1', 'doomed-2']);
  });

  /**
   * GAP, asserted as it actually behaves so that closing it is a deliberate
   * edit that turns this red.
   *
   * The claim is a compare-and-swap on the `(state, startedAt)` pair the row
   * was READ at. That excludes a caller who read the SAME snapshot, and the
   * replayed-key case above. It does NOT exclude a caller who arrives after the
   * first run has started: `IN_PROGRESS` is startable by design (a run can die
   * and must be re-drivable), so a second operator with a DIFFERENT key reads
   * the fresh pair, swaps on it, and starts a second run.
   *
   * The customer is not over-deleted anyway, and that is worth being precise
   * about: what saves them is the strict list read-back before every delete
   * (`total - desiredLimit <= 0` breaks the loop), NOT the claim. The cost is
   * doubled panel load, a doubled `attempts`, and the completion fence entered
   * twice.
   *
   * Closing it needs a lease, and the obvious cheap fix is worse than the gap:
   * refusing any different key while a claim carries no recorded outcome makes
   * ONE crashed run brick the plan forever, and `@@unique([subscriptionId,
   * projectionRevision])` means no replacement plan can be built for that
   * revision either.
   */
  it('GAP: a different key arriving after the run started is NOT excluded', async () => {
    const h = build({ plan: blockedPlan(), gateListCall: 1 });

    const first = h.controller.approveDevicePlan(
      PLAN_ID,
      { commandKey: 'cmd-ov-A', reason: 'ticket 91: panel fixed' },
      ADMIN,
      REQ,
    );
    await h.gateEntered;

    const second = await h.controller.approveDevicePlan(
      PLAN_ID,
      { commandKey: 'cmd-ov-B', reason: 'ticket 92: another operator' },
      ADMIN,
      REQ,
    );
    h.releaseGate();
    const firstOutcome = await first;

    assert.equal(second.status, 'APPLIED');
    assert.equal(firstOutcome.status, 'APPLIED');
    // Two runs claimed the plan — the exclusion did not hold.
    assert.equal(h.plan().attempts, INITIAL_ATTEMPTS + 2);
    assert.equal(h.completionFence.length, 2);
    // And the read-back convergence, not the claim, is what kept the customer
    // whole: each target was deleted exactly once.
    assert.deepEqual(h.deleteCalls, ['doomed-1', 'doomed-2']);
    assert.deepEqual([...h.devices].sort(), ['keep-a', 'keep-b', 'keep-c']);
  });

  // ── What the operator is actually told ───────────────────────────────────

  it('POST approve: a declined override is a 409 naming the state, and the reason survives the safe filter', async () => {
    const h = build({
      plan: planRow({
        state: DeviceReductionPlanState.APPLIED,
        startedAt: PRIOR_START,
        postconditionMetadata: { finalCount: 3, deleted: 2, desiredLimit: DESIRED_LIMIT },
      }),
    });

    const error = await refusal(() =>
      h.controller.approveDevicePlan(
        PLAN_ID,
        { commandKey: 'cmd-ov-A', reason: 'ticket 93: retrying by hand' },
        ADMIN,
        REQ,
      ),
    );

    assert.ok(error instanceof ConflictException);
    // The whole point of `REFUSED`: a 200 carrying `{status:'SKIPPED'}` is
    // indistinguishable from success unless the caller reads a field.
    const body = throughSafeFilter(error);
    assert.equal(body.statusCode, 409);
    // Load-bearing: `AdminSafeExceptionFilter` replaces any message that trips a
    // sensitive pattern with the bare "Request failed". A decline reason that
    // ever did would leave the operator with no reason at all.
    assert.equal(body.message, 'Device reduction plan cannot be re-run: PLAN_STATE_APPLIED');
    // Declined, and audited anyway, with the reason on the record.
    assert.equal(h.audit.length, 1);
    const metadata = h.audit[0]!['metadata'] as Record<string, unknown>;
    assert.equal(metadata['status'], 'REFUSED');
    assert.equal(metadata['declineReason'], 'PLAN_STATE_APPLIED');
  });

  it('POST approve: a missing plan is a 404, not a 200 that quietly did nothing', async () => {
    const h = build({ plan: null });

    const error = await refusal(() =>
      h.controller.approveDevicePlan(
        PLAN_ID,
        { commandKey: 'cmd-ov-A', reason: 'ticket 94: stale link' },
        ADMIN,
        REQ,
      ),
    );

    assert.ok(error instanceof NotFoundException);
    const body = throughSafeFilter(error);
    assert.equal(body.statusCode, 404);
    assert.equal(body.message, 'Device reduction plan not found');
  });
});
