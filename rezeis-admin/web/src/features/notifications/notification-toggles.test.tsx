/**
 * A notification switch sends the one key it flips.
 *
 * The toggle tabs used to PATCH `{ ...loadedMap, [key]: !current }`, which
 * wrote a whole loaded settings object back and restored whatever other pages
 * had saved since this one loaded. The server now refuses non-boolean values on
 * this endpoint too (`settings-notification-toggles-stale-snapshot.spec.ts`);
 * this file pins the page's half, the request itself.
 *
 * There is one toggle tab now. The «Системные» tab is gone: its twelve switches
 * were saved into `systemNotifications` and nothing in the panel or the cabinet
 * ever read them, so they changed nothing. The operator's real choice — which
 * events reach the Telegram group — is the event list under «Настройки
 * доставки», and the page says so where the tab used to be.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import NotificationsPage from '@/features/notifications/notifications-page'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

/** `GET /admin/settings` as the page receives it: switches beside structured settings. */
const OVERVIEW = {
  userNotifications: { expired: true, limited: false },
  systemNotifications: {
    node_status: true,
    user_hwid: false,
    customEmojiPacks: [{ id: 'pack-a', name: 'A', emojis: [] }],
    backup: { autoEnabled: false, intervalHours: 24 },
    telegram: { enabled: true, chatId: '-100200' },
    botEmoji: { ownerHasPremium: true },
  },
}

function grantSettingsEdit(): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(['settings:view', 'settings:edit']),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

/** The row a switch sits in: its label, its key in monospace, and the switch. */
async function switchFor(key: string): Promise<HTMLElement> {
  const keyText = await screen.findByText(key, { selector: 'p' })
  const row = keyText.closest('div.flex')
  expect(row).not.toBeNull()
  return within(row as HTMLElement).getByRole('switch')
}

beforeEach(async () => {
  await loadFeatureBundle('notifications')
  grantSettingsEdit()
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/settings') return { data: OVERVIEW }
    return { data: [] }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
})

/**
 * The twelve keys the removed tab switched. Each one rendered as a row with the
 * key itself in monospace, which is what `switchFor` finds.
 */
const DEAD_SYSTEM_KEYS = [
  'bot_lifetime',
  'bot_update',
  'user_registered',
  'web_user_registered',
  'web_account_linked',
  'access_policy',
  'subscription',
  'promocode_activated',
  'trial_getted',
  'node_status',
  'user_first_connected',
  'user_hwid',
] as const

describe('the page offers no switches that nothing reads', () => {
  it('has no System tab, opens on a tab that exists, and points to the event list instead', async () => {
    renderWithProviders(<NotificationsPage />)

    // `Tabs defaultValue` must still name a rendered tab, or the page opens on
    // nothing: the user tab's own switches prove it opened there.
    expect(await switchFor('expired')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())
    expect(tabs).toEqual(['User', 'Delivery settings'])
    expect(screen.queryByRole('tab', { name: 'System' })).not.toBeInTheDocument()

    expect(
      screen.getByText(
        'Which events reach the admin Telegram group as cards is chosen on the “Delivery settings” tab: turn on “Only selected events” and tick the types in the list.',
      ),
    ).toBeInTheDocument()
  })

  it('draws none of the dead switches in any panel, once each panel is open', async () => {
    // Radix mounts only the ACTIVE `TabsContent`. Asking the page for a dead
    // key without opening anything therefore answered "absent" even with the
    // System tab still there — its panel was simply not in the DOM. So every
    // tab is opened in turn and asked while its panel is the mounted one.
    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await switchFor('expired')

    const tabs = screen.getAllByRole('tab')
    expect(tabs.length).toBeGreaterThan(0)
    for (const tab of tabs) {
      await user.click(tab)
      await waitFor(() => {
        expect(tab).toHaveAttribute('aria-selected', 'true')
      })
      const panel = await screen.findByRole('tabpanel')
      // The panel really is this tab's, and really rendered its content —
      // otherwise "no dead key in it" would be true of an empty panel.
      expect(panel).toHaveAttribute('aria-labelledby', tab.id)
      await waitFor(() => {
        expect(panel.querySelector('[role="switch"]')).not.toBeNull()
      })
      for (const key of DEAD_SYSTEM_KEYS) {
        expect(
          within(panel).queryByText(key, { selector: 'p' }),
          `"${key}" is drawn on the ${tab.textContent?.trim()} tab`,
        ).toBeNull()
      }
    }
  })
})

describe('notification switches PATCH only the key they flip', () => {
  it('User tab: sends one key', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()

    await user.click(await switchFor('expired'))

    await waitFor(() => {
      expect(patch).toHaveBeenCalledTimes(1)
    })
    expect(patch).toHaveBeenCalledWith('/admin/settings/notifications', {
      userNotifications: { expired: false },
    })
  })
})
