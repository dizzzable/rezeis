/**
 * The browser half of «Часовой пояс» (Settings → «Платформа»): the zones this
 * browser can list and format, and the refusal the server names when a zone
 * may not be stored. The field is `platform-timezone-field.tsx`.
 */
/** The zones this browser knows, UTC aside (it is the empty choice); `null` when it cannot list them. */
export function listTimeZones(): readonly string[] | null {
  const supported = (Intl as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf
  if (typeof supported !== 'function') return null
  try {
    return supported('timeZone').filter((zone) => zone !== 'UTC')
  } catch {
    return null
  }
}

/** `UTC+03:00` — the zone's offset at `at`; `null` for a zone this browser does not know. */
export function zoneOffsetLabel(zone: string, at: Date): string | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((piece) => piece.type === 'timeZoneName')?.value
    if (part === undefined) return null
    // `GMT` alone is UTC itself; `GMT+03:00` the rest.
    return part === 'GMT' ? 'UTC' : part.replace(/^GMT/u, 'UTC')
  } catch {
    return null
  }
}

/** «19 сентября в 01:42» — the date and time in `zone`; `null` for a zone this browser does not know. */
export function zoneNowLabel(zone: string, at: Date, language: string): string | null {
  try {
    return new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-GB', {
      timeZone: zone,
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at)
  } catch {
    return null
  }
}

/** The refusal the server named in its 400 (`PLATFORM_TIMEZONE_<CODE>: …`), or `null` for any other failure. */
export type PlatformTimezoneRefusal = 'OFFSET' | 'UNKNOWN' | 'NOT_A_ZONE_NAME' | 'NOT_IN_DATABASE'

export function readPlatformTimezoneRefusal(error: unknown): PlatformTimezoneRefusal | null {
  const message =
    typeof error === 'object' && error !== null
      ? (error as { response?: { data?: { message?: unknown } } }).response?.data?.message
      : undefined
  const text = Array.isArray(message) ? message.join(' ') : typeof message === 'string' ? message : ''
  const match = /\bPLATFORM_TIMEZONE_(OFFSET|UNKNOWN|NOT_A_ZONE_NAME|NOT_IN_DATABASE)\b/u.exec(text)
  return match === null ? null : (match[1] as PlatformTimezoneRefusal)
}
