import { PartnerInterface, PartnerWithdrawalInterface } from './partner.interface';

export interface PartnerDetailOverviewInterface {
  readonly partner: PartnerInterface;
  readonly earningsLast30d: number;
  readonly earningsLast7d: number;
  readonly earningsAllTime: number;
  readonly transactionsLast30d: number;
  readonly transactionsAllTime: number;
  readonly referralsByLevel: { readonly l1: number; readonly l2: number; readonly l3: number };
}

export interface PartnerEarningInterface {
  readonly id: string;
  readonly level: number;
  readonly paymentAmount: number;
  readonly percent: string;
  readonly earnedAmount: number;
  readonly sourceTransactionId: string | null;
  readonly description: string | null;
  readonly createdAt: string;
  readonly referralUser: {
    readonly id: string;
    readonly name: string | null;
    readonly username: string | null;
    readonly telegramId: string | null;
  } | null;
}

export interface PartnerReferralInterface {
  readonly id: string;
  readonly level: number;
  readonly parentPartnerId: string | null;
  readonly createdAt: string;
  readonly user: {
    readonly id: string;
    readonly name: string | null;
    readonly username: string | null;
    readonly telegramId: string | null;
  } | null;
}

export interface PartnerAuditEventInterface {
  readonly id: string;
  readonly action: string;
  readonly adminUserId: string | null;
  readonly adminUsername: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export interface PartnerWithdrawalListInterface {
  readonly items: ReadonlyArray<PartnerWithdrawalInterface>;
  readonly total: number;
}

export interface PartnerEarningsListInterface {
  readonly items: ReadonlyArray<PartnerEarningInterface>;
  readonly total: number;
}

export interface PartnerReferralsListInterface {
  readonly items: ReadonlyArray<PartnerReferralInterface>;
  readonly total: number;
}

export interface PartnerAuditListInterface {
  readonly items: ReadonlyArray<PartnerAuditEventInterface>;
  readonly total: number;
}
