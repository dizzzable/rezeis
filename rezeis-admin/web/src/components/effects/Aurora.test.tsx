/**
 * Aurora — compositor-friendly blobs + effect gates.
 *
 * The blobs must stay `filter`-free: the previous implementation animated
 * translate AND scale on `blur(80–100px)` divs, which forced iOS to
 * re-rasterize a viewport-sized Gaussian blur every frame on the sign-in
 * screen. The soft look now comes from radial gradients (see `.aurora-blob`
 * in index.css) and the keyframes are translate-only, so the whole
 * animation composites on the GPU. These tests pin the markup half of that
 * contract plus the `visualEffects` gate; the keyframes themselves are CSS
 * and are covered by review, not jsdom.
 */
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useAppearanceStore } from '@/lib/theme/appearance-store'

import { Aurora } from './Aurora'

beforeEach(() => {
  useAppearanceStore.setState({ visualEffects: true })
})

describe('Aurora', () => {
  it('renders three gradient blobs with their animation classes', () => {
    const { container } = render(<Aurora />)

    const blobs = container.querySelectorAll('.aurora-blob')
    expect(blobs).toHaveLength(3)
    expect(blobs[0]).toHaveClass('aurora-blob--1', 'animate-aurora-1')
    expect(blobs[1]).toHaveClass('aurora-blob--2', 'animate-aurora-2')
    expect(blobs[2]).toHaveClass('aurora-blob--3', 'animate-aurora-3')
  })

  it('carries no blur filter of ANY spelling (the iOS re-rasterization trap)', () => {
    // The original blobs were `blur-3xl` — a NAMED Tailwind utility, not the
    // arbitrary-value form. A rule that forbade only `blur-[...]` therefore
    // did not forbid the actual regression: adding `blur-3xl` back to a blob
    // passed this file untouched. Every spelling that emits a `filter` or
    // `backdrop-filter` is listed:
    //
    //   blur-sm … blur-3xl   named scale        backdrop-blur-*  the same, backdrop
    //   blur-[80px]          arbitrary value    blur             the bare default (8px)
    //   filter-[blur(…)]     arbitrary filter
    //
    // Prefixed variants (`md:blur-lg`, `hover:backdrop-blur-sm`) are covered
    // by matching on a boundary rather than the start of the class string.
    const BLURRED = /(?:^|[\s:])(?:backdrop-)?blur(?:-|$|\s)|filter-\[/
    const { container } = render(<Aurora />)

    const elements = Array.from(container.querySelectorAll('*'))
    expect(elements.length).toBeGreaterThan(0)
    for (const el of elements) {
      expect(String(el.className)).not.toMatch(BLURRED)
      // …and not smuggled in as an inline style either, which no class-name
      // rule can see.
      expect((el as HTMLElement).style.filter ?? '').not.toContain('blur')
      expect((el as HTMLElement).style.backdropFilter ?? '').not.toContain('blur')
    }
  })

  it('keeps the wrapper class the CSS gates target', () => {
    // `:root[data-effects="off"]` and prefers-reduced-motion rules select
    // `.aurora-bg` / `.aurora-blob` — renaming either silently disables
    // the gates.
    const { container } = render(<Aurora />)

    expect(container.querySelector('.aurora-bg')).not.toBeNull()
  })

  it('renders nothing when visual effects are disabled', () => {
    useAppearanceStore.setState({ visualEffects: false })

    const { container } = render(<Aurora />)

    expect(container).toBeEmptyDOMElement()
  })
})
