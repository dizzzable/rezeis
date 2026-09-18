/**
 * The shared tabs: a panel's entry stops for anyone who asked for stillness,
 * and a strip allowed to wrap grows with its rows.
 *
 * jsdom evaluates no stylesheet, so what is held here is what the behaviour
 * rides on — the classes, and the one `index.css` rule the panel's own
 * animations switch is. Both were measured in Chromium against the dev server's
 * compiled CSS:
 *
 *   - a freshly activated panel computed `animation: enter 0.2s` with the system
 *     asking to reduce motion — the bare `data-[state=active]:animate-in` runs
 *     whatever the system says. As `motion-safe:` it computes `none` there, and
 *     still `enter` with no preference. With the panel's switch off
 *     (`data-animations="off"`) the duration collapses to 0.001 ms either way.
 *   - a strip given `flex-wrap` kept `h-10`: on a phone the admins strip wrapped
 *     to three rows inside a one-row box, and the two rows below it covered the
 *     page. Released to `h-auto` it grows with its rows; a strip on one row is
 *     40 px tall either way, so nothing that fit before moves.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

afterEach(cleanup)

function renderTabs(listClassName?: string): void {
  render(
    <Tabs value="one">
      <TabsList className={listClassName}>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">first</TabsContent>
      <TabsContent value="two">second</TabsContent>
    </Tabs>,
  )
}

const MOTION = /(^|:)(animate-|fade-|slide-|zoom-|spin-|duration-)/

describe('TabsContent', () => {
  it('enters only as a motion-safe animation', () => {
    renderTabs()
    const tokens = screen.getByRole('tabpanel').className.split(/\s+/)

    expect(tokens).toContain('motion-safe:data-[state=active]:animate-in')
    // Anchor: the entry is still there for whoever has not asked for stillness…
    expect(tokens.filter((token) => MOTION.test(token))).toEqual([
      'motion-safe:data-[state=active]:animate-in',
      'motion-safe:data-[state=active]:fade-in-0',
      'motion-safe:data-[state=active]:slide-in-from-bottom-1',
      'motion-safe:data-[state=active]:duration-200',
    ])
    // …and none of it is one the system cannot stop.
    expect(tokens.filter((token) => MOTION.test(token) && !token.startsWith('motion-safe:'))).toEqual([])
  })

  it('is collapsed by the panel’s own animations switch as well', () => {
    // The switch is `data-animations="off"` on <html>; this rule is all of it.
    const css = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8')
    const rule = /:root\[data-animations="off"\] \*,\s*:root\[data-animations="off"\] \*::before,\s*:root\[data-animations="off"\] \*::after\s*\{([^}]*)\}/.exec(
      css,
    )
    expect(rule, 'the animations-off rule is gone from index.css').not.toBeNull()
    expect(rule?.[1]).toMatch(/animation-duration:\s*0\.001ms\s*!important/)
    expect(rule?.[1]).toMatch(/animation-iteration-count:\s*1\s*!important/)
  })
})

describe('TabsList', () => {
  it('lets a strip that wraps grow with its rows', () => {
    renderTabs('flex-wrap')
    const tokens = screen.getByRole('tablist').className.split(/\s+/)

    expect(tokens).toContain('flex-wrap')
    // Beats `h-10` on specificity (two classes to one) — only on a strip that wraps.
    expect(tokens).toContain('[&.flex-wrap]:h-auto')
  })

  it('keeps a strip that does not wrap at one row of 40 px', () => {
    renderTabs()
    const tokens = screen.getByRole('tablist').className.split(/\s+/)

    expect(tokens).toContain('h-10')
    expect(tokens).not.toContain('flex-wrap')
    expect(tokens.filter((token) => /^h-(?!10$)/.test(token))).toEqual([])
  })
})
