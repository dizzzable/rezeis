import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
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
})
