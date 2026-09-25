/**
 * THE PART OF THE TRAFFIC LIMIT THAT IS AN ADD-ON, NEXT TO THE LIMIT.
 *
 * With the durable add-on model the subscription card's traffic limit is the
 * plan's base plus every live traffic add-on, each with an end of its own.
 * Nothing on the card said so, and an operator typed new totals around a
 * number that was partly temporary. The card now says «из них докупки: +50 ГБ
 * до 01.10 03:20 (по Москве)» beside the limit and beside the field that edits
 * it — the reset's own time for an add-on that lasts until the traffic reset,
 * in the panel's «Часовой пояс», named.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'

import { trafficAddOnLine } from './traffic-add-on-line'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import UserDetailPanel from './user-detail-panel'

/** Remnawave's MONTH reset, 00:20 UTC on the 1st; the panel takes the add-on off half an hour later. */
const RESET = '2026-10-01T00:20:00.000Z'
const TAKE_OFF = '2026-10-01T00:50:00.000Z'

const SUBSCRIPTION = {
  id: 'sub-1',
  status: 'ACTIVE',
  isTrial: false,
  trafficLimit: 150,
  deviceLimit: 3,
  expireAt: '2026-12-01T10:00:00.000Z',
  remnawaveId: null,
  configUrl: null,
  plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
}

function buildUser(subscription: Record<string, unknown>, displayTimeZone: string | null) {
  return {
    id: 'user-1',
    telegramId: '12345',
    username: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
    language: 'en',
    role: 'USER',
    isBlocked: false,
    isPartner: false,
    points: 0,
    personalDiscount: 0,
    purchaseDiscount: 0,
    maxSubscriptions: 1,
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
    subscriptions: [subscription],
    displayTimeZone,
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

async function openCard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: /^(Subscriptions|Подписки)/ }))
}

describe('the subscription card names the add-on share of the traffic limit', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
    proto['hasPointerCapture'] ??= () => false
    proto['setPointerCapture'] ??= () => {}
    proto['releasePointerCapture'] ??= () => {}
    proto['scrollIntoView'] ??= () => {}
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  afterEach(async () => {
    cleanup()
    if (i18n.language !== 'en') await i18n.changeLanguage('en')
  })

  it('shows «из них докупки» with the reset’s time in the operator’s zone, beside the limit and in the editor', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('userDetail')
    await waitFor(() => expect(i18n.hasResourceBundle('ru', 'translation')).toBe(true))
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: buildUser(
        {
          ...SUBSCRIPTION,
          trafficAddOns: { totalGb: 50, items: [{ gb: 50, endsAt: TAKE_OFF, resetAt: RESET }] },
        },
        'Europe/Moscow',
      ),
    })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await openCard(user)

    const line = await screen.findByTestId('traffic-add-ons')
    // The reset, 00:20 UTC = 03:20 in Moscow — not the take-off at 03:50.
    expect(line).toHaveTextContent('из них докупки: +50 ГБ до 01.10 03:20 (по Москве)')

    await user.click(await screen.findByRole('button', { name: 'Быстрые действия' }))
    expect(await screen.findByTestId('traffic-add-ons-editor')).toHaveTextContent(
      'из них докупки: +50 ГБ до 01.10 03:20 (по Москве)',
    )
  })

  it('says nothing for a subscription without add-ons, and for an older panel that sends no share', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: buildUser({ ...SUBSCRIPTION, trafficAddOns: null }, null) })
    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await openCard(user)
    await screen.findByText('150 GB')
    expect(screen.queryByTestId('traffic-add-ons')).toBeNull()
  })
})

describe('the line itself', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    i18n.t(key, { ...options, lng: 'en' }) as string

  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  it('names each group’s moment, soonest first, with the zone once — UTC when none is set', () => {
    const share = {
      totalGb: 60.5,
      items: [
        { gb: 50, endsAt: TAKE_OFF, resetAt: RESET },
        { gb: 10, endsAt: '2026-10-20T09:00:00.000Z', resetAt: null },
        { gb: 0.5, endsAt: null, resetAt: null },
      ],
    }
    expect(trafficAddOnLine(share, null, 'en', t)).toBe(
      'of which add-ons: +50 GB until 01.10 00:20, +10 GB until 20.10 09:00, +0.5 GB with no end (UTC)',
    )
    expect(trafficAddOnLine(share, 'Europe/Moscow', 'en', t)).toBe(
      'of which add-ons: +50 GB until 01.10 03:20, +10 GB until 20.10 12:00, +0.5 GB with no end (Moscow Time)',
    )
    // A zone this line has no name for: its offset, never a bare hour.
    expect(trafficAddOnLine(share, 'Asia/Kolkata', 'ru', t)).toContain('(UTC+05:30)')
    // A zone the browser does not know: UTC, named as such.
    expect(trafficAddOnLine(share, 'Mars/Olympus_Mons', 'en', t)).toContain('until 01.10 00:20')
  })

  it('is nothing when there is no share', () => {
    expect(trafficAddOnLine(null, 'Europe/Moscow', 'ru', t)).toBeNull()
    expect(trafficAddOnLine(undefined, 'Europe/Moscow', 'ru', t)).toBeNull()
    expect(trafficAddOnLine({ totalGb: 0, items: [] }, 'Europe/Moscow', 'ru', t)).toBeNull()
  })
})
