/**
 * The merge preview shows a standing hold on a partner balance.
 *
 * For 72 hours after a password recovery by subscription link, nothing leaves
 * the account's partner balance. A merge adds one account's balance to the
 * other and keeps one web account; it now carries a standing hold over to the
 * account it keeps, the later end winning. The operator is told BEFORE pressing
 * the button — on the side that has the hold, with its end, and that it carries
 * over.
 */
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosHeaders, type AxiosResponse } from 'axios'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { activeLocale } from '@/lib/utils'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

// Where the card sends the operator after a merge; the rest of the router is real.
const navigateSpy = vi.hoisted(() => vi.fn())
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigateSpy,
}))

import { MergeAccountsCard } from './user-detail-panel'

const HOUR_MS = 60 * 60 * 1000

function side(overrides: Record<string, unknown>) {
  return {
    userId: 'user-1',
    login: 'alice',
    telegramId: '12345',
    email: null,
    name: 'Alice',
    isBlocked: false,
    hasWebAccount: true,
    hasTrialGrant: false,
    subscriptions: { total: 1, active: 1, trial: 0 },
    transactionsCount: 3,
    partner: { isPartner: true, balanceMinor: 150_000 },
    balanceHoldUntil: null,
    createdAt: new Date(Date.now() - 400 * 24 * HOUR_MS).toISOString(),
    ...overrides,
  }
}

function answer(data: unknown): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } }
}

async function findCounterpart(preview: unknown): Promise<void> {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    expect(path).toBe('/admin/users/user-1/merge-preview')
    return answer(preview)
  })
  renderWithProviders(<MergeAccountsCard currentUserId="user-1" queryKey={['user', 'user-1']} />)
  await userEvent.type(screen.getByPlaceholderText(i18n.t('userDetailPanel.web.merge.refPlaceholder')), 'bob')
  await userEvent.click(screen.getByRole('button', { name: i18n.t('userDetailPanel.web.merge.find') }))
  await screen.findByText(i18n.t('userDetailPanel.web.merge.pickSurvivor'))
}

describe('the merge preview and a hold on a partner balance', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the hold on the side that has it, until when, and that it carries over', async () => {
    const holdUntil = new Date(Date.now() + 40 * HOUR_MS).toISOString()
    await findCounterpart({
      current: side({}),
      counterpart: side({ userId: 'user-2', login: 'bob', balanceHoldUntil: holdUntil }),
      conflicts: ['login', 'partner'],
    })

    const until = new Date(holdUntil).toLocaleString(activeLocale())
    const holds = screen.getAllByText(i18n.t('userDetailPanel.web.merge.balanceHeld', { until }))
    expect(holds).toHaveLength(1)
    // On the other account's column, not this one's.
    expect(holds[0].closest('button')?.textContent).toContain('bob')
    expect(screen.getByText(i18n.t('userDetailPanel.web.merge.holdCarriesOver'))).toBeInTheDocument()
  })

  it('says nothing about a hold when neither side has one', async () => {
    await findCounterpart({
      current: side({}),
      counterpart: side({ userId: 'user-2', login: 'bob' }),
      conflicts: ['login', 'partner'],
    })

    expect(screen.queryByText(i18n.t('userDetailPanel.web.merge.holdCarriesOver'))).toBeNull()
    expect(screen.queryByText(/until/i)).toBeNull()
  })
})

describe('after the merge', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    navigateSpy.mockReset()
  })

  it('opens the account that stayed when it is the other one — this one no longer exists', async () => {
    await findCounterpart({
      current: side({}),
      counterpart: side({ userId: 'user-2', login: 'bob', telegramId: null }),
      conflicts: [],
    })
    const post = vi.spyOn(api, 'post').mockResolvedValue(
      answer({ mergedUserId: 'user-2', movedCounts: { subscriptions: 1, transactions: 3, partnerTransactions: 0 }, remnawaveSubscriptionIds: [] }),
    )

    await userEvent.click(screen.getByRole('button', { name: /bob/ }))
    await userEvent.type(screen.getByPlaceholderText(i18n.t('userDetailPanel.web.merge.confirmPlaceholder')), 'MERGE')
    await userEvent.click(screen.getByRole('button', { name: i18n.t('userDetailPanel.web.merge.execute') }))

    await vi.waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/users/user-2'))
    expect(post).toHaveBeenCalledWith('/admin/users/merge', expect.objectContaining({ sourceId: 'user-1', targetId: 'user-2' }))
  })

  it('opens this account by its id when it is the one that stays — the address it was opened by may be gone', async () => {
    await findCounterpart({ current: side({}), counterpart: side({ userId: 'user-2', login: 'bob' }), conflicts: [] })
    vi.spyOn(api, 'post').mockResolvedValue(
      answer({ mergedUserId: 'user-1', movedCounts: { subscriptions: 0, transactions: 0, partnerTransactions: 0 }, remnawaveSubscriptionIds: [] }),
    )

    await userEvent.type(screen.getByPlaceholderText(i18n.t('userDetailPanel.web.merge.confirmPlaceholder')), 'MERGE')
    await userEvent.click(screen.getByRole('button', { name: i18n.t('userDetailPanel.web.merge.execute') }))

    await vi.waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/users/user-1'))
  })
})
