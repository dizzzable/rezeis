/**
 * LiquidGlassFilters — global SVG <filter> definitions for the liquid
 * refraction layer.
 *
 * Why one global node?
 * - SVG filters are referenced by id from CSS (`filter: url(#lg-prominent)`).
 * - Mounting them once at the app root means every glass surface in the
 *   tree uses the same compiled filter tree, so the browser only pays for
 *   one cached compositing pipeline.
 *
 * Why three filter ids?
 * - `#lg-soft`     — low displacement scale, used as a default if you want
 *                    a touch of refraction on a static surface.
 * - `#lg-prominent` — medium displacement plus chromatic aberration; this
 *                    is the one wired up to interactive surfaces (buttons,
 *                    popovers).
 * - `#lg-press`    — same recipe with an exaggerated scale, for the
 *                    `:active` state (squish/refraction emphasis).
 *
 * Browser support guard
 * --------------------
 * `feDisplacementMap` inside `backdrop-filter: url(#…)` only renders in
 * Chromium-based browsers as of 2026. Safari and Firefox accept the
 * syntax but render nothing while still paying the parsing cost. The
 * filters are still emitted in the DOM (other parts of the codebase rely
 * on them via direct `filter:` references), but `index.css` only attaches
 * them through `backdrop-filter` when `data-glass-refraction` is set on
 * <html>.
 *
 * AppearanceProvider sets that data-attribute based on the runtime UA
 * check below plus the user's `glassEnabled` toggle.
 */
import { useEffect, useMemo } from 'react'
import { useGlassStore } from '@/lib/theme/glass-store'

const FILTER_IDS = {
  soft: 'lg-soft',
  prominent: 'lg-prominent',
  press: 'lg-press',
} as const

/** True for Chromium-based browsers where `backdrop-filter: url(#svg)`
 *  works with `feDisplacementMap`. We mirror the runtime check used by
 *  `GlassSurface.tsx`. */
function detectChromiumBackdropFilter(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const isWebkit = /Safari/.test(ua) && !/Chrome/.test(ua)
  const isFirefox = /Firefox/.test(ua)
  return !isWebkit && !isFirefox
}

export function LiquidGlassFilters() {
  // Numeric inputs come from the store; they are global properties.
  const displacementScale = useGlassStore((s) => s.displacementScale)
  const aberrationIntensity = useGlassStore((s) => s.aberrationIntensity)
  const glassEnabled = useGlassStore((s) => s.glassEnabled)

  // Tag <html> so CSS can decide whether to attach `filter: url(...)` at
  // all. The flag stays "off" on non-Chromium browsers, on master
  // toggle off, and (later) when the user disables refraction.
  useEffect(() => {
    const root = document.documentElement
    const supported = detectChromiumBackdropFilter()
    root.dataset.glassRefraction = supported && glassEnabled ? 'on' : 'off'
  }, [glassEnabled])

  // Derive scaled values for the three filter presets. Memoize so React
  // doesn't churn the DOM on unrelated re-renders.
  const presets = useMemo(() => {
    const baseScale = Math.max(0, displacementScale)
    const aberrPx = Math.max(0, aberrationIntensity)
    return {
      soft: {
        scale: Math.round(baseScale * 0.5),
        aberration: 0,
        baseFrequency: 0.012,
      },
      prominent: {
        scale: Math.round(baseScale),
        aberration: aberrPx,
        baseFrequency: 0.018,
      },
      press: {
        scale: Math.round(baseScale * 1.5),
        aberration: aberrPx * 1.4,
        baseFrequency: 0.022,
      },
    }
  }, [displacementScale, aberrationIntensity])

  return (
    <svg
      aria-hidden="true"
      // The SVG itself must not paint — it only carries <defs>. We pin it
      // outside the visual tree with an absolute zero-size placement.
      width="0"
      height="0"
      style={{
        position: 'absolute',
        width: 0,
        height: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <defs>
        {/* ── Soft: subtle, edge-only displacement ─────────────────── */}
        <filter
          id={FILTER_IDS.soft}
          x="-10%"
          y="-10%"
          width="120%"
          height="120%"
          filterUnits="objectBoundingBox"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency={presets.soft.baseFrequency}
            numOctaves="1"
            seed="7"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="2" result="map" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale={presets.soft.scale}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>

        {/* ── Prominent: refraction + chromatic aberration ─────────── */}
        <filter
          id={FILTER_IDS.prominent}
          x="-15%"
          y="-15%"
          width="130%"
          height="130%"
          filterUnits="objectBoundingBox"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency={presets.prominent.baseFrequency}
            numOctaves="2"
            seed="14"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="2" result="map" />

          {/* Three displacement passes with slightly different scales
              isolate R / G / B and reassemble through `screen`. This is
              the canonical liquid-glass dispersion technique. */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale={presets.prominent.scale - presets.prominent.aberration}
            xChannelSelector="R"
            yChannelSelector="G"
            result="dr"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale={presets.prominent.scale}
            xChannelSelector="R"
            yChannelSelector="G"
            result="dg"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale={presets.prominent.scale + presets.prominent.aberration}
            xChannelSelector="R"
            yChannelSelector="G"
            result="db"
          />
          <feColorMatrix
            in="dr"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="dr_only"
          />
          <feColorMatrix
            in="dg"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="dg_only"
          />
          <feColorMatrix
            in="db"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            result="db_only"
          />
          <feBlend in="dr_only" in2="dg_only" mode="screen" result="rg" />
          <feBlend in="rg" in2="db_only" mode="screen" />
        </filter>

        {/* ── Press: stronger displacement for `:active` flourishes ── */}
        <filter
          id={FILTER_IDS.press}
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
          filterUnits="objectBoundingBox"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency={presets.press.baseFrequency}
            numOctaves="2"
            seed="3"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="3" result="map" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale={presets.press.scale}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  )
}
