/**
 * The preview and the cabinet must agree in the state the operator uses to
 * check that they turned the background OFF.
 *
 * They did not. reiwa's `StealthLayout` renders `<NetworkBg>` — three brand
 * glows, a dot grid, four diagonals — for `appBackground.kind === 'none'`, and
 * always has. This panel called that mode "None", described it as "the plain
 * background colour", and previewed it as an empty frame with one decorative
 * blurred disc that the cabinet draws in no mode at all. So the two disagreed
 * exactly where a preview has to be right, and the disagreement was invisible
 * to anyone who had not opened both repositories.
 *
 * The owner's decision was that the code is the truth: `none` keeps drawing
 * what it always drew (renaming the stored value would have restyled every
 * installation that never touched the setting), the wording is what changes,
 * and a new `plain` kind carries the meaning the wording used to promise.
 *
 * This file holds the three halves of that:
 *
 *   1. `none` previews the built-in pattern — the preview finally shows it;
 *   2. `plain` previews nothing — no pattern, no app-background layer, no
 *      leftover ambient glow, so the frame is the flat `bgPrimary` colour;
 *   3. the vendored geometry still matches reiwa's `<NetworkBg>`. That last
 *      one needs the sibling checkout and skips without it, exactly as
 *      `app-background-contrast.parity.test.tsx` does.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '@/test/test-utils'

import { NETWORK_BG_GEOMETRY } from './app-background-builtin-geometry'
import {
  DEFAULT_APP_BACKGROUND_DRAFT,
  type BrandingAppBackgroundDraft,
} from './branding-form-schema'

vi.mock('@/features/plans/plans-api', () => ({
  usePlans: () => ({ data: [] }),
}))

import { BrandingPreview } from './branding-preview'

const REIWA_NETWORK_BG = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'reiwa',
  'web',
  'src',
  'components',
  'ui',
  'network-bg.tsx',
)

const BUILTIN_SELECTOR = '[data-preview-app-background-builtin="network"]'
const PRIMARY = '#22c55e'
/** How jsdom's CSSOM serialises `PRIMARY` once it lands in a style attribute. */
const PRIMARY_SERIALISED = 'rgb(34, 197, 94)'

function appBackground(
  overrides: Partial<BrandingAppBackgroundDraft>,
): BrandingAppBackgroundDraft {
  return { ...DEFAULT_APP_BACKGROUND_DRAFT, ...overrides }
}

function renderPreview(
  background: BrandingAppBackgroundDraft | undefined,
): { readonly container: HTMLElement; readonly unmount: () => void } {
  return renderWithProviders(
    <BrandingPreview
      values={{
        primary: PRIMARY,
        bgPrimary: '#0a0a0a',
        appBackground: background,
        // This spec is about the site-wide background layer; an animated card
        // effect would drag a WebGL renderer into jsdom for nothing.
        cardEffect: 'NONE',
      }}
    />,
  )
}

describe('preview ↔ cabinet parity for the colourless background modes', () => {
  it('draws the built-in pattern for `none`, the mode the cabinet patterns', () => {
    const { container, unmount } = renderPreview(appBackground({ kind: 'none' }))

    const builtin = container.querySelector(BUILTIN_SELECTOR)
    expect(builtin).not.toBeNull()
    // All three glows and the SVG network, i.e. the whole picture rather than
    // a token stand-in for it.
    expect(container.querySelectorAll('[data-preview-builtin-glow]').length).toBe(3)
    expect(builtin?.querySelector('pattern')).not.toBeNull()
    expect(builtin?.querySelectorAll('line').length).toBe(
      NETWORK_BG_GEOMETRY.diagonals.length,
    )
    unmount()
  })

  it('draws the built-in pattern when no appBackground is configured at all', () => {
    // Every installation older than the field. The cabinet has been drawing
    // NetworkBg for them since the day they were created.
    const { container, unmount } = renderPreview(undefined)

    expect(container.querySelector(BUILTIN_SELECTOR)).not.toBeNull()
    unmount()
  })

  it('tints the built-in pattern with the draft brand colour, not a saved one', () => {
    // The preview shows unsaved edits, so the pattern cannot read
    // `--brand-primary` off the panel document the way the cabinet reads it off
    // its own.
    const { container, unmount } = renderPreview(appBackground({ kind: 'none' }))

    const corner = container.querySelector<HTMLElement>(
      '[data-preview-builtin-glow="corner"]',
    )
    const style = corner?.getAttribute('style') ?? ''
    expect(style).toContain(PRIMARY_SERIALISED)
    // The cabinet reads its own `--brand-primary`; reaching for that token here
    // would paint the PANEL's accent and quietly ignore the operator's edit.
    expect(style).not.toContain('--brand-primary')
    unmount()
  })

  it('draws absolutely nothing for `plain`', () => {
    // The promise of the new mode, and the reason the preview-only ambient
    // glow had to go: it would have shown through here.
    //
    // The absence of the app-background CONTAINER is the load-bearing
    // assertion, not just the absence of its children. `plain` carries a
    // gradient and often a leftover effect id — the panel changes only `kind`
    // when the operator switches modes — so a container that mounts and then
    // happens to find nothing to draw is one added branch away from painting an
    // abandoned background over a mode that promises a flat colour.
    const { container, unmount } = renderPreview(
      appBackground({
        kind: 'plain',
        effect: 'aurora',
        gradient: 'linear-gradient(135deg, #101820, #263747)',
      }),
    )

    expect(container.querySelector('[data-preview-app-background]')).toBeNull()
    expect(container.querySelector(BUILTIN_SELECTOR)).toBeNull()
    expect(container.querySelector('[data-preview-builtin-glow]')).toBeNull()
    expect(
      container.querySelector('[data-preview-app-background-texture]'),
    ).toBeNull()
    expect(
      container.querySelector('[data-preview-app-background-layer]'),
    ).toBeNull()
    expect(
      container.querySelector('[data-preview-app-readability]'),
    ).toBeNull()
    unmount()
  })

  it('still mounts the app-background layer for the modes that do draw', () => {
    // Guards the assertion above from passing because the layer stopped
    // mounting for everyone.
    for (const kind of ['gradient', 'texture', 'effect'] as const) {
      const { container, unmount } = renderPreview(appBackground({ kind }))
      expect(
        container.querySelector(`[data-preview-app-background="${kind}"]`),
      ).not.toBeNull()
      unmount()
    }
  })

  it('keeps the built-in pattern out of the configured modes', () => {
    // The cabinet swaps NetworkBg OUT for a configured background rather than
    // layering one over the other, so the preview must not stack them either.
    for (const kind of ['gradient', 'texture', 'effect'] as const) {
      const { container, unmount } = renderPreview(appBackground({ kind }))
      expect(container.querySelector(BUILTIN_SELECTOR)).toBeNull()
      unmount()
    }
  })

  it('previews `none` and `plain` as visibly different frames', () => {
    // The defect in one line: these two used to render identically in the panel
    // while rendering differently in the cabinet.
    const builtin = renderPreview(appBackground({ kind: 'none' }))
    const builtinMarkup = builtin.container.innerHTML
    builtin.unmount()

    const plain = renderPreview(appBackground({ kind: 'plain' }))
    const plainMarkup = plain.container.innerHTML
    plain.unmount()

    expect(builtinMarkup).not.toBe(plainMarkup)
  })
})

/**
 * Layer 3: the vendored numbers against reiwa's own source. Needs the sibling
 * checkout; CI for this repository has none, so it skips there rather than
 * failing, the same arrangement the contrast parity test uses.
 */
describe.skipIf(!existsSync(REIWA_NETWORK_BG))(
  'vendored NetworkBg geometry matches the cabinet source',
  () => {
    const source = existsSync(REIWA_NETWORK_BG)
      ? readFileSync(REIWA_NETWORK_BG, 'utf8')
      : ''

    it('uses the same three glow box sizes', () => {
      for (const disc of NETWORK_BG_GEOMETRY.glows) {
        expect(source).toContain(`h-[${disc.sizePx}px] w-[${disc.sizePx}px]`)
      }
    })

    it('uses the same alpha stops on each glow', () => {
      for (const disc of NETWORK_BG_GEOMETRY.glows) {
        for (const stop of disc.stops) {
          expect(source).toContain(`glow(${stop})`)
        }
      }
    })

    it('uses the same dot-grid pitch and diagonal count', () => {
      expect(source).toContain(
        `width="${NETWORK_BG_GEOMETRY.gridPitchPx}" height="${NETWORK_BG_GEOMETRY.gridPitchPx}"`,
      )
      expect(source.match(/<line\b/g)?.length).toBe(
        NETWORK_BG_GEOMETRY.diagonals.length,
      )
    })

    it('uses the same diagonal endpoints', () => {
      for (const [x1, y1, x2, y2] of NETWORK_BG_GEOMETRY.diagonals) {
        expect(source).toContain(
          `x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"`,
        )
      }
    })

    it('still mixes the brand colour at the same dot and line strengths', () => {
      expect(source).toContain('var(--brand-primary) 55%')
      expect(source).toContain('var(--brand-primary) 14%')
    })

    it('is still mounted at the intensity this preview assumes', () => {
      // `StealthLayout` mounts `<NetworkBg />` with no `intensity`, so the
      // component's own default decides the opacity the preview copies.
      expect(source).toContain(`intensity = 'medium'`)
      expect(source).toContain(`: ${NETWORK_BG_GEOMETRY.opacity}`)
      expect(source).toContain(
        `opacity * ${NETWORK_BG_GEOMETRY.networkOpacityFactor}`,
      )
    })
  },
)
