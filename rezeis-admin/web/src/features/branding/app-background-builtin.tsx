/**
 * AppBackgroundBuiltin — the panel's rendering of the cabinet's BUILT-IN
 * background, i.e. `appBackground.kind === 'none'`.
 *
 * WHY THIS FILE EXISTS. `none` never meant "no background". reiwa's
 * `StealthLayout` renders `<NetworkBg>` for it and always has: three soft
 * `--brand-primary` glows, a dot grid and four diagonals across the whole
 * shell. The panel meanwhile called the mode "None", described it as the plain
 * background colour, and previewed it as an empty frame — so the preview and
 * the cabinet disagreed exactly in the state an operator picks to confirm they
 * had switched the background OFF, which is the one state where a preview has
 * to be right. The stored value stays `none` (renaming it would have restyled
 * every existing installation); what changed is that the panel now tells the
 * truth about it, and draws it.
 *
 * WHAT IS COPIED, AND WHAT IS NOT. Every number below is reiwa's — see
 * `NETWORK_BG_GEOMETRY`, whose source docblock in
 * `reiwa/web/src/components/ui/network-bg.tsx` explains why the three blob
 * sizes and their stop alphas may not be changed independently (they are a
 * numerically convolved Gaussian, and `closest-side` puts alpha 0 exactly on
 * the clip radius). `app-background-builtin.test.tsx` reads that file from the
 * sibling checkout and fails if the two drift apart.
 *
 * Two differences are deliberate and are the only ones allowed:
 *
 *   1. `absolute`, not `fixed`. The cabinet's layer fills the viewport; this
 *      one fills the preview's phone frame.
 *   2. lengths are multiplied by `SCALE`. The cabinet's pixel geometry was
 *      tuned against a real mobile viewport, and the preview frame is narrower
 *      than one; replaying the raw pixels into it would show blobs half again
 *      too large for their frame and a coarser grid than any subscriber sees.
 *      Scaling by the width ratio keeps the composition — where the glows sit,
 *      how many grid dots fit across — proportional to what the cabinet draws.
 *      Percentage offsets are already proportional and are left alone.
 *
 * The brand colour arrives as a prop rather than through `--brand-primary`,
 * because the preview renders the operator's UNSAVED draft: the CSS variable on
 * the panel's own document is the panel's accent, not the value being edited.
 */

import { memo } from 'react'

import { NETWORK_BG_GEOMETRY } from './app-background-builtin-geometry'

/** Width of the preview phone frame (`w-[300px]` in `branding-preview.tsx`). */
const PREVIEW_FRAME_WIDTH_PX = 300
/** Mobile viewport width reiwa's NetworkBg pixel geometry was tuned against. */
const REFERENCE_VIEWPORT_WIDTH_PX = 390
const SCALE = PREVIEW_FRAME_WIDTH_PX / REFERENCE_VIEWPORT_WIDTH_PX

const STOP_POSITIONS = ['0%', '15%', '32%', '50%', '68%', '84%'] as const

/** Cabinet pixels → preview pixels. */
function scalePx(px: number): number {
  return Math.round(px * SCALE)
}

function scaled(px: number): string {
  return `${scalePx(px)}px`
}

/** A signed offset from a percentage anchor, e.g. `calc(33.333% - 86px)`. */
function offsetFrom(anchor: string, px: number): string {
  const value = scalePx(px)
  return value < 0
    ? `calc(${anchor} - ${Math.abs(value)}px)`
    : `calc(${anchor} + ${value}px)`
}

/** Brand glow at a given strength — reiwa's `glow()`, with an explicit colour. */
function glow(primary: string, pct: number): string {
  return `color-mix(in oklab, ${primary} ${pct}%, transparent)`
}

/** The seven-stop falloff reiwa paints into each disc. */
function discBackground(primary: string, stops: readonly number[]): string {
  const list = stops
    .map((pct, index) => `${glow(primary, pct)} ${STOP_POSITIONS[index]}`)
    .join(', ')
  return `radial-gradient(circle closest-side, ${list}, transparent 100%)`
}

interface AppBackgroundBuiltinProps {
  /** The draft brand primary colour (hex or any CSS colour). */
  primary: string
}

export const AppBackgroundBuiltin = memo(function AppBackgroundBuiltin({
  primary,
}: AppBackgroundBuiltinProps) {
  const { opacity, networkOpacityFactor, gridPitchPx, diagonals, glows } =
    NETWORK_BG_GEOMETRY
  const dot = `color-mix(in oklab, ${primary} 55%, transparent)`
  const line = `color-mix(in oklab, ${primary} 14%, transparent)`
  const pitch = scalePx(gridPitchPx)
  const [cornerGlow, sideGlow, bottomGlow] = glows

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
      data-preview-app-background-builtin="network"
    >
      <div
        className="absolute rounded-full"
        data-preview-builtin-glow="corner"
        style={{
          top: scaled(cornerGlow.top),
          left: scaled(cornerGlow.left),
          height: scaled(cornerGlow.sizePx),
          width: scaled(cornerGlow.sizePx),
          background: discBackground(primary, cornerGlow.stops),
          opacity,
        }}
      />
      <div
        className="absolute rounded-full"
        data-preview-builtin-glow="side"
        style={{
          top: offsetFrom('33.333%', sideGlow.topFromThird),
          right: scaled(sideGlow.right),
          height: scaled(sideGlow.sizePx),
          width: scaled(sideGlow.sizePx),
          background: discBackground(primary, sideGlow.stops),
          opacity,
        }}
      />
      <div
        className="absolute rounded-full"
        data-preview-builtin-glow="bottom"
        style={{
          bottom: scaled(bottomGlow.bottom),
          left: offsetFrom('25%', bottomGlow.leftFromQuarter),
          height: scaled(bottomGlow.sizePx),
          width: scaled(bottomGlow.sizePx),
          background: discBackground(primary, bottomGlow.stops),
          opacity,
        }}
      />

      <svg
        className="absolute inset-0 h-full w-full"
        style={{ opacity: opacity * networkOpacityFactor }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern
            id="preview-net-grid"
            x="0"
            y="0"
            width={pitch}
            height={pitch}
            patternUnits="userSpaceOnUse"
          >
            <circle cx={pitch / 2} cy={pitch / 2} r="1" fill={dot} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#preview-net-grid)" />
        {diagonals.map(([x1, y1, x2, y2]) => (
          <line
            key={`${x1}-${y1}-${x2}-${y2}`}
            x1={`${x1}%`}
            y1={`${y1}%`}
            x2={`${x2}%`}
            y2={`${y2}%`}
            stroke={line}
            strokeWidth="0.5"
          />
        ))}
      </svg>
    </div>
  )
})
