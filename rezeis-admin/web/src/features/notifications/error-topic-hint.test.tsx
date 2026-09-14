/**
 * The error topic says which events it receives.
 *
 * The router files an event in the error topic when it is an error report —
 * `isErrorReportEvent` in `src/common/services/error-report.util.ts`, which
 * `resolveTelegramDeliveryTarget` calls: ERROR severity, OR a type ending in
 * `.error` at ANY severity. The field said «Ошибки (ERROR)» and named only
 * `client.error` and `reiwa.error`, so an operator could not know that a
 * WARNING `system.error`, or an automation's own `*.error` type, lands there
 * too. The label and the hint are held to that rule here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import NotificationsPage from '@/features/notifications/notifications-page'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

beforeEach(async () => {
  await loadFeatureBundle('notifications')
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(['settings:view', 'settings:edit']),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/settings') {
      return { data: { userNotifications: {}, systemNotifications: { telegram: { enabled: true, chatId: '-100200' } } } }
    }
    return { data: [] }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
})

describe('the error topic field', () => {
  it('is named for error reports and states the rule the router applies', async () => {
    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: 'Delivery settings' }))

    // Not «ERROR»: the topic also takes `*.error` types raised at WARNING.
    expect(await screen.findByText('Error report topic')).toBeInTheDocument()
    expect(screen.queryByText('Errors (ERROR)')).not.toBeInTheDocument()

    const hint = screen.getByText((content) => content.startsWith('Every error report goes to this topic'))
    // Both halves of `isErrorReportEvent`, and the case the old hint left out.
    expect(hint.textContent).toContain('ERROR-severity events')
    expect(hint.textContent).toContain('events of any severity whose type ends in “.error”')
    expect(hint.textContent).toContain('system.error')
  })
})
