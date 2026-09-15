/**
 * WHAT THESE SPECS PIN — the decisions of the migration steps, without a page.
 *
 *   1. TARGETS: every other plan the catalogue lists except trials, archived and
 *      inactive ones included (owner decision 3).
 *   2. THE REQUEST: explicit groups, "all N" as the rest target, exceptions
 *      after it, and nothing sent to a target no longer offered.
 *   3. UNLIMITED: traffic `null` and devices `<= 0` are unlimited, traffic `0`
 *      is a cap of zero — in the values and in the comparisons.
 *   4. WORDS: every warning, reason and problem kind has words, an unknown code
 *      is shown with its code, and a code spelled like a prototype member is
 *      unknown rather than a crash.
 *   5. THE RUN: when it is a success, when it stops polling, and what the
 *      progress says.
 *   6. THE DICTIONARIES: every migrate key the code names exists in both
 *      languages, and every migrate key the dictionaries hold is named by code.
 *
 * Literals, never the module's own constants, in the expectations: a test that
 * reads the value it pins moves together with it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'
import { keyPaths, valueAt } from '@/test/i18n-key-paths'

import type { PlanMigrationRunStatus } from './plan-migration-api'
import {
  assignAll,
  assignedTargetOf,
  assignSelected,
  benignSkipCount,
  buildMigrationRequest,
  canChooseAnotherTarget,
  canOfferSelectAll,
  classifyMigrationRun,
  describeProblemDetail,
  failuresNeedAnotherTarget,
  twinBlockerReason,
  isKnownMigrationRefusal,
  isMigrationRunSettled,
  isNoResponseError,
  compareDeviceLimits,
  compareTrafficLimits,
  describeMigrationProblemKind,
  describeMigrationProgress,
  describeMigrationReason,
  describeMigrationWarning,
  describeMigrationWarnings,
  describeSubscriber,
  describeWarningCounts,
  diffSquads,
  EMPTY_MIGRATION_ASSIGNMENT,
  EMPTY_MIGRATION_SELECTION,
  isAwaitingRetryEcho,
  listMigrationTargets,
  mayHaveStartedAnyway,
  planLabelOf,
  PLAN_MIGRATION_PROBLEM_KIND_SPECS,
  PLAN_MIGRATION_PROBLEM_KINDS,
  PLAN_MIGRATION_REASON_CODES,
  PLAN_MIGRATION_REASON_I18N_KEYS,
  PLAN_MIGRATION_REFUSAL_I18N_KEYS,
  PLAN_MIGRATION_TARGET_REFUSALS,
  PLAN_MIGRATION_UNKNOWN_PROBLEM_KIND,
  PLAN_MIGRATION_UNKNOWN_REASON_I18N_KEY,
  PLAN_MIGRATION_UNKNOWN_WARNING,
  PLAN_MIGRATION_WARNING_CODES,
  PLAN_MIGRATION_WARNING_SPECS,
  progressPercent,
  readDeviceLimit,
  readTrafficLimit,
  selectedCount,
  shouldPollMigrationRun,
  summariseAssignment,
  toggleRow,
  toggleVisible,
  visibleSelectionState,
} from './plan-migration'
import {
  PLAN_MIGRATION_POLL_MS,
  PLAN_MIGRATION_RETRY_ECHO_MS,
  PLAN_MIGRATION_SEARCH_DEBOUNCE_MS,
  PLAN_MIGRATION_SUCCESS_HOLD_MS,
} from './plan-migration-timing'

describe('the clocks', () => {
  it('polls a running move every 2–3 seconds, and waits out a retry echo longer than one poll', () => {
    expect(PLAN_MIGRATION_POLL_MS).toBe(2_500)
    expect(PLAN_MIGRATION_POLL_MS).toBeGreaterThanOrEqual(2_000)
    expect(PLAN_MIGRATION_POLL_MS).toBeLessThanOrEqual(3_000)
    expect(PLAN_MIGRATION_RETRY_ECHO_MS).toBe(6_000)
    expect(PLAN_MIGRATION_RETRY_ECHO_MS).toBeGreaterThan(2 * PLAN_MIGRATION_POLL_MS)
    expect(PLAN_MIGRATION_SUCCESS_HOLD_MS).toBe(1_400)
    expect(PLAN_MIGRATION_SEARCH_DEBOUNCE_MS).toBe(300)
  })
})

describe('listMigrationTargets', () => {
  const catalogue = [
    { id: 'source', name: 'Gold', availability: 'ALL', isActive: true, isArchived: false },
    { id: 'standard', name: 'Standard', availability: 'ALL', isActive: true, isArchived: false },
    { id: 'trial', name: 'Free trial', availability: 'TRIAL', isActive: true, isArchived: false },
    { id: 'vintage', name: 'Vintage', availability: 'EXISTING', isActive: false, isArchived: true },
    { id: 'dormant', name: 'Dormant', availability: 'INVITED', isActive: false, isArchived: false },
  ]

  it('offers every other plan in catalogue order, archived and inactive included, and never a trial or the source', () => {
    expect(listMigrationTargets(catalogue, 'source').map((plan) => plan.id)).toEqual(['standard', 'vintage', 'dormant'])
    expect(listMigrationTargets(catalogue, 'standard').map((plan) => plan.id)).toEqual(['source', 'vintage', 'dormant'])
  })

  it('offers nothing before the catalogue has loaded', () => {
    expect(listMigrationTargets(undefined, 'source')).toEqual([])
  })

  it('names a plan the catalogue no longer has by its short id, never by nothing', () => {
    const byId = new Map([['standard', { name: 'Standard' }]])
    expect(planLabelOf(byId, 'standard')).toBe('Standard')
    expect(planLabelOf(byId, 'cmsxo98e8006r01jgn33gtpbe')).toBe('cmsxo98e80…')
    expect(planLabelOf(byId, 'short')).toBe('short')
  })
})

describe('the request', () => {
  const eligible = new Set(['standard', 'vintage', 'dormant'])

  it('sends explicit groups in assignment order, and no rest key at all without a rest target', () => {
    let assignment = assignSelected(EMPTY_MIGRATION_ASSIGNMENT, ['sub-1'], 'standard')
    assignment = assignSelected(assignment, ['sub-2', 'sub-3'], 'vintage')
    const request = buildMigrationRequest(assignment, eligible)
    expect(request).toEqual({
      groups: [
        { targetPlanId: 'standard', subscriptionIds: ['sub-1'] },
        { targetPlanId: 'vintage', subscriptionIds: ['sub-2', 'sub-3'] },
      ],
    })
    expect('restTargetPlanId' in request).toBe(false)
  })

  it('moves a re-assigned subscription to its new target, keeping each id in exactly one group', () => {
    let assignment = assignSelected(EMPTY_MIGRATION_ASSIGNMENT, ['sub-1', 'sub-2'], 'standard')
    assignment = assignSelected(assignment, ['sub-2'], 'dormant')
    expect(buildMigrationRequest(assignment, eligible)).toEqual({
      groups: [
        { targetPlanId: 'standard', subscriptionIds: ['sub-1'] },
        { targetPlanId: 'dormant', subscriptionIds: ['sub-2'] },
      ],
    })
    expect(assignedTargetOf(assignment, 'sub-2')).toBe('dormant')
    expect(assignedTargetOf(assignment, 'sub-9')).toBeNull()
  })

  it('expresses "all N" as the rest target, clears earlier rows, and keeps later rows as exceptions', () => {
    const before = assignSelected(EMPTY_MIGRATION_ASSIGNMENT, ['sub-1'], 'dormant')
    let assignment = assignAll('standard')
    expect(assignment.explicit.size).toBe(0)
    expect(assignedTargetOf(assignment, 'sub-1')).toBe('standard')
    // `before` is untouched: assignments are values.
    expect(assignedTargetOf(before, 'sub-1')).toBe('dormant')

    assignment = assignSelected(assignment, ['sub-7'], 'vintage')
    expect(buildMigrationRequest(assignment, eligible)).toEqual({
      groups: [{ targetPlanId: 'vintage', subscriptionIds: ['sub-7'] }],
      restTargetPlanId: 'standard',
    })
  })

  it('folds a row assigned to the rest target into the rest', () => {
    const assignment = assignSelected(assignAll('standard'), ['sub-1', 'sub-2'], 'standard')
    expect(buildMigrationRequest(assignment, eligible)).toEqual({ groups: [], restTargetPlanId: 'standard' })
  })

  it('sends nothing to a target no longer offered, and counts those rows as unassigned again', () => {
    let assignment = assignSelected(EMPTY_MIGRATION_ASSIGNMENT, ['sub-1'], 'deleted-plan')
    assignment = assignSelected(assignment, ['sub-2'], 'standard')
    expect(buildMigrationRequest(assignment, eligible)).toEqual({
      groups: [{ targetPlanId: 'standard', subscriptionIds: ['sub-2'] }],
    })
    expect(summariseAssignment(assignment, 2, eligible)).toEqual({
      assigned: 1,
      unassigned: 1,
      groups: [{ targetPlanId: 'standard', count: 1 }],
      restTargetPlanId: null,
      ineligibleTargetIds: ['deleted-plan'],
      complete: false,
    })

    const staleRest = assignAll('deleted-plan')
    const request = buildMigrationRequest(staleRest, eligible)
    expect(request).toEqual({ groups: [] })
    expect(summariseAssignment(staleRest, 5, eligible)).toMatchObject({
      assigned: 0,
      unassigned: 5,
      ineligibleTargetIds: ['deleted-plan'],
      complete: false,
    })
  })

  it('is complete only when every subscription on the plan has an offered target', () => {
    const partial = assignSelected(EMPTY_MIGRATION_ASSIGNMENT, ['sub-1', 'sub-2'], 'standard')
    expect(summariseAssignment(partial, 3, eligible)).toMatchObject({ assigned: 2, unassigned: 1, complete: false })
    expect(summariseAssignment(partial, 2, eligible)).toMatchObject({ assigned: 2, unassigned: 0, complete: true })
    // A row that left the plan meanwhile does not push `assigned` past the total.
    expect(summariseAssignment(partial, 1, eligible)).toMatchObject({ assigned: 1, unassigned: 0, complete: true })
    expect(summariseAssignment(assignAll('vintage'), 60, eligible)).toMatchObject({
      assigned: 60,
      unassigned: 0,
      restTargetPlanId: 'vintage',
      complete: true,
    })
    expect(summariseAssignment(EMPTY_MIGRATION_ASSIGNMENT, 0, eligible).complete).toBe(false)
  })

  // A row's own choice outranks the rest. Its plan gone, the rest must not quietly
  // take it to a plan nobody picked for it — the request cannot say "all but these".
  it('holds «Далее» for a row whose chosen plan is gone even when a rest target covers every other row', () => {
    const assignment = assignSelected(assignAll('standard'), ['sub-alice'], 'deleted-plan')
    expect(summariseAssignment(assignment, 60, eligible)).toEqual({
      assigned: 59,
      unassigned: 1,
      groups: [],
      restTargetPlanId: 'standard',
      ineligibleTargetIds: ['deleted-plan'],
      complete: false,
    })
    // Assigned again — to the rest's plan or any other offered one — it no longer holds anything.
    expect(summariseAssignment(assignSelected(assignment, ['sub-alice'], 'standard'), 60, eligible)).toMatchObject({
      assigned: 60,
      unassigned: 0,
      ineligibleTargetIds: [],
      complete: true,
    })
    expect(summariseAssignment(assignSelected(assignment, ['sub-alice'], 'vintage'), 60, eligible)).toMatchObject({
      assigned: 60,
      groups: [{ targetPlanId: 'vintage', count: 1 }],
      complete: true,
    })
    // Two such rows count twice, and never past the plan's total.
    const two = assignSelected(assignment, ['sub-bob'], 'deleted-plan')
    expect(summariseAssignment(two, 60, eligible)).toMatchObject({ assigned: 58, unassigned: 2, complete: false })
    expect(summariseAssignment(two, 1, eligible)).toMatchObject({ assigned: 0, unassigned: 1, complete: false })
  })
})

describe('the selection', () => {
  const visible = ['sub-1', 'sub-2', 'sub-3']

  it('draws the header checkbox off, mixed or on from the shown rows', () => {
    expect(visibleSelectionState(EMPTY_MIGRATION_SELECTION, visible)).toBe(false)
    const one = toggleRow(EMPTY_MIGRATION_SELECTION, 'sub-2', visible)
    expect(visibleSelectionState(one, visible)).toBe('indeterminate')
    expect(visibleSelectionState(toggleVisible(one, visible), visible)).toBe(true)
    expect(visibleSelectionState({ all: true, ids: new Set() }, visible)).toBe(true)
    expect(visibleSelectionState(EMPTY_MIGRATION_SELECTION, [])).toBe(false)
  })

  it('selects every shown row, then clears them, without touching rows selected under another search', () => {
    const earlier = toggleRow(EMPTY_MIGRATION_SELECTION, 'sub-99', ['sub-99'])
    const all = toggleVisible(earlier, visible)
    expect([...all.ids].sort()).toEqual(['sub-1', 'sub-2', 'sub-3', 'sub-99'])
    expect([...toggleVisible(all, visible).ids]).toEqual(['sub-99'])
  })

  it('offers "all N" only once every shown row is selected and the plan holds more', () => {
    const shown = toggleVisible(EMPTY_MIGRATION_SELECTION, visible)
    expect(canOfferSelectAll(shown, visible, 60)).toBe(true)
    expect(canOfferSelectAll(shown, visible, 3)).toBe(false)
    expect(canOfferSelectAll(toggleRow(shown, 'sub-1', visible), visible, 60)).toBe(false)
    expect(canOfferSelectAll({ all: true, ids: new Set() }, visible, 60)).toBe(false)
  })

  it('counts "all" as every subscription, and leaves it by unticking one row, keeping the others', () => {
    const all = { all: true, ids: new Set<string>() }
    expect(selectedCount(all, 60)).toBe(60)
    const left = toggleRow(all, 'sub-2', visible)
    expect(left.all).toBe(false)
    expect([...left.ids]).toEqual(['sub-1', 'sub-3'])
    expect(selectedCount(left, 60)).toBe(2)
  })
})

describe('unlimited, in both encodings', () => {
  it('reads traffic null as unlimited and zero as a cap of zero', () => {
    expect(readTrafficLimit(null)).toEqual({ kind: 'unlimited' })
    expect(readTrafficLimit(0)).toEqual({ kind: 'gigabytes', value: 0 })
    expect(readTrafficLimit(75)).toEqual({ kind: 'gigabytes', value: 75 })
  })

  it('reads devices at or below zero as unlimited', () => {
    expect(readDeviceLimit(0)).toEqual({ kind: 'unlimited' })
    expect(readDeviceLimit(-1)).toEqual({ kind: 'unlimited' })
    expect(readDeviceLimit(1)).toEqual({ kind: 'count', value: 1 })
  })

  it('compares traffic with null above every cap and zero below every other', () => {
    expect(compareTrafficLimits(null, 50)).toBe('less')
    expect(compareTrafficLimits(0, null)).toBe('more')
    expect(compareTrafficLimits(50, 0)).toBe('less')
    expect(compareTrafficLimits(0, 50)).toBe('more')
    expect(compareTrafficLimits(null, null)).toBe('same')
    expect(compareTrafficLimits(0, 0)).toBe('same')
  })

  it('compares devices with every value at or below zero as the same unlimited', () => {
    expect(compareDeviceLimits(0, 2)).toBe('less')
    expect(compareDeviceLimits(2, 0)).toBe('more')
    expect(compareDeviceLimits(-1, 0)).toBe('same')
    expect(compareDeviceLimits(3, 1)).toBe('less')
    expect(compareDeviceLimits(1, 3)).toBe('more')
  })

  it('splits squads into kept, removed and added', () => {
    expect(diffSquads(['eu', 'us', 'asia'], ['eu', 'nl'])).toEqual({ kept: ['eu'], removed: ['us', 'asia'], added: ['nl'] })
    expect(diffSquads([], [])).toEqual({ kept: [], removed: [], added: [] })
  })
})

describe('warnings', () => {
  const CONTRACT_WARNINGS = [
    'FEWER_DEVICES',
    'LESS_TRAFFIC',
    'SQUADS_REMOVED',
    'TRIAL_BECOMES_REGULAR',
    'UNKNOWN_LIMIT_TAKES_TARGET',
    'TARGET_NOT_RENEWABLE',
    'PENDING_RENEWAL_FOR_SOURCE',
    'LOCAL_ONLY',
  ]

  it('names exactly the contract’s warning codes, each with its own label and hint', () => {
    expect([...PLAN_MIGRATION_WARNING_CODES].sort()).toEqual([...CONTRACT_WARNINGS].sort())
    const keys = PLAN_MIGRATION_WARNING_CODES.flatMap((code) => [
      PLAN_MIGRATION_WARNING_SPECS[code].labelKey,
      PLAN_MIGRATION_WARNING_SPECS[code].hintKey,
    ])
    expect(new Set(keys).size).toBe(16)
  })

  it('marks what takes something away as caution', () => {
    expect(
      PLAN_MIGRATION_WARNING_CODES.filter((code) => PLAN_MIGRATION_WARNING_SPECS[code].tone === 'caution'),
    ).toEqual(['FEWER_DEVICES', 'LESS_TRAFFIC', 'SQUADS_REMOVED', 'TARGET_NOT_RENEWABLE'])
  })

  it('shows a row’s warnings once each, known ones in a fixed order and unknown ones after them', () => {
    expect(
      describeMigrationWarnings(['LOCAL_ONLY', 'LOYALTY_RESET', 'FEWER_DEVICES', 'LOCAL_ONLY', 'toString']).map(
        (warning) => [warning.code, warning.recognised],
      ),
    ).toEqual([
      ['FEWER_DEVICES', true],
      ['LOCAL_ONLY', true],
      ['LOYALTY_RESET', false],
      ['toString', false],
    ])
  })

  it('describes a code spelled like a prototype member as unknown, with the generic words', () => {
    for (const code of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(describeMigrationWarning(code)).toEqual({ ...PLAN_MIGRATION_UNKNOWN_WARNING, code, recognised: false })
    }
  })

  it('counts a summary’s warnings only when above zero', () => {
    expect(
      describeWarningCounts({ LOCAL_ONLY: 2, SQUADS_REMOVED: 0, FEWER_DEVICES: 1, NEW_CODE: 3 }).map((warning) => [
        warning.code,
        warning.count,
      ]),
    ).toEqual([
      ['FEWER_DEVICES', 1],
      ['LOCAL_ONLY', 2],
      ['NEW_CODE', 3],
    ])
  })
})

describe('reasons and problem kinds', () => {
  it('names every reason the backend sends, and an unknown or prototype-named one generically with its code', () => {
    expect([...PLAN_MIGRATION_REASON_CODES]).toEqual([
      'NOT_ON_SOURCE_PLAN',
      'SUBSCRIPTION_DELETED',
      'SCHEDULED_TERM',
      'TARGET_DELETED',
      'TARGET_IS_TRIAL',
      'SHARED_PROFILE_TARGET_CONFLICT',
      'SHARED_PROFILE_TWIN_BLOCKED',
      'INTERNAL_ERROR',
      'SYNC_FAILED',
    ])
    expect(describeMigrationReason('SHARED_PROFILE_TWIN_BLOCKED')).toEqual({
      code: 'SHARED_PROFILE_TWIN_BLOCKED',
      recognised: true,
      i18nKey: 'plansPage.deleteDialog.migrate.reasons.sharedProfileTwinBlocked',
    })
    expect(describeMigrationReason('SCHEDULED_TERM')).toEqual({
      code: 'SCHEDULED_TERM',
      recognised: true,
      i18nKey: 'plansPage.deleteDialog.migrate.reasons.scheduledTerm',
    })
    for (const code of ['PANEL_GONE', 'toString', '__proto__']) {
      expect(describeMigrationReason(code)).toEqual({
        code,
        recognised: false,
        i18nKey: PLAN_MIGRATION_UNKNOWN_REASON_I18N_KEY,
      })
    }
  })

  it('names the three problem kinds, failures as danger and skips as caution', () => {
    expect([...PLAN_MIGRATION_PROBLEM_KINDS]).toEqual(['MOVE_FAILED', 'MOVE_SKIPPED', 'SYNC_FAILED'])
    expect(describeMigrationProblemKind('MOVE_SKIPPED')).toMatchObject({ tone: 'caution', recognised: true })
    expect(describeMigrationProblemKind('MOVE_FAILED')).toMatchObject({ tone: 'danger', recognised: true })
    expect(describeMigrationProblemKind('valueOf')).toEqual({ ...PLAN_MIGRATION_UNKNOWN_PROBLEM_KIND, recognised: false })
  })
})

function runStatus(overrides: {
  readonly status?: string
  readonly finished?: boolean
  readonly totals?: Partial<PlanMigrationRunStatus['totals']>
  readonly sync?: Partial<PlanMigrationRunStatus['sync']>
  readonly problems?: PlanMigrationRunStatus['problems']
  readonly problemsCursor?: string | null
}): PlanMigrationRunStatus {
  return {
    runId: 'run-1',
    status: overrides.status ?? 'COMPLETED',
    totals: { total: 4, pending: 0, moved: 4, skipped: 0, failed: 0, skippedByReason: {}, ...overrides.totals },
    sync: { total: 3, pending: 0, completed: 3, failed: 0, ...overrides.sync },
    problems: overrides.problems ?? [],
    problemsCursor: overrides.problemsCursor ?? null,
    finished: overrides.finished ?? true,
  }
}

const problemOf = (kind: string, reason: string, subscriptionId: string): PlanMigrationRunStatus['problems'][number] => ({
  subscriptionId,
  user: null,
  targetPlanId: 'standard',
  kind,
  reason,
  detail: null,
})
const skipped = (reason: string, subscriptionId: string) => problemOf('MOVE_SKIPPED', reason, subscriptionId)
const failed = (reason: string, subscriptionId: string) => problemOf('MOVE_FAILED', reason, subscriptionId)

describe('the run', () => {
  it('is running until the server says finished AND its own counts agree', () => {
    expect(classifyMigrationRun(runStatus({ status: 'RUNNING', finished: false, totals: { pending: 2, moved: 2 } }))).toBe(
      'running',
    )
    // Inconsistent answers are not taken as finished: deleting on them would cut the move short.
    expect(classifyMigrationRun(runStatus({ finished: true, totals: { pending: 1, moved: 3 } }))).toBe('running')
    expect(classifyMigrationRun(runStatus({ finished: true, sync: { pending: 1, completed: 2 } }))).toBe('running')
  })

  // §9 A1: a sync that failed but will be retried is PENDING, and the run is not
  // finished — even though the move itself is COMPLETED and nothing is left to move.
  it('reads a completed move whose profile sync is being retried as still running, never as its result', () => {
    const retrying = runStatus({ status: 'COMPLETED', finished: false, sync: { total: 2, pending: 1, completed: 1, failed: 0 } })
    expect(isMigrationRunSettled(retrying)).toBe(false)
    expect(classifyMigrationRun(retrying)).toBe('running')
    expect(shouldPollMigrationRun(retrying, 10_000, null, 6_000)).toBe(true)
    // `finished: false` alone keeps it running, whatever the counts say.
    expect(classifyMigrationRun(runStatus({ status: 'COMPLETED', finished: false }))).toBe('running')
  })

  it('is a success when everything moved with no sync failure', () => {
    expect(classifyMigrationRun(runStatus({}))).toBe('success')
  })

  it('is a success when every skip is benign by the server’s per-reason counts — however many, and whatever the first problems page lists', () => {
    // 120 benign skips; the problems list stops at its first 100.
    const manyBenign = runStatus({
      totals: {
        total: 125,
        moved: 5,
        skipped: 120,
        skippedByReason: { NOT_ON_SOURCE_PLAN: 100, SUBSCRIPTION_DELETED: 20 },
      },
      problems: Array.from({ length: 100 }, (_, index) => skipped('NOT_ON_SOURCE_PLAN', `sub-${index}`)),
      problemsCursor: 'page-2',
    })
    expect(benignSkipCount(manyBenign.totals)).toBe(120)
    expect(classifyMigrationRun(manyBenign)).toBe('success')
    expect(
      classifyMigrationRun(runStatus({ totals: { moved: 3, skipped: 1, skippedByReason: { SUBSCRIPTION_DELETED: 1 } } })),
    ).toBe('success')
  })

  it('has problems on any failure, sync failure, or skip that keeps a subscription on the plan', () => {
    expect(classifyMigrationRun(runStatus({ totals: { moved: 3, failed: 1 } }))).toBe('problems')
    expect(classifyMigrationRun(runStatus({ sync: { completed: 2, failed: 1 } }))).toBe('problems')
    expect(
      classifyMigrationRun(runStatus({ totals: { moved: 3, skipped: 1, skippedByReason: { SCHEDULED_TERM: 1 } } })),
    ).toBe('problems')
    expect(
      classifyMigrationRun(
        runStatus({ totals: { moved: 3, skipped: 1, skippedByReason: { SHARED_PROFILE_TWIN_BLOCKED: 1 } } }),
      ),
    ).toBe('problems')
    // A skip the per-reason counts do not account for is not assumed benign.
    expect(
      classifyMigrationRun(runStatus({ totals: { moved: 2, skipped: 2, skippedByReason: { NOT_ON_SOURCE_PLAN: 1 } } })),
    ).toBe('problems')
    // Even with a benign-looking first problems page.
    expect(
      classifyMigrationRun(
        runStatus({ totals: { moved: 3, skipped: 1, skippedByReason: {} }, problems: [skipped('NOT_ON_SOURCE_PLAN', 'sub-1')] }),
      ),
    ).toBe('problems')
  })

  it('offers another plan when something failed or was held back by its profile twin, and not for a skip another plan cannot fix', () => {
    expect(canChooseAnotherTarget(runStatus({ totals: { failed: 1 } }).totals)).toBe(true)
    expect(
      canChooseAnotherTarget(runStatus({ totals: { skipped: 2, skippedByReason: { SHARED_PROFILE_TWIN_BLOCKED: 2 } } }).totals),
    ).toBe(true)
    expect(canChooseAnotherTarget(runStatus({ totals: { skipped: 2, skippedByReason: { SCHEDULED_TERM: 2 } } }).totals)).toBe(
      false,
    )
    expect(canChooseAnotherTarget(runStatus({}).totals)).toBe(false)
  })

  it('knows a retry would only fail again when the complete list holds only failures another plan must fix', () => {
    const targetOnly = [
      failed('TARGET_DELETED', 'a'),
      failed('TARGET_IS_TRIAL', 'b'),
      failed('SHARED_PROFILE_TARGET_CONFLICT', 'c'),
    ]
    expect(failuresNeedAnotherTarget(targetOnly, true, 3)).toBe(true)
    // Skips and sync failures beside them change nothing.
    expect(failuresNeedAnotherTarget([...targetOnly, skipped('SCHEDULED_TERM', 'd')], true, 3)).toBe(true)
    // One failure a retry may fix keeps the retry.
    expect(failuresNeedAnotherTarget([...targetOnly, failed('INTERNAL_ERROR', 'e')], true, 4)).toBe(false)
    // An incomplete list — more pages, or fewer failures listed than counted — proves nothing.
    expect(failuresNeedAnotherTarget(targetOnly, false, 3)).toBe(false)
    expect(failuresNeedAnotherTarget(targetOnly, true, 4)).toBe(false)
    expect(failuresNeedAnotherTarget([], true, 0)).toBe(false)
  })

  // A held-back twin FAILS only when its blocker failed, and a retry retries both
  // together: whether that can help is the BLOCKER's reason, read off `detail`.
  it('decides whether retrying a held-back twin helps by the reason of the twin holding it back', () => {
    const twin = (blockerReason: string, id: string) => ({
      ...failed('SHARED_PROFILE_TWIN_BLOCKED', id),
      detail: `Twin cmf0blocker on the same Remnawave profile: ${blockerReason}`,
    })
    // Blocked by a failure a retry may clear: retry them.
    expect(failuresNeedAnotherTarget([failed('INTERNAL_ERROR', 'a'), twin('INTERNAL_ERROR', 'b')], true, 2)).toBe(false)
    // Blocked by a deleted target: retrying both fails both again.
    expect(failuresNeedAnotherTarget([failed('TARGET_DELETED', 'a'), twin('TARGET_DELETED', 'b')], true, 2)).toBe(true)
    // A detail this build cannot read is taken as retryable, like the code itself.
    const unreadable = { ...failed('SHARED_PROFILE_TWIN_BLOCKED', 'c'), detail: 'blocked' }
    expect(failuresNeedAnotherTarget([failed('TARGET_DELETED', 'a'), unreadable], true, 2)).toBe(false)
  })

  it('reads the blocker’s reason off a held-back twin’s detail, as the backend writes it, and nothing off anything else', () => {
    expect(twinBlockerReason('Twin cmf1a2b3 on the same Remnawave profile: SCHEDULED_TERM')).toBe('SCHEDULED_TERM')
    expect(
      twinBlockerReason('Twin cmf1a2b3 on the same Remnawave profile: TARGET_DELETED; 2 more twin(s) cannot move either'),
    ).toBe('TARGET_DELETED')
    for (const detail of [
      null,
      '',
      'Row lock timeout',
      'Twin cmf1 on the same Remnawave profile: ',
      'Twin cmf1 on the same Remnawave profile: lower_case',
      // Not a twin's detail, though it ends like one.
      'Deadlock on the same Remnawave profile: INTERNAL_ERROR',
      // Cut short at the column's length: the code may be cut too.
      'Twin cmf1 on the same Remnawave profile: TARGET_DELE…',
    ]) {
      expect(twinBlockerReason(detail)).toBeNull()
    }
  })

  it('says a held-back twin’s blocker reason in words when it knows the code, and the detail as it came otherwise', () => {
    const twinWith = (detail: string | null) => ({ ...skipped('SHARED_PROFILE_TWIN_BLOCKED', 'a'), detail })
    expect(describeProblemDetail(twinWith('Twin cmf9 on the same Remnawave profile: SCHEDULED_TERM'))).toEqual({
      kind: 'blockerReason',
      reason: { code: 'SCHEDULED_TERM', recognised: true, i18nKey: 'plansPage.deleteDialog.migrate.reasons.scheduledTerm' },
    })
    expect(describeProblemDetail(twinWith('Twin cmf9 on the same Remnawave profile: PANEL_GONE'))).toEqual({
      kind: 'raw',
      text: 'Twin cmf9 on the same Remnawave profile: PANEL_GONE',
    })
    expect(describeProblemDetail(twinWith(null))).toBeNull()
    // Any other reason shows its detail as it came, even one that looks like a twin's.
    expect(
      describeProblemDetail({ ...failed('INTERNAL_ERROR', 'b'), detail: 'Twin x on the same Remnawave profile: SCHEDULED_TERM' }),
    ).toEqual({ kind: 'raw', text: 'Twin x on the same Remnawave profile: SCHEDULED_TERM' })
    expect(describeProblemDetail({ ...failed('INTERNAL_ERROR', 'b'), detail: '' })).toBeNull()
  })

  it('keeps polling without an answer and while running, and stops on a settled run with no retry pending', () => {
    const settled = runStatus({})
    expect(shouldPollMigrationRun(undefined, 0, null, 6_000)).toBe(true)
    expect(shouldPollMigrationRun(runStatus({ status: 'RUNNING', finished: false, totals: { pending: 1 } }), 10, null, 6_000)).toBe(
      true,
    )
    expect(shouldPollMigrationRun(settled, 10_000, null, 6_000)).toBe(false)
  })

  it('keeps reading a settled answer as the run before a retry until the window has passed', () => {
    const settled = runStatus({ totals: { moved: 3, failed: 1 } })
    // Fetched before the retry was accepted, and shortly after it.
    expect(isAwaitingRetryEcho(settled, 9_000, 10_000, 6_000)).toBe(true)
    expect(isAwaitingRetryEcho(settled, 15_999, 10_000, 6_000)).toBe(true)
    expect(shouldPollMigrationRun(settled, 15_999, 10_000, 6_000)).toBe(true)
    // Past the window it is the answer.
    expect(isAwaitingRetryEcho(settled, 16_000, 10_000, 6_000)).toBe(false)
    expect(shouldPollMigrationRun(settled, 16_000, 10_000, 6_000)).toBe(false)
    // A running answer is the retry's own: nothing to wait out.
    expect(isAwaitingRetryEcho(runStatus({ finished: false, totals: { pending: 1 } }), 10_001, 10_000, 6_000)).toBe(false)
    expect(isAwaitingRetryEcho(settled, 10_001, null, 6_000)).toBe(false)
  })

  it('counts progress as moved + skipped + failed, then completed + failed sync jobs, phase by phase', () => {
    expect(describeMigrationProgress(runStatus({ status: 'QUEUED', finished: false, totals: { pending: 4, moved: 0 } }))).toEqual({
      phase: 'queued',
      move: { done: 0, total: 4 },
      sync: { done: 3, failed: 0, total: 3 },
    })
    expect(
      describeMigrationProgress(
        runStatus({ status: 'RUNNING', finished: false, totals: { pending: 1, moved: 1, skipped: 1, failed: 1 } }),
      ),
    ).toMatchObject({ phase: 'moving', move: { done: 3, total: 4 } })
    expect(
      describeMigrationProgress(runStatus({ status: 'COMPLETED', finished: false, sync: { pending: 2, completed: 0, failed: 1 } })),
    ).toMatchObject({ phase: 'syncing', sync: { done: 1, failed: 1, total: 3 } })
    expect(describeMigrationProgress(runStatus({})).phase).toBe('settled')
    expect(progressPercent(0, 0)).toBe(100)
    expect(progressPercent(1, 3)).toBe(33)
    expect(progressPercent(7, 5)).toBe(100)
  })
})

describe('refusals', () => {
  it('names exactly the 400/409 codes of the preview and the start, and refreshes the targets only after a target refusal', () => {
    expect([...PLAN_MIGRATION_REFUSAL_I18N_KEYS.keys()].sort()).toEqual([
      'DUPLICATE_SUBSCRIPTION',
      'EMPTY_ASSIGNMENT',
      'MIGRATION_ALREADY_RUNNING',
      'TARGET_IS_SOURCE',
      'TARGET_IS_TRIAL',
      'TARGET_NOT_FOUND',
      'TOO_MANY_IDS',
    ])
    expect([...PLAN_MIGRATION_TARGET_REFUSALS].sort()).toEqual(['TARGET_IS_SOURCE', 'TARGET_IS_TRIAL', 'TARGET_NOT_FOUND'])
    // Server-controlled text: a code spelled like a prototype member is not a refusal.
    expect(PLAN_MIGRATION_REFUSAL_I18N_KEYS.get('toString')).toBeUndefined()
  })

  // The safe error filter writes a generic `errorCode` on every error, so a 500
  // arrives as `INTERNAL_SERVER_ERROR`: a code, and still worth asking again.
  it('treats only the codes it names as final refusals', () => {
    expect(isKnownMigrationRefusal('TOO_MANY_IDS')).toBe(true)
    for (const code of ['INTERNAL_SERVER_ERROR', 'BAD_REQUEST', 'SERVICE_UNAVAILABLE', 'toString', null]) {
      expect(isKnownMigrationRefusal(code)).toBe(false)
    }
  })

  it('recognises a request that got no answer — a timeout or a dropped connection — and nothing else', () => {
    expect(isNoResponseError({ isAxiosError: true, code: 'ECONNABORTED', response: undefined })).toBe(true)
    expect(isNoResponseError({ isAxiosError: true, code: 'ERR_NETWORK' })).toBe(true)
    expect(isNoResponseError({ isAxiosError: true, code: 'ETIMEDOUT', response: null })).toBe(true)
    // An answer, however bad, is not "no answer".
    expect(isNoResponseError({ isAxiosError: true, code: 'ERR_BAD_RESPONSE', response: { status: 500 } })).toBe(false)
    // The dialog abandoning its own request is not the server's silence.
    expect(isNoResponseError({ isAxiosError: true, code: 'ERR_CANCELED' })).toBe(false)
    expect(isNoResponseError(new Error('Network Error'))).toBe(false)
    expect(isNoResponseError(null)).toBe(false)
  })

  // The app's request-timeout middleware answers 408 while the handler goes on and
  // commits; a proxy in front of it answers 504 the same way.
  it('takes a start that got no answer, a 408 or a 504 as one that may have started all the same', () => {
    const answered = (status: number, data: unknown = null) => ({
      isAxiosError: true,
      code: status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
      response: { status, data },
    })
    expect(mayHaveStartedAnyway({ isAxiosError: true, code: 'ECONNABORTED', response: undefined })).toBe(true)
    expect(mayHaveStartedAnyway({ isAxiosError: true, code: 'ERR_NETWORK' })).toBe(true)
    expect(
      mayHaveStartedAnyway(answered(408, { statusCode: 408, message: 'Request timed out after 120000ms', error: 'Request Timeout' })),
    ).toBe(true)
    expect(mayHaveStartedAnyway(answered(504, '<html>504 Gateway Time-out</html>'))).toBe(true)
    // A verdict, whatever it is, says what happened.
    for (const status of [400, 403, 404, 409, 500, 502, 503]) expect(mayHaveStartedAnyway(answered(status)), String(status)).toBe(false)
    expect(mayHaveStartedAnyway({ isAxiosError: true, code: 'ERR_CANCELED' })).toBe(false)
    // Only an HTTP client's error has a status to read.
    expect(mayHaveStartedAnyway({ response: { status: 408 } })).toBe(false)
    expect(mayHaveStartedAnyway(null)).toBe(false)
  })
})

describe('describeSubscriber', () => {
  const user = (fields: Partial<Record<'name' | 'username' | 'telegramId' | 'email', string | null>>) => ({
    id: 'user-1',
    name: null,
    username: null,
    telegramId: null,
    email: null,
    ...fields,
  })

  it('leads with the name and lists the other identifiers', () => {
    expect(describeSubscriber(user({ name: 'Alice', username: 'alice', telegramId: '4242', email: 'a@x.io' }), 'sub-1')).toEqual({
      primary: 'Alice',
      anonymous: false,
      details: [
        { kind: 'username', value: '@alice' },
        { kind: 'telegramId', value: '4242' },
        { kind: 'email', value: 'a@x.io' },
      ],
    })
  })

  it('falls back to @username, then email, then Telegram ID, and only then to the subscription id', () => {
    expect(describeSubscriber(user({ name: '  ', username: '@bob' }), 'sub-1').primary).toBe('@bob')
    expect(describeSubscriber(user({ email: 'c@x.io', telegramId: '7' }), 'sub-1')).toMatchObject({
      primary: 'c@x.io',
      details: [{ kind: 'telegramId', value: '7' }],
    })
    expect(describeSubscriber(user({ telegramId: '7' }), 'sub-1')).toMatchObject({ primary: '7', details: [] })
    expect(describeSubscriber(null, 'sub-1')).toEqual({ primary: 'sub-1', anonymous: true, details: [] })
    expect(describeSubscriber(undefined, 'sub-2')).toEqual({ primary: 'sub-2', anonymous: true, details: [] })
  })
})

// ── The dictionaries ────────────────────────────────────────────────────────

const MIGRATE_ROOT = 'plansPage.deleteDialog.migrate.'
const PLURAL_FORMS = { en: ['one', 'other'], ru: ['one', 'few', 'many', 'other'] } as const
const DICTIONARIES = { en: en as unknown, ru: ru as unknown }

/** Every product source file of this feature, tests excluded. */
function featureSources(): string {
  const dir = join(process.cwd(), 'src', 'features', 'plans')
  return readdirSync(dir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n')
}

/** A key resolves when it is a sentence, or a plural set with `{{count}}` in each form. */
function resolves(lng: 'en' | 'ru', key: string): boolean {
  const dictionary = DICTIONARIES[lng]
  if (typeof valueAt(dictionary, key) === 'string') return true
  return PLURAL_FORMS[lng].every((form) => {
    const sentence = valueAt(dictionary, `${key}_${form}`)
    return typeof sentence === 'string' && sentence.includes('{{count}}')
  })
}

describe('the migrate dictionaries', () => {
  const sources = featureSources()
  const namedByCode = [...new Set(sources.match(/plansPage\.deleteDialog\.migrate\.[A-Za-z0-9_.]+[A-Za-z0-9]/g) ?? [])]

  it.each(['en', 'ru'] as const)('%s words every migrate key the code names', (lng) => {
    // Anti-vacuity: the scan found the tables and the components.
    expect(namedByCode.length).toBeGreaterThan(90)
    expect(namedByCode.filter((key) => !resolves(lng, key))).toEqual([])
  })

  it.each(['en', 'ru'] as const)('%s holds no migrate key the code never names', (lng) => {
    const stored = keyPaths(valueAt(DICTIONARIES[lng], 'plansPage.deleteDialog.migrate'), 'plansPage.deleteDialog.migrate')
    const bases = [...new Set(stored.map((key) => key.replace(/_(one|few|many|other)$/, '')))]
    expect(bases.length).toBeGreaterThan(90)
    expect(bases.filter((key) => !sources.includes(`'${key}'`))).toEqual([])
  })

  it.each(['en', 'ru'] as const)('%s puts the code into the "unknown" labels, and the count into every count', (lng) => {
    const dictionary = DICTIONARIES[lng]
    for (const key of [PLAN_MIGRATION_UNKNOWN_WARNING.labelKey, PLAN_MIGRATION_UNKNOWN_PROBLEM_KIND.i18nKey]) {
      expect(valueAt(dictionary, key), `${lng}: ${key}`).toContain('{{code}}')
    }
    // An unknown REASON is a generic sentence; the raw code is printed beside it, not inside it.
    expect(valueAt(dictionary, PLAN_MIGRATION_UNKNOWN_REASON_I18N_KEY), lng).not.toContain('{{')
    expect(valueAt(dictionary, `${MIGRATE_ROOT}preview.skippedCount`), lng).toContain('{{count}}')
    for (const key of ['choose.lead', 'choose.selectAll', 'choose.unassignedHint', 'preview.count']) {
      for (const form of PLURAL_FORMS[lng]) {
        expect(valueAt(dictionary, `${MIGRATE_ROOT}${key}_${form}`), `${lng}: ${key}_${form}`).toContain('{{count}}')
      }
    }
    expect(valueAt(dictionary, `${MIGRATE_ROOT}choose.selectRow`)).toContain('{{name}}')
    expect(valueAt(dictionary, `${MIGRATE_ROOT}preview.willSkip`)).toContain('{{reason}}')
  })

  // A reason is put after a colon in the preview and in «Почему ту нельзя
  // перенести: …», and starts the line in the problems list — so it must read as
  // the rest of one sentence in each, and bring no colon of its own.
  it('reads a held-back twin as one sentence wherever its reason is put', () => {
    const at = (lng: 'en' | 'ru', key: string): string => valueAt(DICTIONARIES[lng], `${MIGRATE_ROOT}${key}`) as string
    expect(at('ru', 'preview.willSkip').replace('{{reason}}', at('ru', 'reasons.sharedProfileTwinBlocked'))).toBe(
      'Перенос пропустит эту подписку: другую подписку на том же профиле Remnawave перенести нельзя, а переносятся они только вместе',
    )
    expect(at('ru', 'problems.twinReason').replace('{{reason}}', at('ru', 'reasons.scheduledTerm'))).toBe(
      'Почему ту нельзя перенести: подписка уже продлена заранее',
    )
    expect(at('en', 'preview.willSkip').replace('{{reason}}', at('en', 'reasons.sharedProfileTwinBlocked'))).toBe(
      'The move skips this subscription: another subscription on the same Remnawave profile cannot be moved, and they only move together',
    )
    for (const lng of ['en', 'ru'] as const) {
      for (const code of PLAN_MIGRATION_REASON_CODES) {
        expect(valueAt(DICTIONARIES[lng], PLAN_MIGRATION_REASON_I18N_KEYS[code]), `${lng}: ${code}`).not.toContain(':')
      }
    }
  })

  it('words every table entry in both languages, never as its own key path', () => {
    const tableKeys = [
      ...PLAN_MIGRATION_WARNING_CODES.flatMap((code) => [
        PLAN_MIGRATION_WARNING_SPECS[code].labelKey,
        PLAN_MIGRATION_WARNING_SPECS[code].hintKey,
      ]),
      ...PLAN_MIGRATION_REASON_CODES.map((code) => PLAN_MIGRATION_REASON_I18N_KEYS[code]),
      ...PLAN_MIGRATION_PROBLEM_KINDS.map((kind) => PLAN_MIGRATION_PROBLEM_KIND_SPECS[kind].i18nKey),
      ...PLAN_MIGRATION_REFUSAL_I18N_KEYS.values(),
    ]
    expect(tableKeys).toHaveLength(16 + 9 + 3 + 7)
    for (const lng of ['en', 'ru'] as const) {
      for (const key of tableKeys) {
        const sentence = valueAt(DICTIONARIES[lng], key)
        expect(typeof sentence, `${lng}: ${key}`).toBe('string')
        expect((sentence as string).trim().length, `${lng}: ${key}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('motion', () => {
  // A spinner beside words that already say what is happening is decoration:
  // with "reduce motion" it holds still, like every other animation of the steps.
  it('puts every animation of the migration steps behind motion-safe', () => {
    const dir = join(process.cwd(), 'src', 'features', 'plans')
    const files = readdirSync(dir).filter((file) => /^plan-migration-.*\.tsx$/.test(file) && !/\.test\.tsx$/.test(file))
    const unguarded: string[] = []
    let animations = 0
    for (const file of files) {
      for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/(?<![\w-])((?:[\w-]+:)*)animate-[^\s"'`]+/g)) {
        animations += 1
        if (!match[1].split(':').includes('motion-safe')) unguarded.push(`${file}: ${match[0]}`)
      }
    }
    // Anti-vacuity: the scan reached both the 11 spinners and the 6 drawn animations.
    expect(animations).toBeGreaterThanOrEqual(17)
    expect(unguarded).toEqual([])
  })
})
