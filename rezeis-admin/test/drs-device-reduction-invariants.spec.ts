import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { of } from 'rxjs';

import {
  DEVICE_DORMANCY_HORIZON_DAYS,
  DeviceReductionSourceError,
  DeviceRetentionConflictError,
  selectDeviceReductionTargets,
} from '../src/modules/add-on-entitlements/domain/device-reduction-selection';
import { DeviceReductionExecutionService } from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';
import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * The device-reduction staleness invariant, and the shared-panel-profile guard.
 *
 * WHAT IS BEING DEFENDED. The reduction saga deletes real customers' devices.
 * Its ordering rule - newest first - is a POLICY and is kept: you are over your
 * limit, so the registration you just added is the one refused. What it must
 * never do is destroy a registration in active use while retaining one that has
 * not been seen for a full billing period, and multiple registrations per
 * physical device are the EXPECTED state on this deployment, so that is not a
 * rare shape.
 *
 * The tests below assert WHICH device is chosen, never that a sort ran, and the
 * anti-vacuity control exists because a "fix" that simply stopped deleting
 * would otherwise satisfy every other case here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed instant for the pure tests; the executor reads the real clock. */
const NOW = Date.parse('2026-08-22T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const daysAgo = (n: number, base: number = NOW): string => iso(base - n * DAY_MS);

interface Row {
  readonly hwid: string;
  readonly createdAt: string;
  readonly lastSeenAt?: string | null;
}

/**
 * The customer from the live report, as three panel rows.
 *
 * `stale` is NOT a corrupt or phantom record - it is a perfectly genuine
 * Remnawave registration left behind by a client the customer stopped using.
 * That is why `createdAt` cannot identify it: it is simply the oldest row.
 */
const STALE: Row = {
  hwid: 'hw-stale-reinstall',
  createdAt: daysAgo(200),
  lastSeenAt: daysAgo(190),
};
const LAPTOP: Row = { hwid: 'hw-laptop', createdAt: daysAgo(104), lastSeenAt: daysAgo(1) };
const PHONE: Row = { hwid: 'hw-vivo-V2483A', createdAt: daysAgo(8), lastSeenAt: daysAgo(0) };

describe('device reduction - the staleness invariant (defect 1)', () => {
  it('A. refuses instead of destroying the phone in use to keep a row silent for 190 days', () => {
    // Before the fix this returned targets: ['hw-vivo-V2483A'] - the phone seen
    // today - and retained the laptop plus a registration last seen 190 days
    // ago. The overage is 1 and the ONLY reason there is an overage at all is
    // the stale row (see B), so the rule destroyed a live device to protect a
    // dead one.
    let thrown: unknown;
    try {
      selectDeviceReductionTargets([STALE, LAPTOP, PHONE], 2, { nowMs: NOW });
      assert.fail('selection must refuse rather than return a victim here');
    } catch (err: unknown) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof DeviceRetentionConflictError,
      `expected DeviceRetentionConflictError, got ${String(thrown)}`,
    );
    const conflict = thrown as DeviceRetentionConflictError;
    // Named precisely: the device we were about to destroy, and the one whose
    // retention made that wrong. An operator has to be able to act on this.
    assert.deepEqual(conflict.activeTargets, ['hw-vivo-V2483A']);
    assert.deepEqual(conflict.dormantRetained, ['hw-stale-reinstall']);
  });

  it('B. the same customer without the stale row is not over the limit at all', () => {
    // The load-bearing case. The deletion in A happens ONLY because the stale
    // row occupies a slot; remove it and there is nothing to reduce. Any change
    // that leaves A deleting something has to answer for this.
    const result = selectDeviceReductionTargets([LAPTOP, PHONE], 2, { nowMs: NOW });
    assert.equal(result.overage, 0);
    assert.deepEqual(result.targets, []);
    assert.deepEqual(
      result.retained.map((d) => d.hwid).sort(),
      ['hw-laptop', 'hw-vivo-V2483A'],
    );
  });

  it('C. a newly registered client that never connected is still deleted (benign, unchanged)', () => {
    // The newest row is also the least-used one: registered two days ago, never
    // seen since. Newest-first and staleness agree, and the policy applies
    // untouched - this is the case the ordering rule was written for.
    const neverUsed: Row = { hwid: 'hw-just-installed', createdAt: daysAgo(2), lastSeenAt: daysAgo(2) };
    const result = selectDeviceReductionTargets([LAPTOP, PHONE, neverUsed], 2, { nowMs: NOW });
    assert.equal(result.overage, 1);
    assert.deepEqual(result.targets.map((d) => d.hwid), ['hw-just-installed']);
    assert.deepEqual(
      result.retained.map((d) => d.hwid).sort(),
      ['hw-laptop', 'hw-vivo-V2483A'],
    );
  });

  it('D. a duplicate hwid is still refused as source data, not as a retention conflict', () => {
    // Order matters: the source-data checks run FIRST, so a list we cannot even
    // read is never re-labelled as a policy refusal.
    let thrown: unknown;
    try {
      selectDeviceReductionTargets(
        [LAPTOP, { ...LAPTOP, createdAt: daysAgo(50) }],
        1,
        { nowMs: NOW },
      );
      assert.fail('duplicate hwid must refuse');
    } catch (err: unknown) {
      thrown = err;
    }
    assert.ok(thrown instanceof DeviceReductionSourceError);
    assert.equal(thrown instanceof DeviceRetentionConflictError, false);
    assert.match((thrown as Error).message, /duplicate hwid/);
  });

  it('ANTI-VACUITY: a genuine overage with no dormant row still deletes, and deletes the newest', () => {
    // The control. Every other case here is satisfied by a "fix" that simply
    // stops deleting; this one is not. Three devices all in current use, limit
    // 2 - the reduction must still happen, and the policy (newest refused)
    // must still decide it.
    const tablet: Row = { hwid: 'hw-tablet', createdAt: daysAgo(3), lastSeenAt: daysAgo(2) };
    const result = selectDeviceReductionTargets([LAPTOP, PHONE, tablet], 2, { nowMs: NOW });
    assert.equal(result.overage, 1);
    assert.deepEqual(result.targets.map((d) => d.hwid), ['hw-tablet']);
    assert.deepEqual(
      result.retained.map((d) => d.hwid).sort(),
      ['hw-laptop', 'hw-vivo-V2483A'],
    );
  });

  it('ANTI-VACUITY: reducing to zero still deletes every device', () => {
    const result = selectDeviceReductionTargets([LAPTOP, PHONE], 0, { nowMs: NOW });
    assert.equal(result.overage, 2);
    assert.equal(result.targets.length, 2);
    assert.equal(result.retained.length, 0);
  });
});

describe('device reduction - the activity signal gate', () => {
  // The refusal reads `lastSeenAt`, which reaches us as the panel's `lastSeenAt`
  // or its `updatedAt`. Whether a Remnawave HWID row's `updatedAt` advances on
  // USE is not provable from this repository. These tests pin the behaviour for
  // the case where it does not, because getting that wrong would refuse every
  // ordinary reduction on the deployment rather than protect anybody.

  it('is inert when the panel reports no activity at all (every lastSeenAt absent)', () => {
    const rows: Row[] = [
      { hwid: 'hw-old', createdAt: daysAgo(200) },
      { hwid: 'hw-mid', createdAt: daysAgo(100) },
      { hwid: 'hw-new', createdAt: daysAgo(2) },
    ];
    const result = selectDeviceReductionTargets(rows, 2, { nowMs: NOW });
    assert.deepEqual(result.targets.map((d) => d.hwid), ['hw-new']);
  });

  it('is inert when lastSeenAt never moves off createdAt (a panel that does not track use)', () => {
    // Every row's `updatedAt` equals its `createdAt`. Reading that as activity
    // would call the 200-day-old row dormant and refuse - on EVERY customer,
    // for EVERY reduction. The gate must see that nothing moved.
    const rows: Row[] = [
      { hwid: 'hw-old', createdAt: daysAgo(200), lastSeenAt: daysAgo(200) },
      { hwid: 'hw-mid', createdAt: daysAgo(100), lastSeenAt: daysAgo(100) },
      { hwid: 'hw-new', createdAt: daysAgo(2), lastSeenAt: daysAgo(2) },
    ];
    const result = selectDeviceReductionTargets(rows, 2, { nowMs: NOW });
    assert.deepEqual(result.targets.map((d) => d.hwid), ['hw-new']);
  });

  it('does not mistake same-transaction write skew for activity', () => {
    // 30s past createdAt is under the tolerance: an insert stamping both
    // columns, not a device that came back. Still no signal, still no refusal.
    const rows: Row[] = [
      { hwid: 'hw-old', createdAt: daysAgo(200), lastSeenAt: iso(NOW - 200 * DAY_MS + 30_000) },
      { hwid: 'hw-new', createdAt: daysAgo(2), lastSeenAt: iso(NOW - 2 * DAY_MS + 30_000) },
    ];
    const result = selectDeviceReductionTargets(rows, 1, { nowMs: NOW });
    assert.deepEqual(result.targets.map((d) => d.hwid), ['hw-new']);
  });

  it('one row moving off createdAt is enough to make the whole read activity-bearing', () => {
    // The mirror of the test above: the laptop's lastSeenAt sits far past its
    // createdAt, which proves the panel does track use - so the silent row can
    // now be believed to be silent, and the refusal fires.
    assert.throws(
      () => selectDeviceReductionTargets([STALE, LAPTOP, PHONE], 2, { nowMs: NOW }),
      DeviceRetentionConflictError,
    );
  });

  it('the horizon is one billing period, and it is a real boundary at 30/31 days', () => {
    // LITERALS, not `daysAgo(DEVICE_DORMANCY_HORIZON_DAYS)`. Deriving the test
    // input from the constant under test makes the assertion move with the
    // constant: widening the horizon to 31 would keep this green while silently
    // changing which devices survive. Mutation M7 caught exactly that, so the
    // value is pinned here and the boundary is probed with fixed day counts.
    assert.equal(
      DEVICE_DORMANCY_HORIZON_DAYS,
      30,
      'one subscription period; must stay above HWID_DOWNGRADE_GRACE_DAYS = 14',
    );

    const atHorizon: Row = { hwid: 'hw-borderline', createdAt: daysAgo(300), lastSeenAt: daysAgo(30) };
    // Not dormant at exactly 30 days -> ordinary reduction, newest deleted.
    const inside = selectDeviceReductionTargets([atHorizon, PHONE], 1, { nowMs: NOW });
    assert.deepEqual(inside.targets.map((d) => d.hwid), ['hw-vivo-V2483A']);

    // 31 days -> retaining it while deleting the phone is refused.
    const past: Row = { ...atHorizon, lastSeenAt: daysAgo(31) };
    assert.throws(
      () => selectDeviceReductionTargets([past, PHONE], 1, { nowMs: NOW }),
      DeviceRetentionConflictError,
    );
  });

  it('an unparseable lastSeenAt is unknown, never dormant', () => {
    // A garbage timestamp must not be read as "never seen" - that would make a
    // contract drift delete somebody's phone.
    const rows: Row[] = [
      { hwid: 'hw-garbage', createdAt: daysAgo(200), lastSeenAt: 'not-a-date' },
      LAPTOP,
      PHONE,
    ];
    const result = selectDeviceReductionTargets(rows, 2, { nowMs: NOW });
    assert.deepEqual(result.targets.map((d) => d.hwid), ['hw-vivo-V2483A']);
  });
});

// ── the root cause: the projection that discarded the field ────────────────

function fixture(rel: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'remnawave', rel), 'utf8'));
}

function adapter(handler: () => unknown) {
  return new RemnawaveApiService(
    { request: () => handler() } as never,
    { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null } as never,
  );
}

describe('strictListUserDevices carries lastSeenAt (defect 1 root cause)', () => {
  it('2.7.4: reads the row `updatedAt` as last activity', async () => {
    const outcome = await adapter(() => of({ data: fixture('2.7.4/devices.json') }))
      .strictListUserDevices('11111111-1111-4111-8111-111111111111');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.deepEqual(
      outcome.value.devices.map((d) => [d.hwid, d.lastSeenAt]),
      [
        ['hwid-older', '2026-06-01T00:00:00.000Z'],
        ['hwid-newer', '2026-06-15T00:00:00.000Z'],
      ],
    );
  });

  it('2.8.0: reads the row `lastSeenAt`', async () => {
    const outcome = await adapter(() => of({ data: fixture('2.8.0/devices.json') }))
      .strictListUserDevices('22222222-2222-4222-8222-222222222222');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.devices[0]!.lastSeenAt, '2026-07-01T00:00:00.000Z');
  });

  it('3.2.1: reads `updatedAt`, including the row that equals its createdAt', async () => {
    const outcome = await adapter(() => of({ data: fixture('3.2.1/devices.json') }))
      .strictListUserDevices('2');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.deepEqual(
      outcome.value.devices.map((d) => [d.hwid, d.lastSeenAt]),
      [
        ['hwid-321-older', '2026-08-10T13:01:17.530Z'],
        // Registered and never touched again: updatedAt === createdAt. Carried
        // faithfully rather than normalised away - the signal gate needs to see
        // it as it is.
        ['hwid-321-newer', '2026-08-10T13:18:48.050Z'],
      ],
    );
  });

  it('a row with neither field yields null, and does NOT fail the strict read', async () => {
    // Fail-closed applies to hwid and createdAt, not to activity: a panel
    // version that never sends it must not strand every reduction.
    const outcome = await adapter(() =>
      of({ data: { response: { total: 1, devices: [{ hwid: 'a', createdAt: '2026-01-01T00:00:00Z' }] } } }),
    ).strictListUserDevices('u');
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.devices[0]!.lastSeenAt, null);
  });
});

// ── executor harness ───────────────────────────────────────────────────────

const ORIGINAL_FLAG = process.env['ADDON_DEVICE_CLEANUP_AUTO'];
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
  else process.env['ADDON_DEVICE_CLEANUP_AUTO'] = ORIGINAL_FLAG;
});

/** Panel rows as the executor sees them, against the REAL clock it reads. */
function liveRow(hwid: string, createdDaysAgo: number, seenDaysAgo: number | null): unknown {
  const now = Date.now();
  return {
    hwid,
    createdAt: daysAgo(createdDaysAgo, now),
    lastSeenAt: seenDaysAgo === null ? null : daysAgo(seenDaysAgo, now),
  };
}

function okList(...devices: unknown[]) {
  return { kind: 'ok' as const, value: { devices, total: devices.length }, detectedVersion: '2.8.0' };
}

function buildExecutor(opts: {
  selectedDevices: Array<{ hwid: string; createdAt: string }>;
  listQueue: unknown[];
  sibling?: Record<string, unknown> | null;
  planState?: string;
}) {
  const planUpdates: Array<Record<string, unknown>> = [];
  const incidents: Array<Record<string, unknown>> = [];
  const deleteCalls: string[] = [];
  const listQueue = [...opts.listQueue];

  const prisma = {
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma),
    deviceReductionPlan: {
      findUnique: async () => ({
        id: 'plan-1',
        subscriptionId: 'sub-1',
        projectionId: 'proj-1',
        projectionRevision: 4n,
        desiredLimit: 2,
        state: opts.planState ?? 'PENDING',
        startedAt: null,
        selectedDevices: opts.selectedDevices,
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        planUpdates.push(args.data);
        return {};
      },
      updateMany: async (args: { data: Record<string, unknown> }) => {
        planUpdates.push(args.data);
        return { count: 1 };
      },
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => ({ desiredRevision: 4n, desiredDeviceLimit: 2 }),
    },
    subscription: {
      findUnique: async () => ({
        remnawaveId: 'rem-1',
        remnawavePanelId: 4711,
        remnawavePanelUsername: 'rz_alice_sub',
        configUrl: null,
        status: 'ACTIVE',
      }),
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
    strictListUserDevices: async () =>
      listQueue.length > 0 ? listQueue.shift() : okList(liveRow('hw-laptop', 104, 1)),
    strictDeleteUserDevice: async (_ref: unknown, hwid: string) => {
      deleteCalls.push(hwid);
      return { kind: 'ok', value: { total: 1 }, detectedVersion: '2.8.0' };
    },
  };
  const boundary = {
    completeVerifiedDeviceExpiryInTransaction: async () => ({
      status: 'COMPLETED' as const,
      completed: 1,
    }),
  };
  const service = new DeviceReductionExecutionService(
    prisma as never,
    remnawave as never,
    boundary as never,
  );
  return { service, planUpdates, incidents, deleteCalls };
}

describe('device reduction executor - the invariant guards an already-persisted plan', () => {
  it('BLOCKS without deleting when a persisted target is in use and a retained row is dormant', async () => {
    // The plan was built BEFORE this rule existed, so it still names the phone.
    // Its targets are immutable and are not re-chosen here - the executor
    // refuses at the last gate before the delete instead.
    process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
    const live = [
      liveRow('hw-stale-reinstall', 200, 190),
      liveRow('hw-laptop', 104, 1),
      liveRow('hw-vivo-V2483A', 8, 0),
    ];
    const { service, deleteCalls, planUpdates, incidents } = buildExecutor({
      selectedDevices: [{ hwid: 'hw-vivo-V2483A', createdAt: daysAgo(8) }],
      listQueue: [okList(...live), okList(...live)],
    });

    const outcome = await service.executePlan('plan-1');

    assert.equal(outcome.status, 'BLOCKED');
    assert.deepEqual(deleteCalls, [], 'not one device may be deleted');
    const blocked = planUpdates.find((d) => d.state === 'BLOCKED');
    assert.notEqual(blocked, undefined);
    assert.equal(blocked?.lastErrorCode, 'DORMANT_RETENTION_CONFLICT');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.summaryCode, 'DORMANT_RETENTION_CONFLICT');
  });

  it('ANTI-VACUITY: the same executor still deletes when no retained row is dormant', async () => {
    // Identical wiring, one fact changed: the third row was seen this week. The
    // guard must let this through and the device must actually be deleted.
    process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
    const live = [
      liveRow('hw-tablet', 200, 3),
      liveRow('hw-laptop', 104, 1),
      liveRow('hw-vivo-V2483A', 8, 0),
    ];
    const { service, deleteCalls } = buildExecutor({
      selectedDevices: [{ hwid: 'hw-vivo-V2483A', createdAt: daysAgo(8) }],
      listQueue: [okList(...live), okList(liveRow('hw-tablet', 200, 3), liveRow('hw-laptop', 104, 1))],
    });

    const outcome = await service.executePlan('plan-1');

    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, ['hw-vivo-V2483A']);
  });
});

describe('device reduction executor - a shared panel profile (defect 2)', () => {
  const SIBLING = { id: 'sub-2-twin' };

  it('SUPERSEDES without deleting when a second subscription owns the same panel profile', async () => {
    process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
    const live = [liveRow('hw-a', 100, 1), liveRow('hw-b', 50, 1), liveRow('hw-c', 10, 1)];
    const { service, deleteCalls, planUpdates } = buildExecutor({
      selectedDevices: [{ hwid: 'hw-c', createdAt: daysAgo(10) }],
      listQueue: [okList(...live), okList(...live)],
      sibling: SIBLING,
    });

    const outcome = await service.executePlan('plan-1');

    assert.equal(outcome.status, 'SUPERSEDED');
    // The whole point: no read-back can prove whose devices these are, so none
    // of them may be removed.
    assert.deepEqual(deleteCalls, [], 'a shared profile must lose no devices');
    const superseded = planUpdates.find((d) => d.state === 'SUPERSEDED');
    assert.notEqual(superseded, undefined);
    assert.equal(superseded?.lastErrorCode, 'PANEL_PROFILE_SHARED');
  });

  it('raises a CRITICAL incident, unlike a relink, which stays silent', async () => {
    process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
    const live = [liveRow('hw-a', 100, 1), liveRow('hw-b', 50, 1), liveRow('hw-c', 10, 1)];
    const { service, incidents } = buildExecutor({
      selectedDevices: [{ hwid: 'hw-c', createdAt: daysAgo(10) }],
      listQueue: [okList(...live), okList(...live)],
      sibling: SIBLING,
    });

    await service.executePlan('plan-1');

    assert.equal(incidents.length, 1, 'the operator has to be told this deployment has twins');
    assert.equal(incidents[0]!.kind, 'DEVICE_REDUCTION_BLOCKED');
    assert.equal(incidents[0]!.severity, 'CRITICAL');
    assert.equal(incidents[0]!.summaryCode, 'PANEL_PROFILE_SHARED');
  });

  it('fires on the OPERATOR OVERRIDE too, which bypasses the rollout flag entirely', async () => {
    // The reachable path: `deviceCleanupAuto` is off by default, but
    // `approveDevicePlan` calls `executePlan(id, { force: true })`, which skips
    // the flag. A guard that only ran under the flag would guard nothing here.
    delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
    const live = [liveRow('hw-a', 100, 1), liveRow('hw-b', 50, 1), liveRow('hw-c', 10, 1)];
    const { service, deleteCalls, incidents } = buildExecutor({
      selectedDevices: [{ hwid: 'hw-c', createdAt: daysAgo(10) }],
      listQueue: [okList(...live), okList(...live)],
      sibling: SIBLING,
      planState: 'BLOCKED',
    });

    const outcome = await service.executePlan('plan-1', { force: true });

    assert.equal(outcome.status, 'SUPERSEDED');
    assert.deepEqual(deleteCalls, []);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.summaryCode, 'PANEL_PROFILE_SHARED');
  });

  it('ANTI-VACUITY: with no sibling the same override deletes the planned target', async () => {
    delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
    const live = [liveRow('hw-a', 100, 1), liveRow('hw-b', 50, 1), liveRow('hw-c', 10, 1)];
    const { service, deleteCalls } = buildExecutor({
      selectedDevices: [{ hwid: 'hw-c', createdAt: daysAgo(10) }],
      listQueue: [okList(...live), okList(liveRow('hw-a', 100, 1), liveRow('hw-b', 50, 1))],
      sibling: null,
      planState: 'BLOCKED',
    });

    const outcome = await service.executePlan('plan-1', { force: true });

    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(deleteCalls, ['hw-c']);
  });
});

// ── the planner: no plan is persisted for an operator to approve ───────────

describe('device reduction planner - refuses and raises an incident (defect 1)', () => {
  function buildPlanner(devices: unknown[]) {
    const incidents: Array<Record<string, unknown>> = [];
    const upserts: unknown[] = [];
    const prisma = {
      subscriptionEffectiveProjection: {
        findUnique: async () => ({ id: 'proj-1', desiredRevision: 4n, desiredDeviceLimit: 2 }),
      },
      subscription: {
        findUnique: async () => ({
          remnawaveId: 'rem-1',
          remnawavePanelId: 4711,
          remnawavePanelUsername: 'rz_alice_sub',
          configUrl: null,
          status: 'ACTIVE',
        }),
      },
      deviceReductionPlan: {
        upsert: async (args: unknown) => {
          upserts.push(args);
          return { id: 'plan-new' };
        },
      },
      entitlementIncident: {
        upsert: async (args: { create: Record<string, unknown> }) => {
          incidents.push(args.create);
          return { id: 'inc-1' };
        },
      },
    };
    const remnawave = {
      strictListUserDevices: async () => okList(...devices),
    };
    return {
      service: new DeviceReductionPlanService(prisma as never, remnawave as never),
      incidents,
      upserts,
    };
  }

  it('persists NO plan when the selection would destroy a device in use', async () => {
    // Planning is not flag-gated: the boundary scheduler builds and persists a
    // plan whenever a device-slot entitlement expires, and the operator
    // override can then run it with one click. Refusing HERE means there is
    // nothing to click.
    const { service, incidents, upserts } = buildPlanner([
      liveRow('hw-stale-reinstall', 200, 190),
      liveRow('hw-laptop', 104, 1),
      liveRow('hw-vivo-V2483A', 8, 0),
    ]);

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(outcome.status === 'BLOCKED' ? outcome.reason : null, 'DORMANT_RETENTION_CONFLICT');
    assert.deepEqual(upserts, [], 'no plan may be persisted for an operator to approve');
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.summaryCode, 'DORMANT_RETENTION_CONFLICT');
    assert.equal(incidents[0]!.severity, 'WARNING');
  });

  it('ANTI-VACUITY: an ordinary overage still produces a plan with the right target', async () => {
    const { service, incidents, upserts } = buildPlanner([
      liveRow('hw-tablet', 200, 3),
      liveRow('hw-laptop', 104, 1),
      liveRow('hw-vivo-V2483A', 8, 0),
    ]);

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    assert.equal(incidents.length, 0);
    assert.equal(upserts.length, 1);
    const created = (upserts[0] as { create: { selectedDevices: Array<{ hwid: string }> } }).create;
    assert.deepEqual(created.selectedDevices.map((d) => d.hwid), ['hw-vivo-V2483A']);
  });
});
