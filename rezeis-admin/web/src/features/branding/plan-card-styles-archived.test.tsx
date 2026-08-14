/**
 * The tariff-cards editor must list ARCHIVED plans too.
 *
 * `plan-card-styles-section.tsx` opens with the claim "Lists every plan (incl.
 * archived)", and until now nothing held it to that. The claim is only true by
 * a chain of three independent decisions, none of which is local to that file:
 *
 *   1. `PlansAdminService.listPlans` issues a `findMany` with NO `where`, so
 *      the admin endpoint returns archived rows (the public catalog path,
 *      `PlanCatalogService.getCatalog`, filters `isArchived: false` — the two
 *      are deliberately different);
 *   2. `plansListOptions` only applies a `select` filter when `active` is
 *      passed, and it filters `isActive`, never `isArchived`;
 *   3. the section calls `usePlans()` with no filters at all.
 *
 * Any one of those flipping — most cheaply step 3, a one-word edit to
 * `usePlans({ active: true })` — silently drops archived plans from the editor
 * and turns the doc comment into a lie. It matters because an archived plan is
 * still rendered in the cabinet for the subscribers who bought it, so its card
 * still needs a look; losing the row means losing the only way to fix one.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import type { Plan } from '@/features/plans/plans-api'
import { PlanCardStylesSection } from './plan-card-styles-section'

afterEach(() => {
  vi.restoreAllMocks()
})

const BASE_PLAN: Plan = {
  id: 'plan-live',
  name: 'Premium Live',
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

const ARCHIVED_PLAN: Plan = {
  ...BASE_PLAN,
  id: 'plan-retired',
  name: 'Legacy Retired',
  isActive: false,
  isArchived: true,
}

function mockPlansEndpoint(plans: readonly Plan[]): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/plans') return { data: plans }
    return { data: [] }
  })
}

describe('PlanCardStylesSection plan list', () => {
  it('lists archived plans alongside live ones, and marks them archived', async () => {
    mockPlansEndpoint([BASE_PLAN, ARCHIVED_PLAN])

    renderWithProviders(
      <PlanCardStylesSection value={{}} onChange={vi.fn()} primary="#7c3aed" />,
    )

    // Each row prints the name twice — once inside the mini card preview, once
    // as the row label — so these are `findAll`/`getAll` by construction.
    expect(await screen.findAllByText('Legacy Retired')).not.toHaveLength(0)
    expect(screen.getAllByText('Premium Live')).not.toHaveLength(0)
    // The badge is what tells the operator why a card they cannot sell anymore
    // is still on the list.
    expect(screen.getByText('archived')).toBeInTheDocument()
  })

  it('shows an archived-only catalog rather than the empty state', async () => {
    // The degenerate case the `active: true` regression would produce: every
    // plan archived and the editor claiming there are no plans at all.
    mockPlansEndpoint([ARCHIVED_PLAN])

    renderWithProviders(
      <PlanCardStylesSection value={{}} onChange={vi.fn()} primary="#7c3aed" />,
    )

    expect(await screen.findAllByText('Legacy Retired')).not.toHaveLength(0)
    expect(
      screen.queryByText('No plans yet — create plans in the plan configurator first.'),
    ).not.toBeInTheDocument()
  })
})
