/**
 * Range guard for the Postgres `int8` columns this schema binds JS `BigInt`
 * values into — `User.telegramId` above all (`@db.BigInt`, `prisma/schema.prisma`).
 *
 * Why this is a util and not a `try { BigInt(x) } catch` at each call site: that
 * idiom was written repeatedly across this codebase, labelled "overflow", and
 * guarded nothing. JS `BigInt` is arbitrary precision, so it throws only on a
 * string that is not a number at all — and every one of those call sites had
 * already run `/^\d+$/` over the input, which rules exactly that out. The catch
 * block was unreachable. The value it was supposed to stop went on to Prisma,
 * got bound as an `int8` parameter, and came back from Postgres as
 * `22003 numeric field value out of range` — a 500, not the silently skipped
 * clause the comment promised. Long digit strings are precisely what an
 * operator pastes into a search box (an invoice number, a payment reference),
 * so this fired on the input most likely to have had an answer.
 *
 * The check that actually works is a range comparison. It lives here so there
 * is one of it.
 */

/** Largest value a Postgres `int8` column can hold: `2^63 - 1`. */
export const MAX_POSTGRES_BIGINT = 9223372036854775807n;

/** Smallest value a Postgres `int8` column can hold: `-2^63`. */
export const MIN_POSTGRES_BIGINT = -9223372036854775808n;

const UNSIGNED_DECIMAL = /^\d+$/;
const SIGNED_DECIMAL = /^-?\d+$/;

/**
 * Parses a Telegram id, returning `null` when the input cannot be one — either
 * because it is not a decimal string or because no `int8` column could store it.
 *
 * Deliberately UNSIGNED. Telegram user ids are positive, and every caller
 * previously reached its `BigInt()` through its own `/^\d+$/` gate, so a leading
 * `-` is not reachable from any of them; testing for it here would add a second
 * guard that never fires, which is the exact defect this file exists to delete.
 * `MIN_POSTGRES_BIGINT` therefore belongs to `parsePostgresBigInt` — whose input
 * really is unvalidated — and not to this function.
 */
export function parseTelegramId(value: string): bigint | null {
  if (!UNSIGNED_DECIMAL.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_POSTGRES_BIGINT ? parsed : null;
}

/**
 * Parses an operator-supplied decimal string into a value an `int8` column can
 * actually store, or `null`.
 *
 * Signed, unlike `parseTelegramId`, and both bounds are live: this is for
 * request bodies that reach `BigInt()` with no `class-validator` pattern in
 * front of them, where a leading `-` genuinely can arrive — and where it is
 * accepted and stored today, so rejecting it here would be a behaviour change
 * rather than a fix. `null` additionally covers input `BigInt()` would have
 * thrown on outright (`'abc'`, `''`), which at those sites surfaced as a 500.
 */
export function parsePostgresBigInt(value: string): bigint | null {
  if (!SIGNED_DECIMAL.test(value)) return null;
  const parsed = BigInt(value);
  return parsed >= MIN_POSTGRES_BIGINT && parsed <= MAX_POSTGRES_BIGINT ? parsed : null;
}
