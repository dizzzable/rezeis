import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import type { ReactNode } from 'react'

import { useTabSync } from './use-tab-sync'

const ALLOWED = ['list', 'invites', 'imports'] as const
type Tab = (typeof ALLOWED)[number]

function makeWrapper(initialEntry: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
  }
}

describe('useTabSync', () => {
  it('returns the default tab when location.hash is empty', () => {
    const { result } = renderHook(() => useTabSync<Tab>(ALLOWED, 'list'), {
      wrapper: makeWrapper('/users'),
    })
    expect(result.current.activeTab).toBe('list')
  })

  it('parses initial tab from location.hash when it is in the allowed set', () => {
    const { result } = renderHook(() => useTabSync<Tab>(ALLOWED, 'list'), {
      wrapper: makeWrapper('/users#invites'),
    })
    expect(result.current.activeTab).toBe('invites')
  })

  it('falls back to default when hash is not in allowed set', () => {
    const { result } = renderHook(() => useTabSync<Tab>(ALLOWED, 'list'), {
      wrapper: makeWrapper('/users#bogus'),
    })
    expect(result.current.activeTab).toBe('list')
  })

  it('setTab updates state and pushes a hash to the URL', () => {
    let currentLocationHash = ''
    function HashCapture({ children }: { children: ReactNode }) {
      const { hash } = useLocation()
      currentLocationHash = hash
      return <>{children}</>
    }
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <MemoryRouter initialEntries={['/users']}>
          <HashCapture>{children}</HashCapture>
        </MemoryRouter>
      )
    }

    const { result } = renderHook(() => useTabSync<Tab>(ALLOWED, 'list'), {
      wrapper: Wrapper,
    })

    expect(result.current.activeTab).toBe('list')

    act(() => result.current.setTab('invites'))
    expect(result.current.activeTab).toBe('invites')
    expect(currentLocationHash).toBe('#invites')

    act(() => result.current.setTab('imports'))
    expect(result.current.activeTab).toBe('imports')
    expect(currentLocationHash).toBe('#imports')
  })

  it('setTab ignores values not in the allowed set', () => {
    const { result } = renderHook(() => useTabSync<Tab>(ALLOWED, 'list'), {
      wrapper: makeWrapper('/users'),
    })

    act(() => result.current.setTab('not-a-tab'))
    expect(result.current.activeTab).toBe('list')
  })

  it('keeps the query string when the tab changes', () => {
    // THE case, and it lost an operator's work silently. react-router resolves
    // a string destination with `search = ''` unless the string carries one, so
    // switching tabs wiped every query parameter — on Users that is the whole
    // filter set and the search box. Filter to twelve rows, click Bulk to copy
    // ids, click back to List: the badge reads 0 over every user in the
    // install, and "the twelfth row" is now a different account.
    let currentSearch = ''
    let currentHash = ''
    function Probe() {
      const location = useLocation()
      currentSearch = location.search
      currentHash = location.hash
      return useTabSync<Tab>(ALLOWED, 'list')
    }

    const { result } = renderHook(Probe, {
      wrapper: makeWrapper('/users?flagged=true&roles=ADMIN#list'),
    })

    act(() => {
      result.current.setTab('invites')
    })

    expect(currentSearch).toBe('?flagged=true&roles=ADMIN')
    expect(currentHash).toBe('#invites')
  })
})
