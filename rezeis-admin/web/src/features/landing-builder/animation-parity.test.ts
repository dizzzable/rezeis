import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LANDING_ANIMATIONS,
  LANDING_BACKGROUND_OVERLAYS,
  LANDING_CARD_HOVERS,
  LANDING_CTA_STYLES,
} from './landing-builder-api'
import {
  LANDING_ANIMATIONS as KIT_ANIMATIONS,
  LANDING_BACKGROUND_OVERLAYS as KIT_OVERLAYS,
} from './live/landing-schema'
import { ru } from '@/i18n/features/landingBuilder.ru'
import { en } from '@/i18n/features/landingBuilder.en'

// Read from disk rather than `import … from './live/landing.css?raw'`: Vitest
// stubs CSS imports by default (`test.css` is off), so the raw import would
// hand back an empty string and every assertion below would vacuously pass.
// Vitest's cwd is the package root.
const landingCss = readFileSync(
  resolve(process.cwd(), 'src/features/landing-builder/live/landing.css'),
  'utf8',
)

/**
 * The body of an at-rule, brace-balanced.
 *
 * `slice(indexOf(...))` runs to end-of-file, not to the end of the block — so
 * a rule moved OUT of a media query and appended anywhere below still appeared
 * to be inside it, and the assertions that "this rule is gated on reduced
 * motion" / "confined to pointer devices" passed while the gate was gone.
 * Nesting matters too: these blocks contain `@keyframes`.
 */
function atRuleBody(css: string, prelude: string): string {
  const start = css.indexOf(prelude)
  if (start === -1) throw new Error(`stylesheet has no ${prelude} block`)
  const open = css.indexOf('{', start)
  if (open === -1) throw new Error(`${prelude} is not followed by a block`)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`${prelude} block is never closed`)
}

/**
 * A reveal preset only works if four independent layers agree it exists: the
 * backend enum that validates it, the admin list that offers it, the kit parser
 * that accepts it, and the stylesheet that draws it. Miss one and the failure
 * is silent — the operator picks an animation and the section simply does not
 * move, with nothing logged anywhere.
 *
 * The backend enum is asserted by its own spec; these cover the three layers
 * that live in this repo, plus the labels, so an unnamed preset cannot ship as
 * a raw identifier in the dropdown.
 */


describe('reveal animation parity', () => {
  it('the admin list matches the kit list exactly', () => {
    expect([...LANDING_ANIMATIONS].sort()).toEqual([...KIT_ANIMATIONS].sort())
  })

  it.each(LANDING_ANIMATIONS.filter((name) => name !== 'none'))(
    'the stylesheet implements "%s"',
    (name) => {
      // `none` renders no wrapper at all, so it has no class by design.
      expect(landingCss).toContain(`.ls-reveal--${name}`)
    },
  )

  it.each(LANDING_ANIMATIONS)('"%s" has a label in both locales', (name) => {
    const labels = (locale: typeof ru | typeof en) =>
      (locale.landingBuilderPage as { animations: Record<string, string> }).animations
    expect(labels(ru)[name], `ru.${name}`).toBeTypeOf('string')
    expect(labels(en)[name], `en.${name}`).toBeTypeOf('string')
  })

  it('the admin overlay list matches the kit list exactly', () => {
    expect([...LANDING_BACKGROUND_OVERLAYS].sort()).toEqual([...KIT_OVERLAYS].sort())
  })

  it.each(LANDING_BACKGROUND_OVERLAYS.filter((name) => name !== 'none'))(
    'the stylesheet implements the "%s" overlay',
    (name) => {
      expect(landingCss).toContain(`.ls-ov--${name}`)
    },
  )

  it('paints the overlay above the base effect but below the content', () => {
    // Same stacking level as `.ls-bg` (both negative), so DOM order decides —
    // and neither can cover a section, which would dim the copy.
    expect(landingCss).toMatch(/\.ls-ov\s*\{[^}]*z-index:\s*-1/)
    expect(landingCss).toMatch(/\.ls-bg\s*\{[^}]*z-index:\s*-1/)
  })

  it('gates the only animated overlay behind both motion controls', () => {
    // `scanline` is the one overlay that moves; an operator turning off
    // background motion, or a reader asking for reduced motion, must stop it.
    const reducedMotionBlock = atRuleBody(landingCss, '@media (prefers-reduced-motion: reduce)')
    expect(reducedMotionBlock).toContain('.ls-ov--scanline::before')
    expect(landingCss).toContain(".ls-ov[data-animate='off'].ls-ov--scanline::before")
  })

  it('stops the hover and press micro-interactions under reduced motion', () => {
    // Movement is movement whether it comes from a scroll reveal or from a
    // pointer pass over a pricing grid. Non-moving feedback (border, shadow)
    // may stay; `transform` and the shine sweep may not.
    const reducedMotionBlock = atRuleBody(landingCss, '@media (prefers-reduced-motion: reduce)')
    expect(reducedMotionBlock).toContain('.ls-cta:active')
    expect(reducedMotionBlock).toMatch(/\[data-card-hover\][^{]*:hover/)
    expect(reducedMotionBlock).toMatch(/\[data-cta='shine'\][^{]*::after\s*\{[^}]*animation:\s*none/)
  })

  it('acknowledges a press on touch, not only under a fine pointer', () => {
    // Touch is where press feedback matters most — there is no hover state to
    // precede it. Living inside the pointer query silently excluded it.
    const hoverBlock = atRuleBody(landingCss, '@media (hover: hover) and (pointer: fine)')
    expect(hoverBlock).not.toContain('.ls-cta:active')
    expect(landingCss).toContain('.ls-cta:active')
  })

  it.each(LANDING_CARD_HOVERS.filter((name) => name !== 'none'))(
    'the stylesheet implements the "%s" card hover',
    (name) => {
      expect(landingCss).toContain(`[data-card-hover='${name}']`)
    },
  )

  it.each(LANDING_CTA_STYLES.filter((name) => name !== 'none'))(
    'the stylesheet implements the "%s" CTA hover',
    (name) => {
      expect(landingCss).toContain(`[data-cta='${name}']`)
    },
  )

  it('confines every hover effect to pointer devices', () => {
    // A `:hover` rule latches after a tap on touch and stays applied, so a
    // "lift" leaves the card stuck in the air until something else is touched.
    const hoverBlock = atRuleBody(landingCss, '@media (hover: hover) and (pointer: fine)')
    for (const name of LANDING_CARD_HOVERS.filter((n) => n !== 'none')) {
      expect(hoverBlock, name).toContain(`[data-card-hover='${name}']`)
    }
    for (const name of LANDING_CTA_STYLES.filter((n) => n !== 'none')) {
      expect(hoverBlock, name).toContain(`[data-cta='${name}']`)
    }
  })

  it('gives CTA buttons the shared class the hover styles hook onto', () => {
    // The rules target `.ls-cta`; a section that forgets it silently opts out.
    expect(landingCss).toContain('.ls-cta')
  })

  it('animates the FAQ only where the browser supports it', () => {
    // `<details>` is kept for its native keyboard/screen-reader behaviour, so
    // the animation must be additive and never a precondition for opening.
    expect(landingCss).toContain('@supports selector(::details-content)')
  })

  it('keeps the first section out of the opacity fade (LCP guard)', () => {
    // Chrome ignores `opacity: 0` elements as LCP candidates, so an animated
    // hero would drop the page's largest text out of the measurement.
    expect(landingCss).toContain('.ls-reveal--first')
  })

  it('does not pin will-change on settled sections', () => {
    // `will-change` on `.ls-reveal` itself would hold a GPU layer per section
    // for the life of the page, for an animation that runs once.
    expect(landingCss).toMatch(/\.ls-reveal:not\(\.is-visible\)\s*\{[^}]*will-change/)
    expect(landingCss).not.toMatch(/\.ls-reveal\s*\{[^}]*will-change/)
  })

  it('drives the gradient background by transform, not background-position', () => {
    // Animating background-position repaints a full-screen gradient every frame.
    expect(landingCss).toMatch(/@keyframes ls-gradient\s*\{[^}]*transform/)
    expect(landingCss).not.toMatch(/@keyframes ls-gradient\s*\{[^}]*background-position/)
  })

  it('keeps reveal durations inside the perceptual budget', () => {
    // Past ~500ms a reveal reads as lag rather than motion.
    const durations = [...landingCss.matchAll(/\.ls-reveal\s*\{[^}]*?transition:([^;]+);/gs)]
      .flatMap((match) => [...match[1].matchAll(/([\d.]+)s/g)])
      .map((match) => Number.parseFloat(match[1]))
    expect(durations.length).toBeGreaterThan(0)
    for (const duration of durations) expect(duration).toBeLessThanOrEqual(0.5)
  })
})
