/**
 * LiquidGlassMotion consumability guard.
 *
 * The component's only outputs — `--lg-light-x/y` custom properties and the
 * `data-glass-scrolling` flag — are consumed exclusively by CSS rules gated
 * on `:root[data-glass-refraction="on"]`, an attribute LiquidGlassFilters
 * pins to "off" on iOS/WebKit and Firefox. Before this guard the component
 * ran a permanent rAF loop writing documentElement styles 60×/s on devices
 * where nothing could ever read them (whole-document style invalidation,
 * pure battery drain on the login screen). Under test: with refraction
 * "off" the driver must schedule no rAF and attach no writers; flipping the
 * attribute starts/stops it live.
 */
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { useGlassStore } from '@/lib/theme/glass-store'

import { LiquidGlassMotion } from './LiquidGlassMotion'

let rafSpy: MockInstance<typeof window.requestAnimationFrame>

beforeEach(() => {
  useGlassStore.setState({ glassEnabled: true, respectReducedMotion: true })
  // Never fire the callbacks — these tests assert scheduling, not frames.
  rafSpy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockReturnValue(1 as unknown as ReturnType<typeof window.requestAnimationFrame>)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  const root = document.documentElement
  delete root.dataset.glassRefraction
  delete root.dataset.glassScrolling
  root.style.removeProperty('--lg-light-x')
  root.style.removeProperty('--lg-light-y')
})

describe('LiquidGlassMotion with data-glass-refraction="off"', () => {
  it('schedules no rAF loop and writes no light coordinates', () => {
    document.documentElement.dataset.glassRefraction = 'off'

    render(<LiquidGlassMotion />)

    expect(rafSpy).not.toHaveBeenCalled()
    // Not even the initial flush: the vars fall back to the CSS defaults.
    expect(
      document.documentElement.style.getPropertyValue('--lg-light-x'),
    ).toBe('')
  })

  it('ignores pointer movement entirely', () => {
    document.documentElement.dataset.glassRefraction = 'off'

    render(<LiquidGlassMotion />)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100 }))

    expect(
      document.documentElement.style.getPropertyValue('--lg-light-x'),
    ).toBe('')
  })
})

describe('LiquidGlassMotion with data-glass-refraction="on" (Chromium)', () => {
  it('runs the pointer/idle driver as before', () => {
    document.documentElement.dataset.glassRefraction = 'on'

    render(<LiquidGlassMotion />)

    expect(rafSpy).toHaveBeenCalled()
    // Initial flush pins the highlight to the pointer default (50%).
    expect(
      document.documentElement.style.getPropertyValue('--lg-light-x'),
    ).not.toBe('')
  })

  it('starts the driver when the attribute flips on after mount', async () => {
    document.documentElement.dataset.glassRefraction = 'off'

    render(<LiquidGlassMotion />)
    expect(rafSpy).not.toHaveBeenCalled()

    document.documentElement.dataset.glassRefraction = 'on'

    // MutationObserver delivers on a microtask.
    await waitFor(() =>
      expect(
        rafSpy,
        'data-glass-refraction flipped to "on" and the driver never started — ' +
          'the component subscribes to that attribute, so either the ' +
          'MutationObserver is not observing <html data-glass-refraction> or ' +
          'the snapshot it reads is not the attribute. The glass shimmer stays ' +
          'frozen until the next unrelated re-render.',
      ).toHaveBeenCalled(),
    )
  })

  it('stops the driver when the attribute flips off', async () => {
    document.documentElement.dataset.glassRefraction = 'on'

    render(<LiquidGlassMotion />)
    expect(rafSpy).toHaveBeenCalled()

    document.documentElement.dataset.glassRefraction = 'off'
    await waitFor(() =>
      expect(
        window.cancelAnimationFrame,
        'data-glass-refraction flipped to "off" and the rAF loop was never ' +
          'cancelled — the driver keeps writing --lg-light-x/y on <html> every ' +
          'frame, invalidating styles document-wide, to feed CSS rules that are ' +
          'no longer attached. On iOS the attribute is ALWAYS "off", so this is ' +
          'the whole cost of the component there.',
      ).toHaveBeenCalled(),
    )

    // Movement after the flip must not write again.
    document.documentElement.style.removeProperty('--lg-light-x')
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }))
    expect(
      document.documentElement.style.getPropertyValue('--lg-light-x'),
    ).toBe('')
  })
})
