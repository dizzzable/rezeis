/**
 * The shared tooltip stops zooming and sliding for anyone whose system asks for
 * less motion, on the way in and on the way out.
 *
 * jsdom evaluates no stylesheet, so what is held here is the pair of classes the
 * behaviour rides on. Measured in Chromium with the panel's compiled CSS: with
 * no preference the tip computes `animation: enter 0.15s` open and `exit 0.15s`
 * closed; under `prefers-reduced-motion: reduce` both compute to `none`, and
 * without these two classes they stayed `enter`/`exit` — the closed one because
 * `data-[state=closed]:animate-out` outranks a plain `motion-reduce:animate-none`
 * on specificity, which is why the closed state carries its own.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

afterEach(cleanup)

describe('TooltipContent', () => {
  it('drops its zoom-and-slide under reduce-motion, opening and closing', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent>tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    const content = document.querySelector('[data-side][data-state]') as HTMLElement
    expect(content, 'the tip was not rendered').not.toBeNull()
    const tokens = content.className.split(/\s+/)

    // It does animate otherwise…
    expect(tokens).toContain('animate-in')
    expect(tokens).toContain('data-[state=closed]:animate-out')
    // …and each of those two is switched off under reduce-motion.
    expect(tokens).toContain('motion-reduce:animate-none')
    expect(tokens).toContain('motion-reduce:data-[state=closed]:animate-none')
  })
})
