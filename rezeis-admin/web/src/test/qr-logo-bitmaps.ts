/**
 * Logo pictures for the QR logo check's tests, drawn the way a browser hands
 * one to the check: a square box of straight RGBA, transparent where the
 * picture does not cover.
 *
 * jsdom has no canvas, so these are painted here instead — by the SAME
 * painters, at the same resolution and supersampling, as the measurement that
 * set the check's thresholds (13.09.2026). The exact counts the tests pin come
 * from those runs.
 */
import type { QrLogoBitmap } from '@/features/branding/qr-logo-check-run'

/** RGBA 0–255 at a point of the box (`u`, `v` in 0–1), or `null` where the picture is transparent. */
export type LogoPainter = (u: number, v: number) => readonly [number, number, number, number] | null

const INK = [0, 0, 0, 255] as const
const PAPER = [255, 255, 255, 255] as const
const NAVY = [30, 58, 138, 255] as const

/** The painter, sampled 3 × 3 per texel and averaged with its alpha, at `size` × `size`. */
export function paintLogo(painter: LogoPainter, size = 256, supersample = 3): QrLogoBitmap {
  const rgba = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const colour = painter((x + (sx + 0.5) / supersample) / size, (y + (sy + 0.5) / supersample) / size)
          if (colour === null) continue
          const alpha = colour[3] / 255
          r += colour[0] * alpha
          g += colour[1] * alpha
          b += colour[2] * alpha
          a += alpha
        }
      }
      const at = (y * size + x) * 4
      if (a > 0) {
        rgba[at] = Math.round(r / a)
        rgba[at + 1] = Math.round(g / a)
        rgba[at + 2] = Math.round(b / a)
      }
      rgba[at + 3] = Math.round((a / (supersample * supersample)) * 255)
    }
  }
  return { width: size, height: size, rgba }
}

const inCircle = (u: number, v: number, cx: number, cy: number, r: number): boolean =>
  (u - cx) ** 2 + (v - cy) ** 2 <= r * r
const inRect = (u: number, v: number, x0: number, y0: number, x1: number, y1: number): boolean =>
  u >= x0 && u < x1 && v >= y0 && v < y1

function inRoundRect(u: number, v: number, radius: number): boolean {
  if (!inRect(u, v, 0, 0, 1, 1)) return false
  const nx = Math.min(Math.max(u, radius), 1 - radius)
  const ny = Math.min(Math.max(v, radius), 1 - radius)
  return (u - nx) ** 2 + (v - ny) ** 2 <= radius * radius
}

/** A thick "V" in the middle of the box. */
function inV(u: number, v: number): boolean {
  if (v < 0.28 || v > 0.72) return false
  const halfSpan = 0.22 * (1 - (v - 0.28) / 0.44)
  return Math.abs(Math.abs(u - 0.5) - halfSpan) <= 0.07
}

/** Nothing at all: the white field (or the dark plate) shows through. */
export const TRANSPARENT_LOGO: LogoPainter = () => null

/** An app icon: a navy rounded square with a white glyph. Harmless — measured with the filled marks. */
export const APP_ICON_LOGO: LogoPainter = (u, v) => (inRoundRect(u, v, 0.22) ? (inV(u, v) ? PAPER : NAVY) : null)

/** A QR finder pattern filling the box — ring, gap, core at 1:1:3:1:1. The class the cabinet pins as unreadable. */
export const EYE_LOGO: LogoPainter = (u, v) =>
  (inRect(u, v, 0, 0, 1, 1) && !inRect(u, v, 1 / 7, 1 / 7, 6 / 7, 6 / 7)) || inRect(u, v, 2 / 7, 2 / 7, 5 / 7, 5 / 7)
    ? INK
    : PAPER

/** The same proportions, round. */
export const BULLSEYE_LOGO: LogoPainter = (u, v) =>
  (inCircle(u, v, 0.5, 0.5, 0.5) && !inCircle(u, v, 0.5, 0.5, 2.5 / 7)) || inCircle(u, v, 0.5, 0.5, 1.5 / 7)
    ? INK
    : null

/** A small SVG logo, as bytes an upload would hold. */
export const SVG_LOGO_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#1e3a8a"/></svg>',
)
