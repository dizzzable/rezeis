import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { resolveEntitlementBaseline } from '../src/modules/add-on-entitlements/domain/entitlement-baseline';
import { BulkPlanAssignmentService } from '../src/modules/imports/services/bulk-plan-assignment.service';
import {
  NO_RECORDED_ADD_ONS,
  resolveInheritedPlanLimitRefresh,
  resolveInheritedPlanLimitUpdate,
  resolvePlanLimitOwnership,
  type PlanInheritedLimits,
  type RecordedAddOnContribution,
} from '../src/modules/subscriptions/services/plan-inherited-limits.util';
import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';

/**
 * ONE READER FOR "WHO OWNS THIS LIMIT", AND THE TWO POPULATIONS IT USED TO LOSE
 *
 * Part A — the add-on holder who stopped receiving plan edits.
 * Part B — the bulk-assigned subscriber whose plan renames never arrived.
 *
 * Both were silent, both were permanent, and neither was a reasoning error:
 * the decision each path takes is correct, and the inputs it was handed were
 * not. So every case here drives the REAL reader (or the real service) and
 * asserts on the answer a customer would receive — never on a branch or a call.
 */

const GIB = 1024n * 1024n * 1024n;

// ═══════════════════════════════════════════════════════════════════════════
// Part A — the shared ownership reader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every number is deliberately distinct from every other AND from the value
 * each specific mistake would produce, so no two contradictory outcomes can
 * satisfy the same assertion:
 *
 *   plan before            1024 GiB / 3 devices   (what the snapshot records)
 *   add-on contribution      50 GiB / 5 devices   (what the projection recorded)
 *   mirrored column        1074 GiB / 8 devices   (base + add-on)
 *   plan after the edit    2048 GiB / 9 devices
 *   correct column write   2098 GiB / 14 devices
 *
 * Subtracting nothing reads the column as 1074/8 and refuses to write at all.
 * Subtracting twice reads 974/-2 and refuses too, for a different reason.
 * Writing the plan's raw value into the column leaves 2048/9, which is the
 * customer's add-on quietly disappearing.
 */
const PLAN_TRAFFIC_AT_ASSIGNMENT = 1024;
const PLAN_DEVICES_AT_ASSIGNMENT = 3;
const ADD_ON_TRAFFIC_GIB = 50;
const ADD_ON_DEVICES = 5;
const MIRRORED_TRAFFIC_COLUMN = PLAN_TRAFFIC_AT_ASSIGNMENT + ADD_ON_TRAFFIC_GIB; // 1074
const MIRRORED_DEVICE_COLUMN = PLAN_DEVICES_AT_ASSIGNMENT + ADD_ON_DEVICES; // 8
const PLAN_TRAFFIC_AFTER_EDIT = 2048;
const PLAN_DEVICES_AFTER_EDIT = 9;

const HELD_ADD_ONS: RecordedAddOnContribution = {
  activeTrafficContributionBytes: BigInt(ADD_ON_TRAFFIC_GIB) * GIB,
  activeDeviceContribution: ADD_ON_DEVICES,
};

/** The stored snapshot of a subscriber who was never individually adjusted. */
function snapshotAtAssignment(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1',
    name: 'Starter',
    icon: 'zap',
    trafficLimitStrategy: 'NO_RESET',
    trafficLimit: PLAN_TRAFFIC_AT_ASSIGNMENT,
    deviceLimit: PLAN_DEVICES_AT_ASSIGNMENT,
    internalSquads: ['squad-a'],
    externalSquad: null,
    ...patch,
  };
}

/** The mirrored columns of that same subscriber while an add-on is live. */
function columnsWithAddOn(patch: Partial<PlanInheritedLimits> = {}): PlanInheritedLimits {
  return {
    trafficLimit: MIRRORED_TRAFFIC_COLUMN,
    deviceLimit: MIRRORED_DEVICE_COLUMN,
    internalSquads: ['squad-a'],
    externalSquad: null,
    ...patch,
  };
}

/** The plan row after the operator edited it. */
function editedPlan(patch: Partial<PlanInheritedLimits> = {}): PlanInheritedLimits {
  return {
    trafficLimit: PLAN_TRAFFIC_AFTER_EDIT,
    deviceLimit: PLAN_DEVICES_AFTER_EDIT,
    internalSquads: ['squad-a'],
    externalSquad: null,
    ...patch,
  };
}

describe('a plan edit still reaches a customer who is holding an add-on', () => {
  it('reads the mirrored column as INHERITED once the recorded contribution is removed', () => {
    // The whole defect in one case. `Subscription.trafficLimit` mirrors the
    // projection's DESIRED state, so an add-on holder's column is base + add-on
    // while the snapshot holds the plan's raw value. Compared raw they differ,
    // the renewal reads OVERRIDDEN, and from the first add-on that customer ever
    // bought no plan edit reaches them again — permanently, and invisibly, for
    // exactly the customers who paid extra.
    const refresh = resolveInheritedPlanLimitRefresh({
      current: columnsWithAddOn(),
      planSnapshot: snapshotAtAssignment(),
      plan: editedPlan(),
      recorded: HELD_ADD_ONS,
    });

    assert.equal(refresh.ownership.trafficLimit, 'INHERITED');
    assert.equal(refresh.ownership.deviceLimit, 'INHERITED');
    // The plan's own values are what the snapshot must go on recording…
    assert.equal(refresh.snapshot.trafficLimit, PLAN_TRAFFIC_AFTER_EDIT);
    assert.equal(refresh.snapshot.deviceLimit, PLAN_DEVICES_AFTER_EDIT);
    // …and the customer keeps the add-on they are still paying for.
    assert.equal(refresh.columns.trafficLimit, 2098);
    assert.equal(refresh.columns.deviceLimit, 14);
  });

  it('does not let the column write and the snapshot write become the same fragment', () => {
    // They are the same values only when nothing is recorded. With a live add-on
    // they MUST differ, and writing either one where the other belongs is a
    // permanent corruption rather than a cosmetic slip: the snapshot carrying
    // base+add-on makes the next comparison subtract a contribution that is not
    // in the baseline, and the column carrying base-only makes the next
    // projection recompute attribute the shortfall to the operator and pin it.
    const refresh = resolveInheritedPlanLimitRefresh({
      current: columnsWithAddOn(),
      planSnapshot: snapshotAtAssignment(),
      plan: editedPlan(),
      recorded: HELD_ADD_ONS,
    });

    assert.notDeepStrictEqual(refresh.columns, refresh.snapshot);
    assert.equal(
      refresh.columns.trafficLimit !== refresh.snapshot.trafficLimit,
      true,
      'the add-on share belongs in the column and never in the baseline',
    );
    assert.equal(refresh.columns.deviceLimit !== refresh.snapshot.deviceLimit, true);
  });

  it('removes the recorded contribution EXACTLY once', () => {
    // Removing it twice reads 1074 - 50 - 50 = 974, which is what THIS snapshot
    // records — so a double subtraction would report a never-adjusted subscriber
    // and hand the plan's value to a column the operator really did set.
    const refresh = resolveInheritedPlanLimitRefresh({
      current: columnsWithAddOn(),
      planSnapshot: snapshotAtAssignment({
        trafficLimit: MIRRORED_TRAFFIC_COLUMN - 2 * ADD_ON_TRAFFIC_GIB, // 974
        deviceLimit: MIRRORED_DEVICE_COLUMN - 2 * ADD_ON_DEVICES, // -2
      }),
      plan: editedPlan(),
      recorded: HELD_ADD_ONS,
    });

    assert.equal(refresh.ownership.trafficLimit, 'OVERRIDDEN');
    assert.equal('trafficLimit' in refresh.columns, false);
    assert.equal('trafficLimit' in refresh.snapshot, false);
  });

  it('leaves an operator-raised limit alone even while an add-on is live', () => {
    // The other direction, and it is not optional: subtracting the contribution
    // must not turn every add-on holder into an inherited row. 30 + 5 = 35 in the
    // column, against a snapshot of 3 — still the operator's.
    const refresh = resolveInheritedPlanLimitRefresh({
      current: columnsWithAddOn({ deviceLimit: 30 + ADD_ON_DEVICES }),
      planSnapshot: snapshotAtAssignment(),
      plan: editedPlan(),
      recorded: HELD_ADD_ONS,
    });

    assert.equal(refresh.ownership.deviceLimit, 'OVERRIDDEN');
    assert.equal('deviceLimit' in refresh.columns, false, 'a hand-set limit must survive the renewal');
  });

  it('keeps an unlimited plan unlimited — a contribution cannot make it finite', () => {
    // `addTrafficLimit` / `addDeviceLimit` treat unlimited as absorbing. Adding
    // the recorded share onto an unlimited plan value would re-create the legacy
    // `0 + N` footgun, where buying extra devices turned an unlimited profile
    // finite.
    const refresh = resolveInheritedPlanLimitRefresh({
      current: columnsWithAddOn(),
      planSnapshot: snapshotAtAssignment(),
      plan: editedPlan({ trafficLimit: null, deviceLimit: -1 }),
      recorded: HELD_ADD_ONS,
    });

    assert.equal(refresh.columns.trafficLimit, null);
    assert.equal(refresh.columns.deviceLimit, -1);
    assert.equal(refresh.snapshot.trafficLimit, null);
    assert.equal(refresh.snapshot.deviceLimit, -1);
  });

  it('is unchanged for a subscription that holds nothing', () => {
    // The no-add-on form must stay exactly what it always was, or the fix for
    // the add-on holder becomes a change for everybody else.
    const current = columnsWithAddOn({
      trafficLimit: PLAN_TRAFFIC_AT_ASSIGNMENT,
      deviceLimit: PLAN_DEVICES_AT_ASSIGNMENT,
    });
    const withoutRecord = resolveInheritedPlanLimitUpdate({
      current,
      planSnapshot: snapshotAtAssignment(),
      plan: editedPlan(),
    });
    const withEmptyRecord = resolveInheritedPlanLimitRefresh({
      current,
      planSnapshot: snapshotAtAssignment(),
      plan: editedPlan(),
      recorded: NO_RECORDED_ADD_ONS,
    });

    assert.deepStrictEqual(withoutRecord, {
      trafficLimit: PLAN_TRAFFIC_AFTER_EDIT,
      deviceLimit: PLAN_DEVICES_AFTER_EDIT,
      internalSquads: ['squad-a'],
      externalSquad: null,
    });
    assert.deepStrictEqual(withEmptyRecord.columns, withoutRecord);
    assert.deepStrictEqual(withEmptyRecord.snapshot, withoutRecord);
  });
});

// ── The same subtraction, seen from the projection side ────────────────────

describe('the projection baseline removes the recorded contribution exactly once', () => {
  const TERM = { baseTrafficLimitBytes: 100n * GIB, baseDeviceLimit: 3 };

  it('reaches the term baseline, and neither the un-subtracted nor the twice-subtracted column', () => {
    // 20 devices in the column, 5 recorded, 15 in the snapshot. Subtract once and
    // the row is INHERITED so the paid term governs (3). Subtract nothing and it
    // reads OVERRIDDEN at 20; subtract twice and it reads OVERRIDDEN at 10. Three
    // distinct answers, so no two mistakes can satisfy the same assertion.
    const baseline = resolveEntitlementBaseline({
      term: TERM,
      subscription: {
        trafficLimit: MIRRORED_TRAFFIC_COLUMN,
        deviceLimit: 20,
        planSnapshot: snapshotAtAssignment({ deviceLimit: 15 }),
      },
      recorded: HELD_ADD_ONS,
    });

    assert.deepStrictEqual([...baseline.overriddenKeys], []);
    assert.equal(baseline.baseDeviceLimit, 3);
    assert.notEqual(baseline.baseDeviceLimit, 20, 'the contribution was never taken out of the column');
    assert.notEqual(baseline.baseDeviceLimit, 10, 'the contribution was taken out twice');
    assert.equal(baseline.baseTrafficLimitBytes, 100n * GIB);
  });

  it('still attributes a genuinely operator-set column to the operator', () => {
    const baseline = resolveEntitlementBaseline({
      term: TERM,
      subscription: {
        trafficLimit: MIRRORED_TRAFFIC_COLUMN,
        deviceLimit: 30 + ADD_ON_DEVICES,
        planSnapshot: snapshotAtAssignment(),
      },
      recorded: HELD_ADD_ONS,
    });

    assert.deepStrictEqual([...baseline.overriddenKeys], ['deviceLimit']);
    assert.equal(baseline.baseDeviceLimit, 30, 'the operator owns 30; the add-on layers on top of it');
  });
});

// ── UNDECIDABLE is a third state, not a synonym for OVERRIDDEN ─────────────

describe('an unreadable snapshot is UNDECIDABLE and not OVERRIDDEN', () => {
  /** An imported row: a snapshot that carries none of the four limit keys. */
  const unreadableLimits = { id: 'plan-1', trafficLimitStrategy: 'NO_RESET' };

  it('names the third state explicitly', () => {
    const { ownership } = resolvePlanLimitOwnership({
      current: { trafficLimit: 100, deviceLimit: 2, internalSquads: [], externalSquad: null },
      planSnapshot: unreadableLimits,
    });

    assert.equal(ownership.trafficLimit, 'UNDECIDABLE');
    assert.equal(ownership.deviceLimit, 'UNDECIDABLE');
    assert.notEqual(ownership.deviceLimit, 'OVERRIDDEN');
  });

  it('lets an imported customer buy the upgrade they paid for', () => {
    // This is what the distinction BUYS, and why collapsing the two states is a
    // regression even where no renewal changes. Resolving an unreadable snapshot
    // toward the COLUMN would mean an imported subscriber could buy a plan
    // change, be charged, and stay on the old limits with nothing to show for it.
    const baseline = resolveEntitlementBaseline({
      term: { baseTrafficLimitBytes: 500n * GIB, baseDeviceLimit: 7 },
      subscription: { trafficLimit: 100, deviceLimit: 2, planSnapshot: unreadableLimits },
      recorded: NO_RECORDED_ADD_ONS,
    });

    assert.deepStrictEqual([...baseline.overriddenKeys], []);
    assert.equal(baseline.baseDeviceLimit, 7, 'the paid term must govern an UNDECIDABLE row');
    assert.notEqual(baseline.baseDeviceLimit, 2, 'collapsing UNDECIDABLE into OVERRIDDEN pins the old limit');
    assert.equal(baseline.baseTrafficLimitBytes, 500n * GIB);
  });

  it('reads as OVERRIDDEN the moment the snapshot actually carries the key', () => {
    // The control for the case above: a verdict of UNDECIDABLE everywhere would
    // satisfy it just as well, and that would hand every operator override back
    // to the plan.
    const { ownership } = resolvePlanLimitOwnership({
      current: { trafficLimit: 100, deviceLimit: 2, internalSquads: [], externalSquad: null },
      planSnapshot: { ...unreadableLimits, deviceLimit: 7 },
    });

    assert.equal(ownership.deviceLimit, 'OVERRIDDEN');
  });

  it('is invisible to the renewal, which is why a green renewal suite cannot guard it', () => {
    // Both states leave the column alone, so the renewal fragment is identical
    // for either. The three-way answer has to be asserted where the two states
    // DISAGREE — on what a paid term is worth — or nothing guards it at all.
    const undecidable = resolveInheritedPlanLimitUpdate({
      current: { trafficLimit: 100, deviceLimit: 2, internalSquads: [], externalSquad: null },
      planSnapshot: unreadableLimits,
      plan: editedPlan(),
    });
    const overridden = resolveInheritedPlanLimitUpdate({
      current: { trafficLimit: 100, deviceLimit: 2, internalSquads: [], externalSquad: null },
      planSnapshot: { ...unreadableLimits, deviceLimit: 7 },
      plan: editedPlan(),
    });

    assert.equal('deviceLimit' in undecidable, false);
    assert.equal('deviceLimit' in overridden, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Part B — the bulk-assigned subscriber the plan-rename mirror could not see
// ═══════════════════════════════════════════════════════════════════════════

const ASSIGNED_PLAN = {
  id: 'plan-bulk-1',
  name: 'Original name',
  tag: null,
  type: 'BOTH',
  icon: 'rocket',
  trafficLimit: 250,
  deviceLimit: 4,
  trafficLimitStrategy: 'NO_RESET',
  internalSquads: ['squad-bulk'],
  externalSquad: null,
  isActive: true,
  durations: [{ days: 30 }],
} as const;

const RENAMED_PLAN = {
  ...ASSIGNED_PLAN,
  name: 'Renamed on the invoice',
  tag: 'PROMO',
  type: 'UNLIMITED',
  trafficLimitStrategy: 'MONTH',
};

/** Runs the REAL bulk assignment over one imported subscription. */
async function runBulkAssignment(
  storedSnapshot: unknown,
): Promise<{ readonly written: Record<string, unknown> | null; readonly skippedAlreadyAssigned: number }> {
  const updates: Array<Record<string, unknown>> = [];
  const service = new BulkPlanAssignmentService(
    {
      plan: { findUnique: async () => ASSIGNED_PLAN },
      subscription: {
        findMany: async () => [
          {
            id: 'sub-bulk-1',
            status: SubscriptionStatus.ACTIVE,
            remnawaveId: 'panel-1',
            planSnapshot: storedSnapshot,
          },
        ],
        update: async (args: { readonly data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
      },
      profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
    } as never,
    { enqueue: async () => undefined } as never,
  );

  const result = await service.assignPlan({
    planId: ASSIGNED_PLAN.id,
    userIds: ['user-1'],
    createdBy: 'admin-1',
  });
  const written = updates[0]?.['planSnapshot'];
  return {
    written: written === undefined ? null : (written as Record<string, unknown>),
    skippedAlreadyAssigned: result.skippedAlreadyAssigned,
  };
}

/**
 * Runs the REAL `PlanSnapshotSyncService` over one stored snapshot, applying the
 * service's OWN selection predicate.
 *
 * The JSON key and the bound plan id are read out of the `Prisma.Sql` the
 * service builds, not restated here: this is the seam the defect lived in, and a
 * double that returned the row unconditionally would report a pass for a
 * snapshot the real query can never match.
 */
async function runPlanRename(
  storedSnapshot: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const written: Array<Record<string, unknown>> = [];
  let selectedOn: string | null = null;
  const matched = await new PlanSnapshotSyncService().syncPlanSnapshotMetadata(
    {
      $queryRaw: async (query: { readonly strings?: readonly string[]; readonly values?: readonly unknown[] }) => {
        const text = (query.strings ?? []).join('?');
        const key = /plan_snapshot"?\s*->>\s*'([^']+)'/.exec(text)?.[1] ?? null;
        selectedOn = key;
        assert.ok(key !== null, 'the sync must still select subscribers by a plan_snapshot JSON key');
        const wanted = (query.values ?? [])[0];
        return storedSnapshot[key] === wanted
          ? [{ id: 'sub-bulk-1', planSnapshot: storedSnapshot }]
          : [];
      },
      subscription: {
        update: async (args: { readonly data: { readonly planSnapshot: Record<string, unknown> } }) => {
          written.push(args.data.planSnapshot);
          return null;
        },
      },
    } as never,
    RENAMED_PLAN as never,
  );

  assert.equal(selectedOn, 'id', 'the canonical plan-id key on a subscription snapshot is `id`');
  assert.equal(matched, written.length);
  return written[0] ?? null;
}

describe('a bulk-assigned subscription still receives its plan renames', () => {
  it('is found by the plan-rename mirror, and its display keys move with the plan', async () => {
    // The writer emitted only `planId`, while `PlanSnapshotSyncService` selects
    // on `plan_snapshot->>'id'`. So a bulk-assigned row matched nothing: a
    // renamed plan kept showing its old name on the cabinet card, in the bot and
    // on every invoice, forever, for every subscription assigned in bulk.
    const assignment = await runBulkAssignment({ importedFrom: 'stealthnet', importRecordId: 'imp-1' });
    assert.ok(assignment.written !== null, 'the imported subscription must have been assigned');
    assert.equal(assignment.written['id'], ASSIGNED_PLAN.id);

    const renamed = await runPlanRename(assignment.written);

    assert.ok(renamed !== null, 'a bulk-assigned subscriber must be reachable by a plan rename');
    assert.equal(renamed['name'], RENAMED_PLAN.name);
    assert.equal(renamed['tag'], RENAMED_PLAN.tag);
    assert.equal(renamed['type'], RENAMED_PLAN.type);
    assert.equal(renamed['trafficLimitStrategy'], RENAMED_PLAN.trafficLimitStrategy);
    // …and the four limit keys stay frozen at what the assignment gave them, or
    // every bulk-assigned subscriber reads as OVERRIDDEN from the first rename.
    assert.equal(renamed['trafficLimit'], ASSIGNED_PLAN.trafficLimit);
    assert.equal(renamed['deviceLimit'], ASSIGNED_PLAN.deviceLimit);
  });

  it('keeps the import-domain planId marker, so a second run still skips an assigned row', async () => {
    // `planId` is NOT a duplicate of `id` to be tidied away. It is what
    // `isImportedOrUnassigned` tests, and it is the ONLY key the altshop and
    // remnashop importers carry across a re-import — dropping it would let a
    // re-import silently unlink the plan and a re-run re-plan a subscription an
    // operator already assigned.
    const first = await runBulkAssignment({ importedFrom: 'stealthnet' });
    assert.ok(first.written !== null);
    assert.equal(first.written['planId'], ASSIGNED_PLAN.id);

    const second = await runBulkAssignment(first.written);

    assert.equal(second.written, null, 'an already-assigned subscription must not be re-planned');
    assert.equal(second.skippedAlreadyAssigned, 1);
  });
});
