/**
 * Glass utility helpers.
 */

/** Multiplier converting normalized blur (0-1) to CSS pixels. */
export const GLASS_BLUR_SCALE = 80

/** Convert a normalized blur value (0-1) to a CSS px value. */
export function glassBlurPx(blur: number): number {
  return Math.round(Math.max(0, Math.min(1, blur)) * GLASS_BLUR_SCALE)
}
