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
