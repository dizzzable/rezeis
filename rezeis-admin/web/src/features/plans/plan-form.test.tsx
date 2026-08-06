import { screen } from '@testing-library/react'
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
