import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { AddOnEntitlementInspectionService } from '../src/modules/add-on-entitlements/services/add-on-entitlement-inspection.service';
import {
  DeviceReductionExecutionService,
  STALE_PANEL_LINK,
} from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';

/**
 * WHY WAS THIS PLAN BLOCKED? -- THE OPERATOR'S ONLY VIEW OF THE ANSWER.
 *
 * Two halves of one defect, both about a reason that reaches nobody.
 *
 * -- HALF ONE: THE PLAN KNOWS AND WILL NOT SAY ------------------------------
 *
 * `markState` persists `lastErrorCode` on every terminal transition, and it is
 * always the CURRENT reason. `AddOnEntitlementInspectionService` never selects
 * it, so the inspection payload -- the only per-plan surface the operator has,
 * and the hinge every remediation command hangs off -- omits it entirely. The
 * column is correct and unread.
 *
 * -- HALF TWO: THE INCIDENT KEEPS THE FIRST REASON FOREVER ------------------
 *
 * `raiseIncident` upserts on `device-reduction:${planId}` with `update: {}`.
 * That key names a PLAN, not a CAUSE, so the second time a plan is blocked for
 * a DIFFERENT reason the row keeps the first `summaryCode` -- and `summaryCode`
 * is exactly what the inspection service surfaces and the SPA renders verbatim.
 *
 * The staleness bites on the intended workflow, not on an exotic one. `BLOCKED`
 * is in `OPERATOR_OVERRIDE_STARTABLE_STATES` precisely so an operator can fix
 * the cause and re-drive; a plan first blocked for a malformed device list and
 * then, once the panel is answering again, for a stale panel link still tells
 * them about the device list. They fix the wrong thing.
 *
 * `update: {}` has a second edge that is sharper still: it leaves a RESOLVED
 * incident RESOLVED. A fresh occurrence then raises nothing an operator can
 * see at all -- the SPA offers its acknowledge control only while
 * `state === 'OPEN'`.
 *
 * -- THE SEMANTICS CHOSEN, AND WHY ------------------------------------------
 *
 * An `EntitlementIncident` is a UNIT OF OPERATOR WORK, not a log line: it
 * carries `state`, `acknowledgedBy/At`, `resolvedBy/At` and `resolutionCode`.
 * Mutating one cause into another would launder all of that -- an incident
 * ACKNOWLEDGED by a person who never saw the new cause, or RESOLVED against a
 * fault that is still live. This repository already states the same view in the
 * one other place that upserts an incident: `add-on-entitlement.service.ts`
 * treats a support ref already bound to a different `summaryCode` as a
 * CONFLICT rather than as something to overwrite.
 *
 * So the KEY is refined rather than the row mutated: `supportRef` becomes
 * `device-reduction:${planId}:${summaryCode}`. A distinct cause is a distinct
 * incident; the same cause recurring is still ONE row (which is what the empty
 * `update` was protecting, and it stays protected); and because a recurrence of
 * a cause that was already resolved is a real event, that one `update` REOPENS
 * the row instead of leaving a closed record standing over a live fault.
 *
 * Note what this does NOT need: the inspection service already returns
 * incidents `createdAt desc`, so the newest cause sorts to the top with no SPA
 * change at all.
 */

/** A live 2.x uuid, in the spelling a 3.x panel can no longer answer to. */
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';

/** The two reasons this plan is blocked for, in order, pinned as literals. */
const FIRST_REASON = 'STRICT_LIST_INVALIDCONTRACT';
const SECOND_REASON = 'STALE_PANEL_LINK';

const ORIGINAL_FLAG = process.env['ADDON_DEVICE_CLEANUP_AUTO'];
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
  else process.env['ADDON_DEVICE_CLEANUP_AUTO'] = ORIGINAL_FLAG;
});
function enableAuto(): void {
  process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
}

/**
 * Timestamps are RELATIVE TO NOW, never literals -- the dormancy gate in the
 * delete loop classifies every row against `Date.now()`, so a dated fixture is
 * one whose meaning drifts. Nothing here carries a `lastSeenAt`, so that gate
 * reads every row as unknown and stays inert.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function okList(...hwids: string[]) {
  return {
    kind: 'ok' as const,
    value: {
      devices: hwids.map((hwid) => ({ hwid, createdAt: daysAgo(30), lastSeenAt: null })),
      total: hwids.length,
    },
    detectedVersion: '3.2.1',
  };
}

/** The panel's answers, switchable BETWEEN runs so one plan can fail twice differently. */
interface PanelMode {
  addressing: 'id' | 'uuid' | 'unknown';
  throws: boolean;
  listQueue: unknown[];
}

/**
 * One durable world: a plan row and an incident table that both runs and the
 * inspection service read. Nothing here resets between runs, which is the whole
 * point -- the defect is about what the SECOND run leaves behind for a reader.
 */
function world(remnawaveId: string = DEAD_UUID) {
  const plan: Record<string, unknown> = {
    id: 'plan-1',
    subscriptionId: 'sub-1',
    projectionId: 'proj-1',
    projectionRevision: 4n,
    desiredLimit: 1,
    selectedDevices: [{ hwid: 'new', createdAt: daysAgo(2) }],
    state: 'PENDING',
    attempts: 0,
    lastErrorCode: null,
    postconditionMetadata: {},
    startedAt: null,
    createdAt: new Date(Date.now() - 60_000),
  };
  const incidents: Array<Record<string, unknown>> = [];
  const mode: PanelMode = { addressing: 'id', throws: false, listQueue: [] };
  const panelCalls: string[] = [];

  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    deviceReductionPlan: {
      findUnique: async () => ({ ...plan }),
      update: async (args: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(args.data)) {
          // `attempts: { increment: 1 }` is the only structured write here.
          if (value !== null && typeof value === 'object' && 'increment' in value) {
            plan[key] = (plan[key] as number) + (value as { increment: number }).increment;
          } else {
            plan[key] = value;
          }
        }
        return { ...plan };
      },
      updateMany: async (args: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(args.data)) {
          if (value !== null && typeof value === 'object' && 'increment' in value) {
            plan[key] = (plan[key] as number) + (value as { increment: number }).increment;
          } else {
            plan[key] = value;
          }
        }
        return { count: 1 };
      },
      // Honours `select` EXACTLY, so a field the service forgets to ask for is
      // `undefined` here just as it is in production. A fake that returned the
      // whole row would let an unselected column pass this file and be missing
      // on the wire.
      findMany: async (args: { select: Record<string, boolean> }) =>
        [plan].map((row) => project(row, args.select)),
    },
    subscriptionEffectiveProjection: {
      findUnique: async (args: { select?: Record<string, boolean> }) =>
        project(
          {
            desiredRevision: 4n,
            state: 'PENDING',
            desiredTrafficLimitBytes: null,
            desiredDeviceLimit: 1,
            lastAppliedRevision: null,
          },
          args.select,
        ),
    },
    subscription: {
      findUnique: async () => ({
        remnawaveId,
        remnawavePanelId: 8123,
        remnawavePanelUsername: 'rz_alice_sub',
        configUrl: null,
        status: 'ACTIVE',
      }),
      findFirst: async () => null,
    },
    addOnEntitlement: { findMany: async () => [] },
    entitlementIncident: {
      // A REAL upsert keyed on `supportRef`, because "one row or two" is the
      // decision under test and a fake that always inserted (or always
      // mutated) would decide it for the service.
      upsert: async (args: {
        where: { supportRef: string };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        const existing = incidents.find((row) => row['supportRef'] === args.where.supportRef);
        if (existing !== undefined) {
          Object.assign(existing, args.update);
          return existing;
        }
        const row: Record<string, unknown> = {
          id: `inc-${incidents.length + 1}`,
          state: 'OPEN',
          acknowledgedBy: null,
          acknowledgedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionCode: null,
          // Strictly increasing, so `createdAt desc` has a defined answer and
          // "the operator sees the CURRENT reason first" is a real claim.
          createdAt: new Date(Date.now() + incidents.length),
          ...args.create,
        };
        incidents.push(row);
        return row;
      },
      findMany: async (args: { select: Record<string, boolean> }) =>
        [...incidents]
          .sort((a, b) => (b['createdAt'] as Date).getTime() - (a['createdAt'] as Date).getTime())
          .map((row) => project(row, args.select)),
    },
  };

  const remnawave = {
    getPanelShape: async () => {
      panelCalls.push('getPanelShape');
      if (mode.throws) throw new Error('panel unreachable');
      return { addressing: mode.addressing };
    },
    strictListUserDevices: async () => {
      panelCalls.push('strictListUserDevices');
      return mode.listQueue.length > 0 ? mode.listQueue.shift() : okList('old');
    },
    strictDeleteUserDevice: async () => {
      panelCalls.push('strictDeleteUserDevice');
      return { kind: 'ok', value: { total: 1 }, detectedVersion: '3.2.1' };
    },
  };

  const completion = {
    completeVerifiedDeviceExpiryInTransaction: async () => ({
      status: 'COMPLETED' as const,
      completed: 1,
    }),
  };

  const execution = new DeviceReductionExecutionService(
    prisma as never,
    remnawave as never,
    completion as never,
  );
  const inspection = new AddOnEntitlementInspectionService(prisma as never);
  return { execution, inspection, plan, incidents, mode, panelCalls };
}

/** Mimics Prisma's `select`: absent keys are absent, not `undefined`-valued. */
function project(
  row: Record<string, unknown>,
  select: Record<string, boolean> | undefined,
): Record<string, unknown> {
  if (select === undefined) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) out[key] = row[key];
  }
  return out;
}

/**
 * Blocks the same plan twice, for two different causes, the way it actually
 * happens: the panel was garbling its device list, the operator fixed that and
 * re-drove the plan, and the now-readable era revealed a stale link underneath.
 */
async function blockTwiceForDifferentReasons(w: ReturnType<typeof world>) {
  enableAuto();
  // Run 1 -- the era probe is down, so the guard fails open (deliberately) and
  // the run reaches the device list, which comes back malformed.
  w.mode.throws = true;
  w.mode.listQueue = [{ kind: 'invalidContract', details: 'total mismatch' }];
  const first = await w.execution.executePlan('plan-1');

  // Run 2 -- the panel is answering again, and the operator re-drives the
  // BLOCKED plan through the override. Now the era is readable: 3.x, against a
  // stored 2.x uuid.
  w.mode.throws = false;
  w.mode.addressing = 'id';
  w.mode.listQueue = [];
  const second = await w.execution.executePlan('plan-1', { force: true });
  return { first, second };
}

// -- HALF TWO: THE CURRENT REASON ------------------------------------------

describe('a plan blocked twice for different reasons', () => {
  it('THE PROOF: the operator is shown the CURRENT reason, not the first one', async () => {
    const w = world();

    const { first, second } = await blockTwiceForDifferentReasons(w);

    assert.deepEqual(first, { status: 'BLOCKED', reason: FIRST_REASON });
    assert.deepEqual(second, { status: 'BLOCKED', reason: SECOND_REASON });

    const result = await w.inspection.inspectSubscription('sub-1');
    assert.equal(
      result.incidents[0]?.summaryCode,
      SECOND_REASON,
      'the newest incident is the live cause, and it is what the operator reads first',
    );
    assert.equal(
      result.deviceReductionPlans[0]?.lastErrorCode,
      SECOND_REASON,
      'and the plan itself agrees, on the same payload',
    );
  });

  it('the FIRST cause survives as its own record rather than being overwritten', async () => {
    // Why two rows and not one mutated row. An incident carries a lifecycle --
    // acknowledged by whom, resolved by whom, with what resolution code -- so
    // rewriting its `summaryCode` would leave a person's acknowledgement
    // attached to a cause they never saw.
    const w = world();

    await blockTwiceForDifferentReasons(w);

    assert.equal(w.incidents.length, 2, 'two causes, two units of operator work');
    assert.deepEqual(
      w.incidents.map((row) => row['supportRef']),
      [`device-reduction:plan-1:${FIRST_REASON}`, `device-reduction:plan-1:${SECOND_REASON}`],
      'the support ref names the CAUSE as well as the plan',
    );
    assert.deepEqual(
      w.incidents.map((row) => row['summaryCode']),
      [FIRST_REASON, SECOND_REASON],
    );
  });

  it('an acknowledgement is NOT laundered onto a cause the operator never saw', async () => {
    // The concrete harm of mutating in place. The SPA renders its acknowledge
    // control only while `state === 'OPEN'`, so a new cause landing on an
    // already-ACKNOWLEDGED row would arrive looking handled.
    const w = world();
    enableAuto();
    w.mode.throws = true;
    w.mode.listQueue = [{ kind: 'invalidContract', details: 'total mismatch' }];
    await w.execution.executePlan('plan-1');

    // The operator acknowledges what they were told about.
    const acknowledged = w.incidents[0]!;
    acknowledged['state'] = 'ACKNOWLEDGED';
    acknowledged['acknowledgedBy'] = 'admin-alice';

    w.mode.throws = false;
    w.mode.addressing = 'id';
    w.mode.listQueue = [];
    await w.execution.executePlan('plan-1', { force: true });

    assert.deepEqual(
      {
        state: acknowledged['state'],
        by: acknowledged['acknowledgedBy'],
        summaryCode: acknowledged['summaryCode'],
      },
      { state: 'ACKNOWLEDGED', by: 'admin-alice', summaryCode: FIRST_REASON },
      'the row alice acknowledged still says what she acknowledged',
    );
    const fresh = w.incidents.find((row) => row['summaryCode'] === SECOND_REASON);
    assert.equal(fresh?.['state'], 'OPEN', 'and the new cause arrives needing attention');
  });

  it('a RESOLVED incident does not swallow a fresh occurrence of the same cause', async () => {
    // The sharper edge of the empty `update`: it leaves a resolved row
    // resolved, so a recurrence raises nothing visible at all. Re-driving a
    // BLOCKED plan is a deliberate operator action, never an unattended sweep
    // (`BLOCKED` is not in `AUTO_STARTABLE_STATES`), so a repeat is real news:
    // the remedy was tried and the fault came back.
    const w = world();
    enableAuto();
    w.mode.addressing = 'id';
    await w.execution.executePlan('plan-1');
    assert.equal(w.incidents.length, 1);

    const row = w.incidents[0]!;
    row['state'] = 'RESOLVED';
    row['resolvedBy'] = 'admin-alice';
    row['resolvedAt'] = new Date();
    row['resolutionCode'] = 'RECONCILED';

    await w.execution.executePlan('plan-1', { force: true });

    assert.equal(w.incidents.length, 1, 'the same cause is still ONE row, not a new one per click');
    assert.deepEqual(
      {
        state: row['state'],
        resolvedBy: row['resolvedBy'],
        resolutionCode: row['resolutionCode'],
        summaryCode: row['summaryCode'],
      },
      { state: 'OPEN', resolvedBy: null, resolutionCode: null, summaryCode: SECOND_REASON },
      'a live fault under a closed record is the one state this must never leave behind',
    );
  });

  it('the same cause twice in a row is still ONE incident (the sweep must not storm)', async () => {
    // What the empty `update` was protecting, kept. The automatic sweep re-runs
    // PENDING and IN_PROGRESS plans, so an identical failure must land on the
    // same row rather than minting one per tick.
    const w = world();
    enableAuto();
    w.mode.addressing = 'id';

    await w.execution.executePlan('plan-1');
    await w.execution.executePlan('plan-1', { force: true });
    await w.execution.executePlan('plan-1', { force: true });

    assert.equal(w.incidents.length, 1);
    assert.equal(w.incidents[0]?.['summaryCode'], SECOND_REASON);
  });
});

// -- HALF ONE: THE PLAN'S OWN REASON REACHES THE CONTRACT -------------------

describe('lastErrorCode on the inspection contract', () => {
  it('THE PROOF: the field is on the RETURNED OBJECT, not merely written to a row', async () => {
    const w = world();
    enableAuto();
    w.mode.addressing = 'id';
    await w.execution.executePlan('plan-1');

    const result = await w.inspection.inspectSubscription('sub-1');

    assert.equal(result.deviceReductionPlans.length, 1);
    assert.equal(result.deviceReductionPlans[0]?.lastErrorCode, STALE_PANEL_LINK);
    assert.equal(
      result.deviceReductionPlans[0]?.state,
      'BLOCKED',
      'state and reason travel together -- BLOCKED alone never said WHY',
    );
  });

  it('is asked for in the SELECT, so it is not `undefined` on the wire', async () => {
    // The failure this catches is invisible to a fake that returns whole rows:
    // a mapping reading `row.lastErrorCode` off a row Prisma was never told to
    // select yields `undefined` in production and a green test everywhere else.
    // The fake here honours `select` exactly, so this is the same claim the
    // database makes.
    const w = world();
    w.plan['lastErrorCode'] = 'STILL_OVER_LIMIT';

    const result = await w.inspection.inspectSubscription('sub-1');

    assert.equal(result.deviceReductionPlans[0]?.lastErrorCode, 'STILL_OVER_LIMIT');
  });

  it('is null -- not undefined, not absent -- on a plan that has never failed', async () => {
    // A PENDING plan is the common case, and `null` is what the column holds.
    // `undefined` would vanish from the JSON body entirely and force the reader
    // to distinguish "never failed" from "field not implemented".
    const w = world();

    const result = await w.inspection.inspectSubscription('sub-1');

    const plan = result.deviceReductionPlans[0]!;
    assert.equal(plan.lastErrorCode, null);
    assert.equal('lastErrorCode' in plan, true, 'the key is present and explicitly null');
  });

  it('still returns a bounded target COUNT and no raw HWIDs', async () => {
    // The invariant the new field must not erode: the inspect view returns how
    // MANY devices a plan targets and never which.
    const w = world();
    w.plan['selectedDevices'] = [
      { hwid: 'secret-a', createdAt: daysAgo(2) },
      { hwid: 'secret-b', createdAt: daysAgo(1) },
    ];

    const result = await w.inspection.inspectSubscription('sub-1');

    assert.equal(result.deviceReductionPlans[0]?.targetCount, 2);
    assert.equal(JSON.stringify(result).includes('secret-a'), false);
  });
});
