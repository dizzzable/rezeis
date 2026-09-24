/**
 * «Remnawave» page — what an operator is told about the panel version.
 *
 * A Remnawave 2.x panel is refused on every path, the status read included, so
 * the page lands in its error branch. That branch used to say "could not
 * connect — check configuration", which sends the operator to the wrong fix:
 * the configuration is fine, the panel is too old. The version read is the one
 * request the server still answers for such a panel, and `tooOld` is what it
 * says; these cases pin that the page listens to it in both branches, and that
 * the untested-version notice stays what it was for a 3.x outside the set.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import RemnaWavePage from './remnawave-page'

// The tabs own their own queries; none of them is under test here.
vi.mock('./catalog/catalog-tab', () => ({ CatalogTab: () => null }))
vi.mock('./costs/costs-tab', () => ({ CostsTab: () => null }))
vi.mock('./dashboard/dashboard-tab', () => ({ DashboardTab: () => null }))
vi.mock('./infra/infra-tab', () => ({ InfraTab: () => null }))
vi.mock('./live/live-tab', () => ({ LiveTab: () => null }))
vi.mock('./settings/settings-tab', () => ({ SettingsTab: () => null }))
vi.mock('./users/users-tab', () => ({ UsersTab: () => null }))

const REFUSED_2X = {
  version: '2.7.4',
  major: 2,
  minor: 7,
  patch: 4,
  supported: false,
  tooOld: true,
  reachable: true,
  liveIpControl: false,
  bandwidthNodesUsers: false,
  userAddressing: 'unknown',
  connectionsApi: 'unknown',
  userLookups: { byTelegramId: false, byEmail: false },
}

/** A 3.x outside the tested set: served, and warned about as "untested". */
const UNTESTED_3X = {
  ...REFUSED_2X,
  version: '3.1.0',
  major: 3,
  minor: 1,
  patch: 0,
  tooOld: false,
  liveIpControl: true,
  bandwidthNodesUsers: true,
  userAddressing: 'id',
  connectionsApi: 'connections',
}

const UNREADABLE = {
  ...REFUSED_2X,
  version: null,
  major: null,
  minor: null,
  patch: null,
  tooOld: false,
  reachable: false,
}

const STATUS_OK = { isReachable: true, branding: null }

/** The body the server sends with its 502 on a 2.x panel. */
function tooOldRejection(): Error {
  return Object.assign(new Error('Request failed with status code 502'), {
    isAxiosError: true,
    response: {
      status: 502,
      data: { code: 'REZEIS_PANEL_TOO_OLD', message: 'Remnawave 2.x is not supported. Update the panel to 3.x.' },
    },
  })
}

function serve(options: { status: 'ok' | 'refused'; capabilities: unknown }) {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/remnawave/status') {
      if (options.status === 'refused') throw tooOldRejection()
      return { data: STATUS_OK }
    }
    if (path === '/admin/remnawave/version') return { data: options.capabilities }
    throw new Error(`unexpected GET ${path}`)
  })
}

function text(key: string, vars?: Record<string, unknown>): string {
  const value = i18n.t(key, vars)
  // A missing bundle renders the key itself, and an assertion against the key
  // would pass over a page that printed nothing but keys.
  expect(value).not.toBe(key)
  return value
}

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('remnawave')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RemnaWavePage — the panel version notice', () => {
  it('a refused 2.x panel says "not supported, update the panel", not "check the configuration"', async () => {
    serve({ status: 'refused', capabilities: REFUSED_2X })
    renderWithProviders(<RemnaWavePage />)

    const notice = await screen.findByTestId('remnawave-panel-too-old')
    expect(notice).toHaveTextContent(text('remnaWavePage.panelTooOld.title', { version: '2.7.4' }))
    expect(notice).toHaveTextContent(text('remnaWavePage.panelTooOld.description'))
    expect(notice).toHaveTextContent('2.7.4')
    expect(screen.queryByText(text('remnaWavePage.connectionError'))).toBeNull()
    expect(screen.queryByText(text('remnaWavePage.connectionErrorDescription'))).toBeNull()
  })

  it('a status read that fails for any other reason still says "could not connect"', async () => {
    serve({ status: 'refused', capabilities: UNREADABLE })
    renderWithProviders(<RemnaWavePage />)

    expect(await screen.findByText(text('remnaWavePage.connectionError'))).toBeInTheDocument()
    expect(screen.queryByTestId('remnawave-panel-too-old')).toBeNull()
  })

  it('shows the 2.x notice INSTEAD of the untested-version warning when the page renders', async () => {
    serve({ status: 'ok', capabilities: REFUSED_2X })
    renderWithProviders(<RemnaWavePage />)

    expect(await screen.findByTestId('remnawave-panel-too-old')).toBeInTheDocument()
    expect(screen.queryByText(text('remnaWavePage.versionWarning.title'))).toBeNull()
  })

  it('keeps the untested-version warning for a 3.x outside the tested set', async () => {
    serve({ status: 'ok', capabilities: UNTESTED_3X })
    renderWithProviders(<RemnaWavePage />)

    expect(await screen.findByText(text('remnaWavePage.versionWarning.title'))).toBeInTheDocument()
    expect(
      screen.getByText(text('remnaWavePage.versionWarning.description', { version: '3.1.0' })),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('remnawave-panel-too-old')).toBeNull()
  })
})
