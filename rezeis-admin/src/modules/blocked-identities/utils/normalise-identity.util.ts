import { BlockedIdentityKind } from '@prisma/client';

/**
 * Normalisation for blocklist values.
 *
 * The unique index is `(kind, value)`, so what "the same identity" means is
 * decided entirely here. Get it wrong and the list still looks correct in the
 * admin table while `User@Example.com` walks past an entry for
 * `user@example.com`.
 *
 * One function, used by BOTH the write path and every read path. Two copies is
 * how a list stops matching itself: the writer stores a trimmed value, a reader
 * looks up an untrimmed one, and the block silently does nothing.
 */

/** A value that could not be normalised into a usable identity. */
export interface NormalisedIdentityFailure {
  readonly ok: false;
  readonly reason: 'EMPTY' | 'NOT_NUMERIC' | 'NOT_AN_EMAIL' | 'TOO_LONG';
}

export interface NormalisedIdentitySuccess {
  readonly ok: true;
  readonly value: string;
}

export type NormalisedIdentity = NormalisedIdentitySuccess | NormalisedIdentityFailure;

/**
 * Longest value we will store. Telegram ids are ~10 digits and logins are
 * short; this exists so a paste of the wrong thing entirely (a log line, a
 * whole file) is refused with a reason instead of landing in the table.
 */
const MAX_VALUE_LENGTH = 254;

export function normaliseBlockedIdentity(
  kind: BlockedIdentityKind,
  raw: string,
): NormalisedIdentity {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'EMPTY' };
  if (trimmed.length > MAX_VALUE_LENGTH) return { ok: false, reason: 'TOO_LONG' };

  switch (kind) {
    case BlockedIdentityKind.TELEGRAM_ID: {
      // Operators paste ids in every shape a Telegram client shows them:
      // `123456789`, `id123456789`, `tg://user?id=123456789`, or with a stray
      // sign. Everything that is not a digit is dropped, and the result must
      // still be a plausible id — refusing loudly beats storing `""` under a
      // kind whose whole job is to match a numeric id.
      const digits = trimmed.replace(/\D+/g, '');
      if (digits.length === 0) return { ok: false, reason: 'NOT_NUMERIC' };
      // Leading zeros would make two spellings of one id look like two
      // identities to the unique index.
      const withoutLeadingZeros = digits.replace(/^0+(?=\d)/, '');
      return { ok: true, value: withoutLeadingZeros };
    }
    case BlockedIdentityKind.EMAIL: {
      const lowered = trimmed.toLowerCase();
      // Deliberately shallow: one `@`, something on each side, no spaces. A
      // full RFC validator would refuse addresses that really exist, and this
      // is a blocklist — the cost of accepting a malformed entry is a row that
      // matches nothing, while the cost of refusing a real address is an
      // operator who cannot block the person in front of them.
      if (!/^[^\s@]+@[^\s@]+$/.test(lowered)) return { ok: false, reason: 'NOT_AN_EMAIL' };
      return { ok: true, value: lowered };
    }
    case BlockedIdentityKind.WEB_LOGIN: {
      return { ok: true, value: trimmed.toLowerCase() };
    }
    default: {
      // Exhaustiveness: a new kind must decide its own normalisation rather
      // than inherit "trim and lower-case" by accident.
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/**
 * Normalises a Telegram id that arrives as a number or bigint (the shape every
 * caller inside this codebase actually holds), without going through string
 * cleaning that could silently accept nonsense.
 */
export function telegramIdToBlockedValue(telegramId: bigint | number | null | undefined): string | null {
  if (telegramId === null || telegramId === undefined) return null;
  const asString = telegramId.toString();
  return /^\d+$/.test(asString) ? asString : null;
}
