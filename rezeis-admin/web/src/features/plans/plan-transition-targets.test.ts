/**
 * WHAT THESE SPECS PIN, and why each one exists.
 *
 *   1. A TRIAL plan is never offered. The old picker filtered on
 *      `isActive && !isArchived` alone, offered the trial plan, and the save
 *      came back refused — in production, in English, naming a cuid. Asserted
 *      by NAME, so a fixture renamed out from under it fails rather than
 *      quietly asserting nothing.
 *   2. The five assignable availabilities really are offered, enumerated from a
 *      literal array and then compared against the catalogue this panel ships
 *      (`PLAN_AVAILABILITIES`) and against the backend rule itself. A seventh
 *      Prisma value added later is therefore VISIBLY unhandled instead of
 *      silently offered.
 *   3. Selections that are no longer selectable are still reported. This is the
 *      half that made a plan permanently unsaveable: a target archived,
 *      deactivated, converted to trial or deleted after being saved stayed in
 *      React state, kept being submitted, and was never rendered, so it could
 *      not be removed.
 *   4. The precedence between reasons. It is a decision about which remedy the
 *      operator is sent to perform, not an accident of statement order.
 *
 * ── ANTI-VACUITY DISCIPLINE ──────────────────────────────────────────────────
 *
 * NO DATE LITERALS. There are none to write — `Plan` carries no timestamps —
 * and none may be added: a fixture dated the day it was written became an
 * expired-subscription assertion five months later elsewhere in this repository
 * and took thirty green tests down with it. Derive any date from a base passed
 * into the test.
 *
 * The two cross-checks (against `PLAN_AVAILABILITIES` and against the backend
 * validator) assert the EXPECTED ANSWER FIRST and agreement second. An
 * agreement-only assertion passes when both sides are wrong, which is precisely
 * how the picker and the server drifted apart in the first place.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PLAN_AVAILABILITIES } from './plan-form-schema'
import type { Plan } from './plans-api'
import {
  ASSIGNABLE_TRANSITION_AVAILABILITIES,
  classifyPlanTransitionTarget,
  selectableTransitionTargets,
  strandedTransitionTargets,
  TRIAL_AVAILABILITY,
} from './plan-transition-targets'

/** The five the server accepts as transition targets. Written out, not derived. */
const ASSIGNABLE_AVAILABILITIES = ['ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED'] as const
/** The rest of the Prisma enum as this build knows it. */
const REFUSED_AVAILABILITIES = ['TRIAL'] as const

const BASE_PLAN: Plan = {
  id: 'plan-base',
  name: 'Base',
  description: null,
  tag: null,
  icon: null,
  type: 'TRAFFIC',
  availability: 'ALL',
  trafficLimit: 50,
  deviceLimit: 1,
  trafficLimitStrategy: 'MONTH',
  isActive: true,
  isArchived: false,
  orderIndex: 0,
  internalSquads: [],
  externalSquad: null,
  durations: [],
  replacementPlanIds: [],
  upgradeToPlanIds: [],
}

function plan(overrides: Partial<Plan> & Pick<Plan, 'id' | 'name'>): Plan {
  return { ...BASE_PLAN, ...overrides }
}

const PREMIUM = plan({ id: 'p-premium', name: 'Premium' })
const INVITE_ONLY = plan({ id: 'p-invite', name: 'Invite only', availability: 'INVITED' })
const FREE_TRIAL = plan({ id: 'p-trial', name: 'Free trial', availability: TRIAL_AVAILABILITY })
const RETIRED = plan({ id: 'p-retired', name: 'Retired', isArchived: true, isActive: false })
const PAUSED = plan({ id: 'p-paused', name: 'Paused', isActive: false })
const CATALOG: readonly Plan[] = [PREMIUM, INVITE_ONLY, FREE_TRIAL, RETIRED, PAUSED]

const names = (plans: readonly Plan[]): string[] => plans.map((candidate) => candidate.name)

describe('classifyPlanTransitionTarget — the production defect', () => {
  // THE BUG. `plan-form.tsx` filtered on `p.isActive && !p.isArchived`, which a
  // live trial plan passes; the server's `ASSIGNABLE_TRANSITION_AVAILABILITIES`
  // excludes TRIAL, so the operator picked it and the save was refused.
  it('refuses a TRIAL plan even when it is active and unarchived', () => {
    expect(FREE_TRIAL.isActive).toBe(true)
    expect(FREE_TRIAL.isArchived).toBe(false)
    expect(classifyPlanTransitionTarget(FREE_TRIAL, null)).toBe('trial')
  })

  it('does not offer the trial plan in the picker, by name', () => {
    const offered = names(selectableTransitionTargets(CATALOG, null))
    expect(offered).not.toContain('Free trial')
    expect(offered).toEqual(['Premium', 'Invite only'])
  })
})

describe('classifyPlanTransitionTarget — availability', () => {
  it.each(ASSIGNABLE_AVAILABILITIES)('accepts an active %s plan', (availability) => {
    expect(classifyPlanTransitionTarget(plan({ id: 'x', name: 'X', availability }), null)).toBeNull()
  })

  it.each(REFUSED_AVAILABILITIES)('refuses a %s plan', (availability) => {
    expect(classifyPlanTransitionTarget(plan({ id: 'x', name: 'X', availability }), null)).toBe(
      'trial',
    )
  })

  it('offers every assignable availability from one catalog', () => {
    const catalog = ASSIGNABLE_AVAILABILITIES.map((availability) =>
      plan({ id: `id-${availability}`, name: availability, availability }),
    )
    expect(names(selectableTransitionTargets(catalog, null))).toEqual([
      'ALL',
      'NEW',
      'EXISTING',
      'INVITED',
      'ALLOWED',
    ])
  })

  // AN ALLOWLIST, NOT `!== 'TRIAL'`. `availability` is `string` on the wire, so
  // a seventh Prisma value can arrive at a panel that predates it. The server
  // tests set membership, so it would refuse the newcomer; a denylist here
  // would offer it and reproduce this whole defect one enum value later.
  it('refuses an availability this build has never heard of', () => {
    const future = plan({ id: 'p-future', name: 'Partner', availability: 'PARTNER' })
    expect(classifyPlanTransitionTarget(future, null)).toBe('unassignable')
    expect(names(selectableTransitionTargets([PREMIUM, future], null))).toEqual(['Premium'])
  })

  // Expected answer FIRST, agreement second — an agreement-only assertion is
  // green when both sides are wrong, which is how this defect happened.
  it('covers the whole availability catalogue this panel ships', () => {
    expect([...ASSIGNABLE_AVAILABILITIES]).toEqual(['ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED'])
    expect([...REFUSED_AVAILABILITIES]).toEqual(['TRIAL'])
    expect([...ASSIGNABLE_TRANSITION_AVAILABILITIES].sort()).toEqual(
      [...ASSIGNABLE_AVAILABILITIES].sort(),
    )
    expect([...PLAN_AVAILABILITIES].sort()).toEqual(
      [...ASSIGNABLE_AVAILABILITIES, ...REFUSED_AVAILABILITIES].sort(),
    )
  })

  /**
   * ACROSS THE PACKAGE BOUNDARY, from a test, deliberately — the same move
   * `subscription-delete-stale-link.test.tsx` makes and for the same reason:
   * comparing this module's set against a second COPY of it proves only that
   * the copy was copied. Read as TEXT rather than imported, because the
   * validator pulls in Nest and Prisma and this assertion needs neither.
   * `tsconfig.app.json` excludes tests, so the production build never follows
   * this path; `build-isolation.test.ts` pins that arrangement.
   */
  it('agrees with the backend validator, which is the rule of record', () => {
    const validator = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../src/modules/plans/services/plans-admin.validators.ts',
    )
    const source: string = readFileSync(validator, 'utf8')
    const block = /ASSIGNABLE_TRANSITION_AVAILABILITIES[^[]*\[([\s\S]*?)\]/.exec(source)
    expect(block).not.toBeNull()
    const backend = [...(block as RegExpExecArray)[1].matchAll(/PlanAvailability\.([A-Z_]+)/g)].map(
      (match) => match[1],
    )
    // The answer, before anything is compared to anything.
    expect([...ASSIGNABLE_AVAILABILITIES]).toEqual(['ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED'])
    // ...and only then, that the server says the same thing.
    expect(backend.sort()).toEqual([...ASSIGNABLE_AVAILABILITIES].sort())
  })
})

describe('classifyPlanTransitionTarget — the plan being edited', () => {
  it('refuses a plan that names itself', () => {
    expect(classifyPlanTransitionTarget(PREMIUM, PREMIUM.id)).toBe('self')
  })

  it('drops the plan being edited from the picker', () => {
    expect(names(selectableTransitionTargets(CATALOG, PREMIUM.id))).toEqual(['Invite only'])
  })

  it('reports a self-reference that is already selected, so it can be removed', () => {
    expect(strandedTransitionTargets(CATALOG, [PREMIUM.id], PREMIUM.id)).toEqual([
      { id: 'p-premium', name: 'Premium', reason: 'self' },
    ])
  })

  // A create has no persisted plan, so nothing can point at itself.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ] as const)('treats %s as "no plan is being edited"', (_label, currentPlanId) => {
    expect(classifyPlanTransitionTarget(PREMIUM, currentPlanId)).toBeNull()
    expect(names(selectableTransitionTargets(CATALOG, currentPlanId))).toEqual([
      'Premium',
      'Invite only',
    ])
  })
})

describe('classifyPlanTransitionTarget — precedence', () => {
  /**
   * The operator is shown ONE reason, so it must be the one still true after
   * every other fix. See the doc comment on `PlanTransitionIneligibility`.
   */
  it('names "self" over every property of the target', () => {
    const hopeless = plan({
      id: 'p-self',
      name: 'Hopeless',
      availability: TRIAL_AVAILABILITY,
      isArchived: true,
      isActive: false,
    })
    expect(classifyPlanTransitionTarget(hopeless, 'p-self')).toBe('self')
  })

  // Told "archived", the operator unarchives a trial plan and is refused again
  // for a reason they were never shown. Trial is terminal; archived is not.
  it('names "trial" over "archived" and "inactive"', () => {
    const archivedTrial = plan({
      id: 'p-at',
      name: 'Archived trial',
      availability: TRIAL_AVAILABILITY,
      isArchived: true,
      isActive: false,
    })
    expect(classifyPlanTransitionTarget(archivedTrial, null)).toBe('trial')
  })

  it('names "unassignable" over "archived" and "inactive"', () => {
    const archivedFuture = plan({
      id: 'p-af',
      name: 'Archived partner',
      availability: 'PARTNER',
      isArchived: true,
      isActive: false,
    })
    expect(classifyPlanTransitionTarget(archivedFuture, null)).toBe('unassignable')
  })

  // Activating an archived plan leaves it archived and still refused, so
  // naming "inactive" first buys the operator a wasted round trip.
  it('names "archived" over "inactive" when a plan is both', () => {
    expect(RETIRED.isArchived).toBe(true)
    expect(RETIRED.isActive).toBe(false)
    expect(classifyPlanTransitionTarget(RETIRED, null)).toBe('archived')
  })

  it('names "inactive" for an unarchived plan that is merely switched off', () => {
    expect(classifyPlanTransitionTarget(PAUSED, null)).toBe('inactive')
  })

  // An archived plan left ACTIVE is not a contradiction — the plans page shows
  // both flags — and it must not slip through as selectable.
  it('refuses an archived plan that is still flagged active', () => {
    const oddity = plan({ id: 'p-odd', name: 'Odd', isArchived: true, isActive: true })
    expect(classifyPlanTransitionTarget(oddity, null)).toBe('archived')
  })
})

describe('strandedTransitionTargets — the invisible selections', () => {
  // THE SECOND HALF OF THE BUG. These ids were seeded into React state from the
  // saved plan and submitted on every save, but only chips that survived the
  // picker filter were rendered — so the plan could not be saved and could not
  // be fixed, and the refusal named a cuid that was nowhere on the screen.
  it('reports an already-selected archived plan with its name and reason', () => {
    expect(strandedTransitionTargets(CATALOG, [RETIRED.id], null)).toEqual([
      { id: 'p-retired', name: 'Retired', reason: 'archived' },
    ])
  })

  it('reports an already-selected inactive plan with its name and reason', () => {
    expect(strandedTransitionTargets(CATALOG, [PAUSED.id], null)).toEqual([
      { id: 'p-paused', name: 'Paused', reason: 'inactive' },
    ])
  })

  it('reports an already-selected trial plan with its name and reason', () => {
    expect(strandedTransitionTargets(CATALOG, [FREE_TRIAL.id], null)).toEqual([
      { id: 'p-trial', name: 'Free trial', reason: 'trial' },
    ])
  })

  // A target deleted after it was saved resolves to no plan at all, so there is
  // no name to show — the chip has to be rendered from the bare id.
  it('reports an id that resolves to no plan as missing, with a null name', () => {
    expect(strandedTransitionTargets(CATALOG, ['cmsxo98e8006r01jgn33gtpbe'], null)).toEqual([
      { id: 'cmsxo98e8006r01jgn33gtpbe', name: null, reason: 'missing' },
    ])
  })

  it('says nothing about selections that are still perfectly valid', () => {
    expect(strandedTransitionTargets(CATALOG, [PREMIUM.id, INVITE_ONLY.id], null)).toEqual([])
  })

  it('keeps the selection order and reports each id once', () => {
    const selected = [PAUSED.id, 'gone-1', PREMIUM.id, RETIRED.id, PAUSED.id, 'gone-1']
    expect(strandedTransitionTargets(CATALOG, selected, null)).toEqual([
      { id: 'p-paused', name: 'Paused', reason: 'inactive' },
      { id: 'gone-1', name: null, reason: 'missing' },
      { id: 'p-retired', name: 'Retired', reason: 'archived' },
    ])
  })

  it('has nothing to report for an empty selection', () => {
    expect(strandedTransitionTargets(CATALOG, [], null)).toEqual([])
  })
})

describe('strandedTransitionTargets — while the catalog is loading', () => {
  // THE TRAP. `undefined` is "not known yet", not "known to be empty". Treating
  // it as an empty catalog would classify every selected id as missing and open
  // the form onto a wall of false alarms that erases itself a moment later.
  it('reports nothing at all while allPlans is undefined', () => {
    expect(strandedTransitionTargets(undefined, [PREMIUM.id, RETIRED.id, 'gone'], null)).toEqual([])
  })

  it('offers nothing while allPlans is undefined', () => {
    expect(selectableTransitionTargets(undefined, null)).toEqual([])
  })

  // ...but a catalog that has LOADED and is genuinely empty is a real finding:
  // every selected id resolves to no plan, and the operator has to be told.
  it('reports every selection as missing once an empty catalog has loaded', () => {
    expect(strandedTransitionTargets([], [PREMIUM.id, 'gone'], null)).toEqual([
      { id: 'p-premium', name: null, reason: 'missing' },
      { id: 'gone', name: null, reason: 'missing' },
    ])
  })
})
