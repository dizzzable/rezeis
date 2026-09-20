import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

/**
 * The five category switches on Settings → Panel → Security.
 *
 * They used to govern web push alone, and were hidden unless THIS browser had
 * a push subscription — reasonable then, because without one there was nothing
 * for them to govern. Since the notification centre they also decide what is
 * filed into the bell, which every operator has and which needs no device and
 * no VAPID key. Hidden, they would leave an operator unable to see or change
 * what reaches their own inbox.
 */

const configured = { value: true }
const subscription = { value: null as unknown }

vi.mock('@/lib/push', () => ({
  PUSH_OPTOUT_KEY: 'rezeis_push_optout',
  detectPushSupport: () => 'ready',
  disablePush: vi.fn(),
  enablePush: vi.fn(),
  ensurePushSubscription: vi.fn(async () => 'unsupported'),
  getCurrentSubscription: vi.fn(async () => subscription.value),
  hasPushOptOut: () => true,
  isPushConfigured: vi.fn(async () => configured.value),
}))

const CATEGORIES = [
  { category: 'support', enabled: true },
  { category: 'payment', enabled: true },
  { category: 'fraud', enabled: false },
  { category: 'withdrawal', enabled: true },
  { category: 'system', enabled: true },
]

async function renderTab(): Promise<void> {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { categories: CATEGORIES } } as never)
  const { default: PanelNotificationsTab } = await import('./panel-notifications-tab')
  renderWithProviders(<PanelNotificationsTab />)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  configured.value = true
  subscription.value = null
})

describe('the notification categories', () => {
  it('are offered on a browser that never subscribed to push', async () => {
    await renderTab()

    expect(await screen.findByText(/Категории уведомлений|Notification categories/i)).toBeInTheDocument()
    expect(await screen.findByRole('switch', { name: /Антифрод|Fraud/i })).toBeInTheDocument()
  })

  it('are offered even when the server has no push keys at all', async () => {
    // Push is genuinely unavailable then — the centre is not, and these
    // switches decide what reaches it.
    configured.value = false
    await renderTab()

    expect(await screen.findByText(/Категории уведомлений|Notification categories/i)).toBeInTheDocument()
    expect(
      await screen.findByRole('switch', { name: /Поддержка|Support/i }),
    ).toBeInTheDocument()
  })
})
