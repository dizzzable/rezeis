/**
 * BrandMarkTile — a true-to-size rendering of the cabinet's entry tile, the
 * first thing a subscriber sees on the sign-in screen.
 *
 * It exists because the branding page previewed the uploaded mark at 24 px in
 * a swatch and at 28 px in the phone header, while the surface an operator
 * actually judges it on draws it at 46 px inside an 80 px plate. An operator
 * uploading a 1024×1024 export therefore had nowhere in the panel to see
 * whether it landed too small — and reported exactly that.
 *
 * Sizes come from `resolveBrandLogoGeometry`, which is mirrored in the cabinet;
 * see the note at the top of `brand-logo-geometry.ts` before changing either.
 */
import type { CSSProperties, JSX } from 'react'

import {
  describeBrandLogoSize,
  resolveBrandLogoGeometry,
  type BrandLogoTileVariant,
} from './brand-logo-geometry'
import { ReiwaMark } from './reiwa-mark'
import type {
  BrandingBrandLogoDraft,
  BrandingSurfaceThemeDraft,
} from './branding-form-schema'

export interface BrandMarkTileProps {
  readonly logo: BrandingBrandLogoDraft
  /** `md` is the sign-in / change-password tile; `lg` the splash tile. */
  readonly variant?: BrandLogoTileVariant
  /** Uploaded mark. `null` falls back to the built-in glyph. */
  readonly logoUrl?: string | null
  readonly brandName: string
  /** Resolved cabinet surface, so the plate matches the chosen theme. */
  readonly surface: string
  readonly borderSoft: string
  /** Brand colour — tints the fallback glyph and the glow. */
  readonly primary: string
  /**
   * The cabinet's `--radius` (`cornerRadii.itemPx`). The tile's corners follow
   * it until the operator sets an explicit radius, so the preview has to know
   * it or it draws corners the cabinet will not.
   */
  readonly itemRadiusPx: number
  readonly className?: string
}

export function BrandMarkTile({
  logo,
  variant = 'md',
  logoUrl,
  brandName,
  surface,
  borderSoft,
  primary,
  itemRadiusPx,
  className,
}: BrandMarkTileProps): JSX.Element {
  const geometry = resolveBrandLogoGeometry({ variant, logo, itemRadiusPx })

  const tileStyle: CSSProperties = {
    width: `${geometry.tilePx}px`,
    height: `${geometry.tilePx}px`,
    borderRadius: `${geometry.tileRadiusPx}px`,
    // `outline` frames paint the hairline only; `none` paints neither. The
    // element keeps its box in every case so the surrounding layout does not
    // shift when the operator turns the plate off.
    backgroundColor: logo.frame === 'glass' || logo.frame === 'solid' ? surface : 'transparent',
    // Hairline and glow are both box-shadow layers, matching the cabinet's own
    // tile exactly. A `border` would be the other reasonable choice, and it is
    // the wrong one here: the two sides would then disagree by a border box on
    // any element that is not `box-sizing: border-box`, and this preview exists
    // to be trusted down to the pixel.
    boxShadow: [
      logo.frame === 'none' ? null : `inset 0 0 0 1px ${borderSoft}`,
      // Radius scales with the slider; ALPHA DOES NOT. The cabinet paints
      // `var(--color-brand-glow)`, a constant 40 % mix of the brand colour that
      // nothing rescales, so a preview that faded the alpha too showed less
      // than half the halo at glow 50 % and none at all near zero — the panel
      // promising a rendering the cabinet does not produce, which is the whole
      // failure this setting was added to end.
      logo.glow > 0
        ? `0 0 ${Math.round(60 * logo.glow)}px ${withAlpha(primary, BRAND_GLOW_ALPHA)}`
        : null,
    ]
      .filter((layer): layer is string => layer !== null)
      .join(', '),
    backdropFilter: logo.frame === 'glass' ? 'blur(24px)' : undefined,
  }

  const markStyle: CSSProperties = {
    width: `${geometry.markPx}px`,
    height: `${geometry.markPx}px`,
    borderRadius: `${geometry.markRadiusPx}px`,
  }

  return (
    <div
      data-brand-mark-tile={variant}
      data-brand-mark-frame={logo.frame}
      className={`flex shrink-0 items-center justify-center ${className ?? ''}`.trim()}
      style={tileStyle}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={brandName}
          data-brand-mark-image
          className="object-contain"
          style={markStyle}
        />
      ) : (
        <ReiwaMark style={{ ...markStyle, color: primary }} />
      )}
    </div>
  )
}

export interface BrandMarkPreviewPanelProps {
  readonly logo: BrandingBrandLogoDraft
  readonly logoUrl: string | null
  readonly brandName: string
  readonly surfaceTheme: BrandingSurfaceThemeDraft
  readonly primary: string
  readonly bgPrimary: string
  readonly itemRadiusPx: number
}

/**
 * The two surfaces the mark appears on, side by side, both at true size: the
 * entry tile a subscriber meets before signing in, and the 32 px header mark
 * they see afterwards on every screen.
 *
 * The header mark is deliberately NOT governed by `brandLogo` — it is a 32 px
 * slot next to a text label, and letting the entry-tile knobs grow it would
 * push the brand name out of a row that has no room. Showing it here is how an
 * operator learns that the same file has to survive both sizes.
 */
export function BrandMarkPreviewPanel({
  logo,
  logoUrl,
  brandName,
  surfaceTheme,
  primary,
  bgPrimary,
  itemRadiusPx,
}: BrandMarkPreviewPanelProps): JSX.Element {
  const surface = withAlpha(surfaceTheme.surface, surfaceTheme.surfaceOpacity)
  const borderSoft = withAlpha(surfaceTheme.borderSoft, surfaceTheme.borderSoftOpacity)
  const { tilePx, markPx } = describeBrandLogoSize({ variant: 'md', logo, itemRadiusPx })

  return (
    <div
      data-brand-mark-preview
      className="flex shrink-0 flex-col items-center gap-2 rounded-lg border px-5 py-4"
      style={{ backgroundColor: bgPrimary }}
    >
      <div className="flex items-end gap-5">
        <div className="flex flex-col items-center gap-1.5">
          <BrandMarkTile
            logo={logo}
            variant="md"
            logoUrl={logoUrl}
            brandName={brandName}
            surface={surface}
            borderSoft={borderSoft}
            primary={primary}
            itemRadiusPx={itemRadiusPx}
          />
          <span
            className="font-mono text-[10px]"
            style={{ color: surfaceTheme.mutedForeground }}
            data-brand-mark-measure
          >
            {markPx}×{markPx} / {tilePx}
          </span>
        </div>
        <div className="flex flex-col items-center gap-1.5 pb-[18px]">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={brandName}
              className="h-8 w-8 rounded-lg object-contain"
              data-brand-mark-header
            />
          ) : (
            <ReiwaMark style={{ width: '32px', height: '32px', color: primary }} />
          )}
          <span className="font-mono text-[10px]" style={{ color: surfaceTheme.mutedForeground }}>
            32×32
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * `--color-brand-glow` in the cabinet is `color-mix(in oklab, var(--brand-primary)
 * 40%, transparent)` and nothing rescales it. The preview mixes the same 40 %
 * so the halo it shows is the halo that ships.
 */
const BRAND_GLOW_ALPHA = 0.4

/** `#rrggbb` → `rgba(...)`, tolerating short form; returns the input unchanged if unparseable. */
function withAlpha(hex: string, alpha: number): string {
  const raw = hex.trim().replace(/^#/, '')
  const normalized =
    raw.length === 3
      ? raw
          .split('')
          .map((character) => character + character)
          .join('')
      : raw.slice(0, 6)
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return hex
  const [r, g, b] = [0, 2, 4].map((offset) =>
    Number.parseInt(normalized.slice(offset, offset + 2), 16),
  )
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`
}
