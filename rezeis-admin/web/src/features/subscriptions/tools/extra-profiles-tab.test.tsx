/**
 * «Лишние профили в Remnawave» — per customer, the profiles none of their
 * subscriptions uses, what the automatic link did with each, and «Привязать
 * профиль». Never a delete.
 *
 * Driven in RUSSIAN; every outcome is asserted as the sentence an operator
 * reads. An empty list is asserted in the three states it can mean different
 * things in: compared and clean, never compared, and compared from a partial
 * read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { coreDictionaryReady, i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import { renderWithProviders } from '@/test/test-utils'
import { ExtraProfilesTab } from './extra-profiles-tab'
import { AUTO_LINK_OUTCOMES } from './panel-link-check-api'

const GIB = 1024 ** 3

const CHECK = {
  lastRunAt: '2026-09-24T03:00:00.000Z',
  lastRunTrigger: 'daily',
  lastRunOutcome: 'complete',
  nextRunAt: '2026-09-25T03:00:00.000Z',
  running: false,
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profileId: '4471',
    username: 'rz_alice_1',
    status: 'ACTIVE',
    createdAt: '2026-08-01T10:00:00.000Z',
    usedTrafficBytes: 5 * GIB,
    subscriptionMarker: 'sub-old',
    linkedBySubscriptionId: null,
    autoLink: 'severalSubscriptions',
    autoLinkedSubscriptionId: null,
    autoLinkedAt: null,
    linkedNow: false,
    ...overrides,
  }
}

const ALICE = {
  userId: 'user-1',
  userExists: true,
  userName: 'Алиса',
  userTelegramId: '12345',
  profiles: [profile()],
  subscriptionsWithoutLink: [
    {
      subscriptionId: 'sub-a',
      status: 'ACTIVE',
      planName: 'Премиум',
      createdAt: '2026-08-01T10:00:00.000Z',
      storedRemnawaveId: null,
    },
    {
      subscriptionId: 'sub-b',
      status: 'EXPIRED',
      planName: 'Базовый',
      createdAt: '2026-07-01T10:00:00.000Z',
      storedRemnawaveId: '0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e',
    },
  ],
}

const GHOST = {
  userId: 'user-ghost',
  userExists: false,
  userName: null,
  userTelegramId: null,
  profiles: [
    profile({
      profileId: '5150',
      username: 'rz_ghost',
      status: 'DISABLED',
      usedTrafficBytes: null,
      subscriptionMarker: null,
      autoLink: 'noSubscriptionWithoutLink',
    }),
  ],
  subscriptionsWithoutLink: [],
}

function reportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    check: CHECK,
    comparedAt: '2026-09-24T03:05:00.000Z',
    readOutcome: 'partial',
    profilesRead: 1200,
    profilesWithoutOwner: 37,
    autoLinked: 4,
    customers: [ALICE, GHOST],
    truncated: false,
    ...overrides,
  }
}

function mockReport(...bodies: ReadonlyArray<Record<string, unknown>>) {
  const spy = vi.spyOn(api, 'get')
  for (const body of bodies) spy.mockResolvedValueOnce({ data: body } as never)
  spy.mockResolvedValue({ data: bodies[bodies.length - 1] } as never)
  return spy
}

function grantEdit(): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(['subscriptions:view', 'subscriptions:edit']),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

/** The customer block that holds this profile username. */
async function blockOf(username: string): Promise<HTMLElement> {
  const cell = await screen.findByText(username)
  const block = cell.closest('section')
  if (block === null) throw new Error(`no customer block for ${username}`)
  return block
}

/** Cells: profile(0) | status(1) | created(2) | traffic(3) | marker(4) | autoLink(5) | action(6). */
async function profileCells(username: string): Promise<HTMLElement[]> {
  const cell = await screen.findByText(username)
  const tr = cell.closest('tr')
  if (tr === null) throw new Error(`no row for ${username}`)
  return within(tr).getAllByRole('cell')
}

describe('«Лишние профили в Remnawave»', () => {
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
    grantEdit()
  })

  it('renders nothing and asks for nothing without subscriptions:edit', () => {
    const get = mockReport(reportBody())
    usePermissionStore.setState({ granted: new Set(['subscriptions:view', 'plans:view']), role: 'ADMIN', loaded: true })

    const { container } = renderWithProviders(<ExtraProfilesTab />)

    expect(container).toBeEmptyDOMElement()
    expect(get).not.toHaveBeenCalled()
  })

  it('says when the comparison read Remnawave, that the read was partial, and what it counted', async () => {
    mockReport(reportBody())

    renderWithProviders(<ExtraProfilesTab />)
    await blockOf('rz_alice_1')

    expect(
      screen.getByText(`Сравнение последний раз читало Remnawave: ${formatDateTime('2026-09-24T03:05:00.000Z')}.`),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Remnawave отдал не весь список — профили за его пределами не сравнивались.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Remnawave отдал весь список.')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Прочитано профилей: 1200. Без строки reiwa_id (не сравнивались): 37. Привязано автоматически: 4.',
      ),
    ).toBeInTheDocument()
    // The automatic check's own status line is here too.
    expect(
      screen.getByText(
        `Последний прогон автоматической проверки: ${formatDateTime(CHECK.lastRunAt)}, ежедневный прогон.`,
      ),
    ).toBeInTheDocument()
  })

  it('says the read was complete when it was', async () => {
    mockReport(reportBody({ readOutcome: 'complete' }))

    renderWithProviders(<ExtraProfilesTab />)
    await blockOf('rz_alice_1')

    expect(screen.getByText('Remnawave отдал весь список.')).toBeInTheDocument()
    expect(screen.queryByText(/отдал не весь список/)).not.toBeInTheDocument()
  })

  it('shows each extra profile: name, id, status, created, traffic, its subscription_id line', async () => {
    mockReport(reportBody())

    renderWithProviders(<ExtraProfilesTab />)
    const cells = await profileCells('rz_alice_1')

    expect(cells[0]).toHaveTextContent('ID 4471')
    expect(cells[1]?.textContent).toBe('активен')
    expect(cells[2]?.textContent).toBe(formatDateTime('2026-08-01T10:00:00.000Z'))
    // The project's bytes helper, in the operator's units.
    expect(cells[3]?.textContent).toBe('5.00 ГБ')
    expect(cells[4]?.textContent).toBe('sub-old')

    const ghost = await profileCells('rz_ghost')
    expect(ghost[1]?.textContent).toBe('отключён')
    expect(ghost[3]?.textContent).toBe('—')
    expect(ghost[4]?.textContent).toBe('нет')
  })

  it('names the customer with a link to their card, or says the panel does not know them', async () => {
    mockReport(reportBody())

    renderWithProviders(<ExtraProfilesTab />)

    const alice = await blockOf('rz_alice_1')
    expect(within(alice).getByRole('link', { name: 'Алиса' })).toHaveAttribute('href', '/users/user-1')
    expect(alice).toHaveTextContent('12345')

    const ghost = await blockOf('rz_ghost')
    expect(ghost).toHaveTextContent('клиент не найден в панели')
    expect(ghost).toHaveTextContent('user-ghost')
    expect(within(ghost).queryByRole('link')).not.toBeInTheDocument()
  })

  it('lists which of the customer’s subscriptions have no link, and says so when none', async () => {
    mockReport(reportBody())

    renderWithProviders(<ExtraProfilesTab />)

    const alice = await blockOf('rz_alice_1')
    expect(alice).toHaveTextContent('Подписки клиента без привязки')
    const items = within(alice).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Премиум · Активна')
    expect(items[0]).toHaveTextContent('хранит пусто · sub-a')
    expect(items[1]).toHaveTextContent('Базовый · Истекла')
    expect(items[1]).toHaveTextContent('хранит 0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e · sub-b')

    const ghost = await blockOf('rz_ghost')
    expect(ghost).toHaveTextContent('У клиента нет подписок без привязки.')
  })

  it('marks a profile linked since the comparison, and offers no link for it', async () => {
    mockReport(
      reportBody({
        customers: [
          {
            ...ALICE,
            profiles: [
              profile({
                linkedNow: true,
                autoLink: 'linked',
                autoLinkedSubscriptionId: 'sub-a',
                autoLinkedAt: '2026-09-24T03:04:00.000Z',
              }),
            ],
          },
        ],
      }),
    )

    renderWithProviders(<ExtraProfilesTab />)
    const cells = await profileCells('rz_alice_1')

    expect(cells[0]).toHaveTextContent('сейчас привязан')
    expect(cells[5]?.textContent).toBe(
      `Проверка привязала его к подписке sub-a (${formatDateTime('2026-09-24T03:04:00.000Z')}).`,
    )
    expect(within(cells[6] as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
  })

  it('says when another customer’s subscription holds the profile, and offers no link', async () => {
    mockReport(
      reportBody({
        customers: [
          { ...ALICE, profiles: [profile({ linkedBySubscriptionId: 'sub-other', autoLink: 'takenByOtherRow' })] },
        ],
      }),
    )

    renderWithProviders(<ExtraProfilesTab />)
    const cells = await profileCells('rz_alice_1')

    expect(cells[0]).toHaveTextContent('привязан к подписке sub-other другого клиента')
    expect(cells[0]).not.toHaveTextContent('удалённой')
    expect(within(cells[6] as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
  })

  it('says a DELETED subscription still holds the profile — not "another customer" — and offers no link', async () => {
    // The same field names two different holders. A deleted row of this very
    // customer is not "another customer", and the profile is not free either:
    // it stays that deleted subscription's.
    mockReport(
      reportBody({
        customers: [
          {
            ...ALICE,
            profiles: [profile({ linkedBySubscriptionId: 'sub-deleted', autoLink: 'namedByDeletedSubscription' })],
          },
        ],
      }),
    )

    renderWithProviders(<ExtraProfilesTab />)
    const cells = await profileCells('rz_alice_1')

    expect(cells[0]).toHaveTextContent('записан за удалённой подпиской sub-deleted')
    expect(cells[0]).not.toHaveTextContent('другого клиента')
    expect(cells[5]?.textContent).toBe(
      'Профиль всё ещё записан за удалённой подпиской sub-deleted — к другой подписке он не привязывается.',
    )
    expect(within(cells[6] as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers no link where there is nothing to link to, and says why', async () => {
    mockReport(
      reportBody({
        customers: [{ ...ALICE, subscriptionsWithoutLink: [], profiles: [profile({ autoLink: 'noSubscriptionWithoutLink' })] }],
      }),
    )

    renderWithProviders(<ExtraProfilesTab />)
    const cells = await profileCells('rz_alice_1')

    expect(within(cells[6] as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
    expect(cells[6]).toHaveTextContent('Привязывать не к чему: у клиента нет подписки без привязки.')
  })

  it('has no delete button anywhere', async () => {
    mockReport(reportBody())

    renderWithProviders(<ExtraProfilesTab />)
    await blockOf('rz_alice_1')

    const buttons = screen.getAllByRole('button').map((button) => button.textContent ?? '')
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.filter((label) => /удал|delete/i.test(label))).toEqual([])
  })

  const OUTCOMES: ReadonlyArray<{ readonly overrides: Record<string, unknown>; readonly sentence: string }> = [
    {
      overrides: { autoLink: 'linked', autoLinkedSubscriptionId: 'sub-a', autoLinkedAt: null },
      sentence: 'Проверка привязала его к подписке sub-a (—).',
    },
    {
      overrides: { autoLink: 'noSubscriptionWithoutLink' },
      sentence: 'Не привязан: у клиента нет живой подписки без привязки.',
    },
    {
      overrides: { autoLink: 'severalSubscriptions' },
      sentence: 'Не привязан: у клиента несколько подписок без привязки — непонятно, к какой.',
    },
    {
      overrides: { autoLink: 'severalProfiles' },
      sentence: 'Не привязан: у клиента несколько лишних профилей — непонятно, какой из них.',
    },
    {
      overrides: { autoLink: 'subscriptionMarkerMismatch' },
      sentence: 'Не привязан: строка subscription_id профиля называет другую подписку.',
    },
    {
      overrides: { autoLink: 'subscriptionRecordsAnotherProfile' },
      sentence:
        'Единственная подписка без привязки хранит id другого профиля Remnawave — автоматически не привязано.',
    },
    {
      overrides: { autoLink: 'takenByOtherRow' },
      sentence: 'Не привязан: к нему привязана живая подписка другого клиента.',
    },
    {
      overrides: { autoLink: 'namedByDeletedSubscription', linkedBySubscriptionId: 'sub-deleted' },
      sentence:
        'Профиль всё ещё записан за удалённой подпиской sub-deleted — к другой подписке он не привязывается.',
    },
    {
      overrides: { autoLink: 'syncInFlight' },
      sentence:
        'Не привязан: у подписки стоит в очереди или выполняется синхронизация — проверка попробует позже.',
    },
    {
      overrides: { autoLink: 'changedDuringCheck' },
      sentence: 'Не привязан: подписка или профиль изменились, пока шла проверка.',
    },
    {
      overrides: { autoLink: 'panelUnavailable' },
      sentence: 'Не пробовали: последнее чтение Remnawave не удалось.',
    },
    {
      overrides: { autoLink: 'ownerNotInPanel' },
      sentence: 'Не привязывается: клиента с таким reiwa_id в панели нет.',
    },
    {
      overrides: { autoLink: 'somethingNewServerSide' },
      sentence: 'Исход, неизвестный этой сборке: somethingNewServerSide',
    },
  ]

  it.each(OUTCOMES)('says what the automatic link did: $overrides.autoLink', async ({ overrides, sentence }) => {
    mockReport(reportBody({ customers: [{ ...ALICE, profiles: [profile(overrides)] }] }))

    renderWithProviders(<ExtraProfilesTab />)
    const cells = await profileCells('rz_alice_1')

    expect(cells[5]?.textContent).toBe(sentence)
  })

  it('has a sentence in both languages for every outcome the contract names', async () => {
    for (const language of ['ru', 'en'] as const) {
      await i18n.changeLanguage(language)
      await loadFeatureBundle('subscriptionTools')
      for (const outcome of AUTO_LINK_OUTCOMES) {
        const key = `subscriptionTools.extraProfiles.autoLink.${outcome}`
        expect(i18n.exists(key), `${language}: ${key}`).toBe(true)
      }
    }
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('subscriptionTools')
  })

  it('says plainly that there are no extra profiles after a comparison', async () => {
    mockReport(reportBody({ customers: [], readOutcome: 'complete' }))

    renderWithProviders(<ExtraProfilesTab />)

    expect(await screen.findByText('Лишних профилей нет.')).toBeInTheDocument()
  })

  // Review R3b-03: the owners the panel does not have — a customer deleted here
  // whose profile outlived the deletion, or another panel's — listed apart.
  const DELETED_HERE = {
    userId: 'user-deleted',
    deletedAt: '2026-09-20T08:00:00.000Z',
    profiles: [profile({ profileId: '6001', username: 'rz_deleted', subscriptionMarker: null, autoLink: 'ownerNotInPanel' })],
  }
  const FOREIGN = {
    userId: 'user-foreign',
    deletedAt: null,
    profiles: [profile({ profileId: '6002', username: 'rz_foreign', subscriptionMarker: null, autoLink: 'ownerNotInPanel' })],
  }

  it('lists the owners the panel does not have APART, after its customers: the day one was deleted here, and nothing to link', async () => {
    mockReport(reportBody({ customers: [ALICE], unknownOwners: [DELETED_HERE, FOREIGN], unknownOwnersTotal: 5 }))

    renderWithProviders(<ExtraProfilesTab />)

    const deleted = await blockOf('rz_deleted')
    const title = screen.getByText('Клиенты, которых нет в панели')
    const alice = await blockOf('rz_alice_1')
    // After the customers, under a heading of their own.
    expect(alice.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(title.compareDocumentPosition(deleted) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Показано: 2 из 5 — сначала клиенты, удалённые здесь.')).toBeInTheDocument()

    expect(deleted).toHaveTextContent('клиент не найден в панели')
    expect(deleted).toHaveTextContent(`клиент удалён в панели ${formatDateTime('2026-09-20T08:00:00.000Z')}`)
    expect(deleted).toHaveTextContent('user-deleted')
    expect(deleted).not.toHaveTextContent('Подписки клиента без привязки')
    expect(within(deleted).queryByRole('button')).not.toBeInTheDocument()
    const cells = await profileCells('rz_deleted')
    expect(cells[5]?.textContent).toBe('Не привязывается: клиента с таким reiwa_id в панели нет.')

    const foreign = await blockOf('rz_foreign')
    expect(foreign).toHaveTextContent('клиент не найден в панели')
    expect(foreign).not.toHaveTextContent('клиент удалён в панели')
  })

  it('does not say "no extra profiles" while owners the panel does not have are listed, and names no count when none was cut', async () => {
    mockReport(reportBody({ customers: [], unknownOwners: [FOREIGN], unknownOwnersTotal: 1, readOutcome: 'complete' }))

    renderWithProviders(<ExtraProfilesTab />)

    await blockOf('rz_foreign')
    expect(screen.queryByText('Лишних профилей нет.')).not.toBeInTheDocument()
    expect(screen.queryByText(/^Показано:/)).not.toBeInTheDocument()
  })

  it('does not call a comparison that never ran "no extra profiles"', async () => {
    mockReport(
      reportBody({
        customers: [],
        comparedAt: null,
        readOutcome: null,
        profilesRead: 0,
        profilesWithoutOwner: 0,
        autoLinked: 0,
      }),
    )

    renderWithProviders(<ExtraProfilesTab />)

    expect(
      await screen.findByText('Показать нечего, пока автоматическая проверка ни разу не сравнила Remnawave.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Сравнение ещё ни разу не читало Remnawave.')).toBeInTheDocument()
    expect(screen.queryByText('Лишних профилей нет.')).not.toBeInTheDocument()
  })

  it('says the list did not load — never "none" — when the request fails', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Network Error'))

    renderWithProviders(<ExtraProfilesTab />)

    expect(await screen.findByText('Список не загрузился')).toBeInTheDocument()
    expect(screen.queryByText('Лишних профилей нет.')).not.toBeInTheDocument()
  })
})

describe('«Привязать профиль» for an extra profile', () => {
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
    grantEdit()
  })

  it('lets the operator pick which subscription gets the profile, and sends the pre-filled id to THAT one', async () => {
    mockReport(reportBody())
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as never)
    const user = userEvent.setup()

    renderWithProviders(<ExtraProfilesTab />)
    const cells = await profileCells('rz_alice_1')
    await user.click(within(cells[6] as HTMLElement).getByRole('button', { name: 'Привязать профиль' }))
    const dialog = await screen.findByRole('dialog', { name: 'Привязать профиль Remnawave' })

    expect(within(dialog).getByLabelText('ID профиля в Remnawave')).toHaveValue('4471')
    const group = within(dialog).getByRole('group', { name: 'К какой подписке привязать профиль' })
    const choices = within(group).getAllByRole('radio')
    expect(choices).toHaveLength(2)
    // Nothing is chosen for the operator: with two candidates, a default would
    // be this screen deciding which subscription the customer's profile joins.
    expect(choices.every((choice) => !(choice as HTMLInputElement).checked)).toBe(true)
    expect(within(dialog).getByRole('button', { name: 'Привязать профиль' })).toBeDisabled()

    await user.click(within(group).getByRole('radio', { name: /sub-b$/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Привязать профиль' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/users/subscriptions/sub-b/remnawave-link', {
      remnawaveId: '4471',
      confirmedWithoutProof: false,
    })
  })

  it('needs no choice when the customer has one subscription without a link', async () => {
    mockReport(
      reportBody({ customers: [{ ...ALICE, subscriptionsWithoutLink: [ALICE.subscriptionsWithoutLink[0]] }] }),
    )
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as never)
    const user = userEvent.setup()

    renderWithProviders(<ExtraProfilesTab />)
    const cells = await profileCells('rz_alice_1')
    await user.click(within(cells[6] as HTMLElement).getByRole('button', { name: 'Привязать профиль' }))
    const dialog = await screen.findByRole('dialog', { name: 'Привязать профиль Remnawave' })

    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument()
    expect(dialog).toHaveTextContent('Подписка: Премиум · Активна')
    await user.click(within(dialog).getByRole('button', { name: 'Привязать профиль' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/users/subscriptions/sub-a/remnawave-link', {
      remnawaveId: '4471',
      confirmedWithoutProof: false,
    })
  })
})
