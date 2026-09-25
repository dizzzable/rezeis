/**
 * «Часовой пояс Remnawave» on the page: the check a typed zone meets before it
 * is sent (the server checks it again — `switches/remnawave-time-zone.ts`), and
 * the spellings the daily check's warning uses.
 */

/**
 * The shape of an IANA zone name, as the server checks it: letters first, then
 * letters, digits, `_`, `+`, `-` and `/` between parts. Offsets like `+03:00`
 * are not names — Remnawave's `TZ` does not take them.
 */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/

/** Is `value` a zone this browser knows — or empty, which puts the zone back to UTC? */
export function isAcceptableTimeZone(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return true
  if (trimmed.length > 64 || !IANA_NAME.test(trimmed)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
    return true
  } catch {
    return false
  }
}

/** `UTC+03:00`, `UTC−03:00`, `UTC+05:45`. */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+'
  const absolute = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

/** `03:05 UTC` — one unambiguous zone for both sides of a mismatch. */
export function utcTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`
}
