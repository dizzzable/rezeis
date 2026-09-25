import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import AddOnsPage from './add-ons-page'

beforeAll(async () => {
  // The lifetime rule's words live in the lazy `addOns` bundle, which the
  // router loads and a bare render does not.
  await i18nReady
  await loadFeatureBundle('addOns')
})

/** `GET /admin/add-on-settings` as the switches service answers it. */
function addOnSettings(resetExpiryOn: boolean, zone: string | null) {
  return {
    switches: [
      { name: 'durableAccounting', enabled: true, defaultEnabled: true, stored: null, env: [] },
      { name: 'deviceCleanupAuto', enabled: true, defaultEnabled: true, stored: null, env: [] },
      { name: 'trafficResetExpiry', enabled: resetExpiryOn, defaultEnabled: false, stored: null, env: [] },
    ],
    remnawaveTimeZone: { value: zone ?? 'UTC', stored: zone, defaultValue: 'UTC' },
  }
}

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

  it('offers no lifetime choice: a traffic add-on lasts until the next reset, in Remnawave\'s zone, while stage 4 is on', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/add-ons') return { data: [] }
      if (path === '/admin/plans') return { data: [] }
      if (path === '/admin/settings/icons') return { data: [] }
      if (path === '/admin/add-on-settings') return { data: addOnSettings(true, 'Europe/Moscow') }
      return { data: {} }
    })

    renderWithProviders(<AddOnsPage />)

    await user.click(await screen.findByRole('button', { name: 'Create add-on' }))

    const rule = await screen.findByText(/Lasts until the plan’s next traffic reset/)
    expect(rule).toHaveTextContent('Remnawave’s clock: Europe/Moscow')
    expect(screen.queryByRole('combobox', { name: 'Lifetime' })).not.toBeInTheDocument()
  })

  it('says a traffic add-on lasts until the end of the subscription while stage 4 is off', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/add-ons') return { data: [] }
      if (path === '/admin/plans') return { data: [] }
      if (path === '/admin/settings/icons') return { data: [] }
      if (path === '/admin/add-on-settings') return { data: addOnSettings(false, null) }
      return { data: {} }
    })

    renderWithProviders(<AddOnsPage />)

    await user.click(await screen.findByRole('button', { name: 'Create add-on' }))

    expect(await screen.findByText(/^Lasts until the end of the subscription\./)).toBeInTheDocument()
  })

  it('says a device add-on lasts until the end of the subscription, and sends no lifetime on save', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/add-ons')
        return {
          data: [
            {
              id: 'a1',
              name: 'Extra device',
              description: null,
              type: 'EXTRA_DEVICES',
              // A row stored before 25.09.2026 still saying «до следующего сброса».
              lifetime: 'UNTIL_NEXT_RESET',
              icon: null,
              value: 1,
              isActive: true,
              orderIndex: 1,
              applicablePlanIds: [],
              prices: [{ currency: 'RUB', price: '50' }],
            },
          ],
        }
      if (path === '/admin/plans') return { data: [] }
      if (path === '/admin/settings/icons') return { data: [] }
      if (path === '/admin/add-on-settings') return { data: addOnSettings(true, null) }
      return { data: {} }
    })
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<AddOnsPage />)

    await user.click(await screen.findByRole('button', { name: 'Edit add-on' }))

    expect(await screen.findByText('Extra devices last until the end of the subscription.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Lifetime' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    // The panel decides the lifetime; the stored «до следующего сброса» sent
    // back beside a device type would be refused by the API.
    expect(patch.mock.calls[0]?.[1]).not.toHaveProperty('lifetime')
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

  // ── Points cashback ─────────────────────────────────────────────────────────

  function mockCatalog(addOns: unknown[] = []): void {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/add-ons') return { data: addOns }
      if (path === '/admin/plans') return { data: [] }
      if (path === '/admin/settings/icons') return { data: [] }
      return { data: {} }
    })
  }

  it('names the points-cashback selector and defaults it to the global rule', async () => {
    const user = userEvent.setup()
    mockCatalog()

    renderWithProviders(<AddOnsPage />)
    await user.click(await screen.findByRole('button', { name: 'Create add-on' }))

    const mode = await screen.findByRole('combobox', { name: 'Points cashback' })
    expect(mode).toHaveTextContent('Same as settings')
    // Neither number applies to an inherited rule, so neither input is offered.
    expect(screen.queryByRole('spinbutton', { name: 'Cashback percent' })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: 'Cashback points' })).toBeNull()
    expect(screen.getByText('The global rule from Settings → Points applies')).toBeInTheDocument()
  })

  it('reveals the percent input for an own percent and the points input for fixed points', async () => {
    const user = userEvent.setup()
    mockCatalog()

    renderWithProviders(<AddOnsPage />)
    await user.click(await screen.findByRole('button', { name: 'Create add-on' }))

    await user.click(await screen.findByRole('combobox', { name: 'Points cashback' }))
    await user.click(await screen.findByRole('option', { name: 'Own percent' }))
    expect(await screen.findByRole('spinbutton', { name: 'Cashback percent' })).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: 'Cashback points' })).toBeNull()
    expect(screen.getByText('Percent of the paid amount')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Points cashback' }))
    await user.click(await screen.findByRole('option', { name: 'Fixed points' }))
    expect(await screen.findByRole('spinbutton', { name: 'Cashback points' })).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: 'Cashback percent' })).toBeNull()
  })

  it('sends the mode and only the number that mode reads when creating', async () => {
    const user = userEvent.setup()
    mockCatalog()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })

    renderWithProviders(<AddOnsPage />)
    await user.click(await screen.findByRole('button', { name: 'Create add-on' }))

    await user.type(await screen.findByPlaceholderText('e.g. +50 GB traffic'), 'Extra 50 GB')
    await user.click(screen.getByRole('combobox', { name: 'Points cashback' }))
    await user.click(await screen.findByRole('option', { name: 'Own percent' }))
    await user.type(await screen.findByRole('spinbutton', { name: 'Cashback percent' }), '15')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith(
      '/admin/add-ons',
      expect.objectContaining({ cashbackMode: 'PERCENT', cashbackPercent: 15 }),
    )
    // Points belong to FIXED; under PERCENT they are not sent at all, so the
    // API nulls whatever the row held.
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('cashbackPoints')
  })

  it('prefills a stored fixed rule and sends it back unchanged on update', async () => {
    const user = userEvent.setup()
    mockCatalog([
      {
        id: 'a1',
        name: 'Extra device',
        description: null,
        type: 'EXTRA_DEVICES',
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        icon: null,
        value: 1,
        isActive: true,
        orderIndex: 1,
        applicablePlanIds: [],
        prices: [{ currency: 'RUB', price: '50' }],
        cashbackMode: 'FIXED',
        cashbackPercent: null,
        cashbackPoints: 20,
      },
    ])
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<AddOnsPage />)
    await user.click(await screen.findByRole('button', { name: 'Edit add-on' }))

    expect(await screen.findByRole('combobox', { name: 'Points cashback' })).toHaveTextContent(
      'Fixed points',
    )
    expect(screen.getByRole('spinbutton', { name: 'Cashback points' })).toHaveValue(20)
    expect(screen.queryByRole('spinbutton', { name: 'Cashback percent' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith(
      '/admin/add-ons/a1',
      expect.objectContaining({ cashbackMode: 'FIXED', cashbackPoints: 20 }),
    )
    expect(patch.mock.calls[0]?.[1]).not.toHaveProperty('cashbackPercent')
  })
})
