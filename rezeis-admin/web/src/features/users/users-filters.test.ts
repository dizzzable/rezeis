import { describe, expect, it } from 'vitest'

import {
  countActiveFilters,
  cycleTriState,
  EMPTY_FILTERS,
  filtersFromParams,
  filtersToParams,
  toggleListValue,
  type UserFilters,
} from './users-filters'

/**
 * The three transformations of a filter set, and why they have to agree.
 *
 * The request that fetches the list, the badge that counts what is on, and the
 * URL that makes a filtered view shareable are each a small transformation of
 * the same object — and each is the kind of thing that quietly goes wrong. A
 * filter counted but not sent shows a badge over an unfiltered list; a filter
 * sent but not restored means a pasted link opens the wrong view.
 */

describe('counting what is on', () => {
  it('counts nothing for an untouched set', () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0)
  })

  it('counts a multi-value filter once, however many members it has', () => {
    // The badge answers "how much am I narrowing this by". Four plans ticked is
    // one decision, not four.
    const filters: UserFilters = { ...EMPTY_FILTERS, planIds: ['a', 'b', 'c', 'd'] }
    expect(countActiveFilters(filters)).toBe(1)
  })

  it('counts an explicit NO as an active filter', () => {
    // "Not blocked" narrows the list exactly as much as "blocked" does. A count
    // that ignored it would show an unfiltered badge over a filtered list.
    expect(countActiveFilters({ ...EMPTY_FILTERS, isBlocked: false })).toBe(1)
  })
})

describe('turning filters into a request', () => {
  it('sends nothing at all when nothing is set', () => {
    expect(filtersToParams(EMPTY_FILTERS)).toEqual({})
  })

  it('joins a multi-value filter with commas', () => {
    expect(filtersToParams({ ...EMPTY_FILTERS, roles: ['USER', 'ADMIN'] })).toEqual({
      roles: 'USER,ADMIN',
    })
  })

  it('sends an explicit NO as the string "false"', () => {
    // The trap: a bare boolean in a query string arrives as "false", and
    // `Boolean('false')` is `true`. The server reads these strings on purpose.
    expect(filtersToParams({ ...EMPTY_FILTERS, isBlocked: false })).toEqual({
      isBlocked: 'false',
    })
  })

  it('omits an unset tri-state rather than sending a default', () => {
    // "I do not care" is not "false". Sending one for the other silently
    // excludes everybody the operator never asked about.
    expect(filtersToParams(EMPTY_FILTERS)).not.toHaveProperty('isBlocked')
  })
})

describe('restoring filters from a link', () => {
  it('round-trips a full set', () => {
    // The property that makes a filtered view shareable: what the URL carries
    // is what the panel comes back with.
    const filters: UserFilters = {
      planIds: ['plan-1', 'plan-2'],
      subscriptionStatuses: ['ACTIVE'],
      roles: ['USER'],
      languages: ['RU'],
      hasSubscription: true,
      isTrial: false,
      isBlocked: undefined,
      hasTelegram: true,
      hasWebAccount: undefined,
      flagged: false,
    }
    const params = new URLSearchParams(filtersToParams(filters))
    expect(filtersFromParams(params)).toEqual(filters)
  })

  it('ignores a value it does not understand instead of refusing the link', () => {
    // A link saved before a filter was renamed should still open the list,
    // narrowed by whatever it can still read.
    const params = new URLSearchParams({ isBlocked: 'perhaps', roles: 'USER' })
    const filters = filtersFromParams(params)
    expect(filters.isBlocked).toBeUndefined()
    expect(filters.roles).toEqual(['USER'])
  })

  it('reads an empty list parameter as no filter', () => {
    // `?roles=` must not become "match nothing", which would render an empty
    // list that looks like a broken page.
    expect(filtersFromParams(new URLSearchParams({ roles: '' })).roles).toEqual([])
  })
})

describe('changing a filter', () => {
  it('adds and removes one member of a multi-value filter', () => {
    const added = toggleListValue(EMPTY_FILTERS, 'planIds', 'plan-1')
    expect(added.planIds).toEqual(['plan-1'])
    expect(toggleListValue(added, 'planIds', 'plan-1').planIds).toEqual([])
  })

  it('cycles a tri-state through all three answers', () => {
    // Three states and not two: "blocked", "not blocked" and "either" are
    // different questions, and a checkbox can only express two of them.
    const yes = cycleTriState(EMPTY_FILTERS, 'isBlocked')
    const no = cycleTriState(yes, 'isBlocked')
    const any = cycleTriState(no, 'isBlocked')
    expect([yes.isBlocked, no.isBlocked, any.isBlocked]).toEqual([true, false, undefined])
  })

  it('leaves the other filters alone', () => {
    const start: UserFilters = { ...EMPTY_FILTERS, roles: ['ADMIN'] }
    expect(cycleTriState(start, 'isBlocked').roles).toEqual(['ADMIN'])
  })
})
