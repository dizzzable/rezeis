import { describe, expect, it } from 'vitest'

import { plansListOptions, plansQueryKeys, readPlanReferences, type Plan } from './plans-api'

const ACTIVE_PLAN: Plan = {
  id: '1',
  name: 'Active',
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
  cashbackMode: 'INHERIT',
  cashbackPercent: null,
}

const INACTIVE_PLAN: Plan = {
  ...ACTIVE_PLAN,
  id: '2',
  name: 'Inactive',
  isActive: false,
}

const ARCHIVED_PLAN: Plan = {
  ...ACTIVE_PLAN,
  id: '3',
  name: 'Archived',
  isArchived: true,
  isActive: false,
}

describe('plansQueryKeys', () => {
  it('returns canonical root key', () => {
    expect(plansQueryKeys.all).toEqual(['admin', 'plans'])
  })

  it('namespaces lists under root', () => {
    expect(plansQueryKeys.lists()).toEqual(['admin', 'plans', 'list'])
  })

  it('appends filters to the list key for cache parameterisation', () => {
    expect(plansQueryKeys.list({ active: true })).toEqual([
      'admin',
      'plans',
      'list',
      { active: true },
    ])
    expect(plansQueryKeys.list({ active: false })).toEqual([
      'admin',
      'plans',
      'list',
      { active: false },
    ])
    expect(plansQueryKeys.list(undefined)).toEqual(['admin', 'plans', 'list', {}])
  })

  // A successful delete invalidates `all` while the dialog that read these
  // references is still mounted. Under that root they would be refetched on the
  // spot, for the plan that was just deleted — a guaranteed 404.
  it('keeps the references key outside the catalogue root', () => {
    const key = plansQueryKeys.references('plan-1')
    expect(key).toEqual(['admin', 'plan-references', 'plan-1'])
    expect(key.slice(0, plansQueryKeys.all.length)).not.toEqual([...plansQueryKeys.all])
  })
})

describe('readPlanReferences', () => {
  it('reads the rows the server sent, in its order', () => {
    expect(
      readPlanReferences({
        planId: 'plan-1',
        references: [
          { kind: 'subscriptions', count: 3 },
          { kind: 'loyaltyTiers', count: 1 },
        ],
      }),
    ).toEqual([
      { kind: 'subscriptions', count: 3 },
      { kind: 'loyaltyTiers', count: 1 },
    ])
  })

  it('reads an empty list as nothing using the plan, with or without planId', () => {
    expect(readPlanReferences({ planId: 'plan-1', references: [] })).toEqual([])
    expect(readPlanReferences({ references: [] })).toEqual([])
  })

  // An empty list is the sentence "deleted for good". Saying it about a body
  // this build could not read would be a confident false statement, so every
  // one of these must throw — the dialog renders a throw as "could not check".
  it.each([
    ['no body', undefined],
    ['an HTML page', '<!doctype html><html></html>'],
    ['a bare array', [{ kind: 'subscriptions', count: 1 }]],
    ['no references', { planId: 'plan-1' }],
    ['references that are not a list', { references: { subscriptions: 1 } }],
    ['a row that is not an object', { references: ['subscriptions'] }],
    ['a row with no kind', { references: [{ count: 1 }] }],
    ['a row with an empty kind', { references: [{ kind: '', count: 1 }] }],
    ['a count sent as text', { references: [{ kind: 'subscriptions', count: '3' }] }],
    ['a fractional count', { references: [{ kind: 'subscriptions', count: 1.5 }] }],
    ['a negative count', { references: [{ kind: 'subscriptions', count: -1 }] }],
    ['a count that is not a number at all', { references: [{ kind: 'subscriptions', count: null }] }],
  ])('throws on %s', (_label, body) => {
    expect(() => readPlanReferences(body)).toThrow()
  })
})

describe('plansListOptions select filter', () => {
  const SAMPLE: ReadonlyArray<Plan> = [ACTIVE_PLAN, INACTIVE_PLAN, ARCHIVED_PLAN]

  it('returns the full catalog when no filter is supplied', () => {
    const select = plansListOptions().select
    expect(select).toBeDefined()
    expect(select!(SAMPLE)).toEqual(SAMPLE)
  })

  it('keeps only active plans when active=true', () => {
    const select = plansListOptions({ active: true }).select
    expect(select!(SAMPLE)).toEqual([ACTIVE_PLAN])
  })

  it('keeps only inactive plans when active=false', () => {
    const select = plansListOptions({ active: false }).select
    expect(select!(SAMPLE)).toEqual([INACTIVE_PLAN, ARCHIVED_PLAN])
  })
})
