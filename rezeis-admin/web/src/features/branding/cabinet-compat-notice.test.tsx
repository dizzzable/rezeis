/**
 * «Кабинет Reiwa» at the top of «WEB Reiwa» (pair reliability, 26.09.2026).
 *
 * Pinned here:
 *   - every surface is named with its version and last contact, and a cabinet
 *     that does not declare its capabilities is said to be one;
 *   - an old cabinet turns the block amber and lists what does not work until
 *     it is updated, the withheld sale first, in the operator's language;
 *   - a cabinet newer than the panel is counted;
 *   - an answer it cannot read shows nothing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'

import api from '@/lib/api'
import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import { missingWhileBehind, readCabinetCompat } from './cabinet-compat-api'
import { CabinetCompatNotice } from './cabinet-compat-notice'

const NOW = Date.parse('2026-09-26T12:00:00.000Z')

const GATE = {
  id: 'web.addon-reset-end',
  kind: 'gate',
  since: '0.9.7.53',
  operatorText: 'докупка трафика «до сброса» в кабинете не продаётся',
  operatorTextEn: 'traffic top-ups “until the reset” are not sold in the cabinet',
}
const DEGRADED = {
  id: 'web.bell-addon-not-applied',
  kind: 'degraded',
  since: '0.9.7.53',
  operatorText: 'уведомление «Докупка не применена» в колокольчике открывает «Доп. опции», а не «Поддержку»',
  operatorTextEn: 'the bell’s “Add-on not applied” opens “Add-ons” instead of “Support”',
}

function surface(overrides: Record<string, unknown> = {}) {
  return {
    state: 'live',
    behind: false,
    version: '0.9.7.54',
    lastSeenAt: new Date(NOW - 20_000).toISOString(),
    declared: true,
    capabilities: [],
    missing: [],
    unknownToPanel: 0,
    instances: [],
    ...overrides,
  }
}

function answer(apiSurface: unknown, botSurface: unknown) {
  return {
    data: {
      panelVersion: '0.9.7.71',
      floorVersion: '0.9.7.52',
      checkedAt: new Date(NOW).toISOString(),
      surfaces: { api: apiSurface, bot: botSurface },
    },
  }
}

function renderNotice() {
  return renderWithProviders(<CabinetCompatNotice now={() => NOW} />)
}

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('branding')
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  if (i18n.language !== 'en') {
    await i18n.changeLanguage('en')
    await loadFeatureBundle('branding')
  }
})

describe('reading the answer', () => {
  it('keeps what it can read and nothing else', () => {
    expect(readCabinetCompat(undefined)).toBeNull()
    expect(readCabinetCompat({ surfaces: null, panelVersion: '0.9.7.71' })).toBeNull()
    expect(readCabinetCompat({ surfaces: {}, panelVersion: 71 })).toBeNull()
    const read = readCabinetCompat(
      answer(surface({ missing: [GATE, { id: 7 }, null, { id: 'x', kind: 'gate' }] }), 'garbage').data,
    )
    expect(read?.surfaces.api.missing).toEqual([
      { id: GATE.id, kind: 'gate', operatorText: GATE.operatorText, operatorTextEn: GATE.operatorTextEn },
    ])
    expect(read?.surfaces.bot.state).toBe('unavailable')
  })

  it('lists what is missing on the surfaces that are behind, once each, the sales first', () => {
    const read = readCabinetCompat(
      answer(surface({ behind: true, missing: [DEGRADED, GATE] }), surface({ behind: false, missing: [DEGRADED] })).data,
    )
    expect(read === null ? [] : missingWhileBehind(read).map((row) => row.id)).toEqual([GATE.id, DEGRADED.id])
  })
})

describe('the block', () => {
  it('names each surface with its version and last contact, from GET /admin/reiwa-peers', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(answer(surface(), surface({ version: '0.9.7.54' })))
    renderNotice()

    const block = await screen.findByTestId('cabinet-compat-notice')
    expect(get).toHaveBeenCalledWith('/admin/reiwa-peers')
    expect(block).toHaveAttribute('data-behind', 'false')
    expect(within(block).getByText('Reiwa cabinet')).toBeInTheDocument()
    expect(within(block).getByTestId('cabinet-compat-api')).toHaveTextContent(
      'Site and API: Reiwa 0.9.7.54 · last heard just now',
    )
    expect(within(block).getByTestId('cabinet-compat-bot')).toHaveTextContent('Bot: Reiwa 0.9.7.54 · last heard just now')
    expect(within(block).queryAllByTestId('cabinet-compat-missing')).toHaveLength(0)
  })

  it('an old cabinet: amber, what does not work until it is updated — the withheld sale first — and nothing charged', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      answer(
        surface({ version: '0.9.7.52', declared: false, behind: true, missing: [DEGRADED, GATE] }),
        surface({ state: 'never', version: null, lastSeenAt: null, declared: false }),
      ),
    )
    renderNotice()

    const block = await screen.findByTestId('cabinet-compat-notice')
    expect(block).toHaveAttribute('data-behind', 'true')
    expect(within(block).getByText('The cabinet is older than this panel (0.9.7.71)')).toBeInTheDocument()
    expect(within(block).getByTestId('cabinet-compat-api')).toHaveTextContent(
      'Reiwa 0.9.7.52 · last heard just now · reports its version, not what it can do (Reiwa 0.9.7.53 and older)',
    )
    // The bot of Reiwa 0.9.7.52 sends nothing at all: never heard from is not «never ran».
    expect(within(block).getByTestId('cabinet-compat-bot')).toHaveTextContent(
      'Bot: does not report itself (Reiwa 0.9.7.52 and older) or has not contacted the panel yet',
    )
    const items = within(block).getAllByTestId('cabinet-compat-missing')
    expect(items.map((item) => [item.textContent, item.getAttribute('data-kind')])).toEqual([
      [GATE.operatorTextEn, 'gate'],
      [DEGRADED.operatorTextEn, 'degraded'],
    ])
    expect(within(block).getByText(/nothing is charged for what is hidden/)).toBeInTheDocument()
  })

  it('says it in Russian, with the panel’s own words', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('branding')
    vi.spyOn(api, 'get').mockResolvedValue(
      answer(surface({ version: '0.9.7.52', declared: false, behind: true, missing: [GATE] }), surface()),
    )
    renderNotice()

    const block = await screen.findByTestId('cabinet-compat-notice')
    expect(within(block).getByText('Кабинет старше этой панели (0.9.7.71)')).toBeInTheDocument()
    expect(within(block).getByTestId('cabinet-compat-api')).toHaveTextContent('Сайт и API: Reiwa 0.9.7.52 · был на связи только что')
    expect(within(block).getByTestId('cabinet-compat-missing')).toHaveTextContent(GATE.operatorText)
    expect(within(block).getByText(/деньги за скрытое не списываются/)).toBeInTheDocument()
  })

  it('a quiet surface is «silent, last heard …» (review R1-14), and one the panel cannot read says so', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      answer(
        surface({ state: 'quiet', lastSeenAt: new Date(NOW - 3 * 60 * 60_000).toISOString() }),
        surface({ state: 'unavailable', version: null, lastSeenAt: null }),
      ),
    )
    renderNotice()

    const block = await screen.findByTestId('cabinet-compat-notice')
    expect(within(block).getByTestId('cabinet-compat-api')).toHaveTextContent(/Reiwa 0\.9\.7\.54 · silent, last heard 3 hours ago/)
    expect(within(block).getByTestId('cabinet-compat-bot')).toHaveTextContent(
      'Bot: the panel cannot read what it knows about it right now',
    )
  })

  it('a cabinet not heard from yet: the sale the floor withholds is named, the guesses are not (review R1-12)', async () => {
    // Right after the panel's update a 0.9.7.52 cabinet has left no evidence
    // until its hourly heartbeat, and «до сброса» is already not sold.
    const STALE_BUTTON = { ...DEGRADED, id: 'bot.stale-button-menu', operatorTextEn: 'the bot stays silent on an old button' }
    vi.spyOn(api, 'get').mockResolvedValue(
      answer(
        surface({ state: 'never', version: null, lastSeenAt: null, declared: false, missing: [GATE, DEGRADED] }),
        surface({ state: 'never', version: null, lastSeenAt: null, declared: false, missing: [STALE_BUTTON] }),
      ),
    )
    renderNotice()
    const block = await screen.findByTestId('cabinet-compat-notice')
    expect(block).toHaveAttribute('data-withheld', 'true')
    expect(block).toHaveAttribute('data-behind', 'false')
    expect(within(block).getByText('Reiwa cabinet')).toBeInTheDocument()
    expect(within(block).getByTestId('cabinet-compat-api')).toHaveTextContent(
      'Site and API: has not reported itself yet (Reiwa 0.9.7.52 reports its version once an hour) or has not contacted the panel',
    )
    expect(within(block).getByText('Until the cabinet reports itself, the panel takes it for version 0.9.7.52:')).toBeInTheDocument()
    expect(within(block).getAllByTestId('cabinet-compat-withheld').map((item) => item.textContent)).toEqual([GATE.operatorTextEn])
    expect(within(block).queryByText(DEGRADED.operatorTextEn)).toBeNull()
    expect(within(block).queryByText(STALE_BUTTON.operatorTextEn)).toBeNull()
    cleanup()

    await i18n.changeLanguage('ru')
    await loadFeatureBundle('branding')
    renderNotice()
    const russian = await screen.findByTestId('cabinet-compat-notice')
    expect(within(russian).getByTestId('cabinet-compat-bot')).toHaveTextContent(
      'Бот: не сообщает о себе (Reiwa 0.9.7.52 и старше) или ещё не выходил на связь с панелью',
    )
    expect(within(russian).getByText('Пока кабинет не сообщил о себе, панель считает его версией 0.9.7.52:')).toBeInTheDocument()
    expect(within(russian).getByTestId('cabinet-compat-withheld')).toHaveTextContent(GATE.operatorText)
  })

  it('a bot not heard from beside a working site withholds nothing: the block stays neutral', async () => {
    const STALE_BUTTON = { ...DEGRADED, id: 'bot.stale-button-menu' }
    vi.spyOn(api, 'get').mockResolvedValue(
      answer(surface({ declared: false }), surface({ state: 'never', version: null, lastSeenAt: null, missing: [STALE_BUTTON] })),
    )
    renderNotice()
    const block = await screen.findByTestId('cabinet-compat-notice')
    expect(block).toHaveAttribute('data-withheld', 'false')
    expect(within(block).queryAllByTestId('cabinet-compat-withheld')).toHaveLength(0)
  })

  it('counts what a cabinet newer than the panel can do that the panel does not know', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(answer(surface({ unknownToPanel: 2 }), surface()))
    renderNotice()

    expect(await screen.findByTestId('cabinet-compat-newer')).toHaveTextContent(
      'it has capabilities the panel does not know yet (2)',
    )
  })

  it('shows nothing for an answer it cannot read', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { surfaces: null } })
    renderNotice()
    await vi.waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByTestId('cabinet-compat-notice')).toBeNull()
  })
})

describe('on «WEB Reiwa»', () => {
  it('sits at the top of the page, above the cabinet’s report on the last save', () => {
    // Source assertion, as the bundle test pins the route: the page pulls in
    // the whole editor, and what is guarded is one line of wiring.
    const page = readFileSync(join(__dirname, 'branding-page.tsx'), 'utf8')
    const block = page.indexOf('<CabinetCompatNotice />')
    const report = page.indexOf('<BrandingDeliveryNotice')
    expect(block).toBeGreaterThan(0)
    expect(block).toBeLessThan(report)
  })
})
