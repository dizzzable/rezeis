/**
 * «Часовой пояс» of Settings → «Платформа»: what an operator may store in
 * `Settings.platformPolicy.timezone`.
 *
 * WHO READS IT, and why the rule is theirs: Telegram cards
 * (`SystemEventsService`) and customer notices (`buildSubscriptionFacts`)
 * format dates with `Intl`; the cabinet's partner pages format the balance
 * hold with `Intl` in the browser; «Бизнес-аналитика» and the payments'
 * «Аналитика» count days with PostgreSQL (`readAnalyticsZone`). So a zone is
 * stored only when BOTH `Intl` and PostgreSQL know it — the rule the reports
 * read it with — and only in the form every reader takes as the same zone: a
 * proper IANA name, `Area/Location`, in PostgreSQL's own spelling.
 *
 * REFUSED, each with its own reason (the SPA names it; the API sentence does):
 *   - OFFSET — `+03:00`, `UTC+3`: not a zone. `Intl` reads `+03:00` as UTC+3,
 *     PostgreSQL as a POSIX offset, UTC−3;
 *   - UNKNOWN — a name `Intl` does not know: `MSK`, `Mars/Olympus_Mons`;
 *   - NOT_A_ZONE_NAME — an abbreviation or a legacy alias (`CET`, `EST5EDT`,
 *     `Japan`): `AT TIME ZONE 'CET'` is a fixed UTC+1 all summer while `Intl`
 *     keeps the daylight hour. The refusal names the zone meant
 *     (`Europe/Brussels`);
 *   - NOT_IN_DATABASE — a zone `Intl` knows and this database's zone files do
 *     not list (a zone newer than its tz data).
 *
 * UTC under any name (`UTC`, `Etc/UTC`, `GMT`) and an empty value store
 * nothing: «UTC (не задан)», the default every reader already falls back to.
 *
 * Only the save is strict. A value an older screen or an import stored is read
 * by each reader with its own fallback to UTC, and never throws.
 */
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../common/prisma/prisma.service';

export type PlatformTimezoneRefusal = 'OFFSET' | 'UNKNOWN' | 'NOT_A_ZONE_NAME' | 'NOT_IN_DATABASE';

/** What `Intl` alone can say about a value an operator sent. */
export type PlatformTimezoneCheck =
  /** Empty, or UTC under one of its names: store nothing. */
  | { readonly kind: 'unset' }
  /** A proper name `Intl` knows: PostgreSQL has the last word ({@link platformTimezoneSpellingSql}). */
  | { readonly kind: 'zone'; readonly name: string }
  | { readonly kind: 'refused'; readonly refusal: PlatformTimezoneRefusal; readonly suggestion: string | null };

/** `Intl`'s own names for UTC. */
const UTC_NAMES: ReadonlySet<string> = new Set(['UTC', 'Etc/UTC', 'Etc/GMT']);

/** An offset from UTC rather than a zone: `+03:00`, `-0500`, `UTC+3`, `GMT−3`. */
const OFFSET = /^(?:UTC|GMT)?\s*[+\-−]\s*\d/iu;

function intlZoneName(name: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The `Intl` half of the rule; pure. */
export function checkPlatformTimezone(value: string | null | undefined): PlatformTimezoneCheck {
  const typed = (value ?? '').trim();
  if (typed === '') return { kind: 'unset' };
  if (OFFSET.test(typed)) return { kind: 'refused', refusal: 'OFFSET', suggestion: null };
  const canonical = intlZoneName(typed);
  if (canonical === null) return { kind: 'refused', refusal: 'UNKNOWN', suggestion: null };
  if (UTC_NAMES.has(canonical)) return { kind: 'unset' };
  if (!typed.includes('/')) {
    return { kind: 'refused', refusal: 'NOT_A_ZONE_NAME', suggestion: canonical.includes('/') ? canonical : null };
  }
  return { kind: 'zone', name: typed };
}

/**
 * The PostgreSQL half: the zone's name as the database spells it (`europe/moscow`
 * → `Europe/Moscow`), when it lists the zone. No row otherwise. The name reaching
 * here is `Area/Location` ({@link checkPlatformTimezone}), and no abbreviation
 * `AT TIME ZONE` would read in its place has a `/`.
 */
export function platformTimezoneSpellingSql(name: string): Prisma.Sql {
  return Prisma.sql`
    SELECT n."name" AS "name"
      FROM pg_timezone_names n
     WHERE LOWER(n."name") = LOWER(${name}::text)
     ORDER BY n."name"
     LIMIT 1`;
}

export type PlatformTimezoneResolution =
  | { readonly ok: true; readonly timezone: string | null }
  | { readonly ok: false; readonly refusal: PlatformTimezoneRefusal; readonly value: string; readonly suggestion: string | null };

/** What to store for `value`, or why not — both halves of the rule. */
export async function resolvePlatformTimezone(
  client: Pick<PrismaService, '$queryRaw'>,
  value: string | null | undefined,
): Promise<PlatformTimezoneResolution> {
  const check = checkPlatformTimezone(value);
  const typed = (value ?? '').trim();
  if (check.kind === 'unset') return { ok: true, timezone: null };
  if (check.kind === 'refused') return { ok: false, refusal: check.refusal, value: typed, suggestion: check.suggestion };
  const [row] = await client.$queryRaw<Array<{ readonly name: string }>>(platformTimezoneSpellingSql(check.name));
  return row === undefined
    ? { ok: false, refusal: 'NOT_IN_DATABASE', value: typed, suggestion: null }
    : { ok: true, timezone: row.name };
}

/**
 * The 400's message: the code the SPA matches first, then the problem in a
 * sentence for anyone reading the API directly.
 */
export function describePlatformTimezoneRefusal(
  resolution: Extract<PlatformTimezoneResolution, { readonly ok: false }>,
): string {
  const value = JSON.stringify(resolution.value);
  const example = resolution.suggestion ?? 'Europe/Moscow';
  switch (resolution.refusal) {
    case 'OFFSET':
      return `PLATFORM_TIMEZONE_OFFSET: platformBranding.timezone ${value} is an offset from UTC, not a time zone; send an IANA zone name such as ${example}`;
    case 'UNKNOWN':
      return `PLATFORM_TIMEZONE_UNKNOWN: platformBranding.timezone ${value} is not a time zone; send an IANA zone name such as ${example}`;
    case 'NOT_A_ZONE_NAME':
      return `PLATFORM_TIMEZONE_NOT_A_ZONE_NAME: platformBranding.timezone ${value} is an abbreviation or an alias, not a zone name; send the zone itself, such as ${example}`;
    case 'NOT_IN_DATABASE':
      return `PLATFORM_TIMEZONE_NOT_IN_DATABASE: platformBranding.timezone ${value} is not in this database's time zone data; choose another zone or update the database's tz data`;
  }
}
