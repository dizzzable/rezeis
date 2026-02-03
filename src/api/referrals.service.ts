import apiClient from './client';
import type {
  Referral,
  ReferralRule,
  ReferralReward,
  ReferralStatistics,
  CreateReferralDTO,
  UpdateReferralDTO,
  CreateReferralRuleDTO,
  UpdateReferralRuleDTO,
  GetReferralsParams,
  GetReferralRulesParams,
  TopReferrer,
  PaginatedResult,
  ApiResponse,
} from '../types/entity.types';

/**
 * Referrals API service
 * Handles all API calls related to referral system management
 */

/**
 * Get referrals with pagination and filters
 * @param params - Query parameters for filtering and pagination
 * @returns Promise with paginated referrals
 */
export async function getReferrals(params: GetReferralsParams = {}): Promise<PaginatedResult<Referral>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<Referral>>>('/api/referrals', {
    params,
  });
  return response.data.data;
}

/**
 * Get referral by ID
 * @param id - Referral ID
 * @returns Promise with referral data
 */
export async function getReferral(id: string): Promise<Referral> {
  const response = await apiClient.get<ApiResponse<Referral>>(`/api/referrals/${id}`);
  return response.data.data;
}

/**
 * Create new referral
 * @param data - Referral creation data
 * @returns Promise with created referral
 */
export async function createReferral(data: CreateReferralDTO): Promise<Referral> {
  const response = await apiClient.post<ApiResponse<Referral>>('/api/referrals', data);
  return response.data.data;
}

/**
 * Update referral
 * @param id - Referral ID
 * @param data - Referral update data
 * @returns Promise with updated referral
 */
export async function updateReferral(id: string, data: UpdateReferralDTO): Promise<Referral> {
  const response = await apiClient.patch<ApiResponse<Referral>>(`/api/referrals/${id}`, data);
  return response.data.data;
}

/**
 * Complete referral
 * @param id - Referral ID
 * @returns Promise with updated referral
 */
export async function completeReferral(id: string): Promise<Referral> {
  const response = await apiClient.post<ApiResponse<Referral>>(`/api/referrals/${id}/complete`);
  return response.data.data;
}

/**
 * Cancel referral
 * @param id - Referral ID
 * @param reason - Cancellation reason
 * @returns Promise with updated referral
 */
export async function cancelReferral(id: string, reason?: string): Promise<Referral> {
  const response = await apiClient.post<ApiResponse<Referral>>(`/api/referrals/${id}/cancel`, {
    reason,
  });
  return response.data.data;
}

/**
 * Get referral statistics
 * @returns Promise with referral statistics
 */
export async function getReferralStatistics(): Promise<ReferralStatistics> {
  const response = await apiClient.get<ApiResponse<ReferralStatistics>>('/api/referrals/statistics');
  return response.data.data;
}

/**
 * Get top referrers
 * @returns Promise with top referrers list
 */
export async function getTopReferrers(): Promise<TopReferrer[]> {
  const response = await apiClient.get<ApiResponse<TopReferrer[]>>('/api/referrals/top-referrers');
  return response.data.data;
}

// ============================================
// Referral Rules
// ============================================

/**
 * Get referral rules with pagination and filters
 * @param params - Query parameters for filtering and pagination
 * @returns Promise with paginated referral rules
 */
export async function getReferralRules(params: GetReferralRulesParams = {}): Promise<ReferralRule[]> {
  const response = await apiClient.get<ApiResponse<ReferralRule[]>>('/api/referrals/rules', {
    params,
  });
  return response.data.data;
}

/**
 * Get active referral rules
 * @returns Promise with active referral rules
 */
export async function getActiveReferralRules(): Promise<ReferralRule[]> {
  const response = await apiClient.get<ApiResponse<ReferralRule[]>>('/api/referrals/rules/active');
  return response.data.data;
}

/**
 * Get referral rule by ID
 * @param id - Rule ID
 * @returns Promise with referral rule data
 */
export async function getReferralRule(id: string): Promise<ReferralRule> {
  const response = await apiClient.get<ApiResponse<ReferralRule>>(`/api/referrals/rules/${id}`);
  return response.data.data;
}

/**
 * Create new referral rule
 * @param data - Referral rule creation data
 * @returns Promise with created referral rule
 */
export async function createReferralRule(data: CreateReferralRuleDTO): Promise<ReferralRule> {
  const response = await apiClient.post<ApiResponse<ReferralRule>>('/api/referrals/rules', data);
  return response.data.data;
}

/**
 * Update referral rule
 * @param id - Rule ID
 * @param data - Referral rule update data
 * @returns Promise with updated referral rule
 */
export async function updateReferralRule(id: string, data: UpdateReferralRuleDTO): Promise<ReferralRule> {
  const response = await apiClient.put<ApiResponse<ReferralRule>>(`/api/referrals/rules/${id}`, data);
  return response.data.data;
}

/**
 * Delete referral rule
 * @param id - Rule ID
 * @returns Promise that resolves when rule is deleted
 */
export async function deleteReferralRule(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/referrals/rules/${id}`);
}

// ============================================
// Referral Rewards
// ============================================

/**
 * Get referral rewards
 * @param params - Query parameters for filtering
 * @returns Promise with paginated referral rewards
 */
export async function getReferralRewards(params: { status?: string; userId?: string; page?: number; limit?: number } = {}): Promise<PaginatedResult<ReferralReward>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<ReferralReward>>>('/api/referrals/rewards', {
    params,
  });
  return response.data.data;
}

/**
 * Approve referral reward
 * @param rewardId - Reward ID
 * @returns Promise with updated reward
 */
export async function approveReferralReward(rewardId: string): Promise<ReferralReward> {
  const response = await apiClient.post<ApiResponse<ReferralReward>>(`/api/referrals/rewards/${rewardId}/approve`);
  return response.data.data;
}

/**
 * Pay referral reward
 * @param rewardId - Reward ID
 * @param data - Payment data
 * @returns Promise with updated reward
 */
export async function payReferralReward(
  rewardId: string,
  data: { paidMethod?: string; transactionId?: string } = {}
): Promise<ReferralReward> {
  const response = await apiClient.post<ApiResponse<ReferralReward>>(`/api/referrals/rewards/${rewardId}/pay`, data);
  return response.data.data;
}

/**
 * Referrals service object
 */
export const referralsService = {
  // Referrals
  getReferrals,
  getReferral,
  createReferral,
  updateReferral,
  completeReferral,
  cancelReferral,
  getReferralStatistics,
  getTopReferrers,
  // Rules
  getReferralRules,
  getActiveReferralRules,
  getReferralRule,
  createReferralRule,
  updateReferralRule,
  deleteReferralRule,
  // Rewards
  getReferralRewards,
  approveReferralReward,
  payReferralReward,
};
