/**
 * theme-colors
 * ────────────
 * Background-effect colour slots for the landing theme.
 *
 * The slots are POSITIONAL: slot n drives `--ls-cN` in landing.css, and each
 * effect reads specific slots (gradient uses all four, mesh uses all four,
 * aurora/blobs/glow read c1 and c2). A hole therefore cannot be dropped —
 * filtering a sparse array makes later colours slide into earlier slots and
 * silently rewires the effect. `setBackgroundColor` fills gaps instead.
 */

/** Matches `backgroundColors.max(4)` in the landing schema and `--ls-c1..c4`. */
export const MAX_BACKGROUND_COLORS = 4

/** Slot indices rendered as pickers, in order. */
export const BACKGROUND_COLOR_SLOTS = [0, 1, 2, 3] as const

/** Last-resort swatch when neither the slot nor `theme.colors.primary` is set. */
export const FALLBACK_BG_COLOR = '#22c55e'

/**
 * Writes `value` into slot `index`, preserving every other slot's position.
 *
 * Gaps below `index` are filled with `fallback` — the same value the picker
 * already displays for an unset slot, so what gets stored is what the operator
 * sees. Out-of-range indices are ignored rather than growing the array past the
 * schema limit.
 */
export function setBackgroundColor(
  current: readonly string[],
  index: number,
  value: string,
  fallback: string,
): string[] {
  const clamped = current.slice(0, MAX_BACKGROUND_COLORS)
  if (index < 0 || index >= MAX_BACKGROUND_COLORS) return clamped
  const length = Math.max(index + 1, clamped.length)
  return Array.from({ length }, (_, slot) =>
    slot === index ? value : (clamped[slot] ?? fallback),
  )
}
