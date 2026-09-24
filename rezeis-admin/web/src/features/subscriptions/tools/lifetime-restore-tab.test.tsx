/**
 * «Бессрочные подписки с датой» and «Вернуть бессрочность».
 *
 * What these pin, each a separate way for the tab to hurt a paying customer:
 *
 *   • EXACTLY the rows the server marks `suggested` are selected on load. A row
 *     whose date may have been paid for (`datedPaymentAfter`) is never ticked
 *     on the operator's behalf, and neither is a row with evidence but no
 *     fingerprint.
 *   • Nothing is written before the confirmation, and the confirmation says
 *     what the restore does AND what it does not do.
 *   • The POST carries exactly the selected ids — no more, no fewer — and a
 *     selection larger than one request may carry goes out in batches.
 *   • Every id sent gets a line in the result, restored or not, and the
 *     selection is not re-applied by the refetch that follows.
 *
 * Driven in RUSSIAN, texts asserted as the operator reads them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { usePermissionStore } from '@/features/rbac'
import { coreDictionaryReady, i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { renderWithProviders } from '@/test/test-utils'
import { LIFETIME_RESTORE_BATCH_SIZE } from './lifetime-restore-api'
import { LifetimeRestoreTab } from './lifetime-restore-tab'

const CENSUS = '/admin/subscriptions/lifetime-restore'

function censusRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscriptionId: 'sub-l1',
    userId: 'user-1',
    userName: 'Алиса',
    userTelegramId: '12345',
    planName: 'Навсегда',
    status: 'EXPIRED',
    expiresAt: '2026-09-01T10:00:00.000Z',
    createdAt: '2026-08-02T10:00:00.000Z',
    linked: true,
    evidence: [{ kind: 'payment', paymentId: 'pay-77' }, { kind: 'snapshot' }],
    thirtyDaysAfterCreate: true,
    datedPaymentAfter: false,
    suggested: true,
    ...overrides,
  }
}

/** The fingerprint, no dated payment after it: suggested. */
const SUGGESTED_A = censusRow()
/** The fingerprint, but a payment for a term came after it: NOT suggested. */
const PAID_AFTER = censusRow({
  subscriptionId: 'sub-l2',
  userName: 'Борис',
  status: 'ACTIVE',
  evidence: [{ kind: 'paymentLine', paymentId: 'pay-88' }],
  datedPaymentAfter: true,
  suggested: false,
})
/** Evidence, but not the fingerprint: NOT suggested. */
const PLAN_ONLY = censusRow({
  subscriptionId: 'sub-l3',
  userName: 'Вера',
  status: 'DISABLED',
  linked: false,
  evidence: [{ kind: 'plan', planId: 'plan-life' }],
  thirtyDaysAfterCreate: false,
  suggested: false,
})
/** A second suggested row. */
const SUGGESTED_B = censusRow({ subscriptionId: 'sub-l4', userName: 'Глеб', evidence: [{ kind: 'snapshot' }] })

const ROWS = [SUGGESTED_A, PAID_AFTER, PLAN_ONLY, SUGGESTED_B]

function censusBody(rows: ReadonlyArray<Record<string, unknown>> = ROWS, overrides: Record<string, unknown> = {}) {
  return { rows, total: rows.length, truncated: false, ...overrides }
}

function result(subscriptionId: string, outcome: string, overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId,
    outcome,
    previousExpiresAt: null,
    statusBefore: null,
    statusAfter: null,
    revivedAddOns: 0,
    syncQueued: false,
    error: null,
    ...overrides,
  }
}

function mockCensus(...bodies: ReadonlyArray<Record<string, unknown>>) {
  const spy = vi.spyOn(api, 'get')
  for (const body of bodies) spy.mockResolvedValueOnce({ data: body } as never)
  spy.mockResolvedValue({ data: bodies[bodies.length - 1] } as never)
  return spy
}

/** Answers every POST with one `restored` result per id it carried. */
function mockRestoreAll() {
  return vi.spyOn(api, 'post').mockImplementation(async (_path: string, body?: unknown) => {
    const ids = (body as { subscriptionIds: string[] }).subscriptionIds
    return { data: { results: ids.map((id) => result(id, 'restored')) } } as never
  })
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

function checkboxOf(subscriptionId: string): HTMLElement {
  return screen.getByRole('checkbox', { name: `Отметить подписку ${subscriptionId}` })
}

/** Cells: select(0) | customer(1) | plan(2) | date(3) | status(4) | evidence(5) | hints(6) | action(7). */
function cellsOf(subscriptionId: string): HTMLElement[] {
  const tr = checkboxOf(subscriptionId).closest('tr')
  if (tr === null) throw new Error(`no row for ${subscriptionId}`)
  return within(tr).getAllByRole('cell')
}

async function waitForCensus(): Promise<void> {
  await screen.findByRole('checkbox', { name: 'Отметить подписку sub-l1' })
}

/** The bulk button, whatever count it carries. */
function bulkButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Вернуть бессрочность \(\d+\)$/ })
}

function sentIds(post: ReturnType<typeof vi.spyOn>, index = 0): unknown {
  const call = post.mock.calls[index]
  expect(call?.[0]).toBe(CENSUS)
  return call?.[1]
}

describe('«Бессрочные подписки с датой»', () => {
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
    const get = mockCensus(censusBody())
    usePermissionStore.setState({ granted: new Set(['subscriptions:view', 'plans:view']), role: 'ADMIN', loaded: true })

    const { container } = renderWithProviders(<LifetimeRestoreTab />)

    expect(container).toBeEmptyDOMElement()
    expect(get).not.toHaveBeenCalled()
  })

  it('selects exactly the suggested rows on load — never one whose date may be paid for', async () => {
    mockCensus(censusBody())

    renderWithProviders(<LifetimeRestoreTab />)
    await waitForCensus()

    expect(checkboxOf('sub-l1')).toBeChecked()
    expect(checkboxOf('sub-l4')).toBeChecked()
    // The fingerprint with a dated payment after it, and evidence with no
    // fingerprint at all: the operator's call, not ours.
    expect(checkboxOf('sub-l2')).not.toBeChecked()
    expect(checkboxOf('sub-l3')).not.toBeChecked()
    expect(bulkButton()).toHaveTextContent('Вернуть бессрочность (2)')
    expect(screen.getByText('Найдено: 4. Отмечено: 2.')).toBeInTheDocument()
  })

  it('selects nothing when the server suggests nothing', async () => {
    mockCensus(censusBody([PAID_AFTER, PLAN_ONLY]))

    renderWithProviders(<LifetimeRestoreTab />)
    await screen.findByRole('checkbox', { name: 'Отметить подписку sub-l2' })

    expect(checkboxOf('sub-l2')).not.toBeChecked()
    expect(checkboxOf('sub-l3')).not.toBeChecked()
    expect(bulkButton()).toBeDisabled()
  })

  it('shows the evidence in words, with the payment and plan ids, and both hints', async () => {
    mockCensus(censusBody())

    renderWithProviders(<LifetimeRestoreTab />)
    await waitForCensus()

    const first = cellsOf('sub-l1')
    expect(first[5]).toHaveTextContent('оплата pay-77 была за «без срока»')
    expect(first[5]).toHaveTextContent('в снимке тарифа самой подписки — «без срока»')
    expect(first[6]).toHaveTextContent('дата = создание профиля в Remnawave + 30 дней')
    expect(first[6]).not.toHaveTextContent('дата может быть оплачена')
    expect(first[3]?.textContent).toBe(formatDate('2026-09-01T10:00:00.000Z'))
    expect(first[4]).toHaveTextContent('Истекла')

    const paidAfter = cellsOf('sub-l2')
    expect(paidAfter[5]).toHaveTextContent('строка совместного продления в оплате pay-88 была за «без срока»')
    expect(paidAfter[6]).toHaveTextContent('дата = создание профиля в Remnawave + 30 дней')
    expect(paidAfter[6]).toHaveTextContent('после этого была оплата за срок — дата может быть оплачена')

    const planOnly = cellsOf('sub-l3')
    expect(planOnly[5]).toHaveTextContent('тариф plan-life продаёт только «без срока»')
    expect(planOnly[6]?.textContent).toBe('')
    expect(planOnly[4]).toHaveTextContent('без привязки к Remnawave')
    expect(first[4]).not.toHaveTextContent('без привязки к Remnawave')
  })

  it('asks before writing, and says what the restore does and does not do', async () => {
    mockCensus(censusBody())
    const post = mockRestoreAll()
    const user = userEvent.setup()

    renderWithProviders(<LifetimeRestoreTab />)
    await waitForCensus()
    await user.click(bulkButton())

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Вернуть бессрочность отмеченным подпискам (2)?',
    })
    expect(post).not.toHaveBeenCalled()
    // What it does…
    expect(dialog).toHaveTextContent('Что будет сделано:')
    expect(dialog).toHaveTextContent('уберётся дата окончания — в карточке будет «Истекает: Бессрочно»;')
    expect(dialog).toHaveTextContent(
      'истёкшая подписка снова станет активной; отключённая и ограниченная сохранят свой статус;',
    )
    expect(dialog).toHaveTextContent('вернутся докупки «до конца подписки», которые закончились по неверной дате;')
    expect(dialog).toHaveTextContent(
      'одна обычная синхронизация отправит в Remnawave дату 31.12.2099 — так Remnawave хранит «без срока», — и профиль, который Remnawave выключил по старой дате, снова включится.',
    )
    // …and what it does not.
    expect(dialog).toHaveTextContent('Чего не будет:')
    expect(dialog).toHaveTextContent('клиенту ничего не напишется;')
    expect(dialog).toHaveTextContent('деньги не вернутся, ни одна оплата не изменится;')
    expect(dialog).toHaveTextContent('удалённые подписки здесь не показываются и не восстанавливаются;')
    expect(dialog).toHaveTextContent('лимиты, тариф и сквады останутся как есть;')
    expect(dialog).toHaveTextContent(
      'само ничего не произойдёт — только с теми строками, для которых вы нажали кнопку.',
    )

    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    expect(post).not.toHaveBeenCalled()
  })

  it('sends exactly the selected ids — the operator’s selection, in table order', async () => {
    mockCensus(censusBody())
    const post = mockRestoreAll()
    const user = userEvent.setup()

    renderWithProviders(<LifetimeRestoreTab />)
    await waitForCensus()
    // Untick a suggestion, tick a row nobody suggested.
    await user.click(checkboxOf('sub-l1'))
    await user.click(checkboxOf('sub-l3'))
    expect(bulkButton()).toHaveTextContent('Вернуть бессрочность (2)')
    await user.click(bulkButton())
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Вернуть бессрочность' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(sentIds(post)).toEqual({ subscriptionIds: ['sub-l3', 'sub-l4'] })
  })

  it('restores one row from its own button, and only that row', async () => {
    mockCensus(censusBody())
    const post = mockRestoreAll()
    const user = userEvent.setup()

    renderWithProviders(<LifetimeRestoreTab />)
    await waitForCensus()
    await user.click(within(cellsOf('sub-l2')[7] as HTMLElement).getByRole('button', { name: 'Вернуть бессрочность' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Вернуть бессрочность подписке sub-l2?' })
    // The same consequences, for one row as for many.
    expect(dialog).toHaveTextContent('клиенту ничего не напишется;')
    await user.click(within(dialog).getByRole('button', { name: 'Вернуть бессрочность' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    // Not the pre-selected rows: the per-row button is about its own row.
    expect(sentIds(post)).toEqual({ subscriptionIds: ['sub-l2'] })
  })

  it('shows a line per id — every outcome in words — and reads the census again', async () => {
    const more = ['sub-x1', 'sub-x2', 'sub-x3', 'sub-x4'].map((subscriptionId) => censusRow({ subscriptionId }))
    const get = mockCensus(censusBody([...ROWS, ...more]), censusBody([PAID_AFTER, PLAN_ONLY]))
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        results: [
          result('sub-l1', 'restored', {
            previousExpiresAt: '2026-09-01T10:00:00.000Z',
            statusBefore: 'EXPIRED',
            statusAfter: 'ACTIVE',
            revivedAddOns: 2,
            syncQueued: true,
          }),
          result('sub-l4', 'alreadyLifetime'),
          result('sub-x1', 'notEligible'),
          result('sub-x2', 'deleted'),
          result('sub-x3', 'notFound'),
          result('sub-x4', 'failed', { error: 'boom' }),
        ],
      },
    } as never)
    vi.spyOn(toast, 'warning').mockReturnValue('t-warn')
    const user = userEvent.setup()

    renderWithProviders(<LifetimeRestoreTab />)
    await waitForCensus()
    await user.click(bulkButton())
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Вернуть бессрочность' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(sentIds(post)).toEqual({
      subscriptionIds: ['sub-l1', 'sub-l4', 'sub-x1', 'sub-x2', 'sub-x3', 'sub-x4'],
    })

    const results = (await screen.findByText('Результат')).closest('div') as HTMLElement
    const line = (id: string): HTMLElement => {
      const tr = within(results).getByText(id).closest('tr')
      if (tr === null) throw new Error(`no result line for ${id}`)
      return tr
    }
    expect(line('sub-l1')).toHaveTextContent('Бессрочность возвращена')
    expect(line('sub-l1')).toHaveTextContent(`дата была ${formatDate('2026-09-01T10:00:00.000Z')}`)
    expect(line('sub-l1')).toHaveTextContent('статус Истекла → Активна')
    expect(line('sub-l1')).toHaveTextContent('вернулось докупок: 2')
    expect(line('sub-l1')).toHaveTextContent('синхронизация с Remnawave поставлена в очередь')
    expect(line('sub-l1')).toHaveTextContent('Алиса')
    expect(line('sub-l4')).toHaveTextContent('Уже бессрочная')
    expect(line('sub-x1')).toHaveTextContent('Нет оснований')
    expect(line('sub-x2')).toHaveTextContent('Удалена')
    expect(line('sub-x3')).toHaveTextContent('Не найдена')
    expect(line('sub-x4')).toHaveTextContent('Ошибка: boom')

    // The restored rows leave the census; the refetch is what shows it.
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Отметить подписку sub-l1' })).not.toBeInTheDocument(),
    )
    expect(get.mock.calls.filter((call) => call[0] === CENSUS).length).toBeGreaterThanOrEqual(2)
  })

  it('gives an id the answer did not name a line of its own, instead of silence', async () => {
    mockCensus(censusBody(), censusBody())
    vi.spyOn(api, 'post').mockResolvedValue({ data: { results: [result('sub-l1', 'restored')] } } as never)
    vi.spyOn(toast, 'warning').mockReturnValue('t-warn')
    const user = userEvent.setup()

    renderWithProviders(<LifetimeRestoreTab />)
    await waitForCensus()
    await user.click(bulkButton())
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Вернуть бессрочность' }))

    const results = (await screen.findByText('Результат')).closest('div') as HTMLElement
    const unnamed = within(results).getByText('sub-l4').closest('tr') as HTMLElement
    expect(unnamed).toHaveTextContent(
      'Нет ответа (в ответе её нет) — нажать ещё раз безопасно: восстановленная подписка ответит «Уже бессрочная».',
    )
  })

  it('does not tick the suggestions again after a run', async () => {
    // The same rows come back — say both failed. They must come back UNticked:
    // pressing the bulk button again is a new decision, not a replay.
    mockCensus(censusBody(), censusBody())
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { results: [result('sub-l1', 'failed', { error: 'x' }), result('sub-l4', 'failed', { error: 'y' })] },
    } as never)
    vi.spyOn(toast, 'warning').mockReturnValue('t-warn')
    const user = userEvent.setup()

    renderWithProviders(<LifetimeRestoreTab />)
    await waitForCensus()
    await user.click(bulkButton())
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Вернуть бессрочность' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await screen.findByText('Результат')

    await waitFor(() => expect(checkboxOf('sub-l1')).not.toBeChecked())
    expect(checkboxOf('sub-l4')).not.toBeChecked()
    expect(bulkButton()).toHaveTextContent('Вернуть бессрочность (0)')
    expect(bulkButton()).toBeDisabled()
  })

  it('says plainly that there is nothing to restore', async () => {
    mockCensus(censusBody([]))

    renderWithProviders(<LifetimeRestoreTab />)

    expect(await screen.findByText('Бессрочных подписок с датой нет.')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('says the census did not load — never "nothing to restore" — when the request fails', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Network Error'))

    renderWithProviders(<LifetimeRestoreTab />)

    expect(await screen.findByText('Список не загрузился')).toBeInTheDocument()
    expect(screen.queryByText('Бессрочных подписок с датой нет.')).not.toBeInTheDocument()
  })
})

describe('a selection larger than one batch', () => {
  const MANY = Array.from({ length: LIFETIME_RESTORE_BATCH_SIZE + 1 }, (_, index) =>
    censusRow({ subscriptionId: `sub-m${String(index).padStart(3, '0')}`, userName: `Клиент ${index}` }),
  )

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

  it('keeps a batch small enough to finish inside the panel’s 30-second request limit', () => {
    // Each id is restored in its own transaction; 200 of them on a slow server
    // can outlast the 30 s the panel gives a request, and a cut request leaves
    // the operator not knowing which rows were written. The server's own
    // ceiling (200) is not the number to fill.
    expect(LIFETIME_RESTORE_BATCH_SIZE).toBeGreaterThan(0)
    expect(LIFETIME_RESTORE_BATCH_SIZE).toBeLessThanOrEqual(50)
  })

  it('goes out in batches the server accepts, together carrying every selected id once', async () => {
    mockCensus(censusBody(MANY))
    const post = mockRestoreAll()
    vi.spyOn(toast, 'success').mockReturnValue('t-ok')
    const user = userEvent.setup()

    renderWithProviders(<LifetimeRestoreTab />)
    await screen.findByRole('checkbox', { name: 'Отметить подписку sub-m000' })
    await user.click(bulkButton())
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Вернуть бессрочность' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    const first = (sentIds(post, 0) as { subscriptionIds: string[] }).subscriptionIds
    const second = (sentIds(post, 1) as { subscriptionIds: string[] }).subscriptionIds
    expect(first).toHaveLength(LIFETIME_RESTORE_BATCH_SIZE)
    expect(second).toEqual([`sub-m${String(LIFETIME_RESTORE_BATCH_SIZE).padStart(3, '0')}`])
    expect([...first, ...second]).toEqual(MANY.map((row) => row.subscriptionId))
  })

  it('stops at a batch that fails, and says which ids got no answer and which were never sent', async () => {
    mockCensus(censusBody(MANY))
    const post = vi.spyOn(api, 'post').mockRejectedValue(
      Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' }),
    )
    vi.spyOn(toast, 'error').mockReturnValue('t-err')
    const user = userEvent.setup()

    renderWithProviders(<LifetimeRestoreTab />)
    await screen.findByRole('checkbox', { name: 'Отметить подписку sub-m000' })
    await user.click(bulkButton())
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Вернуть бессрочность' }))

    const results = (await screen.findByText('Результат')).closest('div') as HTMLElement
    // Nothing is fired after a failed batch: the server may have written it.
    expect(post).toHaveBeenCalledTimes(1)
    const line = (id: string): HTMLElement => within(results).getByText(id).closest('tr') as HTMLElement
    expect(line('sub-m000')).toHaveTextContent(/Нет ответа \(.+\) — нажать ещё раз безопасно/)
    expect(line(`sub-m${String(LIFETIME_RESTORE_BATCH_SIZE).padStart(3, '0')}`)).toHaveTextContent(
      'Не отправлено — запуск остановился на предыдущей пачке.',
    )
  })
})

describe('the audit trail names the restore', () => {
  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('labels `user.subscription.lifetime_restored` in both languages, the way the timeline looks it up', async () => {
    // `dashboard-timelines.tsx` flattens the dotted audit code with `_`.
    const key = `dashboardPage.timelines.auditActions.${'user.subscription.lifetime_restored'.replace(/\./g, '_')}`
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('dashboard')
    expect(i18n.t(key)).toBe('Бессрочность подписки восстановлена')
    await i18n.changeLanguage('en')
    await loadFeatureBundle('dashboard')
    expect(i18n.t(key)).toBe('Subscription made lifetime again')
  })
})
