import apiClient from './client';
import type {
  User,
  Subscription,
  Plan,
  ApiResponse,
  Partner,
  Referral,
  ReferralStatistics,
} from '../types/entity.types';

/**
 * Client API service
 * Handles all API calls for the user-facing client dashboard
 */

// ============================================================================
// Types
// ============================================================================

/**
 * User statistics response
 */
export interface UserStats {
  subscriptions: {
    active_subscriptions: string;
    active_count: string;
    expiring_soon: string;
  };
  traffic: {
    total_traffic_used: string;
    total_traffic_limit: string;
  };
  referrals: {
    referral_count: string;
    total_points: string;
  };
}

/**
 * User subscription with plan details
 */
export interface UserSubscription extends Subscription {
  planName: string;
  planDescription?: string;
  trafficLimit?: number;
  deviceLimit?: number;
}

/**
 * Plan with durations and prices
 */
export interface PlanWithDurations extends Plan {
  durations: Array<{
    id: number;
    days: number;
    prices: Array<{
      currency: string;
      price: number;
    }>;
  }>;
}

/**
 * Payment creation data
 */
export interface CreatePaymentData {
  planId: number;
  durationId: number;
  gatewayId: number;
}

/**
 * Payment response
 */
export interface Payment {
  paymentId: number;
  amount: number;
  currency: string;
  planName: string;
  durationDays: number;
  gatewayName: string;
  status: string;
  paymentUrl: string;
}

/**
 * Payment history item
 */
export interface PaymentHistoryItem {
  id: number;
  userId: string;
  planId?: number;
  durationId?: number;
  gatewayId?: number;
  amount: number;
  currency: string;
  status: string;
  planName?: string;
  gatewayName?: string;
  createdAt: string;
}

/**
 * Payment history response
 */
export interface PaymentHistoryResponse {
  items: PaymentHistoryItem[];
  total: number;
  page: number;
  limit: number;
}

/**
 * QR code data response
 */
export interface QRCodeData {
  qrData: string;
  subscriptionUrl: string;
}

/**
 * Referral with user info
 */
export interface ReferralWithUser extends Referral {
  referredUsername?: string;
  referredFirstName?: string;
}

/**
 * Partner data with earnings
 */
export interface PartnerData extends Partner {
  totalEarningsCount: number;
  totalEarned: number;
  pendingPayouts: number;
  balance: number;
}

/**
 * Notification item
 */
export interface Notification {
  id: number;
  userId: string;
  title: string;
  message: string;
  type: string;
  isRead: boolean;
  createdAt: string;
  readAt?: string;
}

/**
 * Notifications response
 */
export interface NotificationsResponse {
  items: Notification[];
  total: number;
  unreadCount: number;
  page: number;
  limit: number;
}

/**
 * Withdraw referral points response
 */
export interface WithdrawReferralResponse {
  success: boolean;
  message: string;
  remainingPoints?: number;
}

/**
 * Payout request data
 */
export interface PayoutRequestData {
  amount: number;
  method: string;
  requisites: string;
}

/**
 * Payout request response
 */
export interface PayoutRequestResponse {
  success: boolean;
  message: string;
  newBalance?: number;
}

/**
 * Renew subscription response
 */
export interface RenewSubscriptionResponse {
  success: boolean;
  message: string;
  subscription?: {
    id: number;
    currentExpireAt: string;
    status: string;
  };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get current user profile
 * @returns Promise with user profile data
 */
export async function getUserProfile(): Promise<User> {
  const response = await apiClient.get<ApiResponse<{ user: User }>>('/api/client/me');
  return response.data.data.user;
}

/**
 * Get user statistics (traffic, days left, etc.)
 * @returns Promise with user statistics
 */
export async function getUserStats(): Promise<UserStats> {
  const response = await apiClient.get<ApiResponse<{ stats: UserStats }>>('/api/client/stats');
  return response.data.data.stats;
}

/**
 * Get user's subscriptions
 * @returns Promise with array of user subscriptions
 */
export async function getUserSubscriptions(): Promise<UserSubscription[]> {
  const response = await apiClient.get<ApiResponse<{ subscriptions: UserSubscription[] }>>('/api/client/subscriptions');
  return response.data.data.subscriptions;
}

/**
 * Get subscription details
 * @param id - Subscription ID
 * @returns Promise with subscription details
 */
export async function getSubscriptionDetails(id: number): Promise<UserSubscription | null> {
  const response = await apiClient.get<ApiResponse<{ subscription: UserSubscription | null }>>(`/api/client/subscriptions/${id}`);
  return response.data.data.subscription;
}

/**
 * Renew a subscription
 * @param id - Subscription ID
 * @returns Promise with renewal result
 */
export async function renewSubscription(id: number): Promise<RenewSubscriptionResponse> {
  const response = await apiClient.post<RenewSubscriptionResponse>(`/api/client/subscriptions/${id}/renew`);
  return response.data;
}

/**
 * Get QR code for subscription
 * @param id - Subscription ID
 * @returns Promise with QR code data
 */
export async function getSubscriptionQR(id: number): Promise<QRCodeData> {
  const response = await apiClient.get<ApiResponse<QRCodeData>>(`/api/client/subscriptions/${id}/qr`);
  return response.data.data;
}

/**
 * Get available plans for purchase
 * @returns Promise with array of available plans
 */
export async function getAvailablePlans(): Promise<PlanWithDurations[]> {
  const response = await apiClient.get<ApiResponse<{ plans: PlanWithDurations[] }>>('/api/client/plans');
  return response.data.data.plans;
}

/**
 * Create a payment for plan purchase
 * @param data - Payment creation data
 * @returns Promise with payment data
 */
export async function createPayment(data: CreatePaymentData): Promise<Payment> {
  const response = await apiClient.post<ApiResponse<{ payment: Payment }>>('/api/client/payment/create', data);
  return response.data.data.payment;
}

/**
 * Get payment history
 * @param page - Page number
 * @param limit - Items per page
 * @returns Promise with payment history
 */
export async function getPaymentHistory(page: number = 1, limit: number = 10): Promise<PaymentHistoryResponse> {
  const response = await apiClient.get<PaymentHistoryResponse>('/api/client/payment/history', {
    params: { page, limit },
  });
  return response.data;
}

/**
 * Get user's referrals
 * @returns Promise with array of referrals
 */
export async function getReferrals(): Promise<ReferralWithUser[]> {
  const response = await apiClient.get<ApiResponse<{ referrals: ReferralWithUser[] }>>('/api/client/referrals');
  return response.data.data.referrals;
}

/**
 * Get referral statistics
 * @returns Promise with referral stats
 */
export async function getReferralStats(): Promise<ReferralStatistics> {
  const response = await apiClient.get<ApiResponse<{ stats: ReferralStatistics }>>('/api/client/referrals/stats');
  return response.data.data.stats;
}

/**
 * Withdraw referral points
 * @param amount - Amount to withdraw
 * @returns Promise with withdrawal result
 */
export async function withdrawReferralPoints(amount: number): Promise<WithdrawReferralResponse> {
  const response = await apiClient.post<WithdrawReferralResponse>('/api/client/referrals/withdraw', { amount });
  return response.data;
}

/**
 * Get partner dashboard data
 * @returns Promise with partner data
 */
export async function getPartnerData(): Promise<PartnerData | null> {
  const response = await apiClient.get<ApiResponse<{ partner: PartnerData | null }>>('/api/client/partner');
  return response.data.data.partner;
}

/**
 * Request partner payout
 * @param data - Payout request data
 * @returns Promise with payout request result
 */
export async function requestPayout(data: PayoutRequestData): Promise<PayoutRequestResponse> {
  const response = await apiClient.post<PayoutRequestResponse>('/api/client/partner/payout', data);
  return response.data;
}

/**
 * Get user notifications
 * @param page - Page number
 * @param limit - Items per page
 * @param unreadOnly - Show only unread notifications
 * @returns Promise with notifications
 */
export async function getNotifications(page: number = 1, limit: number = 10, unreadOnly: boolean = false): Promise<NotificationsResponse> {
  const response = await apiClient.get<NotificationsResponse>('/api/client/notifications', {
    params: { page, limit, unreadOnly },
  });
  return response.data;
}

/**
 * Mark notification as read
 * @param id - Notification ID
 * @returns Promise with result
 */
export async function markNotificationAsRead(id: number): Promise<{ success: boolean }> {
  const response = await apiClient.patch<{ success: boolean }>(`/api/client/notifications/${id}/read`);
  return response.data;
}

// ============================================================================
// Referral System Types
// ============================================================================

export interface ReferralRule {
  id: string;
  name: string;
  description: string;
  type: 'first_purchase' | 'cumulative' | 'subscription';
  referrerReward: number;
  referredReward: number;
  minPurchaseAmount?: number;
  appliesToPlans?: string[];
  isActive: boolean;
  startDate?: string;
  endDate?: string;
}

export interface ReferralLevel {
  level: number;
  count: number;
  totalEarnings: number;
  commissionRate: number;
}

export interface ReferralEarning {
  id: string;
  amount: number;
  type: 'direct' | 'level2' | 'level3' | 'bonus';
  level: number;
  description?: string;
  status: 'pending' | 'approved' | 'paid' | 'cancelled';
  createdAt: string;
  paidAt?: string;
  referredUsername?: string;
  referredFirstName?: string;
}

export interface TopReferrer {
  userId: string;
  referralCount: number;
  totalRewards: number;
  rank: number;
  username?: string;
  firstName?: string;
  photoUrl?: string;
}

export interface ExchangePointsResponse {
  success: boolean;
  message: string;
  reward?: {
    type: string;
    description: string;
    value: string;
  };
}

export interface FullReferralInfo {
  stats: {
    totalReferrals: number;
    completedReferrals: number;
    activeReferrals: number;
    totalEarnings: number;
    confirmedEarnings: number;
  };
  levels: ReferralLevel[];
  recentReferrals: Array<{
    id: string;
    referredId: string;
    status: string;
    referrerReward: number;
    createdAt: string;
    referredUsername?: string;
    referredFirstName?: string;
    referredPhotoUrl?: string;
  }>;
}

// ============================================================================
// Partner System Types
// ============================================================================

export interface PartnerLevel {
  id: string;
  name: string;
  description: string;
  minReferrals: number;
  minEarnings: number;
  commissionRate: number;
  bonusAmount: number;
  privileges: string[];
}

export interface PartnerEarningItem {
  id: string;
  amount: number;
  commissionRate: number;
  status: string;
  createdAt: string;
  paidAt?: string;
  referredUsername?: string;
  referredFirstName?: string;
  planName?: string;
}

export interface PartnerPayoutItem {
  id: string;
  amount: number;
  method: string;
  status: string;
  transactionId?: string;
  notes?: string;
  createdAt: string;
  processedAt?: string;
}

export interface PartnerReferralDetail {
  id: string;
  referredUserId: string;
  level: number;
  status: string;
  clicks: number;
  conversions: number;
  totalEarnings: number;
  firstClickAt?: string;
  convertedAt?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  subscriptionCount: number;
}

export interface ConversionStats {
  totalClicks: number;
  totalUniqueClicks: number;
  totalConversions: number;
  totalEarnings: number;
  conversionRate: number;
  dailyStats: Array<{
    date: string;
    clicks: number;
    uniqueClicks: number;
    conversions: number;
    conversionRate: number;
    earnings: number;
  }>;
  periodDays: number;
}

export interface FullPartnerStats {
  partner: PartnerData;
  currentLevel: PartnerLevel | null;
  nextLevel: PartnerLevel | null;
  thirtyDaysStats: {
    totalClicks: number;
    totalConversions: number;
    totalEarnings: number;
    conversionRate: number;
  };
  earningsByStatus: Array<{
    status: string;
    count: number;
    total: number;
  }>;
}

// ============================================================================
// Referral System API Functions
// ============================================================================

export async function getFullReferralInfo(): Promise<FullReferralInfo> {
  const response = await apiClient.get<ApiResponse<{ info: FullReferralInfo }>>('/api/client/referrals/full-info');
  return response.data.data.info;
}

export async function getReferralRules(): Promise<ReferralRule[]> {
  const response = await apiClient.get<ApiResponse<{ rules: ReferralRule[] }>>('/api/client/referrals/rules');
  return response.data.data.rules;
}

export async function getReferralHistory(page: number = 1, limit: number = 10): Promise<{ items: ReferralEarning[]; total: number; page: number; limit: number }> {
  const response = await apiClient.get('/api/client/referrals/history', {
    params: { page, limit },
  });
  return response.data;
}

export async function getReferralLevels(): Promise<ReferralLevel[]> {
  const response = await apiClient.get<ApiResponse<{ levels: ReferralLevel[] }>>('/api/client/referrals/levels');
  return response.data.data.levels;
}

export async function getTopReferrers(limit: number = 10): Promise<TopReferrer[]> {
  const response = await apiClient.get<ApiResponse<{ top: TopReferrer[] }>>('/api/client/referrals/top', {
    params: { limit },
  });
  return response.data.data.top;
}

export async function exchangePoints(type: string, amount: number): Promise<ExchangePointsResponse> {
  const response = await apiClient.post<ExchangePointsResponse>('/api/client/referrals/exchange-points', { type, amount });
  return response.data;
}

// ============================================================================
// Partner System API Functions
// ============================================================================

export async function getFullPartnerStats(): Promise<FullPartnerStats | null> {
  const response = await apiClient.get<ApiResponse<{ stats: FullPartnerStats | null }>>('/api/client/partner/full-stats');
  return response.data.data.stats;
}

export async function getPartnerEarningsHistory(page: number = 1, limit: number = 10): Promise<{ items: PartnerEarningItem[]; total: number; page: number; limit: number }> {
  const response = await apiClient.get('/api/client/partner/earnings-history', {
    params: { page, limit },
  });
  return response.data;
}

export async function getPartnerPayoutsHistory(page: number = 1, limit: number = 10): Promise<{ items: PartnerPayoutItem[]; total: number; page: number; limit: number }> {
  const response = await apiClient.get('/api/client/partner/payouts-history', {
    params: { page, limit },
  });
  return response.data;
}

export async function getPartnerReferralDetails(referralId: string): Promise<PartnerReferralDetail | null> {
  const response = await apiClient.get<ApiResponse<{ details: PartnerReferralDetail | null }>>(`/api/client/partner/referral/${referralId}`);
  return response.data.data.details;
}

export async function getReferralsByLevel(level?: number): Promise<PartnerReferralDetail[]> {
  const response = await apiClient.get<ApiResponse<{ referrals: PartnerReferralDetail[] }>>('/api/client/partner/referrals-by-level', {
    params: level ? { level } : {},
  });
  return response.data.data.referrals;
}

export async function getConversionStats(days: number = 30): Promise<ConversionStats> {
  const response = await apiClient.get<ApiResponse<{ stats: ConversionStats }>>('/api/client/partner/conversion-stats', {
    params: { days },
  });
  return response.data.data.stats;
}

// ============================================================================
// Language & Translation API Functions
// ============================================================================

/**
 * Update user language preference
 * @param language - Language code ('ru' | 'en')
 * @returns Promise with update result
 */
export async function updateUserLanguage(language: string): Promise<{ success: boolean; language: string }> {
  const response = await apiClient.put<{ success: boolean; language: string }>('/api/client/language', { language });
  return response.data;
}

/**
 * Get user language preference
 * @returns Promise with language code
 */
export async function getUserLanguage(): Promise<string> {
  const response = await apiClient.get<ApiResponse<{ language: string }>>('/api/client/language');
  return response.data.data.language;
}

/**
 * Get translations for a language
 * @param lang - Language code ('ru' | 'en')
 * @returns Promise with translations object
 */
export async function getTranslations(lang: string): Promise<Record<string, string>> {
  const response = await apiClient.get<ApiResponse<{ translations: Record<string, string> }>>('/api/client/translations', {
    params: { lang },
  });
  return response.data.data.translations;
}

// ============================================================================
// Service Export
// ============================================================================

/**
 * Client service object
 */
export const clientService = {
  getUserProfile,
  getUserStats,
  getUserSubscriptions,
  getSubscriptionDetails,
  renewSubscription,
  getSubscriptionQR,
  getAvailablePlans,
  createPayment,
  getPaymentHistory,
  getReferrals,
  getReferralStats,
  withdrawReferralPoints,
  getPartnerData,
  requestPayout,
  getNotifications,
  markNotificationAsRead,
  // Referral system
  getFullReferralInfo,
  getReferralRules,
  getReferralHistory,
  getReferralLevels,
  getTopReferrers,
  exchangePoints,
  // Partner system
  getFullPartnerStats,
  getPartnerEarningsHistory,
  getPartnerPayoutsHistory,
  getPartnerReferralDetails,
  getReferralsByLevel,
  getConversionStats,
  // Language & Translation
  updateUserLanguage,
  getUserLanguage,
  getTranslations,
};
