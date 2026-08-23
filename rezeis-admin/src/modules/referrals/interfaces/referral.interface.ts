import { PurchaseChannel } from '@prisma/client';

export interface ReferralUserSummaryInterface {
  readonly id: string;
  readonly username: string | null;
  readonly name: string | null;
  /**
   * The label an operator can always read for this user. Never empty for a
   * user that EXISTS: the resolution chain ends at the reiwa id.
   *
   * It exists because `name`/`username` do not identify a web sign-up.
   * `WebAuthService` creates those rows as `{ name: '', email }` with no
   * `username` and no `telegramId`, so the SPA's
   * `user?.name ?? user?.username ?? '-'` printed a dash for a referral edge
   * that is perfectly valid (`Referral.referrerId` is NOT NULL with a required
   * relation). Resolved server-side rather than in the SPA because the tail of
   * the chain lives on the joined `WebAccount`, which the SPA has no business
   * knowing about, and because the same rule already exists once in this
   * codebase - see `buildReferralUserDisplayName`.
   */
  readonly displayName: string;
  readonly telegramId: string | null;
  readonly createdAt: string;
}

/**
 * Wire spelling of the Prisma enum `ReferralInviteSource` (BOT | WEB |
 * UNKNOWN, `prisma/schema.prisma`).
 *
 * Spelled out as a literal union instead of aliasing the Prisma enum ON
 * PURPOSE. `mapReferral` assigns the column straight into this field, so
 * adding a fourth member to the schema stops THAT assignment from compiling
 * rather than silently forwarding a token the SPA has never seen and would
 * render through its `getSourceMeta` default.
 */
export type ReferralInviteSourceValue = 'BOT' | 'WEB' | 'UNKNOWN';

/**
 * Why the referral programme will pay this row's `referrer` NOTHING for this
 * registration, or `null` when it will pay them.
 *
 * `null` is a promise, not an absence: it means `createConfiguredRewards`
 * (`referral-qualification.service.ts`) creates a `ReferralReward` for this
 * row's `referrer` on the next qualifying payment. Every branch that makes it
 * return early instead has a member here, so the field can be read as
 * "will this row move money?" without re-deriving the engine's rules:
 *
 *   PARTNER_PROGRAMME      the earner is an ACTIVE partner. The engine skips
 *                          them on purpose - the partner engine pays them
 *                          instead, out of a different pot.
 *   REWARD_NOT_CONFIGURED  nothing is configured to pay at this level: the
 *                          programme is switched off (`enabled: false`), no
 *                          `reward` block exists at all, or the level's amount
 *                          is 0.
 */
export type ReferralPayoutBlockerValue = 'PARTNER_PROGRAMME' | 'REWARD_NOT_CONFIGURED';

/**
 * ONE ROW PER EARNER, not one row per database row.
 *
 * A registration has at most two people who get paid for it, and only the
 * first is a database row: `Referral.referredId` is `@unique`, so a user has
 * exactly one referrer, ever. The second-level earner is derived at payout
 * time by walking one step up (`createConfiguredRewards`), and this list
 * derives it the same way so the table can say WHICH level a payout is.
 *
 * THE ASYMMETRY, stated on purpose:
 *
 *   a level-1 row is a fact about the GRAPH - it exists because a database row
 *   exists, and it is emitted whether or not money moves. When money will not
 *   move it says so through `payoutBlockedBy`; it is never dropped, because
 *   the relationship is real and the operator needs to see it.
 *
 *   a level-2 row is a fact about MONEY - there is no database row behind it,
 *   so the only thing that could justify inventing one is a payout that will
 *   actually happen. It is emitted only when `createConfiguredRewards` would
 *   create the reward, and it therefore ALWAYS carries `payoutBlockedBy: null`.
 *
 * A consequence worth naming: a level-2 row absent from this list is not a
 * claim that no ancestor exists. It is a claim that no level-2 payout happens.
 */
export interface ReferralInterface {
  /**
   * A database id for a level-1 row; `derived:L2:<level-1 row id>` for a
   * level-2 row. See `DERIVED_LEVEL_2_ID_PREFIX` in `referrals.service.ts`.
   */
  readonly id: string;
  /** The person who EARNS at `level` - the grandparent on a level-2 row. */
  readonly referrer: ReferralUserSummaryInterface;
  readonly referred: ReferralUserSummaryInterface;
  /**
   * The level this row is PAID at: 1 = the direct referrer, 2 = the direct
   * referrer's own referrer. 3 exists only in rows imported from donor
   * systems - nothing organic writes it and nothing derives it.
   */
  readonly level: number;
  readonly inviteSource: ReferralInviteSourceValue;
  readonly qualifiedAt: string | null;
  readonly createdAt: string;
  /** See {@link ReferralPayoutBlockerValue}. Always `null` on a level-2 row. */
  readonly payoutBlockedBy: ReferralPayoutBlockerValue | null;
}

export interface ReferralInviteInterface {
  readonly id: string;
  readonly token: string;
  readonly inviter: ReferralUserSummaryInterface;
  readonly note: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface ReferralStatsInterface {
  /** Backwards-compatible total referrals count. */
  readonly totalReferrals: number;
  readonly qualifiedReferrals: number;
  readonly activeInvites: number;
  readonly consumedInvites: number;
  readonly generatedAt: string;
  // ── Frontend-aligned aliases ────────────────────────────────────────────
  /** Alias of `totalReferrals`, named after the SPA stats card. */
  readonly referrals: number;
  /** Total invites ever issued (active + consumed + revoked + expired). */
  readonly invites: number;
  /** Total reward rows. */
  readonly rewards: number;
  /** Reward rows with `isIssued = true`. */
  readonly issuedRewards: number;
}

export interface CreateReferralInviteResultInterface {
  readonly invite: ReferralInviteInterface;
}

// Re-exported here so the same type vocabulary is reused in DTOs without
// dragging the Prisma enum into the controller file.
export const REFERRAL_INVITE_CHANNELS: ReadonlyArray<keyof typeof PurchaseChannel> = [
  'WEB',
  'TELEGRAM',
];
