/**
 * The window a report covers, the window it is compared with, and the bars a
 * time series is cut into — all in the operator's time zone
 * (`analytics-zone.util.ts`).
 *
 * DAYS ARE LOCAL CALENDAR DAYS. A window opens at local midnight, and a bar is
 * a local day: a payment at 01:30 MSK on 18 September is in the bar of the
 * 18th, not in the 17th's, where UTC puts it. SQL files a row into a bar by
 * its local date (`AT TIME ZONE`, the zone a bind parameter), and the labels
 * are the same local dates, computed without the host's clock — so the two can
 * never disagree, on any server.
 *
 * WHY THE PREVIOUS WINDOW ENDS AT THE SAME LOCAL TIME `days` DAYS AGO. The
 * current window's last day is only partly over. Compared with a previous
 * window that ended at a midnight, every morning would read as a fall. Both
 * windows have the same number of local days, and each ends at the same time
 * of day — across a daylight-saving switch too, where a local day is 23 or 25
 * hours long and a fixed `days × 24 h` would move the comparison by an hour.
 *
 * THE BARS. Up to a month, a bar per day; up to four months, a bar per seven
 * days counted from the window's first day (so the previous window's bars line
 * up with the current ones one for one); beyond that, a bar per calendar month,
 * the first and last of which may be partial.
 */
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  AnalyticsBucketLabelInterface,
  AnalyticsGranularity,
  AnalyticsPeriodInterface,
} from '../interfaces/business-analytics.types';
import { clampWindow } from './analytics-date.util';
import {
  addDays,
  ANALYTICS_ZONE_DAY_MS,
  type AnalyticsZone,
  chooseAnalyticsZone,
  type DatabaseZoneNames,
  dateKeyOf,
  daysBetween,
  instantOfWallClock,
  monthEndKey,
  monthsBetween,
  monthStartKey,
  needsDatabaseZoneCheck,
  readZoneSetting,
  startOfZonedDay,
  wallClockOf,
  type ZoneSettingReading,
} from './analytics-zone.util';

export const ANALYTICS_DAY_MS = ANALYTICS_ZONE_DAY_MS;

export interface AnalyticsWindowInterface {
  readonly days: number;
  readonly now: Date;
  readonly zone: AnalyticsZone;
  /** The window's first local day, `YYYY-MM-DD`. */
  readonly startDay: string;
  /** The day `now` falls on. */
  readonly lastDay: string;
  /** The previous window's first local day. */
  readonly previousStartDay: string;
  /** The day the previous window's last instant falls on. */
  readonly previousLastDay: string;
  /** Local midnight of `startDay`. */
  readonly start: Date;
  /** Local midnight of `previousStartDay`. */
  readonly previousStart: Date;
  /** The local time of `now`, `days` calendar days earlier. Exclusive. */
  readonly previousEnd: Date;
  readonly granularity: AnalyticsGranularity;
  /** Number of bars of the current window. */
  readonly bucketCount: number;
  /** Number of bars of the previous window (equal, except that calendar months may differ by one). */
  readonly previousBucketCount: number;
}

export function granularityFor(days: number): AnalyticsGranularity {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/** How many bars a window from `firstDay` through `lastDay` (both local days) is cut into. */
function bucketCountFor(granularity: AnalyticsGranularity, firstDay: string, lastDay: string, days: number): number {
  switch (granularity) {
    case 'day':
      return days;
    case 'week':
      return Math.ceil(days / 7);
    case 'month':
      return monthsBetween(firstDay, lastDay) + 1;
  }
}

export function planAnalyticsWindow(daysRaw: number, now: Date, zone: AnalyticsZone): AnalyticsWindowInterface {
  const days = clampWindow(daysRaw);
  const lastDay = dateKeyOf(now, zone.name);
  const startDay = addDays(lastDay, -(days - 1));
  const previousStartDay = addDays(lastDay, -(2 * days - 1));
  const previousEnd = instantOfWallClock(wallClockOf(now, zone.name) - days * ANALYTICS_ZONE_DAY_MS, zone.name);
  // The previous window's last instant is just before `previousEnd`.
  const previousLastDay = dateKeyOf(new Date(previousEnd.getTime() - 1), zone.name);
  const granularity = granularityFor(days);
  return {
    days,
    now,
    zone,
    startDay,
    lastDay,
    previousStartDay,
    previousLastDay,
    start: startOfZonedDay(startDay, zone.name),
    previousStart: startOfZonedDay(previousStartDay, zone.name),
    previousEnd,
    granularity,
    bucketCount: bucketCountFor(granularity, startDay, lastDay, days),
    previousBucketCount: bucketCountFor(granularity, previousStartDay, previousLastDay, days),
  };
}

/**
 * Which bar the local day `day` falls in, counted from `firstDay`, the first
 * day of its window. The TypeScript twin of {@link bucketIndexSql}.
 */
export function bucketIndexOf(granularity: AnalyticsGranularity, firstDay: string, day: string): number {
  switch (granularity) {
    case 'day':
      return daysBetween(firstDay, day);
    case 'week':
      return Math.floor(daysBetween(firstDay, day) / 7);
    case 'month':
      return monthsBetween(firstDay, day);
  }
}

/**
 * The bars' labels: for each, the first and the last local day it covers, both
 * inside the window. `firstDay` is the window's first day, `lastDay` its last.
 */
export function bucketLabels(
  granularity: AnalyticsGranularity,
  firstDay: string,
  lastDay: string,
  count: number,
): AnalyticsBucketLabelInterface[] {
  const labels: AnalyticsBucketLabelInterface[] = [];
  for (let index = 0; index < count; index++) {
    let from: string;
    let to: string;
    if (granularity === 'month') {
      const monthStart = monthStartKey(firstDay, index);
      from = monthStart < firstDay ? firstDay : monthStart;
      const monthEnd = monthEndKey(monthStart);
      to = monthEnd > lastDay ? lastDay : monthEnd;
    } else {
      const step = granularity === 'day' ? 1 : 7;
      from = addDays(firstDay, index * step);
      const end = addDays(from, step - 1);
      to = end > lastDay ? lastDay : end;
    }
    // A window read at exactly midnight ends a millisecond before its last bar
    // starts; the bar is then one day long rather than inverted.
    labels.push({ from, to: to < from ? from : to });
  }
  return labels;
}

/** The period block every windowed report carries. */
export function describePeriod(window: AnalyticsWindowInterface): AnalyticsPeriodInterface {
  return {
    start: window.start.toISOString(),
    end: window.now.toISOString(),
    previousStart: window.previousStart.toISOString(),
    previousEnd: window.previousEnd.toISOString(),
    timeZone: window.zone.name,
    timeZoneFallback: window.zone.fallback,
    granularity: window.granularity,
    buckets: bucketLabels(window.granularity, window.startDay, window.lastDay, window.bucketCount),
    previousBuckets: bucketLabels(window.granularity, window.previousStartDay, window.previousLastDay, window.previousBucketCount),
  };
}

/**
 * `1` for a row of the previous window, `0` for the current one. Rows between
 * `previousEnd` and `start` belong to neither and must be filtered out by the
 * caller ({@link bothWindowsSql}).
 */
export function isPreviousSql(column: Prisma.Sql, window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`(CASE WHEN ${column} >= ${window.start} THEN 0 ELSE 1 END)`;
}

/** Rows of the current window, or of the previous one — and nothing between them. */
export function bothWindowsSql(column: Prisma.Sql, window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`(${column} >= ${window.previousStart} AND (${column} >= ${window.start} OR ${column} < ${window.previousEnd}))`;
}

/**
 * The instant a `timestamptz` the panel stored — or a `Date` a statement binds
 * — stands for, whatever the database session's `TimeZone`.
 *
 * Prisma's pg adapter sends a `Date` as its UTC wall-clock time with NO offset,
 * and PostgreSQL reads that in the session's `TimeZone` (measured: on a
 * database whose `timezone` is Europe/Moscow, 04:30Z is stored as 04:30+03 —
 * three hours early — and Prisma reads it back as 04:30Z). Every timestamp the
 * panel writes and every `Date` it binds is shifted the same way, so comparing
 * them is sound; only a conversion into another zone must undo the shift
 * first. On a UTC database this is the identity.
 */
export function panelInstantSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(((${column}) AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC')`;
}

/**
 * Which of the setting's two names PostgreSQL lists as a zone AND will read as
 * one in `AT TIME ZONE` — the database half of `DatabaseZoneNames`
 * (`analytics-zone.util.ts`), one row. Letter case does not matter to
 * `AT TIME ZONE`, so it does not here; an abbreviation does, because
 * `AT TIME ZONE` tries the session's abbreviations first (`CET` would be a
 * fixed UTC+1).
 */
export function databaseZoneNamesSql(reading: ZoneSettingReading): Prisma.Sql {
  const readsAsZone = (name: string): Prisma.Sql => Prisma.sql`(
    EXISTS (SELECT 1 FROM pg_timezone_names n WHERE LOWER(n."name") = LOWER(${name}::text))
    AND NOT EXISTS (SELECT 1 FROM pg_timezone_abbrevs a WHERE LOWER(a."abbrev") = LOWER(${name}::text)))`;
  return Prisma.sql`SELECT ${readsAsZone(reading.canonical)} AS "canonical", ${readsAsZone(reading.typed)} AS "typed"`;
}

/**
 * The zone each setting came to once PostgreSQL was asked — once per process
 * and setting: a zone `Intl` knows and the database's tz data does not would
 * fail every statement it is bound into, and one the database reads as an
 * abbreviation would count other days than the labels.
 */
const zonesReadByDatabase = new Map<string, AnalyticsZone>();

/**
 * THE OPERATOR'S ZONE, for any report that counts days: `setting` is the
 * panel's `Settings.platformPolicy.timezone` as `SettingsService
 * .getPlatformBranding().timezone` hands it over. The zone when both `Intl` and
 * PostgreSQL know it (`analytics-zone.util.ts`), else UTC with `fallback` set,
 * for the page to say so. PostgreSQL is asked once per setting and process;
 * UTC, an empty setting and a name `Intl` does not know never reach it.
 */
export async function readAnalyticsZone(
  client: Pick<PrismaService, '$queryRaw'>,
  setting: string | null | undefined,
): Promise<AnalyticsZone> {
  const reading = readZoneSetting(setting);
  if (!needsDatabaseZoneCheck(reading)) return chooseAnalyticsZone(reading, null);
  let zone = zonesReadByDatabase.get(reading.typed);
  if (zone === undefined) {
    const [row] = await client.$queryRaw<DatabaseZoneNames[]>(databaseZoneNamesSql(reading));
    zone = chooseAnalyticsZone(reading, row ?? null);
    zonesReadByDatabase.set(reading.typed, zone);
  }
  return zone;
}

/** The wall-clock time of a stored `timestamptz` in the report's zone (a bind parameter). */
export function localTimestampSql(column: Prisma.Sql, zone: AnalyticsZone): Prisma.Sql {
  return Prisma.sql`(${panelInstantSql(column)} AT TIME ZONE ${zone.name}::text)`;
}

/**
 * The local calendar day of a stored `timestamptz` in the report's zone. It
 * depends on neither the database session's `TimeZone` (which a `::date` of
 * the instant itself would) nor the server's clock.
 */
export function localDateSql(column: Prisma.Sql, zone: AnalyticsZone): Prisma.Sql {
  return Prisma.sql`(${localTimestampSql(column, zone)})::date`;
}

/**
 * The bar `column` falls in, counted from the first day of ITS window: rows at
 * or after `start` from `startDay`, earlier rows from `previousStartDay`. The
 * SQL twin of {@link bucketIndexOf}; `granularity` is one of three fixed
 * shapes, never caller text.
 */
export function bucketIndexSql(column: Prisma.Sql, window: AnalyticsWindowInterface): Prisma.Sql {
  const day = localDateSql(column, window.zone);
  const origin = Prisma.sql`(CASE WHEN ${column} >= ${window.start} THEN ${window.startDay}::date ELSE ${window.previousStartDay}::date END)`;
  switch (window.granularity) {
    case 'day':
      return Prisma.sql`(${day} - ${origin})::int`;
    case 'week':
      return Prisma.sql`FLOOR((${day} - ${origin}) / 7.0)::int`;
    case 'month':
      return Prisma.sql`((EXTRACT(YEAR FROM ${day}) - EXTRACT(YEAR FROM ${origin})) * 12
        + EXTRACT(MONTH FROM ${day}) - EXTRACT(MONTH FROM ${origin}))::int`;
  }
}

/** An array of `length` zeroes to fill a series in. */
export function zeroes(length: number): number[] {
  return Array.from({ length }, () => 0);
}
