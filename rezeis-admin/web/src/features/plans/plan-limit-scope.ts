/**
 * Works out whether a plan edit changes the traffic / device limits, and in
 * which direction — so the editor can tell the operator WHEN that change
 * reaches people who already bought the plan.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Editing a plan's limits does not touch existing subscribers' panel limits.
 * `PlanSnapshotSyncService` writes the new numbers into each subscription's
 * `plan_snapshot` JSON, but every path that actually pushes to Remnawave reads
 * somewhere else: the legacy processor reads the subscription's own columns,
 * the versioned one reads `SubscriptionEffectiveProjection`, whose base comes
 * from a `subscription_terms` row frozen at term creation. None of those is
 * written by a plan edit, and no scheduler re-derives them. The new limits land
 * at the subscriber's next renewal or upgrade, both of which re-read the live
 * plan row.
 *
 * That deferral is deliberate — the same rule `BulkPlanAssignmentService`
 * states and `bulk-assign-plan-dialog` already shows. What was missing is any
 * statement of it at the point where an operator changes a limit, which is what
 * turned a rule into a surprise.
 *
 * ── Why a module and not an inline expression ─────────────────────────────
 *
 * Two traps make the "did it change, and which way" question worth isolating
 * and testing:
 *
 *  1. **0 means unlimited**, for both fields (`planForm.unlimitedHint`, and
 *     `plan-form-schema` maps `trafficLimitGB === 0` to `trafficLimit: null`).
 *     So 50 → 0 is a RAISE and 0 → 50 is a CUT. A plain numeric comparison gets
 *     both backwards, which would print the reassuring copy over a cut.
 *  2. **The plan type overrides the fields.** The backend's
 *     `normalizePlanWriteInput` forces traffic to unlimited for `DEVICES`,
 *     devices to unlimited for `TRAFFIC`, and both for `UNLIMITED` — so
 *     switching the type is itself a limit change even though neither number
 *     was touched. {@link normalizePlanLimits} mirrors that rule; keep the two
 *     in step.
 */

/** Sentinel the plan editor and the API both use for "no cap". */
const UNLIMITED = 0

const INTEGER_PATTERN = /^\d+$/

export type PlanLimitField = 'traffic' | 'device'

/** Which way the operator moved a limit, with `0` read as infinity. */
export type PlanLimitDirection = 'raise' | 'cut'

export interface PlanLimitChange {
  readonly field: PlanLimitField
  /** `0` means unlimited — the caller formats it. */
  readonly from: number
  readonly to: number
  readonly direction: PlanLimitDirection
}

export interface PlanLimitScopeInput {
  /**
   * False while creating a plan. A plan that has never been saved has no
   * subscribers, so there is nothing to defer and nothing to say.
   */
  readonly isSavedPlan: boolean
  readonly savedType: string
  readonly draftType: string
  readonly savedTrafficLimitGB: string
  readonly draftTrafficLimitGB: string
  readonly savedDeviceLimit: string
  readonly draftDeviceLimit: string
}

/**
 * Mirrors the backend's `normalizePlanWriteInput` type-driven overrides, so a
 * type switch is compared on the limits that will actually be persisted rather
 * than on the numbers still sitting in the (hidden) inputs.
 */
export function normalizePlanLimits(
  type: string,
  trafficLimitGB: number,
  deviceLimit: number,
): { readonly traffic: number; readonly device: number } {
  if (type === 'UNLIMITED') return { traffic: UNLIMITED, device: UNLIMITED }
  if (type === 'DEVICES') return { traffic: UNLIMITED, device: deviceLimit }
  if (type === 'TRAFFIC') return { traffic: trafficLimitGB, device: UNLIMITED }
  return { traffic: trafficLimitGB, device: deviceLimit }
}

/**
 * The limits this edit changes, or an empty list when it changes none.
 *
 * A field is reported only when BOTH sides parse as a non-negative integer: a
 * half-typed or cleared box is not a limit change, and the form's own validation
 * is what should speak about it. Silence here is deliberate — a notice that
 * flickers while someone types is a notice they learn to ignore.
 */
export function describePlanLimitChanges(input: PlanLimitScopeInput): readonly PlanLimitChange[] {
  if (!input.isSavedPlan) return []

  const savedTraffic = parseLimit(input.savedTrafficLimitGB)
  const draftTraffic = parseLimit(input.draftTrafficLimitGB)
  const savedDevice = parseLimit(input.savedDeviceLimit)
  const draftDevice = parseLimit(input.draftDeviceLimit)
  if (
    savedTraffic === null ||
    draftTraffic === null ||
    savedDevice === null ||
    draftDevice === null
  ) {
    return []
  }

  const saved = normalizePlanLimits(input.savedType, savedTraffic, savedDevice)
  const draft = normalizePlanLimits(input.draftType, draftTraffic, draftDevice)

  const changes: PlanLimitChange[] = []
  appendChange(changes, 'traffic', saved.traffic, draft.traffic)
  appendChange(changes, 'device', saved.device, draft.device)
  return changes
}

/**
 * How to describe the edit as a whole. `mixed` covers the case that makes a
 * one-directional sentence a lie — traffic up while devices come down.
 */
export function summarizePlanLimitDirection(
  changes: readonly PlanLimitChange[],
): PlanLimitDirection | 'mixed' | null {
  if (changes.length === 0) return null
  const first = changes[0]!.direction
  return changes.every((change) => change.direction === first) ? first : 'mixed'
}

function appendChange(
  target: PlanLimitChange[],
  field: PlanLimitField,
  from: number,
  to: number,
): void {
  if (from === to) return
  target.push({ field, from, to, direction: isRaise(from, to) ? 'raise' : 'cut' })
}

/** `0` is not "less than everything", it is "more than everything". */
function isRaise(from: number, to: number): boolean {
  if (to === UNLIMITED) return true
  if (from === UNLIMITED) return false
  return to > from
}

function parseLimit(value: string): number | null {
  const trimmed = value.trim()
  if (!INTEGER_PATTERN.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : null
}
