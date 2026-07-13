import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import AddOnsPage from './add-ons-page'

describe('AddOnsPage accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('names dynamic price row controls', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/add-ons') return { data: [] }
      if (path === '/admin/plans') return { data: [] }
      if (path === '/admin/settings/icons') return { data: [] }
      return { data: {} }
    })

    renderWithProviders(<AddOnsPage />)

    await user.click(await screen.findByRole('button', { name: 'Create add-on' }))

    expect(await screen.findByRole('combobox', { name: 'Price 1 currency' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Price 1 amount' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add currency' }))

    expect(screen.getByRole('button', { name: 'Remove price 2' })).toBeInTheDocument()
  })

  it('makes applicable plan chips keyboard-operable toggle buttons', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/add-ons') return { data: [] }
      if (path === '/admin/plans') return { data: [{ id: 'plan-1', name: 'Premium' }] }
      if (path === '/admin/settings/icons') return { data: [] }
      return { data: {} }
    })

    renderWithProviders(<AddOnsPage />)

    await user.click(await screen.findByRole('button', { name: 'Create add-on' }))

    const planButton = await screen.findByRole('button', { name: 'Premium' })
    expect(planButton).toHaveAttribute('aria-pressed', 'false')

    planButton.focus()
    expect(planButton).toHaveFocus()
    await user.keyboard('[Space]')

    expect(planButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders the entitlement delivery SLO tab from metrics', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/add-ons') return { data: [] }
      if (path === '/admin/plans') return { data: [] }
      if (path === '/admin/settings/icons') return { data: [] }
      if (path === '/admin/add-on-entitlements/metrics') {
        return {
          data: {
            entitlementsByState: { ACTIVE: 4, EXPIRED: 1 },
            projectionsByState: { APPLIED: 3 },
            deviceReductionPlansByState: {},
            openIncidentsByKind: { DEVICE_REDUCTION_BLOCKED: 2 },
            slo: {
              objectiveMs: 300000,
              alertMs: 900000,
              strandedCapturedOverObjective: 5,
              strandedCapturedOverAlert: 1,
              oldestStrandedAgeMs: 1200000,
              pendingSyncOverObjective: 0,
              pendingSyncOverAlert: 0,
              oldestPendingSyncAgeMs: null,
            },
          },
        }
      }
      return { data: {} }
    })

    renderWithProviders(<AddOnsPage />)

    await user.click(await screen.findByRole('tab', { name: 'Delivery' }))

    expect(await screen.findByText('Entitlement delivery')).toBeInTheDocument()
    // Stranded paid-line count from the SLO backlog is surfaced.
    expect(await screen.findByText('5')).toBeInTheDocument()
    // Open incident kind badge is shown.
    expect(await screen.findByText('DEVICE_REDUCTION_BLOCKED: 2')).toBeInTheDocument()
    // State breakdown badge.
    expect(screen.getByText('ACTIVE: 4')).toBeInTheDocument()
  })
})
