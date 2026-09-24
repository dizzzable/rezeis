import { SubscriptionStatus } from '@prisma/client';

/**
 * "NO END DATE" ON THE REMNAWAVE WIRE — the one place that says how a
 * subscription without an end (`expiresAt = null`, a plan bought for ever) is
 * written into a panel profile, and how a profile's date is read back.
 *
 * ── Why a sentinel ──────────────────────────────────────────────────────────
 *
 * A Remnawave profile always has a date: `expireAt` is required on
 * `POST /api/users` and optional-but-future on `PATCH /api/users` (3.2.1 to
 * 3.4.4, `create-user.command.ts` / `update-user.command.ts`), and the panel
 * expires the profile when it passes. rezeis had no word for "never": a CREATE
 * sent now + 30 days for a lifetime row and every UPDATE left the date out, so
 * Remnawave cut the customer off at day 30 — and each read-back then copied
 * that date onto the row, which stopped being lifetime.
 *
 * ── Why this date ───────────────────────────────────────────────────────────
 *
 * The year 2099 IS Remnawave's own "no end": its subscription headers report
 * `expire=0` (none) to client apps for a date in 2099
 * (`get-user-info.headers.ts`: `getFullYear() !== 2099`), and its UI offers
 * «до 2099 года» as the choice for "for ever". 31 December at 00:00 UTC is in
 * 2099 on every clock from UTC−12 to UTC+14, so the panel's
 * `getFullYear()` agrees whatever zone its server runs in. It must stay in
 * 2099 for client apps to show "∞"; it may move within the year.
 */
export const PANEL_NO_END_EXPIRE_AT = '2099-12-31T00:00:00.000Z';

/**
 * The first instant a profile's date means "no end" when read back:
 * 2099-01-01 00:00 in UTC+14, the earliest moment that is already 2099
 * anywhere.
 *
 * Not the sentinel itself: Remnawave's «до 2099 года» sets TODAY's month, day
 * and time in 2099, in the operator's own time zone, and a profile made that
 * way means "for ever" just as ours does. Nothing sold reaches it by a
 * duration — it is seventy-odd years out — and every later date an operator
 * might type for "never" (2100, 9999) is past it as well. The sentinel must
 * stay at or after it (`panel-expiry.spec.ts` holds the two together).
 */
export const PANEL_NO_END_FROM = new Date('2098-12-31T10:00:00.000Z');

/** What a PUSH sends for a subscription's expiry: its date, or the sentinel for none. */
export function toPanelExpireAt(expiresAt: Date | null): string {
  return expiresAt === null ? PANEL_NO_END_EXPIRE_AT : expiresAt.toISOString();
}

/**
 * A panel profile's `expireAt` as rezeis holds an expiry:
 *  - `null`: no end — a date at or after {@link PANEL_NO_END_FROM};
 *  - a `Date`: that date;
 *  - `undefined`: the profile did not state a readable one, which a writer
 *    reads as "leave the column alone", never as "no end".
 *
 * The panel's JSON is not validated on its way here, so a string or a `Date`
 * (a test double) is read, and anything else says nothing.
 */
export function panelExpiryToLocal(raw: unknown): Date | null | undefined {
  let instant: number;
  if (raw instanceof Date) {
    instant = raw.getTime();
  } else if (typeof raw === 'string' && raw.length > 0) {
    instant = Date.parse(raw);
  } else {
    return undefined;
  }
  if (Number.isNaN(instant)) return undefined;
  return instant >= PANEL_NO_END_FROM.getTime() ? null : new Date(instant);
}

/**
 * A SUBSCRIPTION WITH NO END TAKES NO DATE FROM REMNAWAVE — the guard every
 * read-back applies before it writes a panel profile's state onto a row whose
 * own `expiresAt` is `null`.
 *
 * Such a date is either the thirty days an older CREATE gave a lifetime row,
 * or an edit made in Remnawave's own UI; neither ends a subscription sold
 * without an end — that is changed in the panel, which pushes it. So a stated
 * DATE is dropped, and so is a stated EXPIRED, which Remnawave derives from
 * that date alone. A stated "no end" (`null`) and every other status go out as
 * the writer built them.
 *
 * `localExpiresAt` `undefined` means the writer did not read the row's expiry,
 * and changes nothing.
 */
export function withLocalOpenEndKept<T extends object>(data: T, localExpiresAt: Date | null | undefined): T {
  if (localExpiresAt !== null) return data;
  const { expiresAt, status, ...rest } = data as T & { readonly expiresAt?: unknown; readonly status?: unknown };
  return {
    ...rest,
    ...(expiresAt instanceof Date ? {} : expiresAt === undefined ? {} : { expiresAt }),
    ...(status === undefined || (expiresAt instanceof Date && status === SubscriptionStatus.EXPIRED) ? {} : { status }),
  } as T;
}
