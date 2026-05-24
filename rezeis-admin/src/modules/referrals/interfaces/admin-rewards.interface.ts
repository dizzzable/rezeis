import { ReferralRewardType } from '@prisma/client';

import { ReferralUserSummaryInterface } from './referral.interface';

export interface AdminReferralRewardInterface {
  readonly id: string;
  readonly referralId: string;
  readonly user: ReferralUserSummaryInterface;
  readonly userTelegramId: string | null;
  readonly type: ReferralRewardType;
  readonly amount: number;
  readonly isIssued: boolean;
  readonly issuedAt: string | null;
  readonly issuedBy: string | null;
  readonly createdAt: string;
}

export interface AdminReferralRewardsListInterface {
  readonly items: readonly AdminReferralRewardInterface[];
  readonly total: number;
}

export interface BulkIssueRewardsResultInterface {
  readonly issued: number;
  readonly skipped: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ readonly id: string; readonly error: string }>;
}
