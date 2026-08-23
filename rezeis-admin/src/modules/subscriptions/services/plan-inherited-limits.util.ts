import { GIB_BYTES } from '../../add-on-entitlements/domain/cutover-baseline';
import { sameSquadSet } from '../../plans/utils/plan-squads.util';

/**
 * Which `Subscription` columns a plan hands down — and how to tell, at renewal
 * time, whether an operator has since set one of them by hand.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Individual configuration and billing are separate concerns. An operator can
 * raise ONE customer's device limit from the admin Users page while that
 * customer keeps being billed for the tariff plan. Before this reader existed
 * the payment renewal path re-applied the plan's four limit columns
 * unconditionally, so the hand-set value reverted on the customer's next
 * payment — and the `profileSyncJob` enqueued in the same transaction then
 * PUSHED the reverted value into the Remnawave panel, so the customer
 * genuinely lost the devices rather than merely displaying the wrong number.
 *
 * ── The rule, per field ───────────────────────────────────────────────────
 *
 * `Subscription.planSnapshot` records what the plan gave this subscription, so
 * "individually overridden" is derivable without storing anything new:
 *
 *   column === snapshot   INHERITED   → adopt the plan's value, so an operator
 *                                       editing the plan still reaches everyone
 *                                       who was never individually adjusted.
 *   column !== snapshot   OVERRIDDEN  → leave the column alone.
 *   snapshot unreadable   UNDECIDABLE → leave the column alone.
 *
 * UNDECIDABLE covers legacy rows whose `planSnapshot` is absent, empty,
 * malformed, or simply predates one of these keys. It resolves toward
 * PRESERVING on purpose: wiping is the destructive direction, and it is the one
 * that reaches a paying customer through the panel push.
 *
 * ── "column" means the BASE, not the mirror — read this before comparing ──
 *
 * `Subscription.trafficLimit` / `deviceLimit` mirror the projection's DESIRED
 * state (`SubscriptionEffectiveProjection.desired*`), which is
 * `base + every ACTIVE add-on`. Every writer that touches a projection mirrors
 * it back into those columns: `applyAddOnViaLedger`, the upgrade path when a
 * projection already exists, the boundary sweep, `forceReconcile` and
 * `reverseEntitlement`.
 *
 * So on a subscription holding a live add-on the column is NOT the plan's
 * value, and comparing it raw reads every add-on holder as OVERRIDDEN. That
 * defect was real and silent: from the first add-on a customer bought, no
 * future plan edit ever reached them again — permanently, and for exactly the
 * customers who had paid extra. {@link resolvePlanLimitOwnership} therefore
 * subtracts the contribution the projection LAST RECORDED before comparing, and
 * both the renewal reader here and
 * `add-on-entitlements/domain/entitlement-baseline.ts` are written on top of
 * it, so the subtraction exists ONCE and cannot drift between them.
 *
 * The quantity to subtract is `SubscriptionEffectiveProjection`'s
 * `activeTrafficContributionBytes` / `activeDeviceContribution` for this
 * subscription, with `?? 0` when there is no projection row yet — the same
 * `?? 0` `EffectiveProjectionService.recomputeInTransaction` uses. Read it
 * through `resolveRecordedAddOnContribution`
 * (`add-on-entitlements/services/configured-baseline.util.ts`); a second
 * derivation of the same number is the failure mode this file exists to avoid.
 *
 * It is the PREVIOUS row's contribution on purpose: the columns were mirrored
 * from that row, so it is the only quantity that can legitimately be taken back
 * out of them. When an add-on has since expired the stale share is removed, the
 * remainder matches the snapshot again, and the column returns to tracking the
 * plan — which is how genuinely drifted columns still get corrected.
 *
 * ── The rejected third state, and why ─────────────────────────────────────
 *
 * "The snapshot is absent ENTIRELY" was considered as a third state, distinct
 * from "the snapshot exists and disagrees": a row that never carried a snapshot
 * arguably has no inheritance to protect, so the renewal could just apply the
 * plan the customer is paying for on this very transaction. That reading has a
 * real cost on the other side and it was NOT taken:
 *
 *  - The rows with no readable snapshot are dominated by IMPORTED and legacy
 *    rows (`remnawave-importer`, `altshop-importer`, `threexui-importer`,
 *    stealthnet). Their columns were seeded from the donor panel, and they are
 *    the rows an operator is most likely to have hand-tuned afterwards. Applying
 *    the plan to them re-creates, for exactly that population, the defect this
 *    reader exists to fix — silently, and pushed to the panel.
 *  - The two harms are not symmetric. Preserving can leave a customer on a
 *    smaller limit than the plan they just renewed; that is visible, and an
 *    operator fixes it from the Users page, or the next plan assignment /
 *    upgrade applies the plan unconditionally. Applying takes working service
 *    away from a customer who had it, with no signal to anyone.
 *
 * The consequence is deliberate and is pinned by
 * "preserves even when the paid plan is MORE generous" in
 * `test/subscription-plan-inherited-limits.spec.ts`. It is ONE branch — the
 * `snapshot === null` arm of {@link resolvePlanLimitOwnership} — if the owner
 * decides a renewal should raise a snapshot-less row to the plan it is paying
 * for.
 *
 * Comparison is per-field and type-correct. `internalSquads` is an array and is
 * compared as an unordered set of values — comparing by reference or by JSON
 * string would make a harmless reordering read as an override forever, which
 * silently freezes plan updates for everyone holding that plan.
 *
 * ── The freeze this branch depends on — do not undo it ────────────────────
 *
 * `PlanSnapshotSyncService.syncPlanSnapshotMetadata`
 * (`src/modules/subscriptions/services/plan-snapshot-sync.service.ts`) USED to
 * rewrite these same four keys into every subscriber's `planSnapshot` on each
 * plan edit while deliberately leaving the columns untouched. One plan edit
 * therefore moved the baseline out from under every subscriber at once: their
 * columns still held the old value, so all of them read as OVERRIDDEN here and
 * their limits were pinned for good. It mirrors only the display fields now
 * (`name`, `tag`, `type`, `trafficLimitStrategy`), which is what restores the
 * snapshot's meaning — the plan AT ASSIGNMENT — and makes the INHERITED branch
 * behave as documented. Anything that starts mirroring the four again silently
 * re-pins every subscriber.
 *
 * The one writer that legitimately moves a snapshot's squad keys after
 * assignment is `PlanSquadPropagationService.propagateInTransaction`
 * (`src/modules/plans/services/plan-squad-propagation.service.ts`): it writes
 * the plan's new squads into the subscription's COLUMNS, so it patches the same
 * two snapshot keys in the same write — otherwise the row it just corrected
 * would read as squad-overridden here and no renewal would ever touch its
 * squads again.
 *
 * ── Contract with the snapshot WRITERS ────────────────────────────────────
 *
 * Every writer of `Subscription.planSnapshot` must record all four keys, or an
 * override becomes undecidable here and the column freezes. There are three,
 * and they are intentionally separate functions:
 *
 *   - `buildPlanSnapshot` in `src/modules/users/utils/plan-snapshot.util.ts`
 *   - `buildPlanSnapshot` (file-local) and `buildItemPlanSnapshot` in
 *     `src/modules/payments/services/payment-subscription-mutation.service.ts`
 *
 * `test/subscription-plan-inherited-limits.spec.ts` fails if any of them stops
 * writing any of `PLAN_INHERITED_LIMIT_KEYS`.
 */

/**
 * The `Subscription` columns that are inherited from the `Plan` unless an
 * operator individually overrides them.
 */
export const PLAN_INHERITED_LIMIT_KEYS = [
  'trafficLimit',
  'deviceLimit',
  'internalSquads',
  'externalSquad',
] as const;

export type PlanInheritedLimitKey = (typeof PLAN_INHERITED_LIMIT_KEYS)[number];

/** The four values, as they appear on a `Subscription` row and on a `Plan`. */
export interface PlanInheritedLimits {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

/**
 * The four values as a caller may know them. A key that is ABSENT is a question
 * the caller is not asking, or a value that could not be read.
 */
export type PartialPlanInheritedLimits = Partial<PlanInheritedLimits>;

/**
 * A Prisma update fragment carrying ONLY the fields that must be refreshed
 * from the plan. A field that is overridden or undecidable is absent, and an
 * absent key leaves the column untouched.
 */
export interface PlanInheritedLimitUpdate {
  trafficLimit?: number | null;
  deviceLimit?: number;
  internalSquads?: string[];
  externalSquad?: string | null;
}

/** Who owns a single inherited-limit field on one subscription. */
export type PlanLimitOwnership = 'INHERITED' | 'OVERRIDDEN' | 'UNDECIDABLE';

/**
 * What the LAST projection recompute recorded as the live add-on share of this
 * subscription's limit columns, in the projection's own units.
 *
 * Read it with `resolveRecordedAddOnContribution`
 * (`add-on-entitlements/services/configured-baseline.util.ts`) — never by
 * re-deriving it from the ledger, and never as a hard zero when a projection
 * row might exist.
 */
export interface RecordedAddOnContribution {
  readonly activeTrafficContributionBytes: bigint;
  readonly activeDeviceContribution: number;
}

/** A subscription with no projection row, or none whose add-ons are live. */
export const NO_RECORDED_ADD_ONS: RecordedAddOnContribution = {
  activeTrafficContributionBytes: 0n,
  activeDeviceContribution: 0,
};

export interface PlanLimitOwnershipResult {
  /** The three-way verdict, for every one of the four keys. */
  readonly ownership: Readonly<Record<PlanInheritedLimitKey, PlanLimitOwnership>>;
  /**
   * The subscription's own limits with the recorded add-on contribution taken
   * back out — the values the verdict above was reached on.
   *
   * A key is ABSENT exactly when the column could not be read as "a legal
   * baseline plus exactly the recorded contribution", which is one of the ways
   * a field lands on UNDECIDABLE. `undefined` is never a legal value for any of
   * the four, so absence is unambiguous.
   */
  readonly base: PartialPlanInheritedLimits;
}

type Baseline<T> = { readonly decided: true; readonly value: T } | { readonly decided: false };

const UNDECIDED = { decided: false } as const;

type LimitBuilder = { -readonly [K in keyof PlanInheritedLimits]?: PlanInheritedLimits[K] };

function readSnapshotObject(snapshot: unknown): Record<string, unknown> | null {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  return snapshot as Record<string, unknown>;
}

/** Does the stored snapshot carry this key at all? Presence only — no compare. */
function snapshotCarriesKey(snapshot: Record<string, unknown>, key: PlanInheritedLimitKey): boolean {
  return Object.prototype.hasOwnProperty.call(snapshot, key);
}

/** `trafficLimit` is a nullable integer; `null` means unlimited and IS a value. */
function readNullableIntBaseline(
  snapshot: Record<string, unknown>,
  key: string,
): Baseline<number | null> {
  const raw = snapshot[key];
  if (raw === null) return { decided: true, value: null };
  if (typeof raw === 'number' && Number.isInteger(raw)) return { decided: true, value: raw };
  return UNDECIDED;
}

/** `deviceLimit` is a non-nullable integer (`<= 0` is the unlimited convention). */
function readIntBaseline(snapshot: Record<string, unknown>, key: string): Baseline<number> {
  const raw = snapshot[key];
  if (typeof raw === 'number' && Number.isInteger(raw)) return { decided: true, value: raw };
  return UNDECIDED;
}

/** `externalSquad` is a nullable string; `null` means "no external squad". */
function readNullableStringBaseline(
  snapshot: Record<string, unknown>,
  key: string,
): Baseline<string | null> {
  const raw = snapshot[key];
  if (raw === null) return { decided: true, value: null };
  if (typeof raw === 'string') return { decided: true, value: raw };
  return UNDECIDED;
}

/** `internalSquads` is a string array; an empty array IS a value, not "absent". */
function readStringArrayBaseline(
  snapshot: Record<string, unknown>,
  key: string,
): Baseline<readonly string[]> {
  const raw = snapshot[key];
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return { decided: true, value: raw as readonly string[] };
  }
  return UNDECIDED;
}

/**
 * The subscription's own limits with the add-on contribution the projection
 * LAST RECORDED removed, expressed in the plan's units so they can be compared
 * with the stored snapshot.
 *
 * A numeric field is OMITTED when the column cannot be read as "a legal
 * baseline plus exactly the recorded contribution" — a device column at or
 * below the contribution, or a traffic column that is not a whole number of GiB
 * above it. An omitted field is a question nobody can answer, so it lands on
 * UNDECIDABLE rather than having a number invented for it.
 *
 * The two resources are encoded DIFFERENTLY and that is not an accident to be
 * tidied away: `deviceLimit <= 0` is the product's canonical unlimited (the
 * panel, sharing detection and the devices UI all agree), while for traffic
 * `null` is unlimited and `0` is a real, finite budget of zero gigabytes.
 * Unlimited absorbs on both, so no contribution is ever embedded in one, and
 * the column passes through untouched.
 *
 * Squads carry no contribution — nothing in the catalogue grants a squad — so
 * they pass through as they are.
 */
function readLimitsBeforeAddOns(
  current: PlanInheritedLimits,
  recorded: RecordedAddOnContribution,
): PartialPlanInheritedLimits {
  const base: LimitBuilder = {};

  if (current.trafficLimit === null) {
    // Unlimited is absorbing, so no contribution is embedded in it.
    base.trafficLimit = null;
  } else if (Number.isInteger(current.trafficLimit) && current.trafficLimit >= 0) {
    const remaining =
      BigInt(current.trafficLimit) * GIB_BYTES - recorded.activeTrafficContributionBytes;
    if (remaining >= 0n && remaining % GIB_BYTES === 0n) {
      base.trafficLimit = Number(remaining / GIB_BYTES);
    }
  }

  if (Number.isInteger(current.deviceLimit)) {
    if (current.deviceLimit <= 0) {
      // `<= 0` is the product's canonical unlimited; nothing is embedded in it.
      // The column passes through UNCHANGED rather than being normalised to 0:
      // an unlimited PLAN is stored as `-1` in both the column and the snapshot,
      // which is the overwhelmingly common shape, and normalising one side of
      // that comparison would read every unlimited subscriber as OVERRIDDEN.
      base.deviceLimit = current.deviceLimit;
    } else {
      const remaining = current.deviceLimit - recorded.activeDeviceContribution;
      // A finite device baseline is >= 1 by the same convention, so anything
      // lower is not a decomposition — it is an unreadable column.
      if (remaining >= 1) base.deviceLimit = remaining;
    }
  }

  base.internalSquads = current.internalSquads;
  base.externalSquad = current.externalSquad;

  return base;
}

/**
 * The three-way ownership verdict for all four inherited-limit fields — the ONE
 * place the rule is computed.
 *
 * `planSnapshot` is the subscription's CURRENT stored snapshot; read it before
 * the same update overwrites it. `recorded` is the add-on contribution the
 * PREVIOUS projection row carries (see the note at the top of this file); omit
 * it only for a subscription that provably holds none, such as a caller asking
 * about squads alone.
 *
 * OVERRIDDEN and UNDECIDABLE are deliberately DISTINCT and must stay so. They
 * agree about the renewal — both leave the column alone — but they disagree
 * about what a PAID term is worth: `entitlement-baseline.ts` resolves
 * UNDECIDABLE toward the PLAN, because otherwise an imported subscriber with an
 * unreadable snapshot could buy an upgrade, be charged, and stay on the old
 * limits. Collapsing the two is a regression even where no renewal changes.
 */
export function resolvePlanLimitOwnership(input: {
  readonly current: PlanInheritedLimits;
  readonly planSnapshot: unknown;
  readonly recorded?: RecordedAddOnContribution;
}): PlanLimitOwnershipResult {
  const recorded = input.recorded ?? NO_RECORDED_ADD_ONS;
  const base = readLimitsBeforeAddOns(input.current, recorded);
  const snapshot = readSnapshotObject(input.planSnapshot);

  // No readable snapshot object at all: every field is undecidable, which is
  // what makes every column survive a renewal untouched.
  const ownership: Record<PlanInheritedLimitKey, PlanLimitOwnership> = {
    trafficLimit: 'UNDECIDABLE',
    deviceLimit: 'UNDECIDABLE',
    internalSquads: 'UNDECIDABLE',
    externalSquad: 'UNDECIDABLE',
  };
  if (snapshot === null) return { ownership, base };

  // Per field: equal to a READABLE snapshot value ⇒ INHERITED. Otherwise only
  // the key's PRESENCE separates "the operator moved it" from "nothing here can
  // answer the question".
  const ownTraffic = base.trafficLimit;
  if (ownTraffic !== undefined) {
    const stored = readNullableIntBaseline(snapshot, 'trafficLimit');
    ownership.trafficLimit =
      stored.decided && stored.value === ownTraffic
        ? 'INHERITED'
        : snapshotCarriesKey(snapshot, 'trafficLimit')
          ? 'OVERRIDDEN'
          : 'UNDECIDABLE';
  }

  const ownDevice = base.deviceLimit;
  if (ownDevice !== undefined) {
    const stored = readIntBaseline(snapshot, 'deviceLimit');
    ownership.deviceLimit =
      stored.decided && stored.value === ownDevice
        ? 'INHERITED'
        : snapshotCarriesKey(snapshot, 'deviceLimit')
          ? 'OVERRIDDEN'
          : 'UNDECIDABLE';
  }

  // `sameSquadSet` (`plans/utils/plan-squads.util.ts`) — the same comparison the
  // plan validators and the squad propagation fan-out use, so a reordered but
  // untouched squad list is not mistaken for an operator override here while
  // being treated as unchanged there. Comparing by index or by
  // `JSON.stringify` would pin this column for the rest of the subscription's
  // life after a harmless reordering.
  const ownSquads = base.internalSquads;
  if (ownSquads !== undefined) {
    const stored = readStringArrayBaseline(snapshot, 'internalSquads');
    ownership.internalSquads =
      stored.decided && sameSquadSet([...stored.value], ownSquads)
        ? 'INHERITED'
        : snapshotCarriesKey(snapshot, 'internalSquads')
          ? 'OVERRIDDEN'
          : 'UNDECIDABLE';
  }

  const ownExternal = base.externalSquad;
  if (ownExternal !== undefined) {
    const stored = readNullableStringBaseline(snapshot, 'externalSquad');
    ownership.externalSquad =
      stored.decided && stored.value === ownExternal
        ? 'INHERITED'
        : snapshotCarriesKey(snapshot, 'externalSquad')
          ? 'OVERRIDDEN'
          : 'UNDECIDABLE';
  }

  return { ownership, base };
}

/**
 * Writes ONE inherited-limit key into a stored `planSnapshot`, leaving every
 * other key untouched.
 *
 * This is how a caller that moves a limit column says "and this is still what
 * the plan gave them" — which {@link resolvePlanLimitOwnership} then reads as
 * INHERITED, so the next renewal re-applies the plan and the change does not
 * outlive it. A caller that moves a column WITHOUT calling this is declaring an
 * operator override that survives renewals forever; both are legitimate, but
 * the choice must be deliberate.
 *
 * `null` is a real value for `trafficLimit` (unlimited), so it is accepted.
 */
export function patchSnapshotNumeric(
  snapshot: unknown,
  key: 'trafficLimit' | 'deviceLimit',
  value: number | null,
): Record<string, unknown> {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { [key]: value };
  }
  return { ...(snapshot as Record<string, unknown>), [key]: value };
}

/**
 * The two fragments a renewal needs, which are NOT the same fragment when the
 * subscription holds an add-on.
 *
 * `snapshot` carries the PLAN's own values — that is what the stored
 * `planSnapshot` means, and it is the baseline the next comparison runs
 * against. `columns` carries the same fields with the recorded add-on
 * contribution added back on, because the limit COLUMNS mirror the projection's
 * desired state (`base + active add-ons`), not the base.
 *
 * Writing one where the other belongs is not cosmetic. Put `columns` in the
 * snapshot and the next comparison subtracts the contribution from a baseline
 * that already excludes it, reading the row as OVERRIDDEN forever. Put
 * `snapshot` in the columns and the customer's paid add-on silently disappears
 * from the mirrored column, and the NEXT projection recompute then subtracts
 * the contribution a second time and pins the operator baseline that much
 * lower — permanently.
 */
export interface PlanInheritedLimitRefresh {
  /** Write into the `Subscription` limit columns. */
  readonly columns: PlanInheritedLimitUpdate;
  /** Re-declare in the stored `planSnapshot`. */
  readonly snapshot: PlanInheritedLimitUpdate;
  /** The verdict each fragment was built from. */
  readonly ownership: Readonly<Record<PlanInheritedLimitKey, PlanLimitOwnership>>;
}

/** Unlimited absorbs — `addTrafficLimit` cannot make an unlimited budget finite. */
function withRecordedTraffic(planTrafficLimit: number | null, contributionBytes: bigint): number | null {
  if (planTrafficLimit === null) return null;
  if (contributionBytes <= 0n) return planTrafficLimit;
  // Unreachable while the field is INHERITED — the decomposition above already
  // required the column to sit a whole number of GiB above the contribution —
  // but a fractional GiB has no representation in this column, so it is refused
  // rather than rounded into the customer's limit.
  if (contributionBytes % GIB_BYTES !== 0n) return planTrafficLimit;
  return planTrafficLimit + Number(contributionBytes / GIB_BYTES);
}

/** `<= 0` is the canonical unlimited device limit, and it absorbs too. */
function withRecordedDevices(planDeviceLimit: number, contribution: number): number {
  if (planDeviceLimit <= 0) return planDeviceLimit;
  if (!Number.isInteger(contribution) || contribution <= 0) return planDeviceLimit;
  return planDeviceLimit + contribution;
}

/**
 * Decides, field by field, which of the four inherited limit columns a renewal
 * may refresh from the plan, and returns BOTH writes it implies — see
 * {@link PlanInheritedLimitRefresh} for why they differ.
 *
 * Overridden and undecidable fields are absent from both fragments, which
 * leaves those columns exactly as the operator (or a legacy import) left them.
 */
export function resolveInheritedPlanLimitRefresh(input: {
  readonly current: PlanInheritedLimits;
  readonly planSnapshot: unknown;
  readonly plan: PlanInheritedLimits;
  readonly recorded?: RecordedAddOnContribution;
}): PlanInheritedLimitRefresh {
  const recorded = input.recorded ?? NO_RECORDED_ADD_ONS;
  const { ownership } = resolvePlanLimitOwnership({
    current: input.current,
    planSnapshot: input.planSnapshot,
    recorded,
  });

  const columns: PlanInheritedLimitUpdate = {};
  const snapshot: PlanInheritedLimitUpdate = {};

  if (ownership.trafficLimit === 'INHERITED') {
    snapshot.trafficLimit = input.plan.trafficLimit;
    columns.trafficLimit = withRecordedTraffic(
      input.plan.trafficLimit,
      recorded.activeTrafficContributionBytes,
    );
  }

  if (ownership.deviceLimit === 'INHERITED') {
    snapshot.deviceLimit = input.plan.deviceLimit;
    columns.deviceLimit = withRecordedDevices(
      input.plan.deviceLimit,
      recorded.activeDeviceContribution,
    );
  }

  // Squads are MEMBERSHIP, not a quantity: nothing in the catalogue grants one,
  // so there is no contribution to add back and the two fragments agree.
  if (ownership.internalSquads === 'INHERITED') {
    snapshot.internalSquads = [...input.plan.internalSquads];
    columns.internalSquads = [...input.plan.internalSquads];
  }

  if (ownership.externalSquad === 'INHERITED') {
    snapshot.externalSquad = input.plan.externalSquad;
    columns.externalSquad = input.plan.externalSquad;
  }

  return { columns, snapshot, ownership };
}

/**
 * The no-add-on form of {@link resolveInheritedPlanLimitRefresh}: one fragment,
 * because with nothing recorded the column write and the snapshot write are the
 * same values.
 *
 * It deliberately does NOT accept a `RecordedAddOnContribution`. A caller that
 * has one must take both fragments and write each where it belongs; letting a
 * contribution in here would make it possible to spread ONE of them into both
 * places, which is the exact corruption {@link PlanInheritedLimitRefresh}
 * documents.
 */
export function resolveInheritedPlanLimitUpdate(input: {
  readonly current: PlanInheritedLimits;
  readonly planSnapshot: unknown;
  readonly plan: PlanInheritedLimits;
}): PlanInheritedLimitUpdate {
  return resolveInheritedPlanLimitRefresh(input).columns;
}
