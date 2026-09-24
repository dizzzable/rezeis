/**
 * WHAT ONE CARD'S «НАЗНАЧИТЬ ПЛАН» SAYS WHEN IT FAILS.
 *
 * The select under «Быстрые действия» fell back to `toasts.subUpdated` —
 * «Подписка обновлена» — whenever a failure carried no message of its own, so a
 * plan that was NOT assigned was announced as a success. And the one refusal
 * the server gives this route a code for (409, a paid renewal period queued
 * with add-ons bought for it) reached the operator as the server's English
 * sentence. Both are driven here through the real panel and the real Radix
 * select, with only the network and the toasts stubbed.
 *
 * ANTI-VACUITY. Each case asserts the toast it must show AND the ones it must
 * not, so a card that toasted nothing — or toasted the success — cannot pass.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PLAN_ASSIGNMENT_REFUSAL_CODES } from '../../../../src/modules/users/controllers/plan-assignment-refusals'
import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { ru } from '@/i18n/features/userDetail.ru'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import { PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL_CODE } from './plan-assignment-refusals'

const PLANS = [
  { id: 'plan-1', name: 'Base', trafficLimit: 100, isArchived: false },
  { id: 'plan-2', name: 'Pro', trafficLimit: 500, isArchived: false },
]
vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: PLANS }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

import UserDetailPanel from './user-detail-panel'

const USER = {
  id: 'user-1',
  telegramId: '12345',
  username: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  language: 'en',
  role: 'USER',
  isBlocked: false,
  isPartner: false,
  points: 0,
  personalDiscount: 0,
  purchaseDiscount: 0,
  maxSubscriptions: 1,
  createdAt: '2026-06-04T10:00:00.000Z',
  updatedAt: '2026-06-04T10:00:00.000Z',
  subscriptions: [
    {
      id: 'sub-1',
      status: 'ACTIVE',
      isTrial: false,
      trafficLimit: 100,
      deviceLimit: 3,
      expireAt: '2026-12-01T10:00:00.000Z',
      remnawaveId: null,
      configUrl: null,
      plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
    },
  ],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
}

const text = (key: string): string => i18n.t(key)

/** Opens the card's quick edits and picks «Pro» in its plan select. */
async function assignPro(): Promise<void> {
  const user = userEvent.setup()
  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
  await user.click(await screen.findByRole('button', { name: 'Quick edits' }))
  const select = (await screen.findAllByRole('combobox')).find((box) => within(box).queryByText('Base') !== null)
  expect(select, 'no plan select on the card').toBeDefined()
  await user.click(select as HTMLElement)
  await user.click(await screen.findByRole('option', { name: /^Pro/ }))
}

describe('one card’s «Назначить план» when the server refuses', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
    // Radix triggers need these; jsdom ships none of them.
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
    proto['hasPointerCapture'] ??= () => false
    proto['setPointerCapture'] ??= () => {}
    proto['releasePointerCapture'] ??= () => {}
    proto['scrollIntoView'] ??= () => {}
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
    toastMock.success.mockClear()
    toastMock.error.mockClear()
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...USER } })
  })

  it('says the plan was not assigned when the failure carries no words of its own', async () => {
    const patch = vi.spyOn(api, 'patch').mockRejectedValue({ response: { status: 502, data: {} } })

    await assignPro()

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/users/subscriptions/sub-1', { planId: 'plan-2' })
    expect(toastMock.error).toHaveBeenCalledWith(text('userDetailPanel.subscriptions.assignFailed'))
    expect(toastMock.error).not.toHaveBeenCalledWith(text('userDetailPanel.toasts.subUpdated'))
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('names the queued paid period in the operator’s words, not the server’s English sentence', async () => {
    const sentence =
      'A paid renewal period is queued for this subscription and carries add-ons bought for it (1). ' +
      'Assigning a plan now would cancel that period, so nothing was changed.'
    vi.spyOn(api, 'patch').mockRejectedValue({
      response: {
        status: 409,
        data: {
          statusCode: 409,
          message: sentence,
          errorCode: PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL_CODE,
          code: PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL_CODE,
        },
      },
    })

    await assignPro()

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1))
    expect(toastMock.error).toHaveBeenCalledWith(text('userDetailPanel.subscriptions.assignBlockedByQueuedRenewal'))
    expect(toastMock.error).not.toHaveBeenCalledWith(sentence)
    expect(toastMock.success).not.toHaveBeenCalled()
    // What a Russian operator reads.
    expect(ru.userDetailPanel.subscriptions.assignBlockedByQueuedRenewal).toMatch(/^План не назначен: следующий срок/)
  })

  it('knows the backend’s own code', () => {
    // The SPA's literal is a hand-written copy (the frontend image carries no
    // backend tree); renamed on one side only, the operator is back to English.
    expect(PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL_CODE).toBe(PLAN_ASSIGNMENT_REFUSAL_CODES.queuedRenewalWithAddOns)
  })
})
