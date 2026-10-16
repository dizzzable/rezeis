import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { usePermissionStore } from '@/features/rbac'
import { renderWithProviders } from '@/test/test-utils'
import { connectPageApi, type ConnectPageConfig } from '@/features/connect-page/connect-page-api'
import { ConnectScreenCard } from './connect-screen-card'

/**
 * The card that decides where «Подключить» goes, now with HOW the cabinet's
 * own screen connects.
 *
 * What matters is what the card WRITES: the mode on its own endpoint and
 * nothing else — a mode sent through the catalog's PUT would freeze the
 * built-in catalog into the database on the first pick, the defect the switch
 * already went through.
 */

vi.mock('@/lib/api', () => ({ api: { put: vi.fn(), get: vi.fn() } }))

vi.mock('@/features/connect-page/connect-page-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/connect-page/connect-page-api')>()
  return { ...actual, connectPageApi: { get: vi.fn() } }
})

function config(overrides: Partial<ConnectPageConfig> = {}): ConnectPageConfig {
  return { version: 2, connectScreenEnabled: true, icons: {}, platforms: [], ...overrides }
}

function grant(tokens: readonly string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

beforeEach(async () => {
  await loadFeatureBundle('subpageConfig')
  grant(['subpage_config:view', 'subpage_config:edit'])
})

afterEach(() => {
  cleanup()
  usePermissionStore.getState().reset()
  vi.clearAllMocks()
})

describe('the connect mode', () => {
  it('shows the page with every instruction as chosen when the panel names no mode', async () => {
    vi.mocked(connectPageApi.get).mockResolvedValue({ config: config(), stored: false, corrupted: null })
    renderWithProviders(<ConnectScreenCard />)

    const page = await screen.findByRole('radio', { name: /Every instruction on one screen/ })
    expect(page).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Interactive — step by step/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('writes the walk on its own endpoint, and only there', async () => {
    vi.mocked(connectPageApi.get).mockResolvedValue({ config: config(), stored: false, corrupted: null })
    vi.mocked(api.put).mockResolvedValue({ data: { mode: 'interactive' } })
    renderWithProviders(<ConnectScreenCard />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('radio', { name: /Interactive — step by step/ }))

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(api.put).toHaveBeenCalledWith('/admin/connect-page/mode', { mode: 'interactive' })
  })

  it('says an older cabinet keeps the ordinary screen while the walk is chosen', async () => {
    vi.mocked(connectPageApi.get).mockResolvedValue({
      config: config({ connectScreenMode: 'interactive' }),
      stored: true,
      corrupted: null,
    })
    renderWithProviders(<ConnectScreenCard />)

    expect(await screen.findByText(/0\.9\.7\.56 or older opens the ordinary screen/)).toBeInTheDocument()
  })

  it('says the choice waits for the switch while the screen is off', async () => {
    vi.mocked(connectPageApi.get).mockResolvedValue({
      config: config({ connectScreenEnabled: false }),
      stored: true,
      corrupted: null,
    })
    renderWithProviders(<ConnectScreenCard />)

    expect(await screen.findByText('The choice takes effect once the connect screen is on.')).toBeInTheDocument()
  })

  it('cannot be changed without the edit permission', async () => {
    grant(['subpage_config:view'])
    vi.mocked(connectPageApi.get).mockResolvedValue({ config: config(), stored: false, corrupted: null })
    renderWithProviders(<ConnectScreenCard />)

    expect(await screen.findByRole('radio', { name: /Interactive — step by step/ })).toBeDisabled()
  })
})
