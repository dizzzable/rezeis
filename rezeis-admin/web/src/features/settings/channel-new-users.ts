/**
 * «Проверять только новых» — the moment in the two shapes it lives in.
 *
 * The panel stores an instant (UTC, ISO-8601 with `Z`, which is the only shape
 * the platform DTO accepts). `<input type="datetime-local">` holds a wall-clock
 * time with no zone at all, and the browser reads it in the device's own zone.
 * These two functions are the only place the card crosses between them, so a
 * round trip through the form cannot shift the moment by the device's offset.
 */

/** A stored instant as the value a `datetime-local` input shows. Empty when unset or unreadable. */
export function instantToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  // Shift by the device's offset so `toISOString` prints local wall-clock
  // digits, then drop the seconds and the zone the input cannot hold.
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

/** What a `datetime-local` input holds, as the instant the panel stores. `null` for empty or unreadable. */
export function localInputToInstant(value: string): string | null {
  if (!value) return null
  // A date-time string without a zone is LOCAL time by the spec, which is
  // exactly how the input meant it.
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
