import { useEffect, type JSX } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation, useNavigate } from 'react-router'

import { usePermissionStore } from '@/features/rbac'
import { SUBSCRIPTION_DELETE_REFUSAL_REMEDY_HREF } from '@/features/users/subscription-delete-refusals'
import { ru as toolsRu } from '@/i18n/features/subscriptionTools.ru'
import { coreDictionaryReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import SubscriptionsPage from './subscriptions-page'
import i18n from 'i18next'

const DAY_MS = 24 * 60 * 60 * 1000

/** Column order of the table under test: the expiry is the seventh cell. */
const EXPIRES_CELL = 6

/**
 * Every instant this file uses is derived from the moment the suite runs.
 *
 * The fixture here was a literal `2026-06-04T10:00:00.000Z`, written while it
 * was still in the future. Nothing marks the day such a literal slips into the
 * past, and on that day the row silently stops describing a live subscription
 * and starts describing an expired one — the assertion keeps passing over a
 * case it no longer names. Noon local, so no timezone offset can move the
 * rendered calendar day away from the one asserted.
 */
function isoDaysFromNow(days: number): string {
  const d = new Date(Date.now() + days * DAY_MS)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

/**
 * `dd.mm.yyyy`, spelled out from the date's own parts rather than borrowed
 * from `toLocaleDateString` — the call the component makes is the thing under
 * test, so re-running it here would assert only that it equals itself.
 */
function expectedRuDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

/**
 * The same date the component would print, in the language the panel is
 * currently in.
 *
 * The cell used to be pinned to `ru-RU` and so was this expectation. Now it
 * follows the operator's language like every other date in the panel, and an
 * assertion that hard-codes one language would fail in the other for a reason
 * that has nothing to do with the cell.
 *
 * The parts are still spelled out by hand rather than borrowed from
 * `toLocaleDateString` — re-running the component's own call here would
 * assert only that it equals itself.
 */
function expectedDate(iso: string): string {
  return i18n.language?.startsWith('ru') === true
    ? expectedRuDate(iso)
    : (() => {
        const d = new Date(iso)
        return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
      })()
}

const datedExpiry = isoDaysFromNow(30)

function expiresCellOf(rowText: string): HTMLElement {
  const row = screen.getByText(rowText).closest('tr')
  if (row === null) throw new Error(`no row for ${rowText}`)
  return within(row).getAllByRole('cell')[EXPIRES_CELL]
}

describe('SubscriptionsPage accessibility', () => {
  beforeEach(() => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/subscriptions?')) {
        return {
          data: {
            items: [
              {
                id: 'subscription-1',
                user: { id: 'cluseralice0000000000001', name: 'Alice' },
                userTelegramId: '12345',
                status: 'ACTIVE',
                isTrial: false,
                plan: { name: 'Premium' },
                trafficLimit: null,
                deviceLimit: null,
                expireAt: datedExpiry,
              },
              {
                // `expiresAt` is `DateTime?` on the model and the list mapper
                // sends `?.toISOString() ?? null`, so this is exactly what an
                // UNLIMITED subscription looks like on the wire — not an
                // absent field, not an empty string.
                id: 'subscription-2',
                user: { id: 'cluserboris00000000000002', name: 'Boris' },
                userTelegramId: '67890',
                status: 'ACTIVE',
                isTrial: false,
                plan: { name: 'Lifetime' },
                trafficLimit: null,
                deviceLimit: null,
                expireAt: null,
              },
            ],
            total: 2,
          },
        }
      }

      if (path === '/admin/subscriptions/stats') {
        return {
          data: {
            total: 2,
            byStatus: { ACTIVE: 2 },
            trialCount: 0,
            expiringIn7d: 0,
          },
        }
      }

      return { data: {} }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('names icon-only subscription actions', async () => {
    renderWithProviders(<SubscriptionsPage />)

    expect(await screen.findByRole('button', { name: 'Refresh subscriptions' })).toBeInTheDocument()
    // Open-user aria prefers reiwa user id (works for web-only / no Telegram).
    expect(
      await screen.findByRole('button', { name: 'Open user cluseralice0000000000001' }),
    ).toBeInTheDocument()
  })

  it('names the status filter select', async () => {
    renderWithProviders(<SubscriptionsPage />)

    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeInTheDocument()
  })

  it('makes the whole row open the user profile (incl. web-only via user.id)', async () => {
    renderWithProviders(<SubscriptionsPage />)

    const userCell = await screen.findByText('Alice')
    const row = userCell.closest('tr')
    expect(row).toHaveClass('cursor-pointer')
    // Keyboard parity without nested interactive roles: focusable row + named ↗ button.
    expect(row).toHaveAttribute('tabindex', '0')
    expect(
      screen.getByRole('button', { name: 'Open user cluseralice0000000000001' }),
    ).toBeInTheDocument()
  })

  it('renders an unlimited subscription as unlimited — not 1970, not blank, not a dash', async () => {
    // `expireAt: null` means the subscription never expires. Typed as a bare
    // `string`, it reached `new Date(null)`, which coerces to 0 and printed a
    // confident `01.01.1970` on every unlimited row.
    //
    // A dash would be no better and is asserted against on purpose: "—" says
    // "we do not know", and we do know. Three distinct wrong answers are
    // rejected here so that swapping the fix for `?? 0`, `?? ''` or a fallback
    // em dash cannot leave this test green.
    renderWithProviders(<SubscriptionsPage />)

    await screen.findByText('Boris')
    const cell = expiresCellOf('Boris')

    expect(cell).toHaveTextContent('Unlimited')
    expect(cell.textContent?.trim()).toBe('Unlimited')
    expect(cell).not.toHaveTextContent('1970')
    expect(cell.textContent?.trim()).not.toBe('')
    expect(cell.textContent?.trim()).not.toBe('—')
    expect(cell.textContent?.trim()).not.toBe('-')
  })

  it('renders a real expiry as that date', async () => {
    // The other half of the same statement: the null branch must not swallow
    // rows that DO have an expiry, or "unlimited" would become the panel's
    // answer to everything.
    renderWithProviders(<SubscriptionsPage />)

    await screen.findByText('Alice')
    const cell = expiresCellOf('Alice')

    expect(cell.textContent?.trim()).toBe(expectedDate(datedExpiry))
    expect(cell).not.toHaveTextContent('Unlimited')
  })
})

/**
 * «Подписки» → «Инструменты»: the header button, the sheet it opens, which
 * tabs an admin sees, and the address that opens a tab.
 *
 * Driven in RUSSIAN, because the tab titles are the words server messages send
 * the operator to — «Подписки» → «Инструменты» → «Слияние подписок-дубликатов» —
 * and they are asserted byte for byte.
 *
 * The address is observed through a probe beside the page: the sheet's state
 * IS the `?tools=` parameter, so "closing removes it" and "switching rewrites
 * it" are facts about the address, not about the DOM.
 */
describe('«Инструменты» — the sheet behind the header button', () => {
  const TABS_RU = [
    'Слияние подписок-дубликатов',
    'Подписки на сквадах, которых нет в панели',
    'Подписки без привязки к Remnawave',
    'Лишние профили в Remnawave',
    'Бессрочные подписки с датой',
  ]

  const CHECK = {
    lastRunAt: '2026-09-24T09:00:00.000Z',
    lastRunTrigger: 'daily',
    lastRunOutcome: 'complete',
    nextRunAt: '2026-09-25T03:00:00.000Z',
    running: false,
  }

  const UNLINKED = {
    check: CHECK,
    total: 1,
    truncated: false,
    rows: [
      {
        subscriptionId: 'sub-dup',
        userId: 'user-1',
        userName: 'Алиса',
        userTelegramId: '12345',
        status: 'ACTIVE',
        planName: 'Премиум',
        createdAt: '2026-08-01T10:00:00.000Z',
        storedRemnawaveId: null,
        linkKind: 'empty',
        reason: 'duplicatePair',
        profileId: '4471',
        otherSubscriptionId: 'sub-live',
        otherUserId: null,
        lookedUpBy: 'shortUuid',
        checkedAt: '2026-09-24T09:00:00.000Z',
      },
    ],
  }

  /** Where the page is, and a way to move it without a click. */
  let navigateTo: ((to: string) => void) | null = null

  function LocationProbe(): JSX.Element {
    const location = useLocation()
    const navigate = useNavigate()
    useEffect(() => {
      navigateTo = navigate
    }, [navigate])
    return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  }

  function address(): string {
    return screen.getByTestId('location').textContent ?? ''
  }

  function mockGets() {
    return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/subscriptions?')) return { data: { items: [], total: 0 } }
      if (path === '/admin/subscriptions/stats') {
        return { data: { total: 0, byStatus: {}, trialCount: 0, expiringIn7d: 0 } }
      }
      if (path === '/admin/profile-sync/panel-links/unlinked') return { data: UNLINKED }
      if (path === '/admin/profile-sync/panel-links/extra-profiles') {
        return {
          data: {
            check: CHECK,
            comparedAt: null,
            readOutcome: null,
            profilesRead: 0,
            profilesWithoutOwner: 0,
            autoLinked: 0,
            customers: [],
            truncated: false,
          },
        }
      }
      if (path === '/admin/subscriptions/lifetime-restore') {
        return { data: { rows: [], total: 0, truncated: false } }
      }
      return { data: {} }
    })
  }

  function grant(...tokens: string[]): void {
    usePermissionStore.setState({
      loaded: true,
      loading: false,
      granted: new Set(tokens),
      mustChangePassword: false,
      role: 'ADMIN',
      rbacRoleId: 'role-1',
      error: null,
    })
  }

  function renderPage(route = '/subscriptions') {
    return renderWithProviders(
      <>
        <SubscriptionsPage />
        <LocationProbe />
      </>,
      { route },
    )
  }

  async function openSheet(route = '/subscriptions'): Promise<HTMLElement> {
    renderPage(route)
    return screen.findByRole('dialog', { name: 'Инструменты подписок' })
  }

  function tabTitles(sheet: HTMLElement): string[] {
    return within(sheet)
      .getAllByRole('tab')
      .map((tab) => tab.textContent ?? '')
  }

  function selectedTab(sheet: HTMLElement): string {
    return within(sheet).getByRole('tab', { selected: true }).textContent ?? ''
  }

  beforeAll(async () => {
    await i18n.changeLanguage('ru')
    await coreDictionaryReady('ru')
    await loadFeatureBundle('subscriptionTools')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.getState().reset()
    mockGets()
  })

  afterEach(() => {
    cleanup()
  })

  it('names the button, the sheet and the five tabs exactly as the server messages do', () => {
    expect(toolsRu.subscriptionTools.button).toBe('Инструменты')
    expect(toolsRu.subscriptionTools.sheet.title).toBe('Инструменты подписок')
    expect(Object.values(toolsRu.subscriptionTools.tabs)).toEqual(TABS_RU)
  })

  it('puts «Инструменты» in the header next to ↻, and no tool card in the page body', async () => {
    grant('subscriptions:edit', 'plans:view')
    renderPage()

    const button = await screen.findByRole('button', { name: 'Инструменты' })
    expect(button.parentElement).toContainElement(screen.getByRole('button', { name: 'Обновить подписки' }))
    // The cards that used to sit above the list are behind the button now.
    expect(screen.queryByText('Слияние подписок-дубликатов')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Предпросмотр слияния' })).not.toBeInTheDocument()
    expect(screen.queryByText('Подписки на сквадах, которых нет в панели')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Проверить' })).not.toBeInTheDocument()
    // …and the repair card is gone for good.
    expect(screen.queryByText('Починка привязки к панели')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(address()).toBe('/subscriptions')
  })

  it('opens the sheet with all five tabs, in order, for an admin with both permissions', async () => {
    grant('subscriptions:edit', 'plans:view')
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Инструменты' }))

    const sheet = await screen.findByRole('dialog', { name: 'Инструменты подписок' })
    expect(tabTitles(sheet)).toEqual(TABS_RU)
    expect(selectedTab(sheet)).toBe('Слияние подписок-дубликатов')
    expect(within(sheet).getByRole('button', { name: 'Предпросмотр слияния' })).toBeInTheDocument()
    expect(address()).toBe('/subscriptions?tools=merge')
  })

  it('with only subscriptions:edit, shows the merge, the two link lists and the lifetime census', async () => {
    grant('subscriptions:edit')
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Инструменты' }))

    const sheet = await screen.findByRole('dialog', { name: 'Инструменты подписок' })
    expect(tabTitles(sheet)).toEqual([TABS_RU[0], TABS_RU[2], TABS_RU[3], TABS_RU[4]])
  })

  it('with only plans:view, shows the squads report alone', async () => {
    grant('plans:view')
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Инструменты' }))

    const sheet = await screen.findByRole('dialog', { name: 'Инструменты подписок' })
    expect(tabTitles(sheet)).toEqual([TABS_RU[1]])
    expect(selectedTab(sheet)).toBe('Подписки на сквадах, которых нет в панели')
    expect(within(sheet).getByRole('button', { name: 'Проверить' })).toBeInTheDocument()
    expect(address()).toBe('/subscriptions?tools=squads')
  })

  it('with neither, shows no button — and an address naming a tab opens nothing', async () => {
    grant('subscriptions:view')
    renderPage('/subscriptions?tools=merge')

    await screen.findByRole('button', { name: 'Обновить подписки' })
    expect(screen.queryByRole('button', { name: 'Инструменты' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the tab the address names: ?tools=lifetime', async () => {
    grant('subscriptions:edit', 'plans:view')
    const get = vi.mocked(api.get)

    const sheet = await openSheet('/subscriptions?tools=lifetime')

    expect(selectedTab(sheet)).toBe('Бессрочные подписки с датой')
    expect(await within(sheet).findByText('Бессрочных подписок с датой нет.')).toBeInTheDocument()
    expect(get.mock.calls.some((call) => call[0] === '/admin/subscriptions/lifetime-restore')).toBe(true)
  })

  it('opens the first allowed tab for a value it does not know', async () => {
    grant('subscriptions:edit', 'plans:view')

    const sheet = await openSheet('/subscriptions?tools=repair')

    expect(selectedTab(sheet)).toBe('Слияние подписок-дубликатов')
  })

  it('opens the first allowed tab — not the forbidden one — for a tab the admin may not see', async () => {
    grant('plans:view')
    const get = vi.mocked(api.get)

    const sheet = await openSheet('/subscriptions?tools=lifetime')

    expect(tabTitles(sheet)).toEqual([TABS_RU[1]])
    expect(selectedTab(sheet)).toBe('Подписки на сквадах, которых нет в панели')
    expect(get.mock.calls.some((call) => call[0] === '/admin/subscriptions/lifetime-restore')).toBe(false)
  })

  it('keeps showing an allowed tab when the address names a forbidden one while the sheet is open', async () => {
    // Opening the sheet hides a mistake here: the dialog focuses the first tab
    // on open, and a focused tab selects itself. An address that changes while
    // the sheet is ALREADY open gets no such help — a forbidden tab honoured
    // then is a sheet with no tab selected and nothing in it.
    grant('plans:view')
    const get = vi.mocked(api.get)
    const sheet = await openSheet('/subscriptions?tools=squads')

    act(() => navigateTo?.('/subscriptions?tools=lifetime'))

    await waitFor(() => expect(address()).toBe('/subscriptions?tools=lifetime'))
    expect(selectedTab(sheet)).toBe('Подписки на сквадах, которых нет в панели')
    expect(within(sheet).getByRole('button', { name: 'Проверить' })).toBeInTheDocument()
    expect(get.mock.calls.some((call) => call[0] === '/admin/subscriptions/lifetime-restore')).toBe(false)
  })

  it('removes the parameter when the sheet closes, and keeps the rest of the address', async () => {
    grant('subscriptions:edit')
    const user = userEvent.setup()

    const sheet = await openSheet('/subscriptions?from=card&tools=unlinked')
    await user.click(within(sheet).getByRole('button', { name: 'Закрыть' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(address()).toBe('/subscriptions?from=card')
  })

  it('rewrites the parameter when the operator switches tabs', async () => {
    grant('subscriptions:edit')
    const user = userEvent.setup()

    const sheet = await openSheet('/subscriptions?tools=merge')
    await user.click(within(sheet).getByRole('tab', { name: 'Лишние профили в Remnawave' }))

    await waitFor(() => expect(address()).toBe('/subscriptions?tools=extraProfiles'))
    expect(selectedTab(sheet)).toBe('Лишние профили в Remnawave')
  })

  it('lands the user card’s delete refusal on «Подписки без привязки к Remnawave»', async () => {
    grant('subscriptions:edit')

    const sheet = await openSheet(SUBSCRIPTION_DELETE_REFUSAL_REMEDY_HREF.stalePanelLink)

    expect(selectedTab(sheet)).toBe('Подписки без привязки к Remnawave')
    expect(await within(sheet).findByText('sub-dup')).toBeInTheDocument()
  })

  it('switches to the merge from a duplicate pair on the unlinked tab', async () => {
    grant('subscriptions:edit')
    const user = userEvent.setup()

    const sheet = await openSheet('/subscriptions?tools=unlinked')
    await user.click(
      await within(sheet).findByRole('button', { name: 'Открыть «Слияние подписок-дубликатов»' }),
    )

    await waitFor(() => expect(selectedTab(sheet)).toBe('Слияние подписок-дубликатов'))
    expect(address()).toBe('/subscriptions?tools=merge')
    expect(within(sheet).getByRole('button', { name: 'Предпросмотр слияния' })).toBeInTheDocument()
  })
})
