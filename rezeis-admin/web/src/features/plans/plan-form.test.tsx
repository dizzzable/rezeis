import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { PlanForm } from './plan-form'
import type { Plan } from './plans-api'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PlanForm validation', () => {
  it('blocks invalid plan payloads before submit', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()

    renderWithProviders(<PlanForm onSubmit={onSubmit} isLoading={false} />)

    await user.type(screen.getByPlaceholderText('Premium 50GB'), 'Premium')
    await user.clear(screen.getByDisplayValue('50'))
    await user.click(screen.getByRole('button', { name: 'Create plan' }))

    expect(await screen.findByText('Enter a whole number of GB, or 0 for unlimited.')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('PlanForm accessibility', () => {
  it('names dynamic pricing controls', async () => {
    const user = userEvent.setup()

    renderWithProviders(<PlanForm onSubmit={vi.fn()} isLoading={false} />)

    expect(screen.getByRole('spinbutton', { name: 'Duration 1 days' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Duration 1 price 1 currency' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Duration 1 price 1 amount' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add currency to duration 1' }))
    expect(screen.getByRole('button', { name: 'Remove duration 1 price 2' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add duration' }))
    expect(screen.getByRole('button', { name: 'Remove duration 2' })).toBeInTheDocument()
  })

  it('makes upgrade plan chips keyboard-operable toggle buttons', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/plans') return { data: [planOption()] }
      if (path === '/admin/remnawave/internal-squads') return { data: [] }
      if (path === '/admin/remnawave/external-squads') return { data: [] }
      if (path === '/admin/settings/icons') return { data: [] }
      return { data: [] }
    })

    renderWithProviders(<PlanForm onSubmit={vi.fn()} isLoading={false} />)

    const upgradeButton = await screen.findByRole('button', { name: 'Premium' })
    expect(upgradeButton).toHaveAttribute('aria-pressed', 'false')

    upgradeButton.focus()
    expect(upgradeButton).toHaveFocus()
    await user.keyboard('[Space]')

    expect(upgradeButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('makes allowed-user chips keyboard-removable and named', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(
      <PlanForm
        plan={{ availability: 'ALLOWED', allowedUserIds: ['user-1234567890'] }}
        onSubmit={vi.fn()}
        isLoading={false}
      />,
    )

    const removeButton = screen.getByRole('button', { name: 'Remove allowed user user-1234567890' })
    removeButton.focus()
    expect(removeButton).toHaveFocus()

    await user.keyboard('[Space]')

    expect(screen.queryByRole('button', { name: 'Remove allowed user user-1234567890' })).not.toBeInTheDocument()
  })
})

// A plan edit does NOT push new traffic/device limits to existing subscribers —
// the panel only learns about them at the subscriber's next renewal or upgrade.
// That deferral is deliberate (see `plan-limit-scope.ts`), but it was never
// stated anywhere the operator could see it, so a correct product rule read as
// a bug: you changed the limit, you were told "Plan updated", and the customers
// kept the old numbers forever with no explanation.
//
// These pin the statement itself. Deleting the notice must break a test.
describe('PlanForm limit-change scope notice', () => {
  it('tells the operator a limit cut waits for renewal, and names both numbers', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(
      <PlanForm plan={planOption()} onSubmit={vi.fn()} isLoading={false} />,
    )

    const trafficInput = screen.getByDisplayValue('50')
    await user.clear(trafficInput)
    await user.type(trafficInput, '20')

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Limit changes reach existing subscribers on renewal')
    expect(notice).toHaveTextContent('Traffic limit: 50 GB → 20 GB')
    expect(notice).toHaveTextContent(
      'Subscribers who already bought this plan keep their current limits — nobody is reduced today. The new limits apply from their next renewal or upgrade.',
    )
  })

  // "On renewal" is only half the rule, and the missing half is the whole point
  // of the feature: a subscriber whose limit an operator set by hand from the
  // Users page is EXEMPT. `resolveInheritedPlanLimitUpdate` re-applies the plan
  // only to the fields whose columns still match that subscription's own
  // `plan_snapshot`, so an individual adjustment outlives the renewal that
  // moves everyone else. Saying nothing here sends an operator hunting a bug
  // when the one customer they hand-tuned does not move with the rest.
  it('states that individually adjusted subscribers are exempt', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(
      <PlanForm plan={planOption()} onSubmit={vi.fn()} isLoading={false} />,
    )

    const trafficInput = screen.getByDisplayValue('50')
    await user.clear(trafficInput)
    await user.type(trafficInput, '20')

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent(
      'Subscribers whose limits an operator set by hand are exempt — renewal leaves an individual adjustment alone.',
    )
  })

  // A raise is not the same event as a cut: nothing is being taken away, but the
  // operator still must not walk away believing the extra allowance is live.
  it('warns that a limit raise is not delivered yet', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(
      <PlanForm plan={planOption()} onSubmit={vi.fn()} isLoading={false} />,
    )

    const trafficInput = screen.getByDisplayValue('50')
    await user.clear(trafficInput)
    await user.type(trafficInput, '100')

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Traffic limit: 50 GB → 100 GB')
    expect(notice).toHaveTextContent(
      'Subscribers who already bought this plan do not get the higher limits today; those apply from their next renewal or upgrade. New purchases get them right away.',
    )
  })

  // 0 is the unlimited sentinel, so this is a giveaway, not a reduction.
  it('reads a drop to 0 as lifting the cap rather than cutting it', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(
      <PlanForm plan={planOption()} onSubmit={vi.fn()} isLoading={false} />,
    )

    const trafficInput = screen.getByDisplayValue('50')
    await user.clear(trafficInput)
    await user.type(trafficInput, '0')

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Traffic limit: 50 GB → unlimited')
    expect(notice).toHaveTextContent('do not get the higher limits today')
  })

  it('stays silent until a limit actually moves', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(
      <PlanForm plan={planOption()} onSubmit={vi.fn()} isLoading={false} />,
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  // A plan being created has no subscribers, so there is nothing to defer and
  // the notice would be pure noise on the busiest form in the module.
  it('stays silent while creating a plan', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(<PlanForm onSubmit={vi.fn()} isLoading={false} />)

    const trafficInput = screen.getByDisplayValue('50')
    await user.clear(trafficInput)
    await user.type(trafficInput, '20')

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

// A `Plan` row has an `icon` and no colour of any kind — the card's gradient,
// accent, texture and effect live in `brandingSettings.planCardStyles`, edited
// in WEB Reiwa → Tariff cards. The icon picker being the only appearance
// control here made this form read as the place appearance is configured, and
// an operator spent real time hunting it for a colour picker that has never
// been in it. These pin the signpost: deleting it must break a test.
describe('PlanForm card-appearance signpost', () => {
  it('says the card colour is configured in WEB Reiwa rather than on the plan', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(<PlanForm onSubmit={vi.fn()} isLoading={false} />)

    expect(
      await screen.findByText(
        /gradient, accent, texture and animation are configured per plan under WEB Reiwa/i,
      ),
    ).toBeInTheDocument()
  })

  it('links to WEB Reiwa in a new tab so the open plan dialog survives', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })

    renderWithProviders(<PlanForm onSubmit={vi.fn()} isLoading={false} />)

    const link = await screen.findByRole('link', { name: 'Open Tariff cards' })
    expect(link).toHaveAttribute('href', '/web-reiwa')
    // Same-tab navigation would unmount the dialog this form lives in and drop
    // a half-filled plan with no warning, so the target is load-bearing.
    expect(link).toHaveAttribute('target', '_blank')
  })
})

// ── Upgrade and replacement targets ─────────────────────────────────────────
//
// The picker was `p.isActive && !p.isArchived`, which is wider than the rule
// the server enforces: it offered TRIAL plans, the save came back refused, and
// the operator read the backend's English diagnostic naming a cuid. The other
// half is worse — ids already saved on the plan were submitted on every save
// while being rendered nowhere, so a target archived, switched off, turned
// into a trial or deleted AFTER it was picked made the plan permanently
// unsaveable with nothing on screen to take off.
describe('PlanForm transition targets', () => {
  // The production defect, stated by name.
  it('does not offer a trial plan as an upgrade target', async () => {
    mockCatalog([
      catalogPlan({ id: 'plan-2', name: 'Premium' }),
      catalogPlan({ id: 'plan-trial', name: 'Trial Week', availability: 'TRIAL' }),
    ])

    renderWithProviders(<PlanForm onSubmit={vi.fn()} isLoading={false} />)

    // Waiting on the selectable one proves the catalog landed, so the absence
    // below is an answer rather than a race.
    expect(await screen.findByRole('button', { name: 'Premium' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Trial Week' })).not.toBeInTheDocument()
  })

  it('shows a saved-but-now-archived target as a marked chip carrying its name', async () => {
    mockCatalog([
      catalogPlan({ id: 'plan-1', name: 'Premium' }),
      catalogPlan({ id: 'plan-legacy', name: 'Legacy Pro', isArchived: true }),
    ])

    renderWithProviders(
      <PlanForm
        plan={editedPlan({ upgradeToPlanIds: ['plan-legacy'] })}
        onSubmit={vi.fn()}
        isLoading={false}
      />,
    )

    const chip = await screen.findByRole('button', { name: 'Remove Legacy Pro — archived' })
    // The name, not the cuid: naming a plan by its id is what made the
    // server's refusal unactionable in the first place.
    expect(chip).toHaveTextContent('Legacy Pro')
    expect(chip).toHaveTextContent('archived')
    // Marked, not merely listed. `destructive` is the theme-token variant, so
    // it stays legible in both light and dark.
    expect(chip).toHaveClass('bg-destructive')
    // …and it is NOT the ordinary selected-chip styling used next to it.
    expect(chip).not.toHaveClass('bg-primary')
  })

  it('takes a stranded target out of the submitted payload when its chip is clicked', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    mockCatalog([
      catalogPlan({ id: 'plan-1', name: 'Premium' }),
      catalogPlan({ id: 'plan-2', name: 'Business' }),
      catalogPlan({ id: 'plan-legacy', name: 'Legacy Pro', isArchived: true }),
    ])

    renderWithProviders(
      <PlanForm
        plan={editedPlan({ upgradeToPlanIds: ['plan-2', 'plan-legacy'] })}
        onSubmit={onSubmit}
        isLoading={false}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Remove Legacy Pro — archived' }))
    await user.click(screen.getByRole('button', { name: 'Update plan' }))

    // The surviving id is asserted positively: "not Legacy Pro" would also
    // pass if the whole list were dropped.
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ upgradeToPlanIds: ['plan-2'] }),
      )
    })
  })

  it('names a target whose plan is gone by its id, and still lets it be removed', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    mockCatalog([
      catalogPlan({ id: 'plan-1', name: 'Premium' }),
      catalogPlan({ id: 'plan-2', name: 'Business' }),
    ])

    renderWithProviders(
      <PlanForm
        plan={editedPlan({ upgradeToPlanIds: ['plan-2', 'plan-deleted-cuid'] })}
        onSubmit={onSubmit}
        isLoading={false}
      />,
    )

    // No name exists to show — the plan is gone from the catalog — so the id
    // is the last resort, and it is still better than showing nothing.
    const chip = await screen.findByRole('button', { name: 'Remove plan-deleted-cuid — deleted' })
    expect(chip).toHaveTextContent('plan-deleted-cuid')

    await user.click(chip)
    await user.click(screen.getByRole('button', { name: 'Update plan' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ upgradeToPlanIds: ['plan-2'] }),
      )
    })
  })

  // `strandedTransitionTargets` answers `[]` for a catalog that has not loaded,
  // and that answer means "not known yet", NOT "nothing is wrong". Rendered
  // ungated, the form opens clean and sprouts warnings a moment later.
  it('says nothing about stranded targets until the plan catalog has answered', async () => {
    let resolveCatalog!: (value: { data: Plan[] }) => void
    const catalog = new Promise<{ data: Plan[] }>((resolve) => {
      resolveCatalog = resolve
    })
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/plans') return catalog
      return { data: [] }
    })

    renderWithProviders(
      <PlanForm
        plan={editedPlan({ upgradeToPlanIds: ['plan-legacy'] })}
        onSubmit={vi.fn()}
        isLoading={false}
      />,
    )

    // The form is mounted and the query is still in flight.
    expect(await screen.findByPlaceholderText('Premium 50GB')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove Legacy Pro/ })).not.toBeInTheDocument()
    // The hint is on screen exactly when the stranded block is, so this fails
    // for a form that resolves the ids against an empty catalog and reports
    // every one of them as deleted — the shape the gate exists to prevent, and
    // one the two assertions above would let through, because that chip is
    // named by the id and carries no error until Save is pressed.
    expect(screen.queryByText(/can no longer be used as targets/)).not.toBeInTheDocument()

    resolveCatalog({
      data: [
        catalogPlan({ id: 'plan-1', name: 'Premium' }),
        catalogPlan({ id: 'plan-legacy', name: 'Legacy Pro', isArchived: true }),
      ],
    })

    // …and once it has answered the warning does appear, which is what makes
    // the silence above a decision rather than a broken selector.
    expect(
      await screen.findByRole('button', { name: 'Remove Legacy Pro — archived' }),
    ).toBeInTheDocument()
  })

  it('blocks the save and names the plan rather than letting the server refuse it', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    mockCatalog([
      catalogPlan({ id: 'plan-1', name: 'Premium' }),
      catalogPlan({ id: 'plan-legacy', name: 'Legacy Pro', isArchived: true }),
    ])

    renderWithProviders(
      <PlanForm
        plan={editedPlan({ upgradeToPlanIds: ['plan-legacy'] })}
        onSubmit={onSubmit}
        isLoading={false}
      />,
    )

    await screen.findByRole('button', { name: 'Remove Legacy Pro — archived' })
    await user.click(screen.getByRole('button', { name: 'Update plan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These upgrade targets can no longer be used: Legacy Pro',
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // `plan-form-schema.ts:195` submits `replacementPlanIds` whenever the plan is
  // archived, but the replacement PICKER only exists under REPLACE_ON_RENEW.
  // Under SELF_RENEW the ids therefore go to the server with no control on the
  // form rendering them — the original defect, one renewal mode over.
  it('surfaces stranded replacement targets under SELF_RENEW, where the picker is hidden', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    mockCatalog([
      catalogPlan({ id: 'plan-1', name: 'Premium' }),
      catalogPlan({ id: 'plan-legacy', name: 'Legacy Pro', isArchived: true }),
    ])

    renderWithProviders(
      <PlanForm
        plan={{
          ...editedPlan({ replacementPlanIds: ['plan-legacy'] }),
          isArchived: true,
          archivedRenewMode: 'SELF_RENEW',
        }}
        onSubmit={onSubmit}
        isLoading={false}
      />,
    )

    const chip = await screen.findByRole('button', { name: 'Remove Legacy Pro — archived' })
    expect(chip).toHaveTextContent('Legacy Pro')
    // The picker itself is genuinely not on screen, which is the whole point.
    expect(screen.queryByText('Replacement plans')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Update plan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These replacement plans can no longer be used: Legacy Pro',
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

function mockCatalog(plans: readonly Plan[]): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/plans') return { data: plans }
    return { data: [] }
  })
}

function catalogPlan(overrides: Partial<Plan> = {}): Plan {
  return { ...planOption(), ...overrides }
}

/**
 * The plan being edited, carrying one duration.
 *
 * `planOption()` has none, and an empty `durations` fails the schema before a
 * save can reach `onSubmit` — which would make every "what got submitted"
 * assertion below pass for the wrong reason.
 */
function editedPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    ...planOption(),
    durations: [
      {
        id: 'duration-1',
        days: 30,
        isActive: true,
        // A decimal STRING, which is what `/admin/plans` actually sends
        // (`Decimal(20, 8)` through `.toString()`). The number here was the
        // old wire type's fiction; the draft builder calls `.toString()` on
        // it either way, so only the honesty of the fixture changes.
        prices: [{ id: 'price-1', currency: 'RUB', price: '299' }],
      },
    ],
    ...overrides,
  }
}

function planOption(): Plan {
  return {
    id: 'plan-1',
    name: 'Premium',
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
    orderIndex: 1,
    internalSquads: [],
    externalSquad: null,
    durations: [],
    replacementPlanIds: [],
    upgradeToPlanIds: [],
  }
}
