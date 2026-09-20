import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RING_MS, useArrivalRing } from './use-arrival-ring'

function ring(enabled = true) {
  return renderHook(
    ({ unread }: { unread: number | null }) => useArrivalRing(unread, enabled),
    { initialProps: { unread: null as number | null } },
  )
}

describe('when the bell moves', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('moves when an alert arrives, and stops on its own', () => {
    const { result, rerender } = ring()

    // The first answer is what was already waiting at sign-in.
    rerender({ unread: 2 })
    expect(result.current).toBe(false)

    rerender({ unread: 3 })
    expect(result.current).toBe(true)

    act(() => void vi.advanceTimersByTime(RING_MS + 1))
    expect(result.current).toBe(false)
  })

  it('stays still when the operator reads one', () => {
    // The count going down is the operator's own doing. Announcing it back to
    // them is the panel talking to itself.
    const { result, rerender } = ring()

    rerender({ unread: 4 })
    rerender({ unread: 1 })

    expect(result.current).toBe(false)
  })

  it('stays still when either switch says stillness', () => {
    const { result, rerender } = ring(false)

    rerender({ unread: 1 })
    rerender({ unread: 9 })

    expect(result.current).toBe(false)
  })

  it('does not count the zero a query reads as while it waits for an answer', () => {
    // `null` is "no answer yet"; a badge that reads 0 in the meantime would
    // make the first real number look like nine alerts arriving at once.
    const { result, rerender } = ring()

    rerender({ unread: null })
    rerender({ unread: 9 })

    expect(result.current).toBe(false)
  })
})
