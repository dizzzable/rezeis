/**
 * «Возврат покупателя» against the Remnawave clean-up (the owner, 15.10.2026:
 * «либо 15 дней надо выставить либо выключить данный функционал»).
 *
 * The reminders 3, 7 and 14 days after a subscription ended are OFF until the
 * operator turns them on, and each reaches nobody once the clean-up has deleted
 * the subscription. So beside the switches the page names the reminders the
 * clean-up would cut short, offers to wait long enough in one tap, and links to
 * the setting — and says nothing when every reminder switched on can arrive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import { isUserNotificationOn, winbackCleanupConflict } from '@/lib/winback-cleanup'
import NotificationsPage from '@/features/notifications/notifications-page'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

describe('the rule', () => {
  it('reads an absent switch as OFF for a reminder and ON for anything else', () => {
    expect(isUserNotificationOn({}, 'expired_14_days_ago')).toBe(false)
    expect(isUserNotificationOn({ expired_14_days_ago: true }, 'expired_14_days_ago')).toBe(true)
    expect(isUserNotificationOn({}, 'expired_1_day_ago')).toBe(true)
    expect(isUserNotificationOn({ expired: false }, 'expired')).toBe(false)
  })

  it('needs the clean-up to wait a day past the latest reminder switched on', () => {
    const on = { expired_14_days_ago: true }
    expect(winbackCleanupConflict(on, { deleteEnabled: true, graceDays: 3 })).toEqual({
      needed: 15,
      graceDays: 3,
      cutShort: ['expired_14_days_ago'],
    })
    // Deleted on the reminder's own day: a race the reminder can lose.
    expect(winbackCleanupConflict(on, { deleteEnabled: true, graceDays: 14 })?.needed).toBe(15)
    expect(winbackCleanupConflict(on, { deleteEnabled: true, graceDays: 15 })).toBeNull()
    expect(winbackCleanupConflict(on, { deleteEnabled: false, graceDays: 0 })).toBeNull()
  })

  it('names only the reminders that would not arrive, and asks for no more than they need', () => {
    const on = { expired_3_days_ago: true, expired_7_days_ago: true }
    expect(winbackCleanupConflict(on, { deleteEnabled: true, graceDays: 5 })).toEqual({
      needed: 8,
      graceDays: 5,
      cutShort: ['expired_7_days_ago'],
    })
    expect(winbackCleanupConflict({}, { deleteEnabled: true, graceDays: 0 })).toBeNull()
  })
})

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

let cleanupServed = false

function serve(userNotifications: Record<string, boolean>, cleanup: { deleteEnabled: boolean; graceDays: number }) {
  cleanupServed = false
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/settings') return { data: { userNotifications, systemNotifications: {} } }
    if (path === '/admin/settings/remnawave-cleanup') {
      cleanupServed = true
      return { data: cleanup }
    }
    return { data: [] }
  })
}

/**
 * Until the clean-up has been read the warning is absent whatever it would
 * say, so an assertion that it is absent waits for the read, then a render.
 */
async function afterCleanupRead(): Promise<void> {
  await waitFor(() => expect(cleanupServed).toBe(true))
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
}

/** The win-back warning — the page has other alerts of its own. */
const TITLE = 'Win-back reminders will not arrive'
const warning = (): HTMLElement | undefined =>
  screen.queryAllByRole('alert').find((node) => node.textContent?.includes(TITLE) === true)
const findWarning = async (): Promise<HTMLElement> => {
  await waitFor(() => expect(warning()).toBeDefined())
  return warning() as HTMLElement
}

/** The switch in the row of `key`. */
async function switchFor(key: string): Promise<HTMLElement> {
  const keyText = await screen.findByText(key, { selector: 'p' })
  return within(keyText.closest('div.flex') as HTMLElement).getByRole('switch')
}

beforeEach(async () => {
  await loadFeatureBundle('notifications')
  grantSettingsEdit()
})

afterEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
})

describe('the notifications page', () => {
  it('shows the three reminders switched off on an install that never touched them', async () => {
    serve({}, { deleteEnabled: true, graceDays: 3 })
    renderWithProviders(<NotificationsPage />)

    for (const key of ['expired_3_days_ago', 'expired_7_days_ago', 'expired_14_days_ago']) {
      expect(await switchFor(key)).toHaveAttribute('aria-checked', 'false')
    }
    expect(await switchFor('expired_1_day_ago')).toHaveAttribute('aria-checked', 'true')
    // Nothing on, nothing cut short.
    await afterCleanupRead()
    expect(warning()).toBeUndefined()
  })

  it('names the reminder the clean-up cuts short, and waits long enough in one tap', async () => {
    const user = userEvent.setup()
    serve({ expired_14_days_ago: true }, { deleteEnabled: true, graceDays: 3 })
    const patch = vi
      .spyOn(api, 'patch')
      .mockImplementation(async () => ({ data: { deleteEnabled: true, graceDays: 15 } }))
    renderWithProviders(<NotificationsPage />)

    const alert = await findWarning()
    expect(alert).toHaveTextContent('after 14 days')
    expect(alert).toHaveTextContent('at least 15')
    const link = within(alert).getByRole('link', { name: 'Open the setting' })
    expect(link).toHaveAttribute('href', '/remnawave?tab=settings')

    await user.click(within(alert).getByRole('button', { name: 'Set 15 days' }))
    expect(patch).toHaveBeenCalledWith('/admin/settings/remnawave-cleanup', { graceDays: 15 })
    // Fixed: the warning goes.
    await waitFor(() => expect(warning()).toBeUndefined())
  })

  it('says nothing when the clean-up waits long enough, or is off', async () => {
    serve({ expired_14_days_ago: true }, { deleteEnabled: true, graceDays: 15 })
    const first = renderWithProviders(<NotificationsPage />)
    expect(await switchFor('expired_14_days_ago')).toHaveAttribute('aria-checked', 'true')
    await afterCleanupRead()
    expect(warning()).toBeUndefined()
    first.unmount()

    vi.restoreAllMocks()
    serve({ expired_14_days_ago: true }, { deleteEnabled: false, graceDays: 0 })
    renderWithProviders(<NotificationsPage />)
    expect(await switchFor('expired_14_days_ago')).toHaveAttribute('aria-checked', 'true')
    await afterCleanupRead()
    expect(warning()).toBeUndefined()
  })
})
