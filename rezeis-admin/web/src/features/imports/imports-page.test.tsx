import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import ImportsPage from './imports-page'

describe('ImportsPage RBAC gating', () => {
  beforeAll(async () => {
    await loadFeatureBundle('imports')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch or render imports without imports:view', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [] } })
    grantPermissions([])

    renderWithProviders(<ImportsPage />)

    expect(await screen.findByText('Import access is restricted')).toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
  })

  it('shows import history read-only when import and run grants are absent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        items: [
          {
            id: 'import-1',
            filename: 'import.json',
            sourceType: 'remnawave',
            status: 'COMMITTED',
            recordsTotal: 2,
            recordsOk: 2,
            recordsFailed: 0,
            errorMessage: null,
            createdAt: '2026-06-03T00:00:00.000Z',
            committedAt: '2026-06-03T00:01:00.000Z',
          },
        ],
      },
    })
    grantPermissions([{ resource: 'imports', action: 'view' }])

    renderWithProviders(<ImportsPage />)

    expect(await screen.findByText('Import history is read-only')).toBeInTheDocument()
    expect(await screen.findByText('remnawave')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run sync' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select file' })).not.toBeInTheDocument()
  })
})

describe('the importer tabs an operator can actually use', () => {
  beforeAll(async () => {
    await loadFeatureBundle('imports')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [] } })
  })

  it('offers every source this panel can import from', async () => {
    // Nothing enumerated the tabs, so the whole import surface was verified
    // by whoever clicked it. A source registered on the API and forgotten in
    // the page — or the reverse — shipped green.
    grantPermissions([
      { resource: 'imports', action: 'view' },
      { resource: 'imports', action: 'import' },
    ])

    renderWithProviders(<ImportsPage />)

    // Matched loosely: two of the triggers carry an icon, which the
    // accessible name picks up alongside the word.
    for (const label of [/Remnawave/, /3x-ui/, /Remnashop/, /Altshop/, /STEALTHNET/, /Bedolaga/]) {
      expect(await screen.findByRole('tab', { name: label })).toBeInTheDocument()
    }
  })

  it('describes each donor in its own words, never a different donor’s', async () => {
    // THE DEFECT THIS TEST EXISTS FOR. The wallet block was gated on "does
    // this donor have a balance" but still rendered STEALTHNET's strings, so
    // the Bedolaga tab said "за 1 единицу баланса" while Bedolaga keeps its
    // wallet in KOPEKS and the importer had already divided by a hundred. An
    // operator reading that would enter 100 and grant every migrated customer
    // a hundred times their balance — a credit that is idempotent, so a
    // corrected re-import does not take it back.
    grantPermissions([
      { resource: 'imports', action: 'view' },
      { resource: 'imports', action: 'import' },
    ])

    renderWithProviders(<ImportsPage />)
    await userEvent.click(await screen.findByRole('tab', { name: /Bedolaga/ }))

    const panel = await screen.findByRole('tabpanel')
    const text = panel.textContent ?? ''
    expect(text).toMatch(/Bedolaga/)
    expect(text).not.toMatch(/STEALTHNET/i)
    // The unit the rate is counted in has to be on screen, in words — this is
    // the sentence whose absence would have cost every migrated customer a
    // hundred times their balance.
    expect(text).toMatch(/kopecks/i)
  })

  it('renders no raw translation keys on any file tab', async () => {
    // A bundle forgotten in BOTH languages is symmetric, so the parity suite
    // passes and the operator reads `importsPage.foo.title` off the screen.
    grantPermissions([
      { resource: 'imports', action: 'view' },
      { resource: 'imports', action: 'import' },
    ])

    renderWithProviders(<ImportsPage />)

    for (const label of [/3x-ui/, /Remnashop/, /Altshop/, /STEALTHNET/, /Bedolaga/]) {
      await userEvent.click(await screen.findByRole('tab', { name: label }))
      const panel = await screen.findByRole('tabpanel')
      expect(panel.textContent ?? '').not.toMatch(/importsPage\./)
    }
  })
})

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((permission) => `${permission.resource}:${permission.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}
