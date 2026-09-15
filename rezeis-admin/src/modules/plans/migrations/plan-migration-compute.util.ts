import {
  PlanAvailability,
  PlanType,
  Prisma,
  SubscriptionStatus,
  TrafficLimitStrategy,
} from '@prisma/client';

import { GIB_BYTES } from '../../add-on-entitlements/domain/cutover-baseline';
import {
  PLAN_INHERITED_LIMIT_KEYS,
  resolveInheritedPlanLimitRefresh,
  resolvePlanLimitOwnership,
  withRecordedDevices,
  withRecordedTraffic,
  type PlanInheritedLimitKey,
  type PlanLimitOwnership,
  type RecordedAddOnContribution,
} from '../../subscriptions/services/plan-inherited-limits.util';
import { displayPlanName } from '../utils/plan-deletion.util';
import { sameSquadSet } from '../utils/plan-squads.util';
import type { PlanMigrationWarningCode } from './plan-migration.codes';

/**
 * WHAT MOVING ONE SUBSCRIPTION FROM PLAN P TO PLAN Q DOES TO IT — COMPUTED ONCE.
 *
 * The preview (`POST …/migrations/preview`) and the move itself
 * (`PlanMigrationMoveService`) both call {@link computePlanMigration}. A dry run
 * computed by a second function is a promise the move does not have to keep, so
 * there is no second function: the preview is this call without the write.
 *
 * ── The limits, per field (owner decision 7) ─────────────────────────────────
 *
 * Ownership is the renewal's own reader, `resolvePlanLimitOwnership`, over the
 * subscription's CURRENT columns and snapshot — i.e. relative to P:
 *
 *   INHERITED    the column still equals what P gave → it takes Q's value,
 *                through `resolveInheritedPlanLimitRefresh`, the SAME call a
 *                renewal makes, so the recorded add-on share rides on top
 *                exactly as it does there;
 *   OVERRIDDEN   an operator set it by hand → the column is KEPT ("INDIVIDUAL"
 *                on the wire);
 *   UNDECIDABLE  nothing can tell (an imported row, a snapshot without the key)
 *                → it takes Q's value too ("UNKNOWN" on the wire). A renewal
 *                leaves such a column alone; a move is the operator deciding the
 *                subscription now belongs to Q, and the owner chose Q's value.
 *                The add-on share is kept with the same helpers the refresh uses.
 *
 * Bonus top-ups (promocode, quest, referral points) re-declare the raised value
 * in the snapshot (`patchSnapshotNumeric` at every reward site), so they read
 * INHERITED and take Q's value — which is precisely what a renewal does to
 * them: a top-up is for the current period, not a permanent individual limit.
 *
 * ── The snapshot ─────────────────────────────────────────────────────────────
 *
 * Merged, never rebuilt: see {@link buildMigratedPlanSnapshot}. A limit key that
 * takes Q's value (INHERITED or UNKNOWN) records Q's value, so it reads
 * INHERITED from Q afterwards. A key kept INDIVIDUAL keeps its OLD snapshot
 * value — what P gave — and that is what keeps it individual: ownership is
 * derived from "column differs from snapshot", the column is unchanged, and the
 * old snapshot value already differed from it. Writing Q's value there instead
 * would silently hand the field back to the plan whenever the operator's value
 * happens to equal Q's: the next edit of Q, carried by a renewal, would then
 * overwrite the operator's number and push it to the panel.
 */

/** Ownership as the wire reports it. */
export type MigrationOwnership = 'INHERITED' | 'INDIVIDUAL' | 'UNKNOWN';

/** The four limit columns plus the trial flag, as the subscription row holds them. */
export interface MigrationLimitValues {
  /** Whole GiB; `null` is unlimited. */
  readonly trafficLimit: number | null;
  /** `<= 0` is unlimited. */
  readonly deviceLimit: number;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  readonly isTrial: boolean;
}

/** The target plan's fields a move reads. */
export interface MigrationTargetPlan {
  readonly id: string;
  readonly name: string;
  readonly deletedAt: Date | null;
  readonly description: string | null;
  readonly tag: string | null;
  readonly type: PlanType;
  readonly icon: string | null;
  readonly availability: PlanAvailability;
  readonly trialSettings: Prisma.JsonValue;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategy;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

/** The subscription's fields a move reads. */
export interface MigrationSubscriptionState {
  readonly status: SubscriptionStatus;
  readonly isTrial: boolean;
  readonly remnawaveId: string | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  readonly planSnapshot: Prisma.JsonValue;
}

export interface MigrationOwnershipView {
  readonly trafficLimit: MigrationOwnership;
  readonly deviceLimit: MigrationOwnership;
  /** Both squad fields folded into one (INDIVIDUAL wins, then UNKNOWN). */
  readonly squads: MigrationOwnership;
  /** The two squad fields as the resolver decides them — it decides them apart. */
  readonly internalSquads: MigrationOwnership;
  readonly externalSquad: MigrationOwnership;
}

export type MigrationKeptField = 'trafficLimit' | 'deviceLimit' | 'squads';

export type MigrationLimitChanges = Partial<
  Record<PlanInheritedLimitKey, { readonly from: unknown; readonly to: unknown }>
>;

export interface PlanMigrationComputation {
  readonly ownership: MigrationOwnershipView;
  readonly before: MigrationLimitValues;
  /**
   * What the row holds after the move when it has no ACTIVE durable term. With
   * one, the numeric columns are the recomputed projection's
   * ({@link numericColumnsFromProjection}); squads and the trial flag are these.
   */
  readonly after: MigrationLimitValues;
  readonly kept: readonly MigrationKeptField[];
  /** The same verdict per column: the limit keys the operator owns and the move keeps. */
  readonly individualKeys: readonly PlanInheritedLimitKey[];
  readonly warnings: readonly PlanMigrationWarningCode[];
  /** Linked and ACTIVE/LIMITED: the only rows a move pushes to Remnawave now. */
  readonly pushesToRemnawave: boolean;
  /** The `planSnapshot` to write. */
  readonly planSnapshot: Record<string, unknown>;
  /** Only the limit keys whose value changes, as the limits audit row lists them. */
  readonly limitChanges: MigrationLimitChanges;
}

const PUSHABLE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.LIMITED,
]);

/** Linked and ACTIVE or LIMITED — decision 9's "gets a Remnawave push now". */
export function pushesToRemnawave(subscription: {
  readonly status: SubscriptionStatus;
  readonly remnawaveId: string | null;
}): boolean {
  return subscription.remnawaveId !== null && PUSHABLE_STATUSES.has(subscription.status);
}

export function toWireOwnership(value: PlanLimitOwnership): MigrationOwnership {
  if (value === 'OVERRIDDEN') return 'INDIVIDUAL';
  if (value === 'UNDECIDABLE') return 'UNKNOWN';
  return 'INHERITED';
}

function foldSquadOwnership(
  internal: MigrationOwnership,
  external: MigrationOwnership,
): MigrationOwnership {
  if (internal === external) return internal;
  if (internal === 'INDIVIDUAL' || external === 'INDIVIDUAL') return 'INDIVIDUAL';
  if (internal === 'UNKNOWN' || external === 'UNKNOWN') return 'UNKNOWN';
  return 'INHERITED';
}

function ownershipView(
  ownership: Readonly<Record<PlanInheritedLimitKey, PlanLimitOwnership>>,
): MigrationOwnershipView {
  const internalSquads = toWireOwnership(ownership.internalSquads);
  const externalSquad = toWireOwnership(ownership.externalSquad);
  return {
    trafficLimit: toWireOwnership(ownership.trafficLimit),
    deviceLimit: toWireOwnership(ownership.deviceLimit),
    squads: foldSquadOwnership(internalSquads, externalSquad),
    internalSquads,
    externalSquad,
  };
}

/**
 * Ownership of a subscription's limits relative to the plan it is on now — the
 * listing's column, with no target in view. The same reader, the same recorded
 * add-on share, so the listing and the preview cannot disagree about a row.
 */
export function describeMigrationOwnership(
  subscription: MigrationSubscriptionState,
  recorded: RecordedAddOnContribution,
): MigrationOwnershipView {
  return ownershipView(
    resolvePlanLimitOwnership({
      current: subscription,
      planSnapshot: subscription.planSnapshot,
      recorded,
    }).ownership,
  );
}

/** The row's current values, in the wire's shape. */
export function currentLimitValues(subscription: MigrationSubscriptionState): MigrationLimitValues {
  return {
    trafficLimit: subscription.trafficLimit,
    deviceLimit: subscription.deviceLimit,
    internalSquads: [...subscription.internalSquads],
    externalSquad: subscription.externalSquad,
    isTrial: subscription.isTrial,
  };
}

export function computePlanMigration(input: {
  readonly subscription: MigrationSubscriptionState;
  readonly target: MigrationTargetPlan;
  readonly recorded: RecordedAddOnContribution;
  /** From `resolveTargetRenewability`; false raises TARGET_NOT_RENEWABLE. */
  readonly targetRenewable: boolean;
  /**
   * A renewal payment of the subscription is in flight (decision 10) — priced
   * for the source plan, or for its replacement or a chosen plan.
   */
  readonly pendingRenewalForSource: boolean;
}): PlanMigrationComputation {
  const { subscription, target, recorded } = input;
  const before = currentLimitValues(subscription);

  // The renewal's own refresh decides INHERITED and writes those columns with
  // the recorded add-on share on top.
  const refresh = resolveInheritedPlanLimitRefresh({
    current: subscription,
    planSnapshot: subscription.planSnapshot,
    plan: target,
    recorded,
  });
  const own = refresh.ownership;

  // UNDECIDABLE takes Q's value as well (decision 7), with the same add-on
  // arithmetic the refresh applies to an INHERITED field.
  const trafficLimit =
    own.trafficLimit === 'INHERITED'
      ? (refresh.columns.trafficLimit as number | null)
      : own.trafficLimit === 'UNDECIDABLE'
        ? withRecordedTraffic(target.trafficLimit, recorded.activeTrafficContributionBytes)
        : subscription.trafficLimit;
  const deviceLimit =
    own.deviceLimit === 'INHERITED'
      ? (refresh.columns.deviceLimit as number)
      : own.deviceLimit === 'UNDECIDABLE'
        ? withRecordedDevices(target.deviceLimit, recorded.activeDeviceContribution)
        : subscription.deviceLimit;
  const internalSquads =
    own.internalSquads === 'OVERRIDDEN'
      ? [...subscription.internalSquads]
      : [...target.internalSquads];
  const externalSquad =
    own.externalSquad === 'OVERRIDDEN' ? subscription.externalSquad : target.externalSquad;

  const after: MigrationLimitValues = {
    trafficLimit,
    deviceLimit,
    internalSquads,
    externalSquad,
    // Q is never a TRIAL plan (decision 3), so a trial moved onto it becomes a
    // regular subscription, renewable at Q's prices (decision 11). Written as
    // the rule rather than as `false` so the flag can never be SET by a move.
    isTrial: subscription.isTrial && target.availability === PlanAvailability.TRIAL,
  };

  const kept: MigrationKeptField[] = [];
  if (own.trafficLimit === 'OVERRIDDEN') kept.push('trafficLimit');
  if (own.deviceLimit === 'OVERRIDDEN') kept.push('deviceLimit');
  if (own.internalSquads === 'OVERRIDDEN' || own.externalSquad === 'OVERRIDDEN') kept.push('squads');

  const limitChanges = diffLimits(before, after);
  const pushes = pushesToRemnawave(subscription);

  const warnings: PlanMigrationWarningCode[] = [];
  if (isFewerDevices(before.deviceLimit, after.deviceLimit)) warnings.push('FEWER_DEVICES');
  if (isLessTraffic(before.trafficLimit, after.trafficLimit)) warnings.push('LESS_TRAFFIC');
  if (squadsRemoved(before, after)) warnings.push('SQUADS_REMOVED');
  if (before.isTrial && !after.isTrial) warnings.push('TRIAL_BECOMES_REGULAR');
  const unknownChanged = (
    [
      ['trafficLimit', own.trafficLimit],
      ['deviceLimit', own.deviceLimit],
      ['internalSquads', own.internalSquads],
      ['externalSquad', own.externalSquad],
    ] as const
  ).some(([key, verdict]) => verdict === 'UNDECIDABLE' && limitChanges[key] !== undefined);
  if (unknownChanged) warnings.push('UNKNOWN_LIMIT_TAKES_TARGET');
  if (!input.targetRenewable) warnings.push('TARGET_NOT_RENEWABLE');
  if (input.pendingRenewalForSource) warnings.push('PENDING_RENEWAL_FOR_SOURCE');
  if (!pushes) warnings.push('LOCAL_ONLY');

  const individualKeys = PLAN_INHERITED_LIMIT_KEYS.filter((key) => own[key] === 'OVERRIDDEN');
  return {
    ownership: ownershipView(own),
    before,
    after,
    kept,
    individualKeys,
    warnings,
    pushesToRemnawave: pushes,
    planSnapshot: buildMigratedPlanSnapshot(subscription.planSnapshot, target, new Set(individualKeys)),
    limitChanges,
  };
}

/**
 * The stored snapshot with Q written over P — every other key kept.
 *
 * NOT the editor's `buildPlanSnapshot` (`users/utils/plan-snapshot.util.ts`),
 * which rebuilds ten keys from nothing and so drops what a move must keep:
 *
 *   - `selectedDurationDays` — the renewal picks its duration from it
 *     (`SubscriptionRenewalService`), so dropping it re-prices every moved
 *     subscriber on Q's SHORTEST duration;
 *   - `importRecordId` / `importedFrom` and the payment keys (`amount`,
 *     `currency`, `gatewayType`, `purchaseType`, `snapshotSource`) — history the
 *     move has no business rewriting.
 *
 * Written from Q: identity (`id`, and `planId` only where the snapshot already
 * carries it — the delete guard matches either key, so a re-imported row left
 * with `planId: P` would still count as on P), display (`name`, `description`,
 * `tag`, `type`, `icon`, `trafficLimitStrategy` — the panel push reads `tag` and
 * the strategy from here), the limit keys that take Q's value, and
 * `availability` / `trialSettings` only where present: the cabinet's free-trial
 * badge reads those two (`readSubscriptionTrialFree`) and nothing reads them when
 * absent.
 *
 * `kept` names the limit keys the operator owns (OVERRIDDEN): those keep the
 * value the stored snapshot already holds — see the file header for why that,
 * and not Q's value, is what keeps them individual. An OVERRIDDEN key is always
 * present in the stored snapshot (the resolver needs it to say OVERRIDDEN), so
 * there is always an old value to keep.
 */
export function buildMigratedPlanSnapshot(
  stored: Prisma.JsonValue,
  target: MigrationTargetPlan,
  kept: ReadonlySet<PlanInheritedLimitKey> = new Set(),
): Record<string, unknown> {
  const base =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const fromTarget: Record<PlanInheritedLimitKey, unknown> = {
    trafficLimit: target.trafficLimit,
    deviceLimit: target.deviceLimit,
    internalSquads: [...target.internalSquads],
    externalSquad: target.externalSquad,
  };
  const limits: Record<string, unknown> = {};
  for (const key of PLAN_INHERITED_LIMIT_KEYS) {
    if (kept.has(key) && Object.prototype.hasOwnProperty.call(base, key)) continue;
    limits[key] = fromTarget[key];
  }
  const next: Record<string, unknown> = {
    ...base,
    id: target.id,
    name: displayPlanName(target),
    description: target.description,
    tag: target.tag,
    type: target.type,
    icon: target.icon ?? null,
    trafficLimitStrategy: target.trafficLimitStrategy,
    ...limits,
  };
  if (Object.prototype.hasOwnProperty.call(base, 'planId')) next['planId'] = target.id;
  if (Object.prototype.hasOwnProperty.call(base, 'availability')) {
    next['availability'] = target.availability;
  }
  if (Object.prototype.hasOwnProperty.call(base, 'trialSettings')) {
    next['trialSettings'] = target.trialSettings;
  }
  return next;
}

/**
 * The numeric columns of a subscription whose ACTIVE term was rotated onto Q —
 * the recomputed projection's desired state, in the column's encoding.
 *
 * Traffic converts bytes back to whole GiB (`null` stays unlimited). Devices
 * need one decision: the projection spells unlimited `null`, and the column has
 * TWO spellings of it (`0` and `-1`). Writing `0` for a Q whose own value is
 * `-1` would leave the column disagreeing with the snapshot the move just wrote,
 * and the next ownership read would call an untouched field INDIVIDUAL. So an
 * unlimited result keeps the spelling the computation chose (Q's for a field
 * that takes Q's value, the row's own for a kept one), and falls back to `0` —
 * what every other projection mirror writes — only when that was not unlimited.
 */
export function numericColumnsFromProjection(
  projection: {
    readonly desiredTrafficLimitBytes: bigint | null;
    readonly desiredDeviceLimit: number | null;
  },
  computed: Pick<MigrationLimitValues, 'deviceLimit'>,
): { readonly trafficLimit: number | null; readonly deviceLimit: number } {
  return {
    trafficLimit:
      projection.desiredTrafficLimitBytes === null
        ? null
        : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
    deviceLimit:
      projection.desiredDeviceLimit === null
        ? computed.deviceLimit <= 0
          ? computed.deviceLimit
          : 0
        : projection.desiredDeviceLimit,
  };
}

/**
 * Before/after of only the limit keys that move; squads compared as sets.
 *
 * `excluded` drops keys whatever their values did. The move passes the keys the
 * operator owns: the limits audit row of a move (`source: 'plan_migration'`)
 * promises that every key it lists now comes from the assigned plan, and a kept
 * key can still change value when its projection recomputes against a moved add-on
 * ledger — which is not the plan giving it anything.
 */
export function diffLimits(
  before: Omit<MigrationLimitValues, 'isTrial'>,
  after: Omit<MigrationLimitValues, 'isTrial'>,
  excluded: ReadonlySet<PlanInheritedLimitKey> = new Set(),
): MigrationLimitChanges {
  const changes: { -readonly [K in PlanInheritedLimitKey]?: { from: unknown; to: unknown } } = {};
  if (!excluded.has('trafficLimit') && before.trafficLimit !== after.trafficLimit) {
    changes.trafficLimit = { from: before.trafficLimit, to: after.trafficLimit };
  }
  if (!excluded.has('deviceLimit') && before.deviceLimit !== after.deviceLimit) {
    changes.deviceLimit = { from: before.deviceLimit, to: after.deviceLimit };
  }
  if (!excluded.has('internalSquads') && !sameSquadSet(before.internalSquads, after.internalSquads)) {
    changes.internalSquads = { from: [...before.internalSquads], to: [...after.internalSquads] };
  }
  if (!excluded.has('externalSquad') && before.externalSquad !== after.externalSquad) {
    changes.externalSquad = { from: before.externalSquad, to: after.externalSquad };
  }
  return changes;
}

/** After is finite and lower than before; `<= 0` is unlimited on both sides. */
function isFewerDevices(before: number, after: number): boolean {
  if (after <= 0) return false;
  return before <= 0 || after < before;
}

/** After is finite and lower than before; `null` is unlimited on both sides. */
function isLessTraffic(before: number | null, after: number | null): boolean {
  if (after === null) return false;
  return before === null || after < before;
}

function squadsRemoved(before: MigrationLimitValues, after: MigrationLimitValues): boolean {
  const kept = new Set(after.internalSquads);
  if (before.internalSquads.some((squad) => !kept.has(squad))) return true;
  return before.externalSquad !== null && before.externalSquad !== after.externalSquad;
}
