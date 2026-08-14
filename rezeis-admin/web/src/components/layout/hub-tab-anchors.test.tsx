/**
 * Do the `#hash` anchors in `deepLinkNavItems` actually open their tab?
 *
 * `admin-nav-config.test.ts` checks the anchors against `HUB_TABS` — that the
 * DATA agrees with itself. This file checks the half that data cannot: that the
 * pages still READ the hash. Both hubs shipped with an uncontrolled
 * `<Tabs defaultValue=…>`, so `/settings/panel#backups` and `/audit#system-logs`
 * silently opened Appearance and Audit instead, and every link pointing at them
 * — the `router.tsx` redirects for `/backup`, `/security/2fa`,
 * `/system/config-portability`, `/system/logs`, plus the new Cmd+K rows — was
 * decorative.
 *
 * Without these cases, reverting either page to `defaultValue` leaves the whole
 * suite green while the feature is dead again: the anchors would still match
 * `HUB_TABS`, and `HUB_TABS` would still match the triggers. That is precisely a
 * test that guards nothing, so the assertion is made against a RENDERED page at
 * a real URL rather than against the constants.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import PanelSettingsHub from '@/features/settings/panel-settings-hub'
import AuditPage from '@/features/audit/audit-page'

// Partial mock, not a replacement: these pages reach `@/i18n/i18n` through
// `withFeatureBundle`, and that module needs the real `initReactI18next`.
// Only `useTranslation` is swapped, so assertions can name i18n KEYS instead of
// copy either locale is free to reword.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  const translation = { t: (key: string) => key }
  return { ...actual, useTranslation: () => translation }
})

// Gated tabs must be present for the deep link to be able to select them; the
// permission behaviour itself is covered in `admin-nav-config.test.ts`.
vi.mock('@/features/rbac', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => children,
  usePermissionStore: (selector: (value: unknown) => unknown) =>
    selector({ loaded: true, hasPermission: () => true }),
}))

function renderAt(path: string, element: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </MemoryRouter>,
  )
}

function expectActiveTab(name: string) {
  expect(screen.getByRole('tab', { name })).toHaveAttribute('data-state', 'active')
}

describe('panel settings hub honours its deep-link anchors', () => {
  it.each([
    ['#backups', 'panelSettings.tabs.backups'],
    ['#config', 'panelSettings.tabs.config'],
    ['#security', 'panelSettings.tabs.security'],
  ])('opens %s on the matching tab', (hash, tabLabel) => {
    renderAt(`/settings/panel${hash}`, <PanelSettingsHub />)

    expectActiveTab(tabLabel)
  })

  it('falls back to appearance for an unknown anchor', () => {
    renderAt('/settings/panel#not-a-tab', <PanelSettingsHub />)

    expectActiveTab('panelSettings.tabs.appearance')
  })

  it('falls back to appearance when there is no anchor at all', () => {
    renderAt('/settings/panel', <PanelSettingsHub />)

    expectActiveTab('panelSettings.tabs.appearance')
  })
})

describe('audit page honours its deep-link anchor', () => {
  it('opens #system-logs on the system logs tab', () => {
    renderAt('/audit#system-logs', <AuditPage />)

    expectActiveTab('auditPage.tabs.systemLogs')
  })

  it('falls back to the audit tab without an anchor', () => {
    renderAt('/audit', <AuditPage />)

    expectActiveTab('auditPage.tabs.audit')
  })
})
