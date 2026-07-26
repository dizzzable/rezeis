const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How recently an account must have been created for an advertising touch to
 * count as acquiring it. Wide enough to cover the gap between the click and the
 * end of registration (the web funnel attributes only once the account exists,
 * and a visitor can leave the form half-finished), narrow enough that a
 * long-standing customer who happens to open an ad link is not booked as a new
 * acquisition.
 */
export const NEW_ACCOUNT_MAX_AGE_MS = MS_PER_DAY;

/**
 * True when an advertising touch may claim `createdAt`'s account as acquired.
 *
 * Attribution used to be granted to any account with an empty
 * `acquisitionPlacementId`, so an advertisement shown to an existing audience
 * booked long-time customers as fresh registrations and their next renewal as
 * the placement's first purchase — the payback of a campaign came out several
 * times higher than reality, and the decision to scale that channel was made on
 * fiction.
 */
export function isNewAccountAtTouch(
  createdAt: Date | null | undefined,
  touchAt: Date = new Date(),
): boolean {
  if (createdAt === null || createdAt === undefined) {
    return false;
  }
  const ageMs = touchAt.getTime() - createdAt.getTime();
  if (!Number.isFinite(ageMs)) {
    return false;
  }
  // A negative age means the row is newer than the touch (clock skew between
  // containers) — still a brand-new account.
  return ageMs <= NEW_ACCOUNT_MAX_AGE_MS;
}

/**
 * Decides whether a first purchase still counts for the placement that
 * acquired the user. A conversion is attributed iff the purchase happened
 * **on or after** the first touch and **within** `windowDays` of it; later
 * purchases are organic.
 *
 * The window is inclusive of the boundary instant (`acquisitionAt + windowDays`)
 * so a purchase exactly `windowDays` later still attributes. A non-positive
 * window or a missing/`null` `acquisitionAt` means "no attribution".
 */
export function isWithinAttributionWindow(
  acquisitionAt: Date | null | undefined,
  purchaseAt: Date,
  windowDays: number,
): boolean {
  if (acquisitionAt === null || acquisitionAt === undefined) {
    return false;
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    return false;
  }
  const start = acquisitionAt.getTime();
  const purchase = purchaseAt.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(purchase)) {
    return false;
  }
  if (purchase < start) {
    return false;
  }
  const deadline = start + windowDays * MS_PER_DAY;
  return purchase <= deadline;
}

/** Whole days (rounded down, floored at 0) between two instants. */
export function daysBetween(from: Date, to: Date): number {
  const delta = to.getTime() - from.getTime();
  if (!Number.isFinite(delta) || delta <= 0) {
    return 0;
  }
  return Math.floor(delta / MS_PER_DAY);
}
