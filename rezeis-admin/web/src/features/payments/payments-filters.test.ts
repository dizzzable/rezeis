import { describe, expect, it } from 'vitest'

import {
  EMPTY_PAYMENTS_FILTERS,
  clientPaymentsHref,
  dateToDay,
  dayToDate,
  filtersFromSearchParams,
  filtersToApiParams,
  hasActiveFilters,
  paymentHref,
  subscriptionPaymentsHref,
  withFilters,
} from './payments-filters'

/**
 * The address bar ↔ filters ↔ request triangle, without rendering anything.
 *
 * The page tests prove the wiring; these pin the transformations, and above
 * all the two promises the module header makes: a value the page does not
 * understand is SENT (so the API can refuse it by name), and a UI-only key is
 * NEVER sent (the API forbids unknown parameters).
 */

const CUID = 'cmfk2x9pq0000abcd1234efgh'

describe('filtersToApiParams', () => {
  it('sends every filter that is set, and nothing the address bar holds for the page itself', () => {
    const filters = filtersFromSearchParams(
      new URLSearchParams({
        q: 'ref-1',
        userId: CUID,
        subscriptionId: CUID,
        status: 'REFUNDED',
        payment: 'open-one',
        page: '3',
      }),
    )

    const params = filtersToApiParams(filters, 50)

    expect(Object.fromEntries(params)).toEqual({
      limit: '50',
      offset: '100',
      q: 'ref-1',
      userId: CUID,
      subscriptionId: CUID,
      status: 'REFUNDED',
    })
    expect(params.has('payment')).toBe(false)
    expect(params.has('page')).toBe(false)
  })

  it('forwards a value it does not understand, so the API can name it in a 400', () => {
    const filters = filtersFromSearchParams(
      new URLSearchParams({ userId: '12345', status: 'PAID', dateFrom: 'yesterday', page: 'two' }),
    )

    const params = filtersToApiParams(filters, 50)

    expect(params.get('userId')).toBe('12345')
    expect(params.get('status')).toBe('PAID')
    expect(params.get('dateFrom')).toBe('yesterday')
    expect(params.get('offset')).toBe('two')
  })

  it('turns picked days into the first and last instant of those days, locally', () => {
    const params = filtersToApiParams(
      { ...EMPTY_PAYMENTS_FILTERS, dateFrom: '2026-09-01', dateTo: '2026-09-18' },
      50,
    )

    expect(params.get('dateFrom')).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).toISOString())
    expect(params.get('dateTo')).toBe(new Date(2026, 8, 18, 23, 59, 59, 999).toISOString())
  })

  it('starts on the first page when none is named', () => {
    expect(filtersToApiParams(EMPTY_PAYMENTS_FILTERS, 50).get('offset')).toBe('0')
  })
})

describe('withFilters', () => {
  it('keeps the open payment while the filters change', () => {
    const current = new URLSearchParams({ payment: 'open-one', status: 'PENDING' })

    const next = withFilters(current, { ...filtersFromSearchParams(current), status: 'COMPLETED', q: 'x' })

    expect(Object.fromEntries(next)).toEqual({ payment: 'open-one', status: 'COMPLETED', q: 'x' })
  })

  it('removes a cleared filter and never writes page=1', () => {
    const current = new URLSearchParams({ q: 'x', page: '4' })

    const next = withFilters(current, { ...filtersFromSearchParams(current), q: '', page: '1' })

    expect(next.toString()).toBe('')
  })
})

describe('hasActiveFilters', () => {
  it('counts the linked client and subscription, which no control on the page can set', () => {
    expect(hasActiveFilters({ ...EMPTY_PAYMENTS_FILTERS, userId: CUID })).toBe(true)
    expect(hasActiveFilters({ ...EMPTY_PAYMENTS_FILTERS, subscriptionId: CUID })).toBe(true)
  })

  it('does not count the page', () => {
    expect(hasActiveFilters({ ...EMPTY_PAYMENTS_FILTERS, page: '2' })).toBe(false)
  })
})

describe('days', () => {
  it('round-trips a picked day', () => {
    expect(dateToDay(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dayToDate('2026-01-05')?.getTime()).toBe(new Date(2026, 0, 5).getTime())
  })

  it('does not roll 31 February over into March', () => {
    expect(dayToDate('2026-02-31')).toBeUndefined()
  })
})

describe('links into the page', () => {
  it('encodes each link so an id cannot break out of its parameter', () => {
    expect(clientPaymentsHref(CUID)).toBe(`/payments?userId=${CUID}`)
    expect(subscriptionPaymentsHref(CUID)).toBe(`/payments?subscriptionId=${CUID}`)
    expect(paymentHref('a&b=c')).toBe('/payments?payment=a%26b%3Dc')
  })
})
