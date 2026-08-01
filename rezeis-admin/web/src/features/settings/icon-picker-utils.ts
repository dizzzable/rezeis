import { PLAN_ICON_OPTIONS } from '@/features/plans/plan-icon-options'

/** Prefix marking an `icon` value as a reference to a custom uploaded icon. */
export const CUSTOM_ICON_PREFIX = 'custom:'

/** Set of built-in Lucide preset keys, for fast emoji-vs-preset detection. */
const PRESET_KEYS = new Set(PLAN_ICON_OPTIONS.map((option) => option.key))

/**
 * `true` when an icon value is an emoji (a Unicode glyph or a `:slug:`
 * custom-pack shortcode) rather than a Lucide preset key, a `custom:<id>`
 * uploaded icon, or null ("Auto").
 */
export function isEmojiIcon(value: string | null): value is string {
  return value !== null && value.length > 0 && !value.startsWith(CUSTOM_ICON_PREFIX) && !PRESET_KEYS.has(value)
}
