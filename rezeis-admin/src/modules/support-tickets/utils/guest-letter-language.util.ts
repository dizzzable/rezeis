/**
 * The language a guest's letters are written in.
 *
 * A guest has no account, so nothing on record said which language they read,
 * and every letter went out in Russian. The cabinet says it now: the guest page
 * sends its own language, `ru` or `en`, with the message that opens the
 * conversation and with each reply after it.
 *
 * ── A header, not a body field ────────────────────────────────────────────
 *
 * The panel's global `ValidationPipe` refuses a property its DTO does not
 * declare (`forbidNonWhitelisted`, `main.ts`). A new body field sent to a panel
 * older than this one would have failed the whole request with a 400 — no
 * conversation at all, for a letter's language. A header such a panel does not
 * read, it ignores, so the two can ship in either order.
 *
 * ── Kept on the message it came with ──────────────────────────────────────
 *
 * `SupportTicketMessage.metadata.locale`, not a column on the guest: no
 * migration, and the language a guest last wrote in is the one their next
 * letter should be in. A letter reads the newest guest message that carries
 * one. None — a conversation opened from a cabinet older than this, or a value
 * this does not know — is Russian, as every guest letter was before.
 */
export type GuestLetterLanguage = 'ru' | 'en';

/** The header the cabinet sends the guest page's language in. */
export const GUEST_LOCALE_HEADER = 'x-support-guest-locale';

/**
 * How many of the guest's newest messages a letter looks through for a
 * language. A thread whose last twenty guest messages all came from an older
 * cabinet gets the Russian letter it always got.
 */
export const GUEST_LANGUAGE_LOOKBACK = 20;

/** The language a request names, when it is one a letter is written in; else `null`. */
export function readGuestLocale(value: unknown): GuestLetterLanguage | null {
  if (typeof value !== 'string') return null;
  const normalised = value.trim().toLowerCase();
  return normalised === 'ru' || normalised === 'en' ? normalised : null;
}

/** What a guest message's `metadata` holds of its language; nothing when the request named none. */
export function guestLocaleMetadata(
  locale: GuestLetterLanguage | null | undefined,
): { readonly locale: GuestLetterLanguage } | undefined {
  return locale === null || locale === undefined ? undefined : { locale };
}

/**
 * The language of the guest's next letter: the one their newest message that
 * names a language was written in (`messages` newest first), Russian when none
 * does.
 */
export function guestLetterLanguage(
  messages: ReadonlyArray<{ readonly metadata?: unknown }> | null | undefined,
): GuestLetterLanguage {
  for (const message of messages ?? []) {
    const metadata = message.metadata;
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    const locale = readGuestLocale((metadata as Record<string, unknown>)['locale']);
    if (locale !== null) return locale;
  }
  return 'ru';
}
