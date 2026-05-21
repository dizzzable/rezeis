import { WithdrawalStatus } from '@prisma/client';

export interface PartnerUserSummaryInterface {
  readonly id: string;
  readonly login: string | null;
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
}

export interface PartnerStatsInterface {
  readonly totalPartners: number;
  readonly activePartners: number;
  readonly pendingWithdrawals: number;
  readonly completedWithdrawals: number;
  readonly totalBalance: number;
  readonly generatedAt: string;
}
