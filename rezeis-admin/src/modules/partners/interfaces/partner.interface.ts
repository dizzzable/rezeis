import { PartnerAccrualStrategy, PartnerRewardType, WithdrawalStatus } from '@prisma/client';

export interface PartnerUserSummaryInterface {
  readonly id: string;
  readonly login: string | null;
  readonly username: string | null;
  readonly name: string | null;
  readonly telegramId: string | null;
  readonly createdAt: string;
}

export interface PartnerInterface {
  readonly id: string;
  readonly user: PartnerUserSummaryInterface;
  readonly balance: number;
  readonly totalEarned: number;
  readonly totalWithdrawn: number;
  readonly isActive: boolean;
  readonly referralsCount: number;
  readonly useGlobalSettings: boolean;
  readonly accrualStrategy: PartnerAccrualStrategy;
  readonly rewardType: PartnerRewardType;
  readonly level1Percent: string | null;
  readonly level2Percent: string | null;
  readonly level3Percent: string | null;
  readonly level1FixedAmount: number | null;
  readonly level2FixedAmount: number | null;
  readonly level3FixedAmount: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PartnerWithdrawalInterface {
  readonly id: string;
  readonly partnerId: string;
  readonly amount: number;
  readonly status: WithdrawalStatus;
  readonly method: string;
  readonly requisites: string;
  readonly adminComment: string | null;
  readonly processedBy: string | null;
  readonly processedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly partner: {
    readonly id: string;
    readonly isActive: boolean;
    readonly user: {
      readonly id: string;
      readonly name: string | null;
      readonly username: string | null;
      readonly telegramId: string | null;
    } | null;
  } | null;
}

export interface PartnerStatsInterface {
  readonly totalPartners: number;
  readonly activePartners: number;
  readonly pendingWithdrawals: number;
  readonly completedWithdrawals: number;
  readonly rejectedWithdrawals: number;
  readonly totalBalance: number;
  readonly totalEarned: number;
  readonly totalWithdrawn: number;
  /** Earnings ledger total (in minor units) for the trailing 30 days. */
  readonly earningsLast30d: number;
  /** Earnings ledger total (in minor units) for the trailing 7 days. */
  readonly earningsLast7d: number;
  /** Number of withdrawals approved/completed in the trailing 30 days. */
  readonly completedLast30d: number;
  readonly generatedAt: string;
}
