/**
 * GlassBackground auth gate.
 *
 * The animated backgrounds are WebGL shaders driven by rAF loops — the
 * single biggest reason /sign-in ran hot on iPhones was the default
 * liquidChrome shader animating full-screen behind the login card. The
 * gate under test: while unauthenticated the component must render only a
 * static CSS-gradient stand-in and must not touch BG_COMPONENTS at all
 * (mounting even a Suspense boundary around the lazy import would fetch
 * the chunk). Post-auth the animated path is unchanged.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useGlassStore } from '@/lib/theme/glass-store'

import { GlassBackground } from './GlassBackground'

const authState = vi.hoisted(() => ({ isAuthenticated: false }))

vi.mock('@/features/auth/auth-provider', () => ({
  useAuth: () => authState,
}))

// Track renders of the animated background component itself, so the tests
// can prove the pre-auth path never invokes it (not merely that it is
// invisible). The exact count is a React scheduling detail (the store
// hydration effect re-renders once) — the invariants are zero vs. nonzero.
const animatedMounts = vi.hoisted(() => ({ count: 0 }))
const loaderCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('./backgrounds', () => ({
  BG_COMPONENTS: {
    liquidChrome: function AnimatedBackgroundStub() {
      animatedMounts.count += 1
      return <div data-testid="animated-background" />
    },
  },
  BG_LOADERS: {
    liquidChrome: () => {
      loaderCalls.count += 1
      return Promise.resolve({ default: () => null })
    },
  },
}))

beforeEach(() => {
  vi.useFakeTimers()
  animatedMounts.count = 0
  loaderCalls.count = 0
  authState.isAuthenticated = false
  useGlassStore.setState({
    glassEnabled: true,
    background: { id: 'liquidChrome', opacity: 0.5, props: {} },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GlassBackground auth gate', () => {
  it('renders only the static gradient while unauthenticated', () => {
    const { container } = render(<GlassBackground />)

    expect(
      container.querySelector('[data-glass-background-static]'),
    ).not.toBeNull()
    expect(screen.queryByTestId('animated-background')).toBeNull()
    expect(animatedMounts.count).toBe(0)
  })

  it('mounts the animated background once authenticated', () => {
    authState.isAuthenticated = true

    const { container } = render(<GlassBackground />)

    expect(screen.getByTestId('animated-background')).toBeInTheDocument()
    expect(animatedMounts.count).toBeGreaterThan(0)
    // The gradient STAYS. It is the floor the shader composites onto, not a
    // pre-auth substitute — see below.
    expect(container.querySelector('[data-glass-background-static]')).not.toBeNull()
  })

  it('never lets the background go flat while the shader chunk is in flight', () => {
    // The regression this pins: the gradient used to be swapped out the
    // instant `isAuthenticated` flipped, with `<Suspense fallback={null}>`
    // behind it. So the first authenticated frame — the dashboard's own
    // chunk and queries already landing, and for silk/beams/dither a 950 KB
    // vendor-three download still running — rendered on a flat background,
    // and the shader then popped in over nothing. The gradient must survive
    // the transition.
    const { container, rerender } = render(<GlassBackground />)
    expect(animatedMounts.count).toBe(0)
    expect(container.querySelector('[data-glass-background-static]')).not.toBeNull()

    authState.isAuthenticated = true
    rerender(<GlassBackground />)

    expect(screen.getByTestId('animated-background')).toBeInTheDocument()
    expect(container.querySelector('[data-glass-background-static]')).not.toBeNull()
    // …and the shader arrives on its own layer, which is what carries the
    // fade-in keyframe (index.css) rather than appearing in one frame.
    expect(container.querySelector('[data-glass-background-animated]')).not.toBeNull()
  })

  it('renders nothing at all when the background feature is off', () => {
    useGlassStore.setState({ glassEnabled: false })

    const { container } = render(<GlassBackground />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing pre-auth when the background is "none"', () => {
    // The static stand-in replaces a background — it must not invent one
    // for operators who explicitly disabled it.
    useGlassStore.setState({
      background: { id: 'none', opacity: 0.5, props: {} },
    })

    const { container } = render(<GlassBackground />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('GlassBackground login-screen prefetch', () => {
  it('warms the chunk during idle while unauthenticated', () => {
    render(<GlassBackground />)
    expect(loaderCalls.count).toBe(0) // not synchronously — that is the point

    vi.advanceTimersByTime(5_000)
    expect(loaderCalls.count).toBe(1)
    // Downloaded, not mounted: the whole reason the raw loader is exported
    // separately from the `lazy()` component.
    expect(animatedMounts.count).toBe(0)
    expect(screen.queryByTestId('animated-background')).toBeNull()
  })

  it('does not prefetch post-auth — the component is already loading it', () => {
    authState.isAuthenticated = true

    render(<GlassBackground />)
    vi.advanceTimersByTime(5_000)

    expect(loaderCalls.count).toBe(0)
  })

  it('does not prefetch a background the operator turned off', () => {
    useGlassStore.setState({ glassEnabled: false })

    render(<GlassBackground />)
    vi.advanceTimersByTime(5_000)

    expect(loaderCalls.count).toBe(0)
  })

  it('cancels the pending warm-up when it unmounts first', () => {
    // Sign-in resolves fast on a warm session: the shell can unmount before
    // idle ever arrives, and a stray import firing into a torn-down tree is
    // exactly the kind of thing that shows up later as a mystery request.
    const { unmount } = render(<GlassBackground />)
    unmount()

    vi.advanceTimersByTime(5_000)
    expect(loaderCalls.count).toBe(0)
  })
})
