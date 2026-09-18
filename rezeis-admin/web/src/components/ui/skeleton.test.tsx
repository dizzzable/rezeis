/**
 * The loading placeholder stops shimmering for anyone whose system asks for
 * less motion.
 *
 * jsdom evaluates no stylesheet, so what is held is the class the behaviour
 * rides on: Tailwind emits `motion-safe:animate-pulse` inside
 * `@media (prefers-reduced-motion: no-preference)`, while a bare
 * `animate-pulse` — what the skeleton had — pulses whatever the system says.
 * Nothing in `index.css` stops the bare one under reduce-motion; only the
 * panel's own animations switch (`data-animations="off"`) did.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Skeleton } from './skeleton'

afterEach(cleanup)

describe('Skeleton', () => {
  it('shimmers only as a motion-safe animation', () => {
    const { container } = render(<Skeleton className="h-4 w-8" />)
    const block = container.firstElementChild as HTMLElement
    const tokens = block.className.split(/\s+/)

    expect(tokens).toContain('motion-safe:animate-pulse')
    // Every animation it carries is one the system may stop.
    expect(tokens.filter((token) => /(^|:)animate-/.test(token) && !token.startsWith('motion-safe:'))).toEqual([])
    // Still the placeholder it was: its shape, and the caller's size.
    expect(block).toHaveClass('rounded-md', 'bg-muted', 'h-4', 'w-8')
  })
})
