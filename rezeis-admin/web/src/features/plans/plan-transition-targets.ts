/**
 * WHO MAY BE AN UPGRADE OR REPLACEMENT TARGET — one rule, mirroring the server.
 *
 * ── THE DEFECT THIS EXISTS TO END ────────────────────────────────────────────
 *
 * `plan-form.tsx` built its two transition pickers from
 *
 *     allPlans.filter((p) => p.id !== plan?.id && p.isActive && !p.isArchived)
 *
 * and the server's rule (`ASSIGNABLE_TRANSITION_AVAILABILITIES` in
 * `src/modules/plans/services/plans-admin.validators.ts`) is strictly narrower:
 * a target must be active, not archived, AND carry an availability drawn from
 * ALL | NEW | EXISTING | INVITED | ALLOWED. The Prisma enum has a sixth value,
 * TRIAL, which that filter happily offered. The operator picked a trial plan,
 * pressed save, and the write came back refused. That happened in production.
 *
 * The second half is worse and is why this module has a stranded-target
 * function at all. `upgradeToPlanIds` / `replacementPlanIds` are seeded into
 * React state from the saved plan and submitted verbatim, but only chips whose
 * plan survived that filter were ever RENDERED. A target archived, deactivated,
 * converted to trial, or deleted after it was saved therefore stayed in state,
 * kept being submitted, and could not be seen — let alone deselected. The plan
 * became permanently unsaveable and the refusal named a cuid that appeared
 * nowhere on the screen. Whatever cannot be offered must still be SHOWN when it
 * is already selected, or the operator has no way out.
 *
 * ── A MODULE WITH NO IMPORTS BUT THE WIRE TYPE ───────────────────────────────
 *
 * Pure and total on purpose: no React, no network, no i18n. Both pickers ask
 * the same two questions of the same function, so they cannot drift apart from
 * each other, and every branch below is reachable from a plain unit test.
 *
 * The availability literals are hand-written rather than imported from the
 * backend's `PlanAvailability`: nothing the production frontend project
 * compiles may reach into `src/` — the Docker frontend stage is `COPY web/ .`
 * and `build-isolation.test.ts` pins that after exactly this mistake cost a
 * failed image build on a release tag. The cross-boundary link is enforced from
 * the TEST side instead, where the repository exists.
 */
import type { Plan } from './plans-api'

/**
 * Why a plan may not be a transition target.
 *
 * ── PRECEDENCE, AND WHY IT IS THIS ORDER ─────────────────────────────────────
 *
 * A plan is routinely ineligible for more than one reason at once — an archived
 * trial, an inactive archived plan. The operator is shown ONE reason, so it has
 * to be the one that is still true after they have fixed everything else;
 * otherwise the panel sends them to do work that does not unblock the save.
 *
 *   1. `self`   — not a property of the target at all, but of the reference.
 *                 The server refuses it in a separate, earlier check
 *                 ('Plan transitions cannot reference the same plan'), and no
 *                 edit to the plan's own flags can make it legal. Wins.
 *   2. `missing` — structurally prior to everything below: there is no plan to
 *                 ask the remaining questions of.
 *   3. `trial`  — terminal. A trial plan cannot be quietly un-trialed to
 *                 unblock a save: `assertTrialConstraints` refuses converting
 *                 an existing plan's availability TO trial, only one active
 *                 trial plan may exist at a time, and the trial claim ledger
 *                 hangs off it. Told "archived" first, the operator unarchives
 *                 a trial plan and is refused again for a reason they were
 *                 never shown. The only action that works is choosing a
 *                 different target, and that is what this reason says.
 *   4. `unassignable` — the same terminal shape as `trial`, for an availability
 *                 this build has never heard of. See the note on the allowlist
 *                 below.
 *   5. `archived` — the deliberate retirement state, and the stronger of the
 *                 two remaining flags: activating an archived plan leaves it
 *                 archived and still refused, so naming `inactive` first costs
 *                 a wasted round trip. Naming `archived` first states the real
 *                 cost of using this target up front.
 *   6. `inactive` — the last thing left, and a single checkbox away.
 *
 * `plan-transition-targets.test.ts` pins this order; it is a decision, not an
 * artefact of the order the `if`s happen to be written in.
 */
export type PlanTransitionIneligibility =
  | 'self'
  | 'missing'
  | 'trial'
  | 'unassignable'
  | 'archived'
  | 'inactive'

/** The Prisma `PlanAvailability` value the picker used to offer and must not. */
export const TRIAL_AVAILABILITY = 'TRIAL'

/**
 * Mirrors `ASSIGNABLE_TRANSITION_AVAILABILITIES` in the backend validator.
 *
 * AN ALLOWLIST, NOT `!== 'TRIAL'`. `Plan.availability` is typed `string` on the
 * wire, not a union, so the catalog can serve a value this build has never seen
 * — a seventh enum member added to Prisma while this panel is mid-rollout. The
 * server tests membership of this exact set, so anything outside it is refused
 * there; a denylist here would offer the newcomer and reproduce, one enum value
 * later, the very defect this module was written to close.
 */
export const ASSIGNABLE_TRANSITION_AVAILABILITIES: ReadonlySet<string> = new Set([
  'ALL',
  'NEW',
  'EXISTING',
  'INVITED',
  'ALLOWED',
])

/** Everything the decision actually reads. Keeps callers free to pass a `Plan`. */
export type PlanTransitionCandidate = Pick<
  Plan,
  'id' | 'availability' | 'isActive' | 'isArchived'
>

/**
 * Why this plan may not be a transition target, or `null` when it may be.
 *
 * `'missing'` is never returned from here — an id that resolves to no plan has
 * no plan to classify, so only {@link strandedTransitionTargets} can report it.
 *
 * `currentPlanId` is the plan being edited: `null`/`undefined`/`''` on a
 * create, where nothing is persisted yet and no reference can be self-directed.
 */
export function classifyPlanTransitionTarget(
  plan: PlanTransitionCandidate,
  currentPlanId: string | null | undefined,
): PlanTransitionIneligibility | null {
  if (typeof currentPlanId === 'string' && currentPlanId.length > 0 && plan.id === currentPlanId) {
    return 'self'
  }
  if (plan.availability === TRIAL_AVAILABILITY) return 'trial'
  if (!ASSIGNABLE_TRANSITION_AVAILABILITIES.has(plan.availability)) return 'unassignable'
  if (plan.isArchived) return 'archived'
  if (!plan.isActive) return 'inactive'
  return null
}

/**
 * The plans that may be OFFERED in a transition picker, in catalog order.
 *
 * `undefined` — the catalog has not loaded — yields `[]`, which is what the
 * picker already renders its empty state for.
 */
export function selectableTransitionTargets(
  allPlans: readonly Plan[] | undefined,
  currentPlanId: string | null | undefined,
): Plan[] {
  if (allPlans === undefined) return []
  return allPlans.filter((plan) => classifyPlanTransitionTarget(plan, currentPlanId) === null)
}

export interface StrandedTransitionTarget {
  readonly id: string
  /** The plan's name when it is still in the catalog; `null` when `reason === 'missing'`. */
  readonly name: string | null
  readonly reason: PlanTransitionIneligibility
}

/**
 * Ids that are SELECTED but not selectable — the ones the old picker submitted
 * invisibly. They must still be rendered, marked with their reason, so the
 * operator can take them off. Order is the selection order; a repeated id is
 * reported once, at its first position, because the server dedupes the two
 * lists into one set before validating them.
 *
 * ── `allPlans === undefined` RETURNS `[]`, DELIBERATELY ───────────────────────
 *
 * While the catalog query is in flight there is no list to resolve ids against,
 * so every selected id would classify as `'missing'` and the form would open
 * onto a wall of "this target no longer exists" that erases itself a moment
 * later. `undefined` means NOT KNOWN YET, which is not a finding about any
 * plan, so this reports nothing.
 *
 * That makes the caller's contract explicit: **an empty result while
 * `allPlans === undefined` is silence, not a clean bill of health.** Render the
 * stranded warnings only once the catalog has resolved — `isPending` is the
 * gate, and `[]` is the answer once it has. An empty ARRAY is a different
 * statement from `undefined`: the catalog is known and holds nothing, so every
 * selected id genuinely resolves to no plan and every one is reported
 * `'missing'`.
 */
export function strandedTransitionTargets(
  allPlans: readonly Plan[] | undefined,
  selectedIds: readonly string[],
  currentPlanId: string | null | undefined,
): StrandedTransitionTarget[] {
  if (allPlans === undefined) return []
  const planById = new Map(allPlans.map((plan) => [plan.id, plan]))
  const reported = new Set<string>()
  const stranded: StrandedTransitionTarget[] = []
  for (const id of selectedIds) {
    if (reported.has(id)) continue
    reported.add(id)
    const plan = planById.get(id)
    if (plan === undefined) {
      stranded.push({ id, name: null, reason: 'missing' })
      continue
    }
    const reason = classifyPlanTransitionTarget(plan, currentPlanId)
    if (reason === null) continue
    stranded.push({ id, name: plan.name, reason })
  }
  return stranded
}
