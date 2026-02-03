/**
 * Partner Entity Types
 * Defines types for partner program entities
 */

export type PartnerStatus = 'pending' | 'active' | 'suspended' | 'rejected';
export type EarningStatus = 'pending' | 'approved' | 'paid' | 'cancelled';
export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type PayoutMethod = 'bank_transfer' | 'paypal' | 'crypto' | 'other';

export interface Partner {
  id: string;
  userId: string;
  commissionRate: number;
  totalEarnings: number;
  paidEarnings: number;
  pendingEarnings: number;
  referralCode: string;
  referralCount: number;
  payoutMethod: PayoutMethod | null;
  payoutDetails: Record<string, unknown>;
  status: PartnerStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PartnerEarning {
  id: string;
  partnerId: string;
  referredUserId: string | null;
  subscriptionId: string | null;
  amount: number;
  commissionRate: number;
  status: EarningStatus;
  createdAt: Date;
  paidAt: Date | null;
}

export interface PartnerPayout {
  id: string;
  partnerId: string;
  amount: number;
  method: PayoutMethod;
  status: PayoutStatus;
  transactionId: string | null;
  notes: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface CreatePartnerDto {
  userId: string;
  commissionRate?: number;
  payoutMethod?: PayoutMethod;
  payoutDetails?: Record<string, unknown>;
  referralCode?: string;
}

export interface UpdatePartnerDto {
  commissionRate?: number;
  payoutMethod?: PayoutMethod;
  payoutDetails?: Record<string, unknown>;
  status?: PartnerStatus;
  totalEarnings?: number;
  paidEarnings?: number;
  pendingEarnings?: number;
  referralCount?: number;
}

export interface CreatePayoutDto {
  amount: number;
  method: PayoutMethod;
  notes?: string;
}

export interface ProcessPayoutDto {
  transactionId?: string;
  notes?: string;
}

export interface PartnerFilters {
  status?: PartnerStatus;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PartnerStats {
  totalPartners: number;
  pendingPartners: number;
  activePartners: number;
  suspendedPartners: number;
  totalEarnings: number;
  totalPaid: number;
  totalPending: number;
  totalReferrals: number;
}

export interface PartnerDashboard {
  partner: Partner;
  earnings: {
    total: number;
    paid: number;
    pending: number;
  };
  recentEarnings: PartnerEarning[];
  recentPayouts: PartnerPayout[];
  referrals: number;
}

export interface PayoutFilters {
  status?: PayoutStatus;
  partnerId?: string;
  page?: number;
  limit?: number;
}

export interface EarningFilters {
  status?: EarningStatus;
  partnerId?: string;
  page?: number;
  limit?: number;
}
