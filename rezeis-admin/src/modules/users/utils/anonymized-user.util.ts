/**
 * THE ROWS IN `users` THAT ARE NOT CUSTOMERS.
 *
 * «Удалить полностью» removes an account and everything about it, but the
 * operator's books are not the account's to take: a payment that happened
 * happened, and dropping it would silently rewrite the revenue already
 * reported for a closed month. So the protected rows — transactions, promocode
 * activations, referral rewards and points exchanges, the partner ledger — are
 * moved onto a fresh row that carries no identity at all, and `anonymizedAt`
 * marks it.
 *
 * Such a row is not a person. It has no Telegram id, no e-mail, no login and
 * no name; it holds no subscription, reaches no channel and cannot sign in.
 * Counting it as a customer would inflate «Всего пользователей» by one for
 * every deletion and put a blank line in the list.
 *
 * ── Where this is NOT applied, and why ────────────────────────────────────
 *
 * Reads that answer a question about MONEY or ACQUISITION must keep it: the
 * whole point of the holder is that revenue, refunds, the partner ledger and
 * the per-placement payback stay whole. A search by Telegram id, name or
 * e-mail needs nothing either — the holder has none of them and matches
 * nothing. Broadcast delivery is the same: no chat to write to and no browser
 * subscribed.
 *
 * `test/anonymized-users-are-not-customers.spec.ts` holds the list of readers
 * that must carry the filter, so the next one added is not forgotten.
 */

/** Spread into a `where` on `User` to leave the holders out. */
export const NOT_ANONYMIZED_USER = { anonymizedAt: null } as const;

/**
 * ── The same rule in hand-written SQL ─────────────────────────────────────
 *
 * Two analytics reads count people in `Prisma.sql`, which takes a fragment
 * rather than an object and so cannot spread the constant above. They spell
 * the predicate out — `"anonymized_at" IS NULL` — and
 * `test/anonymized-users-are-not-customers.spec.ts` names them, so the second
 * form of the rule is held to the first.
 */
