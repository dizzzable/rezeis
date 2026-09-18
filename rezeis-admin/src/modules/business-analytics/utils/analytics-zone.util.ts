/**
 * The operator's time zone: the calendar every analytics report counts days in.
 *
 * The panel stores it as `Settings.platformPolicy.timezone` (read through
 * `SettingsService.getPlatformBranding()`, the reader Telegram cards and
 * customer notifications already use). Until the 2026-09 review the reports
 * counted UTC days: a payment at 01:30 MSK fell in the previous day's bar, and
 * every window of a Moscow operator opened at 03:00.
 *
 * A zone reaches SQL only as a bind parameter, and only after it passed both
 * a shape check (an IANA name, or `UTC`) and `Intl` — so a stray setting can
 * neither break a statement nor ride into one. An empty or unknown setting
 * falls back to UTC, and the report says so (`fallback`), for the page to tell
 * the operator which days they are looking at.
 *
 * Everything here is pure: the calendar arithmetic is done on `YYYY-MM-DD`
 * keys and on "wall clock" values — the local date and time of an instant,
 * written as the milliseconds of a UTC date with the same fields — so the
 * host's own time zone is never consulted.
 */
export const ANALYTICS_ZONE_DAY_MS = 86_400_000;

export interface AnalyticsZone {
  /** An IANA zone (`Europe/Moscow`), or `UTC`. */
  readonly name: string;
  /** The panel's setting was empty or not a zone: days are UTC days. */
  readonly fallback: boolean;
}

export const UTC_ZONE: AnalyticsZone = { name: 'UTC', fallback: false };

/** `UTC`, or an IANA name: an area and one or more locations. Nothing else reaches `Intl` or SQL. */
const ZONE_NAME = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/** The zone the panel's setting names, or UTC — with `fallback` set when the setting could not be used. */
export function resolveAnalyticsZone(setting: string | null | undefined): AnalyticsZone {
  const candidate = (setting ?? '').trim();
  if (candidate === '' || candidate.length > 64 || !ZONE_NAME.test(candidate)) return { name: 'UTC', fallback: true };
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return { name: 'UTC', fallback: true };
  }
  if (resolved === 'UTC' || resolved === 'Etc/UTC' || resolved === 'Etc/GMT') return UTC_ZONE;
  return { name: resolved, fallback: false };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The local date and time of `instant` in `zone`, as the milliseconds of a UTC date with the same fields. */
export function wallClockOf(instant: Date, zone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(instant)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return Date.UTC(
    fields['year']!,
    fields['month']! - 1,
    fields['day']!,
    fields['hour']! % 24,
    fields['minute']!,
    fields['second']!,
    instant.getUTCMilliseconds(),
  );
}

function offsetAt(instant: number, zone: string): number {
  return wallClockOf(new Date(instant), zone) - instant;
}

/**
 * The instant at which `zone`'s clocks show `wallClock`. When the clocks
 * repeat an hour (autumn), the earlier of the two; when they skip it (spring),
 * the moment they jump to — so a day that starts in a skipped hour starts at
 * its first real instant.
 */
export function instantOfWallClock(wallClock: number, zone: string): Date {
  const before = wallClock - offsetAt(wallClock - ANALYTICS_ZONE_DAY_MS, zone);
  const after = wallClock - offsetAt(wallClock + ANALYTICS_ZONE_DAY_MS, zone);
  const valid = [before, after].filter((candidate) => wallClockOf(new Date(candidate), zone) === wallClock);
  if (valid.length > 0) return new Date(Math.min(...valid));
  // Skipped: read with the offset in force before the jump, which lands just after it.
  return new Date(before);
}

/** `YYYY-MM-DD` of the local day `instant` falls on in `zone`. */
export function dateKeyOf(instant: Date, zone: string): string {
  return new Date(wallClockOf(instant, zone)).toISOString().slice(0, 10);
}

function keyToUtcMs(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}

/** The calendar day `days` after (or before) `key`. */
export function addDays(key: string, days: number): string {
  return new Date(keyToUtcMs(key) + days * ANALYTICS_ZONE_DAY_MS).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((keyToUtcMs(to) - keyToUtcMs(from)) / ANALYTICS_ZONE_DAY_MS);
}

/** The first instant of the local day `key` in `zone`. */
export function startOfZonedDay(key: string, zone: string): Date {
  return instantOfWallClock(keyToUtcMs(key), zone);
}

/** The first day of the month `months` months after (or before) the month of `key`. */
export function monthStartKey(key: string, months = 0): string {
  const date = new Date(keyToUtcMs(key));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)).toISOString().slice(0, 10);
}

/** Calendar months from the month of `from` to the month of `to`. */
export function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = to.split('-').map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/** The last day of the month of `key`. */
export function monthEndKey(key: string): string {
  return addDays(monthStartKey(key, 1), -1);
}
