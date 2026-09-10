/**
 * Pure CSV helpers for raw registration-snapshot export (S7).
 * No Nest / Prisma dependencies — unit-testable in isolation.
 */

export const REGISTRATION_EXPORT_HEADERS = [
  'user_id',
  'telegram_id',
  'username',
  'created_at',
  'registration_ip',
  'registration_user_agent',
  'registration_referer',
  'registration_utm_json',
  'registration_channel',
  'acquisition_placement_id',
  'acquisition_at',
] as const;

export type RegistrationExportHeader = (typeof REGISTRATION_EXPORT_HEADERS)[number];

export interface RegistrationExportRow {
  readonly id: string;
  readonly telegramId: bigint | number | string | null;
  readonly username: string | null;
  readonly createdAt: Date | string;
  readonly registrationIp: string | null;
  readonly registrationUserAgent: string | null;
  readonly registrationReferer: string | null;
  readonly registrationUtm: unknown;
  readonly registrationChannel: string | null;
  readonly acquisitionPlacementId: string | null;
  readonly acquisitionAt: Date | string | null;
}

export const REGISTRATION_EXPORT_DEFAULT_LIMIT = 1000;
export const REGISTRATION_EXPORT_MAX_LIMIT = 5000;

/** Strict ISO date (`YYYY-MM-DD`) or datetime with optional `Z` / offset. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse a strict ISO date/datetime. Rejects overflow calendars (`2026-02-31`),
 * non-ISO strings (`July 1, 2026`), and bare timestamps that `Date` would coerce.
 * Returns UTC Date or null when invalid.
 */
export function parseStrictIsoDate(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let year: number;
  let month: number;
  let day: number;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let ms = 0;

  const dateOnly = ISO_DATE_RE.exec(trimmed);
  if (dateOnly) {
    year = Number(dateOnly[1]);
    month = Number(dateOnly[2]);
    day = Number(dateOnly[3]);
  } else {
    const dt = ISO_DATETIME_RE.exec(trimmed);
    if (!dt) return null;
    year = Number(dt[1]);
    month = Number(dt[2]);
    day = Number(dt[3]);
    hour = Number(dt[4]);
    minute = Number(dt[5]);
    second = Number(dt[6]);
    const frac = trimmed.match(/\.(\d{1,3})/);
    if (frac) {
      ms = Number(frac[1].padEnd(3, '0'));
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // Construct in UTC and reject calendar overflow (Feb 31 → Mar).
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day ||
    utc.getUTCHours() !== hour ||
    utc.getUTCMinutes() !== minute ||
    utc.getUTCSeconds() !== second
  ) {
    return null;
  }

  // For datetime with explicit offset, re-parse via Date only after shape OK
  // so Z/+offset is honoured; date-only stays UTC midnight.
  if (dateOnly) {
    return utc;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

/** Clamp limit into [1, MAX]; invalid → default. */
export function clampExportLimit(limit: number | undefined | null): number {
  if (limit == null || !Number.isFinite(limit)) {
    return REGISTRATION_EXPORT_DEFAULT_LIMIT;
  }
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  if (n > REGISTRATION_EXPORT_MAX_LIMIT) return REGISTRATION_EXPORT_MAX_LIMIT;
  return n;
}

export function mapRegistrationRow(row: RegistrationExportRow): string[] {
  return [
    row.id,
    row.telegramId == null ? '' : String(row.telegramId),
    row.username ?? '',
    toIso(row.createdAt),
    row.registrationIp ?? '',
    row.registrationUserAgent ?? '',
    row.registrationReferer ?? '',
    stringifyUtm(row.registrationUtm),
    row.registrationChannel ?? '',
    row.acquisitionPlacementId ?? '',
    row.acquisitionAt == null ? '' : toIso(row.acquisitionAt),
  ];
}

export function renderRegistrationCsv(rows: readonly RegistrationExportRow[]): string {
  const header = [...REGISTRATION_EXPORT_HEADERS];
  const body = rows.map(mapRegistrationRow);
  return renderCsv(header, body);
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function stringifyUtm(utm: unknown): string {
  if (utm == null) return '';
  if (typeof utm === 'string') return utm;
  try {
    return JSON.stringify(utm);
  } catch {
    return '';
  }
}

const BOM = '\ufeff';

/**
 * The first LINE of the file, and the reason it exists is a Russian keyboard.
 *
 * Excel does not split a CSV on the comma. It splits on the WINDOWS LIST
 * SEPARATOR, which is `;` on a ru-RU install — so a comma-delimited file opened
 * by double-click on the operator's own laptop arrives as ONE COLUMN, with each
 * row's whole text crammed into cell A. Nothing about it looks like an error:
 * the file downloaded, it opened, and the data is "there".
 *
 * `sep=,` is Excel's own escape hatch for exactly this, honoured in every
 * locale, and it has to be the first line of the DECODED TEXT — after the BOM,
 * which marks the bytes' encoding rather than being a line, and before the
 * header. Get that order wrong and Excel either mis-reads the Cyrillic (BOM not
 * first) or takes `sep=,` for the header row (`sep=` after the header).
 *
 * ── THE TRADE-OFF, stated here rather than discovered later ──────────────────
 *
 * `sep=,` is an Excel extension, not RFC 4180. The file stays parseable — every
 * line is still well-formed, the quoting rule is unchanged, and the delimiter is
 * still the standard comma — but a non-Excel reader sees one extra leading row,
 * so `pandas.read_csv(path, skiprows=1)` rather than a bare `read_csv`.
 *
 * The alternative was emitting `;` as the delimiter, and it is worse twice over:
 * it fixes ru-RU by breaking en-US, whose list separator IS the comma, and it
 * puts a non-standard delimiter in front of every script as well. This way the
 * one concession is a documented first line, and only Excel needs it.
 */
const EXCEL_SEPARATOR_HINT = 'sep=,';

/**
 * A run of digits long enough that Excel loses some of them.
 *
 * Excel holds every number as a double and rounds anything longer to FIFTEEN
 * significant decimal digits. A 19-digit Telegram id therefore does not merely
 * *display* as `4.5E+18` — the cell no longer holds the id, and widening the
 * column or reformatting it as a number cannot bring the missing digits back.
 * The operator copies it into a support ticket and it addresses nobody.
 *
 * 16 and up, because 15 is the last length Excel keeps exactly. Shorter runs
 * can still show in scientific notation on a narrow column, but the value
 * underneath is intact — and decorating those as well would put `="…"` in front
 * of far more cells than the defect warrants.
 */
const EXCEL_LOSES_DIGITS = /^\d{16,}$/;

/**
 * The one CSV writer in this module, exported so the full user export uses it
 * rather than growing a second one.
 *
 * A second writer would be a second answer to the questions this one has
 * already settled and paid for: the BOM Excel needs to read UTF-8, CRLF line
 * endings, the `sep=,` line a ru-RU Excel needs to find the columns at all, the
 * text-forcing of ids Excel would otherwise round away, and — the one that
 * matters most — defanging a value that starts like a spreadsheet formula. A
 * username beginning with `=`, `+`, `-` or `@` is a formula to Excel, and it
 * runs when the operator opens the file. The customer chose that username.
 */
export function renderCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines: string[] = [EXCEL_SEPARATOR_HINT];
  lines.push(header.map(quote).join(','));
  for (const row of rows) {
    lines.push(row.map(quote).join(','));
  }
  return `${BOM}${lines.join('\r\n')}`;
}

function quote(value: string): string {
  let v = value === null || value === undefined ? '' : String(value);
  // Defang spreadsheet formula injection even when values are padded with
  // whitespace / control characters (tab, CR, LF, NUL, etc.).
  if (hasLeadingFormulaRisk(v)) {
    v = `'${v}`;
  } else if (EXCEL_LOSES_DIGITS.test(v)) {
    // `="…"` IS a formula, and that is not a hole in the branch above.
    //
    // It is the only in-file way to tell Excel "this cell is text", and it is
    // reachable ONLY for a value this writer has just proved is nothing but
    // digits — so there is no payload to smuggle through it. Anything that
    // ARRIVES looking like a formula still belongs to the defang branch; this
    // one is a literal the writer composes around input it has checked.
    //
    // The `else` is not an optimisation. The two branches are mutually
    // exclusive by construction — `^\d{16,}$` cannot start with `=`, `+`, `-`
    // or `@` — and saying so keeps a later edit from running them the other way
    // round and defanging a wrapper this file wrote itself.
    //
    // Cost to a non-Excel reader: the cell reads `="4593…"` instead of the bare
    // digits. That is recoverable with a strip; a rounded id is not.
    v = `="${v}"`;
  }
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** True when value (after leading whitespace/controls) starts with a formula char. */
function hasLeadingFormulaRisk(value: string): boolean {
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    // space, tab, CR, LF, NUL..US, DEL
    const isWsOrControl =
      code === 0x20 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x7f ||
      (code >= 0x00 && code <= 0x1f);
    if (!isWsOrControl) break;
    i += 1;
  }
  if (i >= value.length) return false;
  const first = value[i];
  return first === '=' || first === '+' || first === '-' || first === '@';
}
