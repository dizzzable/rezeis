/**
 * Operator-only payment events, live in the panel.
 *
 * The server keeps a withheld payment — and its refund — away from every rule,
 * webhook and customer, and until now away from the panel's socket too, so an
 * open «Платежи» page showed it only after a reload. It is broadcast to the
 * operator's panel now; these are the lists it has to refresh. The operator's
 * «Отменить автосписание» ends with an event of the same kind once the
 * provider answered, and the user card's «Автосписание» reads again.
 */
import { describe, expect, it } from 'vitest'

import { adminQueryKeys } from '@/lib/admin-query-keys'
import { userAutopayQueryKey } from '@/features/users/user-autopay-api'

import { getRealtimeInvalidationKeys } from './realtime-invalidation'

describe('operator-only payment events refresh what shows them', () => {
  it('a withheld payment: the payments list, its analytics and the dashboard, as any payment does', () => {
    expect(getRealtimeInvalidationKeys({ type: 'payment.withheld' })).toEqual(
      getRealtimeInvalidationKeys({ type: 'payment.completed' }),
    )
    expect(getRealtimeInvalidationKeys({ type: 'payment.withheld' })).toEqual([
      adminQueryKeys.payments.transactions.all,
      adminQueryKeys.payments.analytics.all,
      adminQueryKeys.dashboard.summary,
      adminQueryKeys.audit.all,
    ])
  })

  it('its refund recorded: the same lists, so the «Не применён» mark and the revenue change without a reload', () => {
    expect(getRealtimeInvalidationKeys({ type: 'payment.withheld_refunded' })).toEqual([
      adminQueryKeys.payments.transactions.all,
      adminQueryKeys.payments.analytics.all,
      adminQueryKeys.dashboard.summary,
      adminQueryKeys.audit.all,
    ])
  })

  it('the operator’s autopay cancel answered: the user card, whose «Автосписание» is under the users key', () => {
    const keys = getRealtimeInvalidationKeys({ type: 'payment.autopay_stopped_by_operator' })
    expect(keys).toEqual([adminQueryKeys.users.all, adminQueryKeys.audit.all])
    // The section's own key starts with it: a prefix invalidates it.
    expect(userAutopayQueryKey('user-1').slice(0, adminQueryKeys.users.all.length)).toEqual([...adminQueryKeys.users.all])
  })
})
