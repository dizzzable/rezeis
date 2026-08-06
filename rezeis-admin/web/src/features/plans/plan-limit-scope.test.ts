import { describe, expect, it } from 'vitest'

import {
  describePlanLimitChanges,
  summarizePlanLimitDirection,
  type PlanLimitScopeInput,
} from './plan-limit-scope'

function scope(overrides: Partial<PlanLimitScopeInput> = {}): PlanLimitScopeInput {
  return {
    isSavedPlan: true,
    savedType: 'BOTH',
    draftType: 'BOTH',
    savedTrafficLimitGB: '50',
    draftTrafficLimitGB: '50',
    savedDeviceLimit: '3',
    draftDeviceLimit: '3',
    ...overrides,
  }
}

describe('describePlanLimitChanges', () => {
  it('says nothing while creating a plan — there is nobody to defer for', () => {
    expect(
      describePlanLimitChanges(scope({ isSavedPlan: false, draftTrafficLimitGB: '20' })),
    ).toEqual([])
  })

  it('says nothing when the edit leaves both limits alone', () => {
    expect(describePlanLimitChanges(scope())).toEqual([])
  })

  it('reports a traffic cut', () => {
    expect(describePlanLimitChanges(scope({ draftTrafficLimitGB: '20' }))).toEqual([
      { field: 'traffic', from: 50, to: 20, direction: 'cut' },
    ])
  })

  it('reports a device raise', () => {
    expect(describePlanLimitChanges(scope({ draftDeviceLimit: '5' }))).toEqual([
      { field: 'device', from: 3, to: 5, direction: 'raise' },
    ])
  })

  // 0 is the "unlimited" sentinel on both fields, so a naive `to > from`
  // comparison calls this a cut and shows the operator the reassuring copy
  // ("nobody is reduced today") over what is actually a giveaway — and, worse,
  // calls the reverse a raise and stays quiet about a real reduction.
  it('treats a move to 0 as a raise, because 0 means unlimited', () => {
    expect(describePlanLimitChanges(scope({ draftTrafficLimitGB: '0' }))).toEqual([
      { field: 'traffic', from: 50, to: 0, direction: 'raise' },
    ])
  })

  it('treats a move away from 0 as a cut, because it puts a cap on', () => {
    expect(
      describePlanLimitChanges(scope({ savedTrafficLimitGB: '0', draftTrafficLimitGB: '50' })),
    ).toEqual([{ field: 'traffic', from: 0, to: 50, direction: 'cut' }])
  })

  it('treats capping an unlimited device allowance as a cut', () => {
    expect(
      describePlanLimitChanges(scope({ savedDeviceLimit: '0', draftDeviceLimit: '2' })),
    ).toEqual([{ field: 'device', from: 0, to: 2, direction: 'cut' }])
  })

  it('reports both fields when both moved', () => {
    expect(
      describePlanLimitChanges(scope({ draftTrafficLimitGB: '100', draftDeviceLimit: '1' })),
    ).toEqual([
      { field: 'traffic', from: 50, to: 100, direction: 'raise' },
      { field: 'device', from: 3, to: 1, direction: 'cut' },
    ])
  })

  // The type drives the persisted limits (`normalizePlanWriteInput`), so a type
  // switch changes them without either number being touched.
  it('sees switching the plan to UNLIMITED as raising both limits', () => {
    expect(describePlanLimitChanges(scope({ draftType: 'UNLIMITED' }))).toEqual([
      { field: 'traffic', from: 50, to: 0, direction: 'raise' },
      { field: 'device', from: 3, to: 0, direction: 'raise' },
    ])
  })

  it('sees switching to DEVICES as dropping the traffic cap only', () => {
    expect(describePlanLimitChanges(scope({ draftType: 'DEVICES' }))).toEqual([
      { field: 'traffic', from: 50, to: 0, direction: 'raise' },
    ])
  })

  it('ignores the traffic box a DEVICES plan does not use', () => {
    expect(
      describePlanLimitChanges(
        scope({ savedType: 'DEVICES', draftType: 'DEVICES', draftTrafficLimitGB: '999' }),
      ),
    ).toEqual([])
  })

  // A cleared box is mid-typing, not an edit. `Number('')` is 0, which would
  // otherwise read as "unlimited" and announce a raise the operator never made.
  it('stays quiet on a half-typed value instead of announcing a phantom raise', () => {
    expect(describePlanLimitChanges(scope({ draftTrafficLimitGB: '' }))).toEqual([])
    expect(describePlanLimitChanges(scope({ draftTrafficLimitGB: '  ' }))).toEqual([])
    expect(describePlanLimitChanges(scope({ draftDeviceLimit: '-' }))).toEqual([])
    expect(describePlanLimitChanges(scope({ draftTrafficLimitGB: '1.5' }))).toEqual([])
  })
})

describe('summarizePlanLimitDirection', () => {
  it('has nothing to say about an edit that changed no limit', () => {
    expect(summarizePlanLimitDirection([])).toBeNull()
  })

  it('reports a single direction when every field moved the same way', () => {
    expect(summarizePlanLimitDirection(describePlanLimitChanges(scope({ draftTrafficLimitGB: '20' })))).toBe('cut')
    expect(summarizePlanLimitDirection(describePlanLimitChanges(scope({ draftDeviceLimit: '9' })))).toBe('raise')
  })

  // Traffic up while devices come down: neither the "nobody is reduced" nor the
  // "you gave something away" sentence is true, so the copy has to hedge.
  it('reports mixed when the fields moved opposite ways', () => {
    expect(
      summarizePlanLimitDirection(
        describePlanLimitChanges(scope({ draftTrafficLimitGB: '100', draftDeviceLimit: '1' })),
      ),
    ).toBe('mixed')
  })
})
