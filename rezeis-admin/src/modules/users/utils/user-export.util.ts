import { deriveClientType } from '../../remnawave/services/remnawave-extended-mappers';
import { renderCsv } from './registration-export.util';
import type { UserExportColumn } from './user-export.catalog';

/**
 * user-export.util
 * ────────────────
 * One user, one row — the projection, with no Nest and no Prisma in sight.
 *
 * Every cell is a string, and every string is produced here rather than by the
 * query, for a reason that has already cost this codebase a defect elsewhere:
 * a `bigint` handed to `String()` by accident, a `Date` rendered in the server's
 * locale, a `null` that becomes the four letters "null" in a column an operator
 * is about to filter on. Each of those is a value that looks like data.
 *
 * ── Dates are ISO, always ────────────────────────────────────────────────────
 *
 * Not the operator's locale, and not Excel's guess. An export is read by a
 * spreadsheet, a script and a person, and only one of the three can be asked
 * what `01/02/2026` means. ISO-8601 in UTC is the one form all three agree on.
 */

/** What the export needs to know about one user. Shaped by the service. */
export interface UserExportRow {
  readonly id: string;
  readonly telegramId: bigint | number | string | null;
  readonly username: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly language: string | null;
  readonly role: string | null;
  readonly referralCode: string | null;
  readonly isBlocked: boolean;
  readonly isBotBlocked: boolean;
  readonly createdAt: Date | string;
  readonly lastSeenAt: Date | string | null;
  readonly points: number | null;
  readonly personalDiscount: number | null;
  readonly pwaInstalledAt: Date | string | null;
  readonly lastSurface: string | null;
  readonly lastFormFactor: string | null;
  readonly lastOs: string | null;
  readonly onboardingCompletedAt: Date | string | null;
  readonly firstTrafficAt: Date | string | null;
  readonly registrationChannel: string | null;
  readonly acquisitionPlacementId: string | null;
  readonly acquisitionAt: Date | string | null;
  readonly registrationIp: string | null;
  readonly registrationUserAgent: string | null;
  readonly registrationReferer: string | null;
  readonly registrationUtm: unknown;
  /** The user's current subscription, when one was joined. */
  readonly subscription: UserExportSubscription | null;
  /** How many non-deleted subscriptions the user holds. */
  readonly subscriptionCount: number | null;
  /** Devices from the panel, already grouped for this user. */
  readonly devices: readonly UserExportDevice[] | null;
}

export interface UserExportSubscription {
  readonly status: string | null;
  readonly planName: string | null;
  readonly expiresAt: Date | string | null;
  readonly isTrial: boolean | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number | null;
}

export interface UserExportDevice {
  readonly hwid: string;
  readonly platform: string | null;
  /**
   * The client, as Remnawave reports it — `FlClash X/v0.3.2 …`, `INCY/3.6.2/…`.
   *
   * This is the only place the VPN client's NAME appears anywhere in the panel's
   * data. `appVersion` on Remnawave's own device interface is a separate field
   * that most clients leave empty, which is why it is not carried here: a column
   * built on it would be blank for the clients an operator most wants to count.
   */
  readonly userAgent: string | null;
  readonly deviceName: string | null;
  /**
   * A `Date` on every supported panel build, and that is not pedantry.
   *
   * The contract schema declares `createdAt`/`updatedAt` as transform pipes to
   * `Date`, and declares no `lastSeenAt` at all. A reader that accepted only a
   * string therefore wrote an EMPTY cell for every device on every healthy
   * panel — and populated correctly only when the panel's answer failed the
   * schema and the raw JSON came through. It worked exactly when the panel was
   * wrong.
   */
  readonly lastSeenAt: Date | string | null;
}

/**
 * Several values in one cell.
 *
 * A pipe, not a comma: the cell is inside a CSV, and a comma would be correct
 * — the writer quotes it — but unreadable the moment somebody splits the file
 * by hand or pastes one cell somewhere. A pipe survives both.
 */
const JOIN = ' | ';

function isoOrEmpty(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function textOrEmpty(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * A boolean an operator can filter on in a spreadsheet.
 *
 * `yes`/`no` rather than `true`/`false` or `1`/`0`: Excel turns TRUE/FALSE into
 * its own boolean type and a bare 1/0 into a number, and both then sort and
 * filter as something other than the two words the column actually holds.
 */
function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value ? 'yes' : 'no';
}

/**
 * A limit, or the word for having none.
 *
 * `0` means unlimited throughout this product — the schema says so and the sync
 * layer encodes it — so exporting the number would put every unlimited customer
 * at the top of an ascending sort as "may connect no devices". That is the same
 * false zero the device count refuses to invent, in a column an operator
 * filters on.
 */
function limitOrUnlimited(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value <= 0 ? 'unlimited' : String(value);
}

function jsonOrEmpty(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * WHICH CLIENT THIS IS, out of the user agent.
 *
 * The VPN client is what an operator wants to group by — "who is on Happ", "how
 * many are still on INCY" — and Remnawave reports it in the User-Agent column
 * of its HWID table and nowhere else. The strings look like
 * `FlClash X/v0.3.2 Platform/windows` and `INCY/3.6.2/android Dalvik/2.1.0`.
 *
 * The parsing is NOT done here. `deriveClientType` already answers this
 * question for the admin request log, and two parsers would answer it
 * differently for the same customer: the log saying `FlClash` while a CSV an
 * operator segments on says `FlClash X` is worse than either answer alone,
 * because the two would be compared. One answer, in one place.
 */
/**
 * The VPN client's name, or nothing when the agent is not one.
 *
 * `deriveClientType` takes the leading RFC-9110 product token, which is the
 * right rule for `Happ/2.1.0` and `INCY/3.6.2/android` and the wrong one for
 * the agents that also land in the panel's HWID table: a subscription fetched
 * by a browser registers `Mozilla`, an Android app's HTTP stack registers
 * `okhttp` or `Dalvik`. Under a header that reads "Client app (Happ, INCY,
 * FlClash…)" an operator counting products reads those as three more products
 * and sizes their support decision on them.
 *
 * Named rather than pattern-matched, because the point is a decision about
 * SPECIFIC agents and a new client must not be silently swallowed by a clever
 * rule. `device_user_agents` still carries the raw string for anyone who wants
 * to look.
 */
const NOT_A_CLIENT_APP: ReadonlySet<string> = new Set([
  'mozilla',
  'okhttp',
  'dalvik',
  'curl',
  'wget',
  'python-requests',
  'axios',
  'go-http-client',
  'java',
  'postmanruntime',
  'node-fetch',
  'undici',
]);

function clientName(device: UserExportDevice): string {
  const name = deriveClientType(device.userAgent) ?? '';
  return NOT_A_CLIENT_APP.has(name.toLowerCase()) ? '' : name;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

/** One cell, for one column, for one user. */
export function projectCell(column: UserExportColumn, row: UserExportRow): string {
  const devices = row.devices ?? [];
  switch (column.id) {
    case 'reiwa_id':
      return row.id;
    case 'telegram_id':
      return textOrEmpty(row.telegramId);
    case 'username':
      return textOrEmpty(row.username);
    case 'name':
      return textOrEmpty(row.name);
    case 'email':
      return textOrEmpty(row.email);
    case 'language':
      return textOrEmpty(row.language);
    case 'role':
      return textOrEmpty(row.role);
    case 'referral_code':
      return textOrEmpty(row.referralCode);

    case 'is_blocked':
      return yesNo(row.isBlocked);
    case 'is_bot_blocked':
      return yesNo(row.isBotBlocked);
    case 'created_at':
      return isoOrEmpty(row.createdAt);
    case 'last_seen_at':
      return isoOrEmpty(row.lastSeenAt);
    case 'points':
      return textOrEmpty(row.points);
    case 'personal_discount':
      return textOrEmpty(row.personalDiscount);

    // DERIVED, and worth the derivation: an operator filtering "installed the
    // app" wants a column with two values in it, not a date column they have to
    // test for emptiness. The date is beside it for anyone who needs when.
    case 'pwa_installed':
      return yesNo(row.pwaInstalledAt !== null && row.pwaInstalledAt !== undefined);
    case 'pwa_installed_at':
      return isoOrEmpty(row.pwaInstalledAt);
    case 'last_surface':
      return textOrEmpty(row.lastSurface);
    case 'last_form_factor':
      return textOrEmpty(row.lastFormFactor);
    case 'last_os':
      return textOrEmpty(row.lastOs);
    case 'onboarding_completed_at':
      return isoOrEmpty(row.onboardingCompletedAt);
    case 'first_traffic_at':
      return isoOrEmpty(row.firstTrafficAt);

    case 'subscription_status':
      return textOrEmpty(row.subscription?.status ?? null);
    case 'subscription_plan':
      return textOrEmpty(row.subscription?.planName ?? null);
    case 'subscription_expires_at':
      // UNLIMITED IS AN ANSWER, and an empty cell is not it.
      //
      // `Subscription.expiresAt` is nullable and `null` means "never expires"
      // right across this product — the points-exchange population is literally
      // queried as `{ status: ACTIVE, expiresAt: null }`. Rendering that as an
      // empty cell made a lifetime customer indistinguishable from one with no
      // subscription at all and from one whose date we failed to read, in the
      // one column an operator filters on to decide who to write to.
      //
      // `limitOrUnlimited` two cases down already solved this shape for
      // `0 ⇒ unlimited`; this is the same decision for a date.
      return row.subscription === null || row.subscription === undefined
        ? ''
        : (row.subscription.expiresAt ?? null) === null
          ? 'unlimited'
          : isoOrEmpty(row.subscription.expiresAt);
    case 'subscription_is_trial':
      return yesNo(row.subscription?.isTrial ?? null);
    // GIGABYTES, and the column says so. `Subscription.trafficLimit` is GB —
    // the sync processor multiplies by 1024³ on its way to the panel — and this
    // column was called `…_bytes`, understating every figure by a factor of a
    // billion under a header an operator would filter on.
    case 'subscription_traffic_limit_gb':
      return limitOrUnlimited(row.subscription?.trafficLimit ?? null);
    case 'subscription_device_limit':
      return limitOrUnlimited(row.subscription?.deviceLimit ?? null);
    case 'subscriptions_total':
      return textOrEmpty(row.subscriptionCount);

    // EMPTY, NOT ZERO, when the panel was not asked or could not answer. A `0`
    // in a device count is a finding — "this person has connected nothing" —
    // and inventing it out of a failed sweep is the export telling the operator
    // something that is not true.
    // DEDUPED BY HWID, like every other device column. Two subscription rows
    // pointing at one panel profile — which donor imports produce, and which
    // the duplicate-merge service exists to clean up — concatenated the same
    // device list twice, so the count came out double the hwid list beside it.
    case 'device_count':
      return row.devices === null
        ? ''
        : String(uniqueNonEmpty(devices.map((device) => device.hwid)).length);
    case 'device_hwids':
      return uniqueNonEmpty(devices.map((device) => device.hwid)).join(JOIN);
    case 'device_apps':
      return uniqueNonEmpty(devices.map(clientName)).join(JOIN);
    case 'device_user_agents':
      // The raw strings, for the version and anything a future client puts in
      // there. `device_apps` is the one to group by; this is the one to read.
      return uniqueNonEmpty(devices.map((device) => device.userAgent ?? '')).join(JOIN);
    case 'device_platforms':
      return uniqueNonEmpty(devices.map((device) => device.platform ?? '')).join(JOIN);
    case 'device_models':
      // Remnawave's "Модель" column — `Windows 11 Pro (25H2)`, `vivo V2403A (16)`.
      return uniqueNonEmpty(devices.map((device) => device.deviceName ?? '')).join(JOIN);
    case 'device_last_seen_at': {
      const seen = devices
        .map((device) => {
          if (device.lastSeenAt === null || device.lastSeenAt === undefined) return 0;
          const at =
            device.lastSeenAt instanceof Date
              ? device.lastSeenAt.getTime()
              : Date.parse(device.lastSeenAt);
          return Number.isFinite(at) ? at : 0;
        })
        .filter((value) => value > 0);
      return seen.length === 0 ? '' : new Date(Math.max(...seen)).toISOString();
    }

    case 'registration_channel':
      return textOrEmpty(row.registrationChannel);
    case 'acquisition_placement_id':
      return textOrEmpty(row.acquisitionPlacementId);
    case 'acquisition_at':
      return isoOrEmpty(row.acquisitionAt);

    case 'registration_ip':
      return textOrEmpty(row.registrationIp);
    case 'registration_user_agent':
      return textOrEmpty(row.registrationUserAgent);
    case 'registration_referer':
      return textOrEmpty(row.registrationReferer);
    case 'registration_utm':
      return jsonOrEmpty(row.registrationUtm);

    default:
      // A column in the catalogue with no case here writes an empty cell, and
      // an empty cell is indistinguishable from missing data — so the guard
      // beside this file asserts the two lists cover each other exactly.
      return '';
  }
}

/** The whole file, for the columns the caller settled on. */
export function renderUserExportCsv(
  columns: readonly UserExportColumn[],
  rows: readonly UserExportRow[],
): string {
  return renderCsv(
    columns.map((column) => column.id),
    rows.map((row) => columns.map((column) => projectCell(column, row))),
  );
}
