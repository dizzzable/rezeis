/**
 * The (i) on «Сигналы фрода» that says which detectors work on this panel.
 *
 * Every row is read from the capability the server reports, never from a
 * version comparison here. A Remnawave 2.x panel is refused on every path — the
 * HWID reads included — so on such a panel no row may say "active"; an
 * unreadable version is never refused, so it keeps the HWID row on.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { en } from '@/i18n/en'
import { i18n, i18nReady } from '@/i18n/i18n'
import { ru } from '@/i18n/ru'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import { FraudVersionInfo } from './fraud-version-info'

const BASE = {
  major: null,
  minor: null,
  patch: null,
  supported: false,
  tooOld: false,
  reachable: true,
  liveIpControl: false,
  bandwidthNodesUsers: false,
  userAddressing: 'unknown',
  connectionsApi: 'unknown',
  userLookups: { byTelegramId: false, byEmail: false },
}

const REFUSED_2X = { ...BASE, version: '2.7.4', major: 2, minor: 7, patch: 4, tooOld: true }
const PANEL_321 = {
  ...BASE,
  version: '3.2.1',
  major: 3,
  minor: 2,
  patch: 1,
  supported: true,
  liveIpControl: true,
  bandwidthNodesUsers: true,
  userAddressing: 'id',
  connectionsApi: 'connections',
}
const UNREADABLE = { ...BASE, version: null, reachable: false }

const t = (key: string, vars?: Record<string, unknown>): string => {
  const value = i18n.t(`fraudPage.versionInfo.${key}`, vars)
  expect(value).not.toBe(`fraudPage.versionInfo.${key}`)
  return value
}

/** The text of the tooltip row whose label is `label`. */
function rowText(tooltip: HTMLElement, label: string): string {
  const row = within(tooltip).getByText(label).closest('li')
  if (row === null) throw new Error(`no row for ${label}`)
  return row.textContent ?? ''
}

async function openFor(capabilities: unknown, expectedVersionLine: string): Promise<HTMLElement> {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/remnawave/version') return { data: capabilities }
    throw new Error(`unexpected GET ${path}`)
  })
  const user = userEvent.setup()
  renderWithProviders(<FraudVersionInfo />)
  await user.hover(screen.getByRole('button', { name: t('label') }))
  const tooltip = await screen.findByRole('tooltip')
  // The capability read is async: wait for the line that proves it landed, so
  // no assertion below is made against the "unknown" first paint.
  await waitFor(() => expect(tooltip).toHaveTextContent(expectedVersionLine))
  return tooltip
}

beforeAll(async () => {
  await i18nReady
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FraudVersionInfo', () => {
  it('on a refused 2.x panel no detector is "active" — HWID included — and the floor named is 3.x', async () => {
    const tooltip = await openFor(REFUSED_2X, t('detected', { version: '2.7.4' }))

    const hwid = rowText(tooltip, t('hwid'))
    expect(hwid).not.toContain(t('active'))
    expect(hwid).toContain(t('allVersions'))
    expect(rowText(tooltip, t('ipSharing'))).toContain(t('needs3x'))
    expect(rowText(tooltip, t('perUserTraffic'))).toContain(t('needs3x'))
  })

  it('on a 3.x panel every detector is active', async () => {
    const tooltip = await openFor(PANEL_321, t('detected', { version: '3.2.1' }))

    for (const label of [t('hwid'), t('ipSharing'), t('perUserTraffic')]) {
      expect(rowText(tooltip, label)).toContain(t('active'))
    }
  })

  it('an unreadable version is never refused: the HWID row stays on', async () => {
    const tooltip = await openFor(UNREADABLE, t('unknown'))

    expect(rowText(tooltip, t('hwid'))).toContain(t('active'))
    expect(rowText(tooltip, t('ipSharing'))).toContain(t('needs3x'))
  })

  it('names no 2.x floor in either language', () => {
    for (const [lng, dictionary] of [['en', en], ['ru', ru]] as const) {
      const info = dictionary.fraudPage.versionInfo
      expect(info.needs3x, lng).toMatch(/3\.x/)
      expect(`${info.needs3x} ${info.allVersions}`, lng).not.toMatch(/2\.8|2\.x/)
    }
  })
})
