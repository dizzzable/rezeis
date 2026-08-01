export const SHORTCODE_RE = /^:([a-z0-9_]+):$/

/** `true` when the shortcode/value is a custom-pack emoji reference. */
export function isShortcodeEmoji(value: string): boolean {
  return SHORTCODE_RE.test(value)
}
