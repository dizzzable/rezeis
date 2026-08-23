/**
 * THE MACHINE-READABLE HALF of the three refusals
 * `POST /admin/users/subscriptions/:subscriptionId/sync` answers with.
 *
 * All three arrive as HTTP 200 with `{ synced: false, … }`, because none of
 * them is a failure: nothing is linked, the panel merely blinked, or the
 * profile is genuinely gone. The operator's next action differs for each —
 * link a profile / press it again / repair the link — and conflating the
 * middle one with the last is what sends somebody off repairing a link that
 * was never broken. So the admin SPA has to tell them apart.
 *
 * It used to tell them apart by matching the English `message` byte for byte,
 * em dash included. That worked, and it was one copy-edit away from silently
 * degrading all three to a generic "refused" notice — a non-success notice
 * still appears, so nothing looks broken; the operator just quietly stops
 * getting the specific guidance. A correct decision that stops reaching its
 * caller with no test failing is the exact defect this endpoint's whole
 * repair history is about, so the discriminator is now a code the wording
 * cannot move.
 *
 * SPELLING is lowercase snake_case, following `totp_enroll_reauth_required`
 * and every other discriminator this repository puts in a RESULT object
 * (`internal-signature.util.ts`'s `reason: 'stale' | 'mismatch'`,
 * `admin-auth.service.ts`'s `reason: 'totp_required'`). The SCREAMING_SNAKE
 * neighbours in `admin-safe-exception.filter.ts`'s `SAFE_PRODUCT_CODES` are a
 * different channel: that allowlist gates codes escaping from thrown
 * `HttpException` bodies, and none of these three is ever thrown.
 *
 * WHY A MODULE OF ITS OWN, and one with no imports at all: the admin SPA's
 * `subscription-sync-outcome.test.tsx` imports this file directly across the
 * package boundary and compares it against the SPA's own hand-written table,
 * so a code added or renamed here fails that test by name. Reaching across
 * from a TEST is deliberate and already blessed — see the header of
 * `web/src/features/rbac/rbac-catalog-parity.test.ts` and the invariant
 * `web/src/build-isolation.test.ts` enforces (nothing the production frontend
 * project COMPILES may reach out; tests may). Importing the controller itself
 * would drag Nest and Prisma into a jsdom worker, which is why the literals do
 * not live there.
 *
 * The `message` beside each code stays exactly as it was. It is the
 * human-readable half, it is what an older panel build falls back to during a
 * rolling deploy, and something else may already be reading it.
 */
export const SUBSCRIPTION_SYNC_REFUSAL_CODES = {
  /** No panel profile is linked. Nothing to sync — NOT an error condition. */
  notLinked: 'sync_no_profile_linked',
  /** Transient: an outage, an expired token, a 5xx, a timeout. Retry. */
  panelUnavailable: 'sync_panel_unavailable',
  /** The panel answered, and does not have this profile. The link IS broken. */
  profileMissing: 'sync_profile_missing',
} as const;

/** Every value above, as a union — so a typo is a compile error, not a 200. */
export type SubscriptionSyncRefusalCode =
  (typeof SUBSCRIPTION_SYNC_REFUSAL_CODES)[keyof typeof SUBSCRIPTION_SYNC_REFUSAL_CODES];
