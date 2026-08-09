/**
 * index.css contract — the mobile/GPU rules that have no runtime surface.
 *
 * These four rules are CSS-only fixes for iOS defects that never show up in
 * a jsdom render, so this file asserts on the stylesheet source. It is a
 * source-text test on purpose: the alternative is no guard at all, and each
 * of these was a real, reported defect.
 *
 *   1. `@media (pointer: coarse)` form-control font size — Mobile Safari
 *      zooms the whole page when a focused control renders text below 16px
 *      and never zooms back out. The auth card's inputs are `text-sm`.
 *   2. `#glass-background` sized in LARGE viewport units — `100dvh`/`100vh`
 *      change while the iOS address bar collapses mid-scroll, and every
 *      change makes the WebGL backgrounds reallocate their drawing buffer
 *      (renderer.setSize → canvas.width write) during the gesture.
 *   3. `.aurora-blob` must stay `filter`-free and its keyframes
 *      translate-only — animating `scale` on a blurred layer re-rasterizes a
 *      viewport-sized Gaussian every frame.
 *   4. `.aurora-blob` must be listed in BOTH effect gates. The animation
 *      lives on the blobs, not on the `.aurora-bg` wrapper, so gating only
 *      the wrapper silently leaves them animating for operators who turned
 *      effects off or asked the OS for reduced motion.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'index.css'), 'utf8')

/** Returns the body of the first block whose header matches `header`. */
function block(header: string | RegExp): string {
  const source = typeof header === 'string' ? header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : header.source
  const open = new RegExp(`${source}[^{]*\\{`).exec(css)
  if (!open) throw new Error(`no block matching ${String(header)}`)
  let depth = 0
  const start = open.index + open[0].length
  for (let i = start - 1; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(start, i)
    }
  }
  throw new Error(`unterminated block matching ${String(header)}`)
}

/** All `.aurora-blob…` rule bodies (the modifier rules carry the gradients). */
function auroraBlobRules(): string[] {
  const out: string[] = []
  const re = /^\.aurora-blob[^{]*\{([^}]*)\}/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(css)) !== null) out.push(match[1])
  return out
}

/**
 * px value of a single CSS length term — but ONLY for units that are
 * absolute here.
 *
 * `px` is absolute. `rem` and `em` are not, and neither can be trusted as a
 * floor in this stylesheet:
 *   • `rem` follows the root, and `:root[data-font-size="small"]` in this
 *     very file sets `font-size: 14px`. An operator on that appearance
 *     setting turns a `1rem` "16px floor" into 14px and gets Safari's
 *     zoom-on-focus back.
 *   • `em` in a `font-size` declaration resolves against the PARENT, never
 *     the element, so it can be anything at all.
 * Both return null so a floor expressed in them counts as 0 and fails.
 */
function lengthPx(term: string): number | null {
  const m = /^(\d*\.?\d+)px$/.exec(term.trim())
  return m ? Number(m[1]) : null
}

/**
 * The `font-size` declaration that applies to form controls, found by its
 * SELECTOR rather than by position.
 *
 * Reading "the first `font-size:` inside the coarse-pointer block" is what
 * this used to do, and it made the assertion unfalsifiable in the way that
 * matters: any earlier ≥16px rule in the same block satisfied it, so setting
 * the actual `input, select, textarea` rule to `0.875rem` — a live iOS
 * zoom-on-focus bug — passed. The rule is located by the selector it belongs
 * to, so it is the real declaration or nothing.
 */
function formControlFontSize(mediaBlock: string): { selector: string; value: string } {
  const re = /([^{}]*?)\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(mediaBlock)) !== null) {
    const selector = match[1].trim()
    if (!/(^|[,\s>])(?:[^,]*\s)?input\b/.test(selector)) continue
    const decl = /font-size:\s*([^;]+);/.exec(match[2])
    if (decl) return { selector, value: decl[1].replace(/!important/, '').trim() }
  }
  throw new Error('no font-size rule targeting `input` inside the coarse-pointer block')
}

describe('touch-device form control sizing', () => {
  const coarse = block(/@media\s*\(pointer:\s*coarse\)/)
  const rule = formControlFontSize(coarse)

  it('covers input, select and textarea — every auth field, TOTP included', () => {
    // The auth card renders plain <input> elements (ui/input.tsx), so an
    // element-level rule covers username, password, confirm AND the TOTP
    // code field without enumerating them.
    for (const selector of ['input', 'select', 'textarea']) {
      expect(coarse).toMatch(new RegExp(`(^|[,{\\s])\\[data-auth-surface\\]\\s+${selector}\\s*[,{]`, 'm'))
    }
  })

  it('guarantees an ABSOLUTE floor of at least 16px so Safari never zooms on focus', () => {
    // Absolute is load-bearing, not pedantry: this stylesheet lets the
    // operator move the root font size to 14px (`data-font-size="small"`), so
    // a floor written in `rem` is only 16px for operators who left the
    // appearance setting alone. `lengthPx` returns null for rem/em, which
    // makes such a floor score 0 and fail here.
    const terms = rule.value.startsWith('max(')
      ? rule.value.slice(4, rule.value.lastIndexOf(')')).split(',')
      : [rule.value]
    const floor = Math.max(...terms.map((t) => lengthPx(t) ?? 0))
    expect(floor).toBeGreaterThanOrEqual(16)
  })

  it('proves the root font size really is operator-movable below 16px', () => {
    // The premise of the test above. If this ever stops being true the rem
    // objection goes away — but while it holds, a rem floor is a live bug.
    expect(css).toMatch(/:root\[data-font-size="small"\]\s*\{[^}]*font-size:\s*14px/)
  })

  it('applies the floor ONLY on the auth surfaces, never panel-wide', () => {
    // `pointer: coarse` matches iPads and Android tablets, not just phones,
    // and this declaration carries `!important`. Applied to a bare
    // `input, select, textarea` it outranks `text-xs` on ~61 dense controls
    // across 18 files: an `h-7` box with `py-2` leaves 10px of content for a
    // ~19px line box, and the text clips. Every selector here must be
    // scoped.
    expect(rule.selector).toMatch(/\[data-auth-surface\]/)
    for (const part of rule.selector.split(',')) {
      expect(part.trim()).toMatch(/^\[data-auth-surface\]\s+\w+$/)
    }
  })

  it('is anchored to a marker the auth shells really set', () => {
    // A scoped rule whose scope nothing carries is a rule that does nothing.
    const signIn = readFileSync(join(__dirname, 'features', 'auth', 'sign-in-page.tsx'), 'utf8')
    const forced = readFileSync(
      join(__dirname, 'features', 'auth', 'force-password-change-page.tsx'),
      'utf8',
    )
    expect(signIn).toMatch(/data-auth-surface/)
    expect(forced).toMatch(/data-auth-surface/)
  })
})

describe('glass background host sizing', () => {
  it('is pinned to the LARGE viewport, never the dynamic one', () => {
    const large = block(/#glass-background/) // the vh fallback rule
    expect(large).toMatch(/height:\s*100vh/)
    // …upgraded to lvh where supported.
    expect(css).toMatch(/@supports\s*\(height:\s*100lvh\)/)
    expect(css).toMatch(/#glass-background\s*\{[^}]*height:\s*100lvh/)
  })

  it('never sizes the host in units that move with the address bar', () => {
    const hostRules = [...css.matchAll(/#glass-background[^{]*\{([^}]*)\}/g)].map((m) => m[1])
    expect(hostRules.length).toBeGreaterThan(0)
    for (const rule of hostRules) {
      expect(rule).not.toMatch(/\d(?:dvh|dvw|svh|svw)\b/)
    }
  })
})

describe('aurora blobs', () => {
  it('paints its softness with gradients, not a per-frame filter', () => {
    const rules = auroraBlobRules()
    expect(rules.length).toBeGreaterThanOrEqual(3)
    expect(rules.filter((r) => r.includes('radial-gradient'))).toHaveLength(3)
    for (const rule of rules) {
      expect(rule).not.toMatch(/filter\s*:/)
      expect(rule).not.toMatch(/blur\(/)
    }
  })

  it('animates transform: translate only — no scale on a soft layer', () => {
    for (const n of [1, 2, 3]) {
      const frames = block(new RegExp(`@keyframes\\s+aurora-${n}`))
      expect(frames).toMatch(/translate\(/)
      expect(frames).not.toMatch(/scale\(/)
    }
  })

  it('is listed in the effects-off gate, not just the .aurora-bg wrapper', () => {
    expect(css).toMatch(/:root\[data-effects="off"\]\s+\.aurora-blob\s*[,{]/)
  })

  it('is listed in the prefers-reduced-motion gate', () => {
    const reduced = block(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(reduced).toMatch(/(^|[,{\s])\.aurora-blob\s*[,{]/m)
  })

  it('promotes to a compositor layer only while it is actually animating', () => {
    // `.aurora-blob` declares `will-change: transform`, which pins three
    // viewport-sized elements to their own compositor layers. Turning the
    // animation off does NOT release that — only the declaration ceasing to
    // apply does. So both gates must reset it, or a phone with reduced motion
    // on carries three full-screen layers for the life of the page to animate
    // nothing at all.
    expect(auroraBlobRules().some((r) => /will-change:\s*transform/.test(r))).toBe(true)

    const gates: Array<[string, string]> = [
      ['prefers-reduced-motion', block(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)],
      // The effects-off gate is one flat selector list, so slice from the
      // `.aurora-blob` entry to the end of its declaration block.
      [
        'data-effects="off"',
        /:root\[data-effects="off"\]\s+\.aurora-blob[\s\S]*?\{([\s\S]*?)\}/.exec(css)?.[1] ?? '',
      ],
    ]
    for (const [name, body] of gates) {
      expect(body, `${name} gate must release will-change`).toMatch(
        /will-change:\s*auto\s*!important/,
      )
      // Releasing without !important would lose to `.aurora-blob`'s own
      // declaration on specificity in the media-query case.
      expect(body, `${name} gate must also stop the animation`).toMatch(
        /animation:\s*none\s*!important/,
      )
    }
  })
})
