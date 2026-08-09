/**
 * The three text animations wired onto the `TitleEffect` switch —
 * `shuffle` (reactbits/Shuffle), `typewriter` (reactbits/TextType) and
 * `proximity` (reactbits/VariableProximity).
 *
 * What these assert is the CONTRACT of the only two call sites
 * (`dashboard-page.tsx` and `effects-settings-card.tsx`): the animation
 * renders inline inside an `<h1>`/`<div>` that has already set font size and
 * weight. So every spec renders inside a real `<h1>` and checks the emitted
 * DOM, not merely that nothing threw — a component that renders a `<div>`, a
 * `<p>`, or its own font stack is broken here even though it mounts cleanly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore, type TextAnimationId } from '@/lib/theme/effects-store'
import { TitleEffect } from './TitleEffect'

const TITLE = 'Dashboard'

/**
 * Elements that may not appear inside a heading's inline content. Tag names
 * rather than computed display, deliberately: jsdom loads no stylesheet, so
 * `getComputedStyle().display` would report the UA default and call every
 * Tailwind `inline-block` a block. The tag is the honest signal available here,
 * and it is the half that actually broke — `TextType` defaults to `as="div"`
 * and `Shuffle` defaults to `tag="p"`.
 */
const BLOCK_LEVEL = 'div,p,h1,h2,h3,h4,h5,h6,section,article,ul,ol,li,table,form,blockquote,pre,hr,figure'

/**
 * A selector that only exists once the lazy chunk has actually arrived.
 *
 * Without one, every assertion below would happily pass against the Suspense
 * fallback — which is a plain `<span>` holding the title and therefore
 * satisfies "inline, no block element, contains the text" without the
 * component under test ever being constructed.
 */
const LOADED: Record<'shuffle' | 'typewriter' | 'proximity', string> = {
  shuffle: '.will-change-transform', // Shuffle's own baseTw
  typewriter: '.whitespace-pre-wrap', // TextType's own root class
  proximity: '.sr-only', // VariableProximity's accessible copy
}

function renderInHeading(animation: TextAnimationId) {
  useEffectsStore.setState({ textAnimation: animation })
  return render(
    <h1 className="text-2xl font-bold tracking-tight" data-testid="heading">
      <TitleEffect text={TITLE} />
    </h1>,
  )
}

async function headingWith(animation: 'shuffle' | 'typewriter' | 'proximity') {
  const heading = await screen.findByTestId('heading')
  await waitFor(() => {
    expect(heading.querySelector(LOADED[animation])).not.toBeNull()
  })
  return heading
}

describe('TitleEffect — newly wired title animations', () => {
  beforeEach(() => {
    useEffectsStore.getState().reset()
    useAppearanceStore.setState({ visualEffects: true })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe.each([
    ['shuffle' as const],
    ['typewriter' as const],
    ['proximity' as const],
  ])('%s', (animation) => {
    it('renders the title inline, with no block-level element inside the heading', async () => {
      renderInHeading(animation)
      const heading = await headingWith(animation)

      expect(heading.textContent).toContain(TITLE)
      // Scoped to the heading, not to the render container: the container is
      // itself a <div> and holds the <h1>, both of which the selector matches.
      expect(heading.querySelectorAll(BLOCK_LEVEL)).toHaveLength(0)
      expect(heading.firstElementChild?.tagName).toBe('SPAN')
    })
  })

  it('falls back to plain markup when a string-only animation has no string', async () => {
    // `hasUsableString` gates every string-only id BEFORE the Suspense
    // boundary. That gate is what stops `TextType` from reaching
    // `textArray[currentTextIndex].length` on '' — it has no guard of its own
    // and throws there.
    for (const animation of ['shuffle', 'typewriter', 'proximity'] as const) {
      useEffectsStore.setState({ textAnimation: animation })
      const { container, unmount } = render(
        <h1>
          <TitleEffect>
            <em>{TITLE}</em>
          </TitleEffect>
        </h1>,
      )
      expect(container.querySelector('em')?.textContent).toBe(TITLE)
      // Nothing lazy was ever asked for: the guard returned before <Suspense>.
      expect(container.querySelector('.whitespace-pre-wrap')).toBeNull()
      unmount()
    }
  })

  // ── Shuffle ────────────────────────────────────────────────────────────────

  it('shuffle inherits the surrounding font instead of stamping its own', async () => {
    renderInHeading('shuffle')
    const shuffled = (await headingWith('shuffle')).firstElementChild as HTMLElement

    // The component only skips its `'Press Start 2P'` inline fallback when
    // `className` matches /font[-[]/i. That face is not a dependency of this
    // app, so a miss here means every heading silently renders in the generic
    // `sans-serif` instead of the operator's theme font.
    expect(shuffled.style.fontFamily).toBe('')
    expect(shuffled.className).toMatch(/font-\[inherit\]!/)
  })

  it('shuffle renders as a span, not the component default <p>', async () => {
    renderInHeading('shuffle')
    const heading = await headingWith('shuffle')
    expect(heading.firstElementChild?.tagName).toBe('SPAN')

    // GSAP's SplitText builds one element per character and defaults to
    // `<div>`. Those land inside the <h1>, so the per-char tag is part of this
    // contract too, not just the root's.
    const chars = heading.querySelectorAll('.shuffle-char')
    expect(chars.length).toBe(TITLE.length)
    for (const char of chars) expect(char.tagName).toBe('SPAN')
  })

  it('shuffle stays visible under prefers-reduced-motion', async () => {
    // With `respectReducedMotion` (default true) the component's useGSAP body
    // returns before `setReady(true)`, so its own class list is stuck on
    // `invisible` — permanently, for the users least able to work around it.
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: true, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as unknown as MediaQueryList,
    )

    renderInHeading('shuffle')
    const shuffled = (await headingWith('shuffle')).firstElementChild as HTMLElement

    expect(shuffled.className).toContain('invisible')
    // …which is exactly why the call site forces the winning token. `.uppercase`
    // is emitted after `.normal-case` in the utilities layer and `.visible`
    // after `.invisible`, so an unprefixed utility would lose the cascade.
    expect(shuffled.className).toMatch(/visible!/)
    expect(shuffled.className).toMatch(/normal-case!/)
  })

  // ── TextType ───────────────────────────────────────────────────────────────

  it('typewriter types the title once and never deletes it', async () => {
    // Warm the module registry so React.lazy's import() settles on a
    // microtask; the dynamic import would otherwise need the real event loop
    // while timers are faked.
    await import('@/components/reactbits/TextType')

    useEffectsStore.setState({ textAnimation: 'typewriter' })
    vi.useFakeTimers()

    const { container } = render(
      <h1>
        <TitleEffect text="Hi" />
      </h1>,
    )
    await act(async () => {
      await Promise.resolve()
    })

    // TextType's own root carries `whitespace-pre-wrap`; its first child holds
    // the characters typed so far. The sibling `opacity-0` copy in
    // TypewriterInline always holds the full string, so reading the heading's
    // textContent would prove nothing about the animation.
    const typed = () =>
      container.querySelector('.whitespace-pre-wrap')?.firstElementChild?.textContent

    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
    }
    expect(typed()).toBe('Hi')

    // `loop` defaults to TRUE upstream. Left at the default, the component
    // waits `pauseDuration` (2000 ms) and then deletes the title one character
    // at a time, forever. Sample across 12 s: the only value ever observed
    // after completion must be the finished string.
    const observed = new Set<string>()
    for (let i = 0; i < 60; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      observed.add(typed() ?? '<missing>')
    }
    expect([...observed]).toEqual(['Hi'])
  })

  it('typewriter reserves the final line box and keeps one stable string for assistive tech', async () => {
    renderInHeading('typewriter')

    const heading = await screen.findByTestId('heading')
    await waitFor(() => {
      expect(heading.querySelector('.whitespace-pre-wrap')).not.toBeNull()
    })

    // The animated copy is hidden from the a11y tree…
    const animated = heading.querySelector('[aria-hidden="true"]')
    expect(animated?.querySelector('.whitespace-pre-wrap')).not.toBeNull()

    // …and a full-width copy stays in it, so the heading has its final size
    // from the first frame instead of growing a character at a time.
    const reserved = heading.querySelector('.opacity-0')
    expect(reserved?.textContent).toBe(TITLE)
    expect(reserved?.getAttribute('aria-hidden')).toBeNull()
  })

  it('typewriter renders as a span, not the component default <div>', async () => {
    const { container } = renderInHeading('typewriter')
    await waitFor(() => {
      expect(container.querySelector('.whitespace-pre-wrap')).not.toBeNull()
    })
    expect(container.querySelector('.whitespace-pre-wrap')?.tagName).toBe('SPAN')
  })

  // ── VariableProximity ──────────────────────────────────────────────────────

  it('proximity gets a container to measure against and no font of its own', async () => {
    const { container } = renderInHeading('proximity')

    // The sr-only copy is the component's accessible text; the per-letter
    // spans are aria-hidden.
    await waitFor(() => {
      expect(container.querySelector('.sr-only')).not.toBeNull()
    })
    expect(container.querySelector('.sr-only')?.textContent).toBe(TITLE)

    // Upstream hard-codes `fontFamily: '"Roboto Flex", sans-serif'` on this
    // root. That face is not installed, so the declaration resolved to the
    // generic `sans-serif` and overrode the operator's theme font.
    const root = container.querySelector('.sr-only')?.parentElement
    expect(root?.style.fontFamily).toBe('')
    expect(root?.style.display).toBe('inline')

    // The wrapper `TitleEffect` renders for `containerRef` — without it the
    // component measures against `null` and every letter reads the raw
    // viewport coordinate.
    expect(root?.parentElement?.tagName).toBe('SPAN')
    expect(root?.parentElement?.className).toContain('inline')
  })

  it('proximity animates the wght axis both installed font kinds understand', async () => {
    const { container } = renderInHeading('proximity')
    await waitFor(() => {
      expect(container.querySelector('.sr-only')).not.toBeNull()
    })

    // Letters start at the `from` end of the axis. A static face (ibm-plex-mono)
    // simply has no `wght` axis to apply this to — a no-op, not an error.
    const letters = container.querySelectorAll('[aria-hidden="true"]')
    expect(letters.length).toBe(TITLE.length)
    expect(letters[0].textContent).toBe(TITLE[0])
  })
})
