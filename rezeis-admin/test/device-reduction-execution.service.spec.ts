import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { DeviceReductionExecutionService } from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';
import {
  panelUserAddress,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';

const ORIGINAL_FLAG = process.env['ADDON_DEVICE_CLEANUP_AUTO'];
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
  else process.env['ADDON_DEVICE_CLEANUP_AUTO'] = ORIGINAL_FLAG;
});
function enableAuto(): void {
  process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
}

function okList(...hwids: string[]) {
  return {
    kind: 'ok' as const,
    value: { devices: hwids.map((hwid) => ({ hwid, createdAt: '2026-01-01T00:00:00Z' })), total: hwids.length },
    detectedVersion: '2.8.0',
  };
}

/**
 * A subscription row as Prisma returns it once the guard's select asks for the
 * panel identity.
 *
 * Both supplementary columns are populated by DEFAULT: every supported panel
 * version carries a numeric `id` and a `username` on every user row, so both
 * are recorded when the profile is linked. Omitting them from the fake would
 * hide the case this saga is most exposed to — it deletes, and an identity it
 * cannot name is an identity it cannot verify a delete against.
 */
function subscriptionRow(patch: Record<string, unknown> = {}) {
  return {
    remnawaveId: 'rem-1',
    remnawavePanelId: 4711,
    remnawavePanelUsername: 'rz_alice_sub',
    status: 'ACTIVE',
    ...patch,
  };
}

interface Opts {
  plan?: Record<string, unknown> | null;
  projection?: { desiredRevision: bigint; desiredDeviceLimit: number | null } | null;
  subscription?: Record<string, unknown> | null;
  subscriptionQueue?: Array<Record<string, unknown> | null>;
  /** A second non-deleted subscription sharing this panel profile, or none. */
  sibling?: Record<string, unknown> | null;
  listQueue?: unknown[];
  deleteResults?: unknown[];
  completionOutcome?: { readonly status: 'COMPLETED' | 'SUPERSEDED'; readonly completed: number };
}

function build(opts: Opts = {}) {
  const planUpdates: Array<Record<string, unknown>> = [];
  const incidents: Array<Record<string, unknown>> = [];
  const deleteCalls: string[] = [];
  const panelRefs: unknown[] = [];
  const completedSubscriptions: string[] = [];
  const completionRevisions: bigint[] = [];
  const listQueue = [...(opts.listQueue ?? [])];
  const deleteResults = [...(opts.deleteResults ?? [])];

  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    deviceReductionPlan: {
      findUnique: async () =>
        opts.plan === undefined
          ? {
              id: 'plan-1',
              subscriptionId: 'sub-1',
              projectionId: 'proj-1',
              projectionRevision: 4n,
              desiredLimit: 1,
              state: 'PENDING',
              selectedDevices: [{ hwid: 'new', createdAt: '2026-06-01T00:00:00Z' }],
            }
          : opts.plan,
      update: async (args: { data: Record<string, unknown> }) => {
        planUpdates.push(args.data);
        return {};
      },
    },
    subscriptionEffectiveProjection: {
      findUnique: async () =>
        opts.projection === undefined
          ? { desiredRevision: 4n, desiredDeviceLimit: 1 }
          : opts.projection,
    },
    subscription: {
      // A queue when a test needs the row to CHANGE between the guard taken
      // before the loop and the re-guard taken inside it — the only way to
      // express a concurrent relink, which is a different event from a delete
      // or a revision bump and has its own supersede reason.
      findUnique: async () => {
        if (opts.subscriptionQueue !== undefined) {
          return opts.subscriptionQueue.shift() ?? subscriptionRow();
        }
        return opts.subscription === undefined ? subscriptionRow() : opts.subscription;
      },
      // A SIBLING lookup: `loadGuard` asks, on every pass, whether a second
      // non-deleted subscription points at the same panel profile. `null` is
      // "no twin", the ordinary case these tests are about; the shared-profile
      // case is driven explicitly in drs-device-reduction-invariants.spec.ts.
      findFirst: async () => opts.sibling ?? null,
    },
    entitlementIncident: {
      upsert: async (args: { create: Record<string, unknown> }) => {
        incidents.push(args.create);
        return { id: 'inc-1' };
      },
    },
  };

  const remnawave = {
    strictListUserDevices: async (ref: unknown) => {
      panelRefs.push(ref);
      return listQueue.length > 0 ? listQueue.shift() : okList('old');
    },
    strictDeleteUserDevice: async (ref: unknown, hwid: string) => {
      panelRefs.push(ref);
      deleteCalls.push(hwid);
      return deleteResults.length > 0 ? deleteResults.shift() : { kind: 'ok', value: { total: 1 }, detectedVersion: '2.8.0' };
    },
  };

  const completion = {
    completeVerifiedDeviceExpiryInTransaction: async (
      _tx: unknown,
      subscriptionId: string,
      projectionRevision: bigint,
    ) => {
      completedSubscriptions.push(subscriptionId);
      completionRevisions.push(projectionRevision);
      return opts.completionOutcome ?? { status: 'COMPLETED', completed: 1 };
    },
  };
  const service = new DeviceReductionExecutionService(
    prisma as never,
    remnawave as never,
    completion as never,
  );
  return {
    service,
    planUpdates,
    incidents,
    deleteCalls,
    panelRefs,
    completedSubscriptions,
    completionRevisions,
  };
}

describe('DeviceReductionExecutionService (T-011c)', () => {
  it('is a no-op when the deviceCleanupAuto flag is off', async () => {
    const { service, planUpdates, deleteCalls } = build();
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'AUTO_DISABLED');
    assert.equal(planUpdates.length, 0);
    assert.equal(deleteCalls.length, 0);
  });

  it('deletes the planned target and marks APPLIED when the final count is within the limit', async () => {
    enableAuto();
    const { service, planUpdates, deleteCalls, completedSubscriptions } = build({
      // initial list (overage), post-delete final read-back within limit
      listQueue: [okList('old', 'new'), okList('old')],
      deleteResults: [{ kind: 'ok', value: { total: 1 }, detectedVersion: '2.8.0' }],
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, ['new']);
    assert.equal(planUpdates.some((d) => d.state === 'IN_PROGRESS'), true);
    assert.equal(planUpdates.some((d) => d.state === 'APPLIED'), true);
    assert.deepStrictEqual(completedSubscriptions, ['sub-1']);
  });

  it('supersedes instead of applying when the completion fence observes a newer projection', async () => {
    enableAuto();
    const { service, planUpdates, completedSubscriptions, completionRevisions } = build({
      listQueue: [okList('old'), okList('old')],
      completionOutcome: { status: 'SUPERSEDED', completed: 0 },
    });

    const outcome = await service.executePlan('plan-1');

    assert.equal(outcome.status, 'SUPERSEDED');
    assert.deepStrictEqual(completedSubscriptions, ['sub-1']);
    assert.deepStrictEqual(completionRevisions, [4n]);
    assert.equal(planUpdates.some((data) => data.state === 'APPLIED'), false);
    assert.equal(planUpdates.some((data) => data.state === 'SUPERSEDED'), true);
  });

  it('marks SUPERSEDED when the projection revision advanced past the plan', async () => {
    enableAuto();
    const { service, planUpdates, deleteCalls } = build({
      projection: { desiredRevision: 9n, desiredDeviceLimit: 1 },
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'SUPERSEDED');
    assert.deepEqual(deleteCalls, []);
    assert.equal(planUpdates.some((d) => d.state === 'SUPERSEDED'), true);
  });

  it('marks SUPERSEDED when the profile is RELINKED mid-saga, without touching the old one', async () => {
    // The gap the other supersede checks leave open. `loadGuard` reports a
    // relinked subscription as a perfectly healthy `ok` — it only refuses a
    // DELETED subscription, an advanced revision, a relaxed limit and a
    // DETACHED (null) profile. So the loop used to keep addressing the profile
    // the plan was built against: the wrong profile loses devices, and the
    // read-back then blesses a limit that was never applied to the live one.
    enableAuto();
    const { service, planUpdates, deleteCalls } = build({
      subscriptionQueue: [
        subscriptionRow(),
        // A relink between the guard and the first delete: same subscription,
        // different panel profile.
        subscriptionRow({ remnawaveId: 'rem-2', remnawavePanelId: 5122, remnawavePanelUsername: 'rz_alice_sub_2' }),
      ],
    });

    const outcome = await service.executePlan('plan-1');

    assert.equal(outcome.status, 'SUPERSEDED');
    assert.deepEqual(deleteCalls, [], 'not one device may be removed from either profile');
    const superseded = planUpdates.find((d) => d.state === 'SUPERSEDED');
    assert.notEqual(superseded, undefined);
    // A distinct reason, not folded into the generic one: an operator reading
    // the plan has to be able to tell a relink from a revision bump.
    assert.equal(superseded?.lastErrorCode, 'PANEL_PROFILE_RELINKED');
  });

  it('marks SUPERSEDED when the subscription was deleted (profile DELETE priority)', async () => {
    enableAuto();
    const { service, deleteCalls } = build({ subscription: subscriptionRow({ status: 'DELETED' }) });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'SUPERSEDED');
    assert.deepEqual(deleteCalls, []);
  });

  it('addresses every panel call with the recorded numeric id when the stored id is a stale 2.x uuid', async () => {
    // The upgraded-panel case: created on 2.x, panel now 3.x, uuid destroyed by
    // the panel's own migration. Each pass re-reads the row, so the identity has
    // to survive the guard — a delete addressed by the dead uuid would fail
    // validation and strand the saga short of the limit it was built to restore.
    enableAuto();
    const staleUuid = '330f2b38-1362-46ab-b5c0-dea32167eff9';
    const { service, deleteCalls, panelRefs } = build({
      subscription: subscriptionRow({ remnawaveId: staleUuid, remnawavePanelId: 8123 }),
      listQueue: [okList('old', 'new'), okList('old')],
      deleteResults: [{ kind: 'ok', value: { total: 1 }, detectedVersion: '3.2.1' }],
    });

    const outcome = await service.executePlan('plan-1');

    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, ['new']);
    // List, delete and the final read-back all carry the full identity — the
    // delete included, which is the one that destroys something.
    assert.equal(panelRefs.length, 3);
    for (const ref of panelRefs) {
      assert.deepStrictEqual(ref, {
        remnawaveId: staleUuid,
        panelId: 8123,
        panelUsername: 'rz_alice_sub',
      });
      assert.deepStrictEqual(panelUserAddress(ref as StoredPanelIdentity, 'id'), {
        kind: 'ready',
        segment: '8123',
      });
    }
  });

  it('DEFERS without deleting when the panel is unavailable', async () => {
    enableAuto();
    const { service, deleteCalls } = build({ listQueue: [{ kind: 'unavailable', retryAfterMs: null }] });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'DEFERRED');
    assert.deepEqual(deleteCalls, []);
  });

  it('stops early (converged) when the current overage is already gone', async () => {
    enableAuto();
    const { service, deleteCalls, planUpdates } = build({
      // already within limit at execution time
      listQueue: [okList('old'), okList('old')],
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, [], 'nothing to delete when already within limit');
    assert.equal(planUpdates.some((d) => d.state === 'APPLIED'), true);
  });

  it('skips a target already absent from the panel (idempotent) without deleting', async () => {
    enableAuto();
    const { service, deleteCalls } = build({
      // target "new" is not in the list; still over limit via two other rows
      plan: {
        id: 'plan-1', subscriptionId: 'sub-1', projectionId: 'proj-1', projectionRevision: 4n,
        desiredLimit: 1, state: 'PENDING',
        selectedDevices: [{ hwid: 'new', createdAt: '2026-06-01T00:00:00Z' }],
      },
      listQueue: [okList('old', 'other'), okList('old', 'other')],
    });
    const outcome = await service.executePlan('plan-1');
    // target absent → not deleted; final still over → remediation
    assert.deepEqual(deleteCalls, []);
    assert.equal(outcome.status, 'REMEDIATION_REQUIRED');
  });

  it('BLOCKS and raises an incident on an invalid-contract device list', async () => {
    enableAuto();
    const { service, incidents, planUpdates } = build({
      listQueue: [{ kind: 'invalidContract', details: 'total mismatch' }],
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.kind, 'DEVICE_REDUCTION_BLOCKED');
    assert.equal(planUpdates.some((d) => d.state === 'BLOCKED'), true);
  });

  it('requires remediation when targets are exhausted but still over the limit', async () => {
    enableAuto();
    const { service, incidents } = build({
      // delete succeeds but final read-back still over the limit
      listQueue: [okList('old', 'new'), okList('old', 'extra')],
      deleteResults: [{ kind: 'ok', value: { total: 2 }, detectedVersion: '2.8.0' }],
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'REMEDIATION_REQUIRED');
    assert.equal(incidents.length, 1);
  });

  it('skips a plan that is already terminal (APPLIED)', async () => {
    enableAuto();
    const { service, deleteCalls } = build({
      plan: { id: 'plan-1', state: 'APPLIED', subscriptionId: 'sub-1', projectionRevision: 4n, desiredLimit: 1, selectedDevices: [] },
    });
    const outcome = await service.executePlan('plan-1');
    assert.equal(outcome.status, 'SKIPPED');
    assert.deepEqual(deleteCalls, []);
  });
});
