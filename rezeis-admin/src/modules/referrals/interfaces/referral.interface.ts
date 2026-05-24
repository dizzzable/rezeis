import { PurchaseChannel } from '@prisma/client';

export interface ReferralUserSummaryInterface {
  readonly id: string;
  readonly username: string | null;
  readonly name: string | null;
  readonly telegramId: string | null;
  readonly createdAt: string;
}

export interface ReferralInterface {
  readonly id: string;
  readonly referrer: ReferralUserSummaryInterface;
  readonly referred: ReferralUserSummaryInterface;
  readonly qualifiedAt: string | null;
  readonly createdAt: string;
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
