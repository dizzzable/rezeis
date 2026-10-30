/**
 * The same moment one calendar month later, on the project's clock.
 *
 * A monthly contest ends «1-го числа в 00:00» or «в последний день месяца в
 * 23:59» as the operator reads the clock, not as UTC does — so the month is
 * added to the wall-clock date in `zone`, and the result is turned back into
 * an instant there. Daylight saving moves the UTC offset, not the hour the
 * contest ends at.
 *
 * The last day of a month stays the last day: 31 October → 30 November →
 * 31 December. Plain "same day number, clamped" would drift to the 30th and
 * stay there, and a monthly contest would quietly start ending a day early.
 */
export function addCalendarMonth(instant: Date, zone: string): Date {
  const wall = wallClock(instant, zone);
  const lastDay = daysInMonth(wall.year, wall.month);
  const nextMonth = wall.month === 12 ? 1 : wall.month + 1;
  const nextYear = wall.month === 12 ? wall.year + 1 : wall.year;
  const nextLastDay = daysInMonth(nextYear, nextMonth);
  const day = wall.day === lastDay ? nextLastDay : Math.min(wall.day, nextLastDay);
  return fromWallClock({ ...wall, year: nextYear, month: nextMonth, day }, zone);
}

/** A zone `Intl` knows, or UTC. The panel's setting is free text. */
export function safeZone(zone: string | null | undefined): string {
  const candidate = (zone ?? '').trim();
  if (candidate === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return 'UTC';
  }
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

function wallClock(instant: Date, zone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: instant.getUTCMilliseconds(),
  };
}

/**
 * The instant at which `zone`'s clock shows `wall`. The offset is read at a
 * first guess and corrected once, which settles every zone whose offset does
 * not change twice within a few hours. A wall-clock time that does not exist
 * (the hour skipped in spring) lands an hour later, as clocks do.
 */
function fromWallClock(wall: WallClock, zone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  let guess = asUtc - offsetAt(new Date(asUtc), zone);
  guess = asUtc - offsetAt(new Date(guess), zone);
  return new Date(guess);
}

/** How far `zone` is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: Date, zone: string): number {
  const wall = wallClock(instant, zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  return asUtc - instant.getTime();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
