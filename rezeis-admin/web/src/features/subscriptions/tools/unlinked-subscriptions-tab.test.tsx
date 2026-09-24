/**
 * «Подписки без привязки к Remnawave» — what the automatic link check could not
 * prove, in the operator's words, and «Привязать профиль».
 *
 * Driven in RUSSIAN, and every reason is asserted as the sentence an operator
 * reads, facts included — never only a key. A key on screen, or a sentence with
 * `{{profileId}}` still in it, passes every assertion written against keys.
 *
 * ANTI-VACUITY. Nothing waits on the text it is about to assert: each spec
 * waits for the table (or the empty sentence's container) and then asserts
 * synchronously, so an "and NOT the other one" assertion is reachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { usePermissionStore } from '@/features/rbac'
import { coreDictionaryReady, i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import { renderWithProviders } from '@/test/test-utils'
import { UNLINKED_REASON_CODES } from './panel-link-check-api'
import { UnlinkedSubscriptionsTab } from './unlinked-subscriptions-tab'

const LIST = '/admin/profile-sync/panel-links/unlinked'

const CHECK = {
  lastRunAt: '2026-09-24T09:00:00.000Z',
  lastRunTrigger: 'import',
  lastRunOutcome: 'incomplete',
  nextRunAt: '2026-09-24T10:00:00.000Z',
  running: false,
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscriptionId: 'sub-1',
    userId: 'user-1',
    userName: 'Алиса',
    userTelegramId: '12345',
    status: 'ACTIVE',
    planName: 'Премиум',
    createdAt: '2026-08-01T10:00:00.000Z',
    storedRemnawaveId: null,
    linkKind: 'empty',
    reason: 'notFound',
    profileId: null,
    otherSubscriptionId: null,
    otherUserId: null,
    lookedUpBy: 'shortUuid',
    checkedAt: '2026-09-24T09:00:00.000Z',
    ...overrides,
  }
}

function listBody(rows: ReadonlyArray<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return { check: CHECK, total: rows.length, rows, truncated: false, ...overrides }
}

function mockList(...bodies: ReadonlyArray<Record<string, unknown>>) {
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

/** The rendered row of one subscription, found by its id cell. */
async function rowOf(subscriptionId: string): Promise<HTMLElement> {
  const idCell = await screen.findByText(subscriptionId)
  const tr = idCell.closest('tr')
  if (tr === null) throw new Error(`no row for ${subscriptionId}`)
  return tr
}

/** Cells: customer(0) | subscription(1) | holds(2) | reason(3) | checked(4) | action(5). */
async function cellsOf(subscriptionId: string): Promise<HTMLElement[]> {
  return within(await rowOf(subscriptionId)).getAllByRole('cell')
}

async function openLinkDialog(
  user: ReturnType<typeof userEvent.setup>,
  subscriptionId: string,
): Promise<HTMLElement> {
  const cells = await cellsOf(subscriptionId)
  await user.click(within(cells[5] as HTMLElement).getByRole('button', { name: 'Привязать профиль' }))
  return screen.findByRole('dialog', { name: 'Привязать профиль Remnawave' })
}

describe('«Подписки без привязки к Remnawave»', () => {
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
    const get = mockList(listBody([row()]))
    usePermissionStore.setState({ granted: new Set(['subscriptions:view', 'plans:view']), role: 'ADMIN', loaded: true })

    const { container } = renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)

    expect(container).toBeEmptyDOMElement()
    expect(get).not.toHaveBeenCalled()
  })

  // One sentence per `UnlinkedReasonCode`, with its facts in it.
  const REASONS: ReadonlyArray<{ readonly overrides: Record<string, unknown>; readonly sentence: string }> = [
    {
      overrides: { reason: 'notCheckedYet', checkedAt: null, lookedUpBy: null },
      sentence: 'Проверка ещё не смотрела эту подписку — посмотрит при следующем прогоне.',
    },
    {
      overrides: { reason: 'noRoute', lookedUpBy: null },
      sentence: 'Искать не по чему: в ссылке подписки нет короткого UUID и нет имени профиля в Remnawave.',
    },
    {
      overrides: { reason: 'notFound', lookedUpBy: 'shortUuid' },
      sentence: 'Remnawave не нашёл профиль по короткому UUID из ссылки подписки.',
    },
    {
      overrides: { reason: 'notFound', lookedUpBy: 'username' },
      sentence: 'Remnawave не нашёл профиль по имени, записанному в подписке.',
    },
    {
      overrides: { reason: 'panelUnavailable' },
      sentence: 'Remnawave не ответил — проверка повторит через час.',
    },
    {
      overrides: { reason: 'profileUnreadable', profileId: '4471' },
      sentence: 'Профиль 4471 найден, но прочитать его не удалось: он удалён или не читается.',
    },
    {
      overrides: { reason: 'ownedByOther', profileId: '4471', otherUserId: 'user-999' },
      sentence:
        'Профиль 4471 по строке reiwa_id принадлежит другому клиенту (user-999) — к этой подписке он не привязывается.',
    },
    {
      overrides: { reason: 'noOwnerProof', profileId: '4471' },
      sentence:
        'Ничто не доказывает, что профиль 4471 принадлежит этому клиенту: в его описании нет строки reiwa_id или строки называют разных клиентов. Если профиль его — привяжите кнопкой «Привязать профиль» и подтвердите.',
    },
    {
      overrides: { reason: 'markedForOtherSubscription', profileId: '4471', otherSubscriptionId: 'sub-77' },
      sentence:
        'Профиль 4471 по строке subscription_id выдан другой подписке (sub-77) — к этой он не привязывается.',
    },
    {
      overrides: {
        reason: 'profileTaken',
        profileId: '4471',
        otherSubscriptionId: 'sub-77',
        otherUserId: 'user-999',
      },
      sentence: 'Профиль 4471 уже привязан к подписке sub-77 другого клиента (user-999).',
    },
    {
      overrides: { reason: 'duplicatePair', profileId: '4471', otherSubscriptionId: 'sub-2' },
      sentence:
        'Профиль 4471 уже привязан к другой подписке этого же клиента (sub-2): это пара-дубликат, её сводит вкладка «Слияние подписок-дубликатов».',
    },
    {
      overrides: { reason: 'changedDuringCheck' },
      sentence: 'Подписка изменилась, пока шла проверка, — следующий прогон посмотрит её снова.',
    },
    {
      overrides: { reason: 'panelAgrees', storedRemnawaveId: '', linkKind: 'nonNumeric' },
      sentence:
        'Remnawave отвечает тем же значением, что хранит подписка, — переписывать нечего. Если подписка не работает, привяжите профиль вручную.',
    },
  ]

  it.each(REASONS)('says why in Russian, facts included: $overrides.reason', async ({ overrides, sentence }) => {
    mockList(listBody([row(overrides)]))

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)

    const reason = (await cellsOf('sub-1'))[3] as HTMLElement
    expect(reason.querySelector('p')?.textContent).toBe(sentence)
    expect(reason).not.toHaveTextContent('{{')
    expect(reason).not.toHaveTextContent('subscriptionTools.')
  })

  it('has a sentence in both languages for every reason the contract names', async () => {
    for (const language of ['ru', 'en'] as const) {
      await i18n.changeLanguage(language)
      await loadFeatureBundle('subscriptionTools')
      for (const code of UNLINKED_REASON_CODES) {
        const key = `subscriptionTools.unlinked.reasons.${code}`
        expect(i18n.exists(key), `${language}: ${key}`).toBe(true)
      }
    }
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('subscriptionTools')
  })

  it('names a reason this build does not know instead of dropping the row', async () => {
    mockList(listBody([row({ reason: 'somethingNewServerSide' })]))

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)

    const reason = (await cellsOf('sub-1'))[3] as HTMLElement
    expect(reason).toHaveTextContent('Причина, неизвестная этой сборке: somethingNewServerSide')
  })

  it('shows the customer as a link to their card, the plan, the status and what the row holds', async () => {
    mockList(
      listBody([
        row(),
        row({
          subscriptionId: 'sub-uuid',
          userId: 'user-2',
          userName: null,
          userTelegramId: null,
          planName: null,
          status: 'EXPIRED',
          storedRemnawaveId: '0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e',
          linkKind: 'nonNumeric',
        }),
      ]),
    )

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)

    const first = await cellsOf('sub-1')
    expect(within(first[0] as HTMLElement).getByRole('link', { name: 'Алиса' })).toHaveAttribute(
      'href',
      '/users/user-1',
    )
    expect(first[0]).toHaveTextContent('12345')
    expect(first[1]).toHaveTextContent('Премиум')
    expect(first[1]).toHaveTextContent('Активна')
    expect(first[2]?.textContent).toBe('пусто')

    const second = await cellsOf('sub-uuid')
    expect(within(second[0] as HTMLElement).getByRole('link', { name: 'без имени' })).toHaveAttribute(
      'href',
      '/users/user-2',
    )
    expect(second[0]).toHaveTextContent('без Telegram')
    expect(second[1]).toHaveTextContent('без тарифа')
    expect(second[1]).toHaveTextContent('Истекла')
    expect(second[2]?.textContent).toBe('0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e')
    expect(second[2]).not.toHaveTextContent('пусто')
  })

  it('says when the check looked at the row, or that it has not yet', async () => {
    mockList(
      listBody([
        row(),
        row({ subscriptionId: 'sub-new', reason: 'notCheckedYet', checkedAt: null, lookedUpBy: null }),
      ]),
    )

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)

    expect((await cellsOf('sub-1'))[4]?.textContent).toBe(formatDateTime('2026-09-24T09:00:00.000Z'))
    expect((await cellsOf('sub-new'))[4]?.textContent).toBe('ещё нет')
  })

  it('says when the automatic check last ran, how it went, and when it runs next', async () => {
    mockList(listBody([row()]))

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    await cellsOf('sub-1')

    expect(
      screen.getByText(
        `Последний прогон автоматической проверки: ${formatDateTime(CHECK.lastRunAt)}, после импорта бэкапа.`,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Итог: проверено не всё — остаток проверится повторно через час.'),
    ).toBeInTheDocument()
    expect(screen.getByText(`Следующий прогон: ${formatDateTime(CHECK.nextRunAt)}.`)).toBeInTheDocument()
    // Not running right now: the badge would be a false "wait for it".
    expect(screen.queryByText('идёт сейчас')).not.toBeInTheDocument()
  })

  it('says «идёт сейчас» while a run is in progress', async () => {
    mockList(listBody([row()], { check: { ...CHECK, running: true, lastRunOutcome: 'complete' } }))

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    await cellsOf('sub-1')

    expect(screen.getByText('идёт сейчас')).toBeInTheDocument()
    expect(screen.getByText('Итог: проверено всё.')).toBeInTheDocument()
  })

  it('says plainly that the check has never run, and names no result for it', async () => {
    mockList(
      listBody([row()], {
        check: { lastRunAt: null, lastRunTrigger: null, lastRunOutcome: null, nextRunAt: null, running: false },
      }),
    )

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    await cellsOf('sub-1')

    expect(screen.getByText('Автоматическая проверка ещё не завершила ни одного прогона.')).toBeInTheDocument()
    expect(screen.getByText('Следующий прогон не назначен.')).toBeInTheDocument()
    expect(screen.queryByText(/^Итог:/)).not.toBeInTheDocument()
  })

  it('says in one sentence that there are no subscriptions without a link', async () => {
    mockList(listBody([]))

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)

    expect(await screen.findByText('Подписок без привязки нет.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('says the list did not load — never "none" — when the request fails', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(
      Object.assign(new Error('Request failed with status code 503'), {
        isAxiosError: true,
        response: { status: 503, data: { message: 'Service Unavailable' } },
      }),
    )

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)

    expect(await screen.findByText('Список не загрузился')).toBeInTheDocument()
    expect(screen.queryByText('Подписок без привязки нет.')).not.toBeInTheDocument()
  })

  it('counts the rows, and says when the list is cut', async () => {
    mockList(listBody([row()], { total: 740, truncated: true }))

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    await cellsOf('sub-1')

    expect(screen.getByText('Подписок без привязки: 740. Показаны первые 1 из 740.')).toBeInTheDocument()
  })

  it('offers the merge for a duplicate pair, and switches to it', async () => {
    mockList(listBody([row({ reason: 'duplicatePair', profileId: '4471', otherSubscriptionId: 'sub-2' })]))
    const onOpenMerge = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={onOpenMerge} />)
    const reason = (await cellsOf('sub-1'))[3] as HTMLElement
    await user.click(within(reason).getByRole('button', { name: 'Открыть «Слияние подписок-дубликатов»' }))

    expect(onOpenMerge).toHaveBeenCalledTimes(1)
  })

  it('offers the merge ONLY for a duplicate pair', async () => {
    mockList(listBody([row({ reason: 'profileTaken', profileId: '4471', otherSubscriptionId: 'sub-77' })]))

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    const reason = (await cellsOf('sub-1'))[3] as HTMLElement

    expect(within(reason).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('«Привязать профиль» on a row', () => {
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

  it('pre-fills the profile id the check found', async () => {
    mockList(listBody([row({ reason: 'noOwnerProof', profileId: '4471' })]))
    const user = userEvent.setup()

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    const dialog = await openLinkDialog(user, 'sub-1')

    expect(within(dialog).getByLabelText('ID профиля в Remnawave')).toHaveValue('4471')
    expect(dialog).toHaveTextContent('Подписка: Премиум · Активна')
  })

  it('refuses an id that is not a number, next to the field, and sends nothing', async () => {
    mockList(listBody([row()]))
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as never)
    const user = userEvent.setup()

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    const dialog = await openLinkDialog(user, 'sub-1')
    const field = within(dialog).getByLabelText('ID профиля в Remnawave')

    // Empty is "not started", not "wrong" — and it cannot be sent either.
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Привязать профиль' })).toBeDisabled()

    // The 2.x UUID — exactly the kind of link these lists exist to replace.
    await user.type(field, '0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Укажите числовой ID профиля Remnawave — только цифры.',
    )
    expect(field).toHaveAttribute('aria-invalid', 'true')
    const submit = within(dialog).getByRole('button', { name: 'Привязать профиль' })
    expect(submit).toBeDisabled()
    await user.click(submit)

    await user.clear(field)
    await user.type(field, '44 71')
    expect(within(dialog).getByRole('alert')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Привязать профиль' })).toBeDisabled()

    // Digits, but longer than any identifier the server accepts (36): it goes
    // into a panel URL, so the ceiling is part of the rule.
    await user.clear(field)
    await user.type(field, '1'.repeat(37))
    expect(within(dialog).getByRole('alert')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Привязать профиль' })).toBeDisabled()

    // …and the control: at the ceiling it is accepted.
    await user.clear(field)
    await user.type(field, '1'.repeat(36))
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Привязать профиль' })).toBeEnabled()

    expect(patch).not.toHaveBeenCalled()
  })

  it('links with the typed digits as a string and without the operator’s word by default', async () => {
    mockList(listBody([row()]))
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as never)
    const user = userEvent.setup()

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    const dialog = await openLinkDialog(user, 'sub-1')
    await user.type(within(dialog).getByLabelText('ID профиля в Remnawave'), ' 4471 ')
    await user.click(within(dialog).getByRole('button', { name: 'Привязать профиль' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/users/subscriptions/sub-1/remnawave-link', {
      remnawaveId: '4471',
      confirmedWithoutProof: false,
    })
    const body = patch.mock.calls[0]?.[1] as Record<string, unknown>
    expect(typeof body.remnawaveId).toBe('string')
    expect(typeof body.confirmedWithoutProof).toBe('boolean')
  })

  it('sends the operator’s word when they tick «Я проверил(а), что это профиль этого клиента»', async () => {
    mockList(listBody([row({ reason: 'noOwnerProof', profileId: '4471' })]))
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as never)
    const user = userEvent.setup()

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    const dialog = await openLinkDialog(user, 'sub-1')
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Я проверил(а), что это профиль этого клиента' }),
    )
    await user.click(within(dialog).getByRole('button', { name: 'Привязать профиль' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/users/subscriptions/sub-1/remnawave-link', {
      remnawaveId: '4471',
      confirmedWithoutProof: true,
    })
  })

  it('says it linked, closes, and reads the list again', async () => {
    const get = mockList(listBody([row({ profileId: '4471' })]), listBody([]))
    vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as never)
    const success = vi.spyOn(toast, 'success').mockReturnValue('t-ok')
    const user = userEvent.setup()

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    const dialog = await openLinkDialog(user, 'sub-1')
    await user.click(within(dialog).getByRole('button', { name: 'Привязать профиль' }))

    await waitFor(() => expect(success).toHaveBeenCalledWith('Профиль Remnawave привязан'))
    // The linked row leaves the list: the refetch is what shows it.
    expect(await screen.findByText('Подписок без привязки нет.')).toBeInTheDocument()
    expect(get.mock.calls.filter((call) => call[0] === LIST).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the server’s refusal in the dialog and keeps it open', async () => {
    mockList(listBody([row({ profileId: '4471' })]))
    vi.spyOn(api, 'patch').mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: {
          status: 400,
          data: { message: 'This Remnawave profile is already linked to another subscription' },
        },
      }),
    )
    const success = vi.spyOn(toast, 'success').mockReturnValue('t-ok')
    const user = userEvent.setup()

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    const dialog = await openLinkDialog(user, 'sub-1')
    await user.click(within(dialog).getByRole('button', { name: 'Привязать профиль' }))

    const refusal = await within(dialog).findByText(
      'This Remnawave profile is already linked to another subscription',
    )
    expect(refusal.closest('[role="alert"]')).toHaveTextContent('Не привязано')
    expect(screen.getByRole('dialog', { name: 'Привязать профиль Remnawave' })).toBeInTheDocument()
    expect(success).not.toHaveBeenCalled()
  })

  it('forgets the operator’s word when the dialog is closed — it belongs to one attempt', async () => {
    mockList(listBody([row({ profileId: '4471' })]))
    const user = userEvent.setup()

    renderWithProviders(<UnlinkedSubscriptionsTab onOpenMerge={() => {}} />)
    const first = await openLinkDialog(user, 'sub-1')
    const tick = within(first).getByRole('checkbox', { name: 'Я проверил(а), что это профиль этого клиента' })
    await user.click(tick)
    expect(tick).toBeChecked()
    await user.clear(within(first).getByLabelText('ID профиля в Remnawave'))
    await user.click(within(first).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const second = await openLinkDialog(user, 'sub-1')
    expect(
      within(second).getByRole('checkbox', { name: 'Я проверил(а), что это профиль этого клиента' }),
    ).not.toBeChecked()
    expect(within(second).getByLabelText('ID профиля в Remnawave')).toHaveValue('4471')
  })
})
