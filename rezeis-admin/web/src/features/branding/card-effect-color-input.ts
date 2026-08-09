/**
 * Codec between a stored effect colour and `<input type="color">`.
 *
 * The native colour input speaks ONE dialect: six-digit `#rrggbb`, no alpha.
 * The control renderers used to enforce that by testing the stored value
 * against `/^#[0-9a-fA-F]{6}$/` and substituting `#ffffff` whenever it failed —
 * which meant any colour carrying alpha was DISPLAYED as opaque white while the
 * stored value said something else, and the first touch of that swatch wrote a
 * six-digit hex over it, discarding the alpha with no way back.
 *
 * `pixelCard.colors` is the case that made it visible: its default is a
 * deliberate ramp `rgba(255,255,255,1) / 0.8 / 0.6`, so all three swatches
 * showed identical white and one click flattened the ramp permanently. The
 * class is wider than that one effect — every `color`/`colorArray` control is
 * free to hold `rgba()` or an eight-digit hex — so the fix belongs here rather
 * than in the catalogue defaults.
 *
 * `toColorInputValue` hands the picker the RGB part only; `withColorInputValue`
 * puts the operator's new RGB back into the ORIGINAL notation with the original
 * alpha intact.
 */

const HEX3 = /^#([\da-f])([\da-f])([\da-f])$/i
const HEX4 = /^#([\da-f])([\da-f])([\da-f])([\da-f])$/i
const HEX6 = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i
const HEX8 = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i
const RGB_FN = /^rgba?\(\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s)]+)\s*(?:,\s*([^,\s)]+)\s*)?\)$/i

/** How the value was written down, so it can be written back the same way. */
type ColorNotation = 'hex' | 'hex8' | 'rgb' | 'rgba'

interface ParsedColor {
  /** 0–255, integer. */
  r: number
  g: number
  b: number
  /** 0–1. `null` when the source carried no alpha at all. */
  alpha: number | null
  notation: ColorNotation
}

const clampByte = (value: number): number =>
  Math.round(Math.min(255, Math.max(0, Number.isFinite(value) ? value : 0)))

const clampAlpha = (value: number): number =>
  Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1))

const byteToHex = (value: number): string => clampByte(value).toString(16).padStart(2, '0')

/** `50%` and bare numbers both appear in the wild; both resolve to 0–255. */
function parseChannel(raw: string): number | null {
  const text = raw.trim()
  const percent = text.endsWith('%')
  const value = Number.parseFloat(percent ? text.slice(0, -1) : text)
  if (!Number.isFinite(value)) return null
  return clampByte(percent ? (value / 100) * 255 : value)
}

function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const text = raw.trim()
  const percent = text.endsWith('%')
  const value = Number.parseFloat(percent ? text.slice(0, -1) : text)
  if (!Number.isFinite(value)) return null
  return clampAlpha(percent ? value / 100 : value)
}

export function parseColorValue(value: unknown): ParsedColor | null {
  if (typeof value !== 'string') return null
  const text = value.trim()

  const hex8 = HEX8.exec(text)
  if (hex8) {
    return {
      r: Number.parseInt(hex8[1], 16),
      g: Number.parseInt(hex8[2], 16),
      b: Number.parseInt(hex8[3], 16),
      alpha: Number.parseInt(hex8[4], 16) / 255,
      notation: 'hex8',
    }
  }

  const hex6 = HEX6.exec(text)
  if (hex6) {
    return {
      r: Number.parseInt(hex6[1], 16),
      g: Number.parseInt(hex6[2], 16),
      b: Number.parseInt(hex6[3], 16),
      alpha: null,
      notation: 'hex',
    }
  }

  const hex4 = HEX4.exec(text)
  if (hex4) {
    return {
      r: Number.parseInt(hex4[1] + hex4[1], 16),
      g: Number.parseInt(hex4[2] + hex4[2], 16),
      b: Number.parseInt(hex4[3] + hex4[3], 16),
      alpha: Number.parseInt(hex4[4] + hex4[4], 16) / 255,
      // Widened on write-back: `#rgba` cannot express every alpha the picker
      // may later be paired with, and `#rrggbbaa` can.
      notation: 'hex8',
    }
  }

  const hex3 = HEX3.exec(text)
  if (hex3) {
    return {
      r: Number.parseInt(hex3[1] + hex3[1], 16),
      g: Number.parseInt(hex3[2] + hex3[2], 16),
      b: Number.parseInt(hex3[3] + hex3[3], 16),
      alpha: null,
      notation: 'hex',
    }
  }

  const fn = RGB_FN.exec(text)
  if (fn) {
    const r = parseChannel(fn[1])
    const g = parseChannel(fn[2])
    const b = parseChannel(fn[3])
    if (r === null || g === null || b === null) return null
    const alpha = parseAlpha(fn[4])
    return { r, g, b, alpha, notation: alpha === null ? 'rgb' : 'rgba' }
  }

  return null
}

/**
 * The six-digit hex the native picker must be given. Unparseable values still
 * fall back to `#ffffff`, but a value that merely carries alpha no longer does.
 */
export function toColorInputValue(value: unknown, fallback = '#ffffff'): string {
  const parsed = parseColorValue(value)
  if (!parsed) return fallback
  return `#${byteToHex(parsed.r)}${byteToHex(parsed.g)}${byteToHex(parsed.b)}`
}

/**
 * The operator's new RGB, re-expressed in the notation the previous value used
 * and carrying the alpha the previous value carried. A previous value with no
 * alpha (or none we can read) yields a plain six-digit hex, exactly as before.
 */
export function withColorInputValue(previous: unknown, hex: string): string {
  const next = parseColorValue(hex)
  const plain = next
    ? `#${byteToHex(next.r)}${byteToHex(next.g)}${byteToHex(next.b)}`
    : hex
  const parsed = parseColorValue(previous)
  if (!parsed || parsed.alpha === null || !next) return plain

  switch (parsed.notation) {
    case 'hex8':
      return `${plain}${byteToHex(parsed.alpha * 255)}`
    case 'rgba':
      return `rgba(${next.r}, ${next.g}, ${next.b}, ${parsed.alpha})`
    default:
      return plain
  }
}
