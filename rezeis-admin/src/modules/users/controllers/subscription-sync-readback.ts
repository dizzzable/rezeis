/**
 * WHAT ↻ SAYS IT DID with a subscription in the durable term model — the
 * `readback` block `POST /admin/users/subscriptions/:subscriptionId/sync` adds
 * to a successful answer.
 *
 * In the model a Remnawave read never writes the limits, and writes the expiry
 * only when nothing rezeis pushed is newer than the read; a profile holding
 * other limits than rezeis pushes gets rezeis' own sent back
 * (`term-model-readback.ts`). That verdict used to reach the audit row alone
 * (`user.sync.requested`), and the card went on printing the limits it had
 * just sent away as a drift for the operator to chase. So the answer carries
 * it too. A subscription outside the model gets no `readback` key, and the
 * card says what it always said.
 *
 * WHY A MODULE OF ITS OWN, with no imports: the admin SPA's
 * `subscription-sync-readback.test.tsx` imports the verdict list across the
 * package boundary and fails by name when a verdict has no words on the card —
 * the move `subscription-sync-refusals.ts` makes for the refusal codes, for
 * the same reason. The controller maps `PanelLimitsVerdict` onto this list
 * with an exhaustive table, so a verdict added there does not compile until it
 * is added here.
 */
export const SUBSCRIPTION_SYNC_PANEL_LIMITS = [
  /** The profile holds what rezeis pushes. */
  'IN_STEP',
  /** It did not: rezeis' own limits are being sent back. */
  'PUT_BACK',
  /** The read is older than rezeis' own last change, which is on its way or has landed. */
  'OUTRANKED',
  /** Not sent back: the panel reports the profile deleted. */
  'PROFILE_DELETED',
  /** Not sent back: another live subscription names the profile (a duplicate pair). */
  'SHARED_PROFILE',
  /** Not sent back: the row has no `remnawaveId`, and an UPDATE would provision a profile. */
  'UNLINKED',
] as const;

export type SubscriptionSyncPanelLimits = (typeof SUBSCRIPTION_SYNC_PANEL_LIMITS)[number];

export interface SubscriptionSyncReadback {
  /** What became of the limits Remnawave reported. */
  readonly panelLimits: SubscriptionSyncPanelLimits;
  /**
   * `false` only when a push of rezeis' own withheld an expiry: the read is
   * older than it, and Remnawave stated an expiry that differs from the row's.
   * Over two equal dates nothing was withheld, and this is `true`. (The audit
   * row records the verdict itself, `takeExpiry`.)
   */
  readonly expiryTaken: boolean;
  /** `PUT_BACK` only: the push queued, and the limits it sends — the subscription's own columns. */
  readonly limitsPutBack: {
    readonly syncJobId: string;
    /** Whole gigabytes; `null` is unlimited. */
    readonly trafficLimit: number | null;
    /** `<= 0` is unlimited. */
    readonly deviceLimit: number;
  } | null;
}
