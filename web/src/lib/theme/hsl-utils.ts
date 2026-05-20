/**
 * HSL color utilities.
 *
 * Theme palette stores colors as HSL triplets without the hsl() wrapper:
 *   "222.2 47.4% 11.2%"
 *
 * This file provides:
 *  - parse:    "222.2 47.4% 11.2%"  → { h, s, l }
 *  - format:   { h, s, l }          → "222.2 47.4% 11.2%"
 *  - toCssVar: triplet              → "hsl(222.2 47.4% 11.2%)"
 *  - hexToHsl: "#18181b"            → { h, s, l }
 *  - hslToHex: { h, s, l }          → "#18181b"
 */

export interface HSL {
  /** Hue 0–360 */
  h: number
  /** Saturation 0–100 */
  s: number
  /** Lightness 0–100 */
  l: number
}

/** Parse an HSL triplet string into {h, s, l}. */
export function parseHsl(value: string): HSL {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/)
  if (!match) return { h: 0, s: 0, l: 0 }
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) }
}

/** Format {h, s, l} as a CSS-variable-ready triplet. */
export function formatHsl({ h, s, l }: HSL): string {
  const round = (n: number) => Math.round(n * 10) / 10
  return `${round(h)} ${round(s)}% ${round(l)}%`
}

/** Convert HSL triplet to a CSS hsl() value. */
export function toCssVar(value: string): string {
  return `hsl(${value})`
}

/** Convert hex (#RRGGBB) to HSL. */
export function hexToHsl(hex: string): HSL {
  const normalized = hex.replace('#', '').toLowerCase()
  if (normalized.length !== 6) return { h: 0, s: 0, l: 0 }
  const r = parseInt(normalized.slice(0, 2), 16) / 255
  const g = parseInt(normalized.slice(2, 4), 16) / 255
  const b = parseInt(normalized.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }
  return { h: h * 360, s: s * 100, l: l * 100 }
}

/** Convert HSL to hex (#RRGGBB). */
export function hslToHex({ h, s, l }: HSL): string {
  const sNorm = s / 100
  const lNorm = l / 100
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lNorm - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const toHex = (n: number) => {
    const v = Math.round((n + m) * 255)
    return v.toString(16).padStart(2, '0')
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/** Convert a hex string to the HSL triplet string used by CSS variables. */
export function hexToTriplet(hex: string): string {
  return formatHsl(hexToHsl(hex))
}

/** Convert a palette HSL triplet to a hex string for <input type="color">. */
export function tripletToHex(value: string): string {
  return hslToHex(parseHsl(value))
}
