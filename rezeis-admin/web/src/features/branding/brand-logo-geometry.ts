/**
 * Brand-mark tile geometry — the arithmetic that turns the operator's
 * `brandLogo` knobs into pixels.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MIRRORED IN THE CABINET: `reiwa/web/src/components/ui/brand-logo-geometry.ts`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Two repositories, two copies, and no test can catch drift between them —
 * a suite in either repo passes happily while the other side computes
 * something else. So the formula is kept deliberately trivial, each side
 * carries the same fixed table in its own test, and each side names the
 * other file. That is the same arrangement the webhook relay timeouts use,
 * and it is a mitigation, not a guarantee: if you change the arithmetic
 * here, change it there in the same change-set, or the panel's preview will
 * promise a rendering the cabinet does not produce — which is the exact
 * complaint that created this setting.
 *
 * The base sizes come from the cabinet's `EntryBrandTile`: `md` is every form
 * screen (sign-in, change password), `lg` the splash screens (`/`, `/tma`).
 */

/** Cabinet tile sizes at `size: 1`, in CSS pixels. */
export const BRAND_LOGO_TILE_BASE_PX = { md: 80, lg: 96 } as const

export type BrandLogoTileVariant = keyof typeof BRAND_LOGO_TILE_BASE_PX

/**
 * What the tile's old Tailwind classes actually resolved to.
 *
 * `rounded-3xl` is `calc(var(--radius) * 2.2)` and `rounded-xl` is
 * `calc(var(--radius) * 1.4)`, and `--radius` is the operator's item radius.
 * The `md` tile therefore FOLLOWED the theme, which is why an unset `radius`
 * follows it still: a fixed percentage default would have rounded off a theme
 * configured with sharp corners and flattened one configured round. The `lg`
 * tile was the literal `rounded-[28px]` and followed nothing.
 */
const INHERITED_TILE_RADIUS_FACTOR = 2.2
const INHERITED_MARK_RADIUS_FACTOR = 1.4
const INHERITED_LG_TILE_RADIUS_PX = 28

export interface BrandLogoGeometryInput {
  readonly variant: BrandLogoTileVariant
  readonly logo: {
    /** Whole-tile multiplier, 1–1.75. */
    readonly size: number
    /** Fraction of the tile the mark fills, 0.4–1. */
    readonly fill: number
    /** Tile rounding as a percentage of its width, or `null` to follow the theme. */
    readonly radius: number | null
    readonly frame: string
  }
  /** The cabinet's resolved `--radius` (`cornerRadii.itemPx`), in px. */
  readonly itemRadiusPx: number
}

export interface BrandLogoGeometry {
  /** Outer box, and the space the tile occupies in layout. */
  readonly tilePx: number
  /** The mark's own box inside it. */
  readonly markPx: number
  /** Tile corner radius. */
  readonly tileRadiusPx: number
  /**
   * Corner radius of the mark. While the tile's radius is inherited this is
   * inherited too — `rounded-xl`, exactly as before. Once the operator sets a
   * radius the mark's curve is made concentric with the tile's rather than
   * parallel to it (`r_inner = r_outer − inset`): a mark clipped with the
   * tile's own radius reads as a second, tighter corner inside the first.
   */
  readonly markRadiusPx: number
}

/**
 * Rounded to a hundredth of a pixel. `96 * 0.58` is 55.67999999999999 in binary
 * floating point, and emitting that verbatim puts an artefact of the evaluation
 * order into the stylesheet and into every test that pins it. A hundredth of a
 * CSS pixel is below the resolution of any display, so nothing is lost — but
 * BOTH repositories must round, or this preview and the cabinet disagree in the
 * last digits of every declaration.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function resolveBrandLogoGeometry(input: BrandLogoGeometryInput): BrandLogoGeometry {
  const { variant, logo, itemRadiusPx } = input
  const tilePx = BRAND_LOGO_TILE_BASE_PX[variant] * logo.size
  const markPx = tilePx * logo.fill

  if (logo.radius === null) {
    return {
      tilePx: round(tilePx),
      markPx: round(markPx),
      tileRadiusPx: round(
        variant === 'lg'
          ? INHERITED_LG_TILE_RADIUS_PX
          : itemRadiusPx * INHERITED_TILE_RADIUS_FACTOR,
      ),
      markRadiusPx: round(itemRadiusPx * INHERITED_MARK_RADIUS_FACTOR),
    }
  }

  const tileRadiusPx = (tilePx * logo.radius) / 100
  const inset = logo.frame === 'none' ? 0 : (tilePx - markPx) / 2
  return {
    tilePx: round(tilePx),
    markPx: round(markPx),
    tileRadiusPx: round(tileRadiusPx),
    markRadiusPx: round(Math.max(0, tileRadiusPx - inset)),
  }
}

/**
 * The px the operator should be told about: what the mark actually measures on
 * the sign-in screen, rounded for display.
 */
export function describeBrandLogoSize(input: BrandLogoGeometryInput): {
  readonly tilePx: number
  readonly markPx: number
} {
  const geometry = resolveBrandLogoGeometry({ ...input, variant: 'md' })
  return {
    tilePx: Math.round(geometry.tilePx),
    markPx: Math.round(geometry.markPx),
  }
}
