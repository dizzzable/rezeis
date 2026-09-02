import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18nReady } from '@/i18n/i18n'
import { api } from '@/lib/api'
import type { Plan } from '@/features/plans/plans-api'
import { renderWithProviders } from '@/test/test-utils'

import PointsSettingsPage from './points-settings-page'

/**
 * Settings → Points: the cashback card saves ONLY `pointsSettings.cashback`
 * through its own route, and the exchange card — moved here from the referral
 * settings — saves ONLY `referralSettings.pointsExchange`, so neither page
 * can overwrite the other's knobs with stale values. The gift-plan picker
 * rules travelled with the card and are asserted here now.
 */
const BASE: Plan = {
  id: 'plan-base',
  name: 'Base',
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
} as Plan

const CATALOG: readonly Plan[] = [
  { ...BASE, id: 'plan-trial', name: 'Probniy', availability: 'TRIAL' },
  { ...BASE, id: 'plan-standard', name: 'Standard', isActive: false },
  { ...BASE, id: 'plan-mini', name: 'MiniFamily' },
  { ...BASE, id: 'plan-oldmoney', name: 'OldMoney', isArchived: true },
]

function mountWith(options: {
  readonly cashback?: { enabled?: boolean; percent?: number }
  readonly giftPlanId?: string | null
  readonly defaultCurrency?: string
}): ReturnType<typeof userEvent.setup> {
  vi.spyOn(api, 'get').mockImplementation((async (path: string) => {
    if (path === '/admin/plans') return { data: CATALOG }
    return {
      data: {
        defaultCurrency: options.defaultCurrency ?? 'RUB',
        pointsSettings: options.cashback === undefined ? {} : { cashback: options.cashback },
        referralSettings: {
          enabled: true,
          level1Reward: 5,
          pointsExchange: {
            exchangeEnabled: true,
            giftSubscription: {
              enabled: true,
              pointsCost: 30,
              giftDurationDays: 30,
              giftPlanId: options.giftPlanId ?? null,
            },
          },
        },
      },
    }
  }) as never)
  vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderWithProviders(<PointsSettingsPage />)
  return userEvent.setup()
}

function patchCalls(): Array<[string, Record<string, unknown>]> {
  return (api.patch as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>
}

/** Radix's Select reads two DOM methods jsdom lacks; same shim the branding specs use. */
function enableRadixSelectInJsdom(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['hasPointerCapture'] ??= () => false
  proto['releasePointerCapture'] ??= () => {}
  proto['setPointerCapture'] ??= () => {}
  proto['scrollIntoView'] ??= () => {}
}

describe('Settings → Points', () => {
  beforeAll(async () => {
    await i18nReady
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('hydrates the cashback card from the overview and saves only the cashback rule', async () => {
    const user = mountWith({ cashback: { enabled: true, percent: 5 } })

    const toggle = await screen.findByRole('switch', { name: 'Enable cashback' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    const percent = screen.getByRole('spinbutton', { name: 'Default percent' })
    expect(percent).toHaveValue(5)

    await user.clear(percent)
    await user.type(percent, '12')
    await user.click(screen.getByRole('button', { name: /^Save$/ }))

    await vi.waitFor(() => expect(patchCalls().length).toBe(1))
    expect(patchCalls()[0]).toEqual(['/admin/settings/points', { cashback: { enabled: true, percent: 12 } }])
  })

  it('reads an empty pointsSettings as OFF at zero, and refuses to save a percent out of range', async () => {
    const user = mountWith({})

    const toggle = await screen.findByRole('switch', { name: 'Enable cashback' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    const percent = screen.getByRole('spinbutton', { name: 'Default percent' })
    expect(percent).toHaveValue(0)

    await user.clear(percent)
    await user.type(percent, '150')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 0 to 100')
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(patchCalls()).toEqual([])
  })

  it('names the default currency the percent is taken of', async () => {
    mountWith({ defaultCurrency: 'USD' })

    expect(await screen.findByText(/default currency \(USD\)/)).toBeInTheDocument()
  })

  it('saves the exchange card through the referral route with the exchange sub-object only', async () => {
    const user = mountWith({ giftPlanId: 'plan-mini' })

    const exchangeForm = await screen.findByRole('form', { name: 'Points Exchange' })
    expect(exchangeForm).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save exchange' }))

    await vi.waitFor(() => expect(patchCalls().length).toBe(1))
    const [url, body] = patchCalls()[0]!
    expect(url).toBe('/admin/settings/referral')
    expect(Object.keys(body)).toEqual(['pointsExchange'])
    const exchange = body.pointsExchange as Record<string, Record<string, unknown>>
    expect(exchange.giftSubscription.giftPlanId).toBe('plan-mini')
    expect(exchange.giftSubscription.pointsCost).toBe(30)
  })

  it('offers only plans that are on sale as the gift plan', async () => {
    enableRadixSelectInJsdom()
    const user = mountWith({})

    await user.click(await screen.findByRole('combobox', { name: /Gift Plan/i }))
    const options = await screen.findAllByRole('option')

    expect(options.map((option) => (option.textContent ?? '').trim())).toEqual(['Probniy', 'MiniFamily'])
  })

  it('keeps a stored archived gift plan in the list so it stays visible, and keeps saving it', async () => {
    const user = mountWith({ giftPlanId: 'plan-oldmoney' })

    // The trigger shows the stored choice once the catalogue has landed.
    const picker = await screen.findByRole('combobox', { name: /Gift Plan/i })
    await vi.waitFor(() => expect(picker).toHaveTextContent('OldMoney'))

    await user.click(screen.getByRole('button', { name: 'Save exchange' }))
    await vi.waitFor(() => expect(patchCalls().length).toBe(1))
    const exchange = patchCalls()[0]![1].pointsExchange as Record<string, Record<string, unknown>>
    expect(exchange.giftSubscription.giftPlanId).toBe('plan-oldmoney')
  })
})
