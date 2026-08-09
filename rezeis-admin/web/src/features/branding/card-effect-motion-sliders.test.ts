/**
 * The zero end of a speed slider.
 *
 * The catalogue's own header states the rule: a slider must not reach zero
 * where zero stops the picture, because every renderer here keeps asking for
 * frames regardless — an operator who drags "Speed" to the end gets a still
 * image at full frame cost and no way to tell that from a broken effect.
 *
 * The rule was true and the sweep was not. Twelve minimums were raised and the
 * header said so, while four speed-named sliders still reached zero with a
 * non-zero default and had never been classified either way — and a comment
 * that claims a class was swept is worse than no comment, because it stops the
 * next person looking. Each of those is now in `ZERO_MINIMUM_MOTION_SLIDERS`
 * with the component line that justifies it.
 *
 * This file is the part that cannot be argued from memory: a `speed`/`spin`
 * slider either does not reach zero, or it is listed. What it CANNOT check is
 * whether a listed reason is true — that claim lives in the component, and the
 * components have been rewritten at least once under a review that was arguing
 * about them. A wrong reason passes here.
 */

import { describe, expect, it } from 'vitest'

import {
  CARD_EFFECT_CATALOG,
  ZERO_MINIMUM_MOTION_SLIDERS,
} from './card-effect-catalog'

/**
 * Narrow on purpose. `label` is not consulted: it is operator-facing prose that
 * moves with translation and marketing ("Drift", "Wave Spread", "Core Glow"),
 * whereas the prop name is the component's own contract. Amplitude-style props
 * (`twinkleIntensity`, `swirl`, `flowerIntensity`) reach zero legitimately and
 * are not in scope — zero amplitude is a picture, not a stopped one.
 */
const RATE_PROP = /speed|spin/i

interface CatalogSlider {
  readonly id: string
  readonly min: number | undefined
  readonly default: unknown
}

const sliders: readonly CatalogSlider[] = Object.entries(CARD_EFFECT_CATALOG).flatMap(
  ([effect, entry]) =>
    entry.controls
      .filter((control) => control.type === 'slider')
      .map((control) => ({
        id: `${effect}.${control.prop}`,
        min: control.min,
        default: control.default,
      })),
)

const rateSliders = sliders.filter((slider) => RATE_PROP.test(slider.id.split('.')[1]))

describe('the rate sliders the catalogue offers', () => {
  it('finds them, so a rename cannot empty this file silently', () => {
    expect(rateSliders.length).toBeGreaterThan(40)
    expect(sliders.length).toBeGreaterThan(200)
  })

  it('lets none of them reach zero unexamined', () => {
    const unexamined = rateSliders
      .filter((slider) => slider.min === 0)
      .map((slider) => slider.id)
      .filter((id) => !(id in ZERO_MINIMUM_MOTION_SLIDERS))

    expect(unexamined).toEqual([])
  })

  it('gives every exemption a reason worth reading', () => {
    const unreasoned = Object.entries(ZERO_MINIMUM_MOTION_SLIDERS)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([id]) => id)

    expect(unreasoned).toEqual([])
  })
})

describe('the exemption list itself', () => {
  it('names only sliders that exist', () => {
    const known = new Set(sliders.map((slider) => slider.id))
    const missing = Object.keys(ZERO_MINIMUM_MOTION_SLIDERS).filter((id) => !known.has(id))

    expect(missing).toEqual([])
  })

  it('carries no entry for a slider that no longer reaches zero', () => {
    // An exemption that outlives the minimum it excused is the same failure in
    // the other direction: prose that describes a catalogue that has moved on.
    const byId = new Map(sliders.map((slider) => [slider.id, slider]))
    const stale = Object.keys(ZERO_MINIMUM_MOTION_SLIDERS).filter(
      (id) => byId.get(id)?.min !== 0,
    )

    expect(stale).toEqual([])
  })

  it('still covers the four the sweep missed, and the two that were always fine', () => {
    // Spelled out rather than derived, so that deleting one of these from the
    // catalogue's list and from its `min: 0` in the same edit — which the two
    // tests above would both accept — still has to be a deliberate act.
    expect(Object.keys(ZERO_MINIMUM_MOTION_SLIDERS).sort()).toEqual([
      'blackhole.pullSpeed',
      'cosmicOrb.spin',
      'pulseLines.speed',
      'risingLines.riseSpeed',
      'starBurst.twinkleSpeed',
      'stardust.particleSpeed',
    ])
  })
})

describe('the older half of the rule', () => {
  it('keeps a slider whose zero end means "draw nothing" off zero', () => {
    const opacityMax = sliders.find((slider) => slider.id === 'snowfall.opacityMax')

    expect(opacityMax?.min).toBeGreaterThan(0)
  })
})
