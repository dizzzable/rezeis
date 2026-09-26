/**
 * A failing cursor or click effect must never take the page down (review R1-21).
 *
 * The effects sit beside the pages, directly under the providers, outside every
 * page's error boundary. When an effect threw, React unmounted the whole tree:
 * a blank panel with no «Попробовать снова». The likeliest cause is a
 * cursor-effect chunk that keeps failing. After its one automatic reload,
 * `lazyWithChunkRecovery` rethrows the load error into the render
 * (`lib/lazy-chunk.test.ts` proves that half). The mocks below throw exactly
 * that error, and a WebGL failure, from inside the effect. This file proves
 * the other half: whatever the effect throws stays inside the effect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore, type ClickEffectId, type CursorEffectId } from '@/lib/theme/effects-store'

import { EffectsProvider } from './EffectsProvider'

vi.mock('@/components/reactbits/SplashCursor', () => ({
  default: function SplashCursor(): never {
    throw new Error('WebGL: could not create a context')
  },
}))

vi.mock('@/components/reactbits/Crosshair', () => ({
  // What a lazy effect throws once its chunk's one reload is spent.
  default: function Crosshair(): never {
    throw new TypeError(
      'Failed to fetch dynamically imported module: https://panel.example/assets/Crosshair-Q1.js',
    )
  },
}))

vi.mock('@/components/reactbits/BlobCursor', () => ({
  default: function BlobCursor() {
    return <div data-testid="blob-cursor" />
  },
}))

vi.mock('./effects/ClickSparkOverlay', () => ({
  ClickSparkOverlay: function ClickSparkOverlay(): never {
    throw new Error('click effect failed')
  },
}))

function renderProvider(cursorEffect: CursorEffectId, clickEffect: ClickEffectId = 'none') {
  useEffectsStore.setState({ cursorEffect, clickEffect })
  return render(
    <EffectsProvider>
      <main>page</main>
    </EffectsProvider>,
  )
}

/** Lets the lazy effect chunk resolve and render (or throw). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

beforeEach(() => {
  useEffectsStore.getState().reset()
  useEffectsStore.setState({ effectsEnabled: true })
  useAppearanceStore.setState({ visualEffects: true })
  // React prints every error a boundary catches; they are the point here.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a failing effect is a missing decoration, not a blank panel', () => {
  it('keeps the page when a cursor effect throws while rendering', async () => {
    renderProvider('splash')
    await settle()

    expect(screen.getByText('page')).toBeInTheDocument()
  })

  it('keeps the page when a cursor-effect chunk fails after its one reload', async () => {
    renderProvider('crosshair')
    await settle()

    expect(screen.getByText('page')).toBeInTheDocument()
  })

  it('keeps the page when the click effect throws', async () => {
    renderProvider('none', 'spark')
    await settle()

    expect(screen.getByText('page')).toBeInTheDocument()
  })

  it('tries again when the operator picks another effect', async () => {
    renderProvider('splash')
    await settle()
    expect(screen.queryByTestId('blob-cursor')).toBeNull()

    act(() => {
      useEffectsStore.setState({ cursorEffect: 'blob' })
    })
    await settle()

    expect(screen.getByTestId('blob-cursor')).toBeInTheDocument()
    expect(screen.getByText('page')).toBeInTheDocument()
  })
})
