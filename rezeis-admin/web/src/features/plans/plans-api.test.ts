import { describe, expect, it } from 'vitest'

import { plansListOptions, plansQueryKeys, type Plan } from './plans-api'

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
