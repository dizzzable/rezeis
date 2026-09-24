/**
 * The window of a term minted for a subscription that already exists (pure).
 *
 * ONE RULE FOR EVERY TERM THAT DESCRIBES A PERIOD ALREADY RUNNING — the
 * grandfather cutover, and the plan-change rotation — because they answer the
 * same question: "which stretch of time does this subscription's current paid
 * period cover?" The answer is: it ENDS where the subscription does
 * (`expiresAt`), and it starts at the preferred instant (`createdAt` for the
 * cutover, `now` for a rotation) unless that would not leave a window at all.
 *
 * ── Why a lapsed subscription gets a one-second window, not an open end ───
 *
 * `subscription_terms_generation_check` requires `ends_at > starts_at`. A
 * subscription whose `expiresAt` is at or before the preferred start — every
 * import that had already lapsed (`expiresAt <= createdAt`), every rotation of
 * an expired row — has no positive window from that start. The cutover used to
 * answer that with `endsAt = null`, an OPEN-ENDED term, and an open end is a
 * claim the subscription never made: it means "never expires" everywhere in
 * the product. The renewal producer refuses to append after one (`Cannot
 * append a renewal term after an open-ended term`), so a lapsed import that
 * paid to come back had its money taken and its renewal left unfulfilled.
 *
 * So the window is pulled back instead: it ends at `expiresAt` and starts one
 * second before it. Nothing of the period is left to describe; what matters is
 * that the TAIL is closed, so a renewal appends from `now` and the boundary
 * sweep treats UNTIL_SUBSCRIPTION_END add-ons as ended. The same device plan
 * migration has always used (`EXPIRED_TERM_WINDOW_MS`).
 *
 * `expiresAt = null` is the one open end left, and it is a real one: a
 * lifetime subscription.
 */
export const LAPSED_TERM_WINDOW_MS = 1_000;

export interface TermWindow {
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

export function boundedTermWindow(preferredStart: Date, expiresAt: Date | null): TermWindow {
  if (expiresAt === null) {
    return { startsAt: preferredStart, endsAt: null };
  }
  const latestStart = expiresAt.getTime() - LAPSED_TERM_WINDOW_MS;
  return {
    startsAt: new Date(Math.min(preferredStart.getTime(), latestStart)),
    endsAt: expiresAt,
  };
}
