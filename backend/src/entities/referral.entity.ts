/**
 * Referral Entity Types
 * 
 * Defines the structure and types for the referral/referrals system.
 */

import { User } from './user.entity.js';

/**
 * Referral Status
 */
export type ReferralStatus = 'active' | 'completed' | 'cancelled';

/**
 * Referral Reward Status
 */
export type ReferralRewardStatus = 'pending' | 'approved' | 'paid' | 'cancelled';

/**
 * Referral Rule Type
 */
export type ReferralRuleType = 'first_purchase' | 'cumulative' | 'subscription';

/**
 * Referral Rule
 */
export interface ReferralRule {
  id: string;
  name: string;
  description: string;
  type: ReferralRuleType;
  referrerReward: number;
  referredReward: number;
  minPurchaseAmount?: number;
  appliesToPlans?: string[];
  isActive: boolean;
  startDate?: Date;
  endDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Referral
 */
export interface Referral {
  id: string;
  referrerId: string;
  referredId: string;
  referralCode?: string;
  status: ReferralStatus;
  referrerReward: number;
  referredReward: number;
  ruleId?: string;
  completedAt?: Date;
  cancelledAt?: Date;
  cancelledReason?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Referral Reward
 */
export interface ReferralReward {
  id: string;
  referralId: string;
  userId: string;
  amount: number;
  status: ReferralRewardStatus;
  ruleId?: string;
  description?: string;
  paidAt?: Date;
  paidBy?: string;
  paidMethod?: string;
  transactionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Referral Statistics
 */
export interface ReferralStatistics {
  totalReferrals: number;
  activeReferrals: number;
  completedReferrals: number;
  totalRewardsPaid: number;
  pendingRewards: number;
  topReferrers: Array<{
    userId: string;
    referralCount: number;
    totalRewards: number;
  }>;
}

/**
 * Referral with relationships
 */
export interface ReferralWithRelations extends Referral {
  referrer?: User;
  referred?: User;
  rule?: ReferralRule;
}

/**
 * Referral Reward with relationships
 */
export interface ReferralRewardWithRelations extends ReferralReward {
  referral?: Referral;
  user?: User;
  rule?: ReferralRule;
}

/**
 * Create Referral Rule DTO
 */
export interface CreateReferralRuleDto {
  name: string;
  description: string;
  type: ReferralRuleType;
  referrerReward: number;
  referredReward: number;
  minPurchaseAmount?: number;
  appliesToPlans?: string[];
  isActive?: boolean;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Update Referral Rule DTO
 */
export interface UpdateReferralRuleDto {
  name?: string;
  description?: string;
  type?: ReferralRuleType;
  referrerReward?: number;
  referredReward?: number;
  minPurchaseAmount?: number;
  appliesToPlans?: string[];
  isActive?: boolean;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Create Referral DTO
 */
export interface CreateReferralDto {
  referrerId: string;
  referredId: string;
  referralCode?: string;
  ruleId?: string;
  referrerReward?: number;
  referredReward?: number;
  status?: ReferralStatus;
  notes?: string;
}

/**
 * Update Referral DTO
 */
export interface UpdateReferralDto {
  status?: ReferralStatus;
  completedAt?: Date;
  cancelledAt?: Date;
  cancelledReason?: string;
  notes?: string;
}

/**
 * Create Referral Reward DTO
 */
export interface CreateReferralRewardDto {
  referralId: string;
  userId: string;
  amount: number;
  ruleId?: string;
  description?: string;
}

/**
 * Update Referral Reward DTO
 */
export interface UpdateReferralRewardDto {
  status?: ReferralRewardStatus;
  paidAt?: Date;
  paidBy?: string;
  paidMethod?: string;
  transactionId?: string;
}

/**
 * Referral Filters
 */
export interface ReferralFilters {
  status?: ReferralStatus;
  referrerId?: string;
  referredId?: string;
  ruleId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/**
 * Referral Rule Filters
 */
export interface ReferralRuleFilters {
  isActive?: boolean;
  type?: ReferralRuleType;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/**
 * Referral Reward Filters
 */
export interface ReferralRewardFilters {
  status?: ReferralRewardStatus;
  userId?: string;
  referralId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}
