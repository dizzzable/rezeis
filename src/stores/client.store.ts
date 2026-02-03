import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  clientService,
  type UserStats,
  type UserSubscription,
  type PlanWithDurations,
  type PaymentHistoryItem,
  type ReferralWithUser,
  type PartnerData,
  type Notification,
  type QRCodeData,
  type RenewSubscriptionResponse,
  type WithdrawReferralResponse,
  type PayoutRequestResponse,
  type CreatePaymentData,
  type Payment,
  type PayoutRequestData,
  type FullReferralInfo,
  type ReferralRule,
  type ReferralLevel,
  type ReferralEarning,
  type TopReferrer,
  type ExchangePointsResponse,
  type FullPartnerStats,
  type PartnerEarningItem,
  type PartnerPayoutItem,
  type PartnerReferralDetail,
  type ConversionStats,
} from '../api/client.service';
import type { User } from '../types/auth.types';
import type { ReferralStatistics } from '../types/entity.types';

/**
 * Client store state interface
 */
interface ClientState {
  // Data
  user: User | null;
  stats: UserStats | null;
  subscriptions: UserSubscription[];
  plans: PlanWithDurations[];
  payments: PaymentHistoryItem[];
  referrals: ReferralWithUser[];
  referralStats: ReferralStatistics | null;
  partner: PartnerData | null;
  notifications: Notification[];
  unreadNotificationsCount: number;

  // Referral system - detailed
  fullReferralInfo: FullReferralInfo | null;
  referralRules: ReferralRule[];
  referralHistory: ReferralEarning[];
  referralLevels: ReferralLevel[];
  topReferrers: TopReferrer[];

  // Partner system - detailed
  fullPartnerStats: FullPartnerStats | null;
  partnerEarnings: PartnerEarningItem[];
  partnerPayouts: PartnerPayoutItem[];
  partnerReferrals: PartnerReferralDetail[];
  conversionStats: ConversionStats | null;

  // Loading states
  isLoadingUser: boolean;
  isLoadingStats: boolean;
  isLoadingSubscriptions: boolean;
  isLoadingPlans: boolean;
  isLoadingPayments: boolean;
  isLoadingReferrals: boolean;
  isLoadingPartner: boolean;
  isLoadingNotifications: boolean;
  isProcessingPayment: boolean;
  isRenewing: boolean;
  isWithdrawing: boolean;
  isRequestingPayout: boolean;
  isLoadingReferralHistory: boolean;
  isLoadingPartnerEarnings: boolean;
  isLoadingPartnerPayouts: boolean;
  isLoadingConversionStats: boolean;
  isExchangingPoints: boolean;

  // Error states
  error: string | null;

  // Actions - Data fetching
  fetchUserProfile: () => Promise<void>;
  fetchUserStats: () => Promise<void>;
  fetchSubscriptions: () => Promise<void>;
  fetchPlans: () => Promise<void>;
  fetchPaymentHistory: (page?: number, limit?: number) => Promise<void>;
  fetchReferrals: () => Promise<void>;
  fetchPartnerData: () => Promise<void>;
  fetchNotifications: (page?: number, limit?: number, unreadOnly?: boolean) => Promise<void>;

  // Actions - Referral system detailed
  fetchFullReferralInfo: () => Promise<void>;
  fetchReferralRules: () => Promise<void>;
  fetchReferralHistory: (page?: number, limit?: number) => Promise<void>;
  fetchReferralLevels: () => Promise<void>;
  fetchTopReferrers: (limit?: number) => Promise<void>;
  exchangePoints: (type: string, amount: number) => Promise<ExchangePointsResponse | null>;

  // Actions - Partner system detailed
  fetchFullPartnerStats: () => Promise<void>;
  fetchPartnerEarnings: (page?: number, limit?: number) => Promise<void>;
  fetchPartnerPayouts: (page?: number, limit?: number) => Promise<void>;
  fetchPartnerReferrals: (level?: number) => Promise<void>;
  fetchConversionStats: (days?: number) => Promise<void>;

  // Actions - Operations
  renewSubscription: (id: number) => Promise<RenewSubscriptionResponse | null>;
  getSubscriptionQR: (id: number) => Promise<QRCodeData | null>;
  createPayment: (data: CreatePaymentData) => Promise<Payment | null>;
  withdrawReferralPoints: (amount: number) => Promise<WithdrawReferralResponse | null>;
  requestPayout: (data: PayoutRequestData) => Promise<PayoutRequestResponse | null>;
  markNotificationAsRead: (id: number) => Promise<boolean>;

  // Actions - State management
  clearError: () => void;
  reset: () => void;
}

/**
 * Initial state for the client store
 */
const initialState = {
  user: null,
  stats: null,
  subscriptions: [],
  plans: [],
  payments: [],
  referrals: [],
  referralStats: null,
  partner: null,
  notifications: [],
  unreadNotificationsCount: 0,
  fullReferralInfo: null,
  referralRules: [],
  referralHistory: [],
  referralLevels: [],
  topReferrers: [],
  fullPartnerStats: null,
  partnerEarnings: [],
  partnerPayouts: [],
  partnerReferrals: [],
  conversionStats: null,
  isLoadingUser: false,
  isLoadingStats: false,
  isLoadingSubscriptions: false,
  isLoadingPlans: false,
  isLoadingPayments: false,
  isLoadingReferrals: false,
  isLoadingPartner: false,
  isLoadingNotifications: false,
  isProcessingPayment: false,
  isRenewing: false,
  isWithdrawing: false,
  isRequestingPayout: false,
  isLoadingReferralHistory: false,
  isLoadingPartnerEarnings: false,
  isLoadingPartnerPayouts: false,
  isLoadingConversionStats: false,
  isExchangingPoints: false,
  error: null,
};

/**
 * Zustand store for client dashboard state management
 */
export const useClientStore = create<ClientState>()(
  devtools(
    (set, get) => ({
      ...initialState,

      // ============================================================================
      // Data Fetching Actions
      // ============================================================================

      fetchUserProfile: async () => {
        set({ isLoadingUser: true, error: null });
        try {
          const user = await clientService.getUserProfile();
          set({ user, isLoadingUser: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch user profile';
          set({ error: errorMessage, isLoadingUser: false });
        }
      },

      fetchUserStats: async () => {
        set({ isLoadingStats: true, error: null });
        try {
          const stats = await clientService.getUserStats();
          set({ stats, isLoadingStats: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch user stats';
          set({ error: errorMessage, isLoadingStats: false });
        }
      },

      fetchSubscriptions: async () => {
        set({ isLoadingSubscriptions: true, error: null });
        try {
          const subscriptions = await clientService.getUserSubscriptions();
          set({ subscriptions, isLoadingSubscriptions: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch subscriptions';
          set({ error: errorMessage, isLoadingSubscriptions: false });
        }
      },

      fetchPlans: async () => {
        set({ isLoadingPlans: true, error: null });
        try {
          const plans = await clientService.getAvailablePlans();
          set({ plans, isLoadingPlans: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch plans';
          set({ error: errorMessage, isLoadingPlans: false });
        }
      },

      fetchPaymentHistory: async (page = 1, limit = 10) => {
        set({ isLoadingPayments: true, error: null });
        try {
          const response = await clientService.getPaymentHistory(page, limit);
          set({ payments: response.items, isLoadingPayments: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch payment history';
          set({ error: errorMessage, isLoadingPayments: false });
        }
      },

      fetchReferrals: async () => {
        set({ isLoadingReferrals: true, error: null });
        try {
          const [referrals, stats] = await Promise.all([
            clientService.getReferrals(),
            clientService.getReferralStats(),
          ]);
          set({ referrals, referralStats: stats, isLoadingReferrals: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch referrals';
          set({ error: errorMessage, isLoadingReferrals: false });
        }
      },

      fetchPartnerData: async () => {
        set({ isLoadingPartner: true, error: null });
        try {
          const partner = await clientService.getPartnerData();
          set({ partner, isLoadingPartner: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch partner data';
          set({ error: errorMessage, isLoadingPartner: false });
        }
      },

      fetchNotifications: async (page = 1, limit = 10, unreadOnly = false) => {
        set({ isLoadingNotifications: true, error: null });
        try {
          const response = await clientService.getNotifications(page, limit, unreadOnly);
          set({
            notifications: response.items,
            unreadNotificationsCount: response.unreadCount,
            isLoadingNotifications: false,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch notifications';
          set({ error: errorMessage, isLoadingNotifications: false });
        }
      },

      // ============================================================================
      // Referral System Detailed Actions
      // ============================================================================

      fetchFullReferralInfo: async () => {
        set({ isLoadingReferrals: true, error: null });
        try {
          const info = await clientService.getFullReferralInfo();
          set({ fullReferralInfo: info, isLoadingReferrals: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch referral info';
          set({ error: errorMessage, isLoadingReferrals: false });
        }
      },

      fetchReferralRules: async () => {
        try {
          const rules = await clientService.getReferralRules();
          set({ referralRules: rules });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch referral rules';
          set({ error: errorMessage });
        }
      },

      fetchReferralHistory: async (page = 1, limit = 10) => {
        set({ isLoadingReferralHistory: true, error: null });
        try {
          const response = await clientService.getReferralHistory(page, limit);
          set({ referralHistory: response.items, isLoadingReferralHistory: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch referral history';
          set({ error: errorMessage, isLoadingReferralHistory: false });
        }
      },

      fetchReferralLevels: async () => {
        try {
          const levels = await clientService.getReferralLevels();
          set({ referralLevels: levels });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch referral levels';
          set({ error: errorMessage });
        }
      },

      fetchTopReferrers: async (limit = 10) => {
        try {
          const top = await clientService.getTopReferrers(limit);
          set({ topReferrers: top });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch top referrers';
          set({ error: errorMessage });
        }
      },

      exchangePoints: async (type: string, amount: number) => {
        set({ isExchangingPoints: true, error: null });
        try {
          const result = await clientService.exchangePoints(type, amount);
          set({ isExchangingPoints: false });
          if (result.success) {
            get().fetchFullReferralInfo();
            get().fetchUserStats();
          }
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to exchange points';
          set({ error: errorMessage, isExchangingPoints: false });
          return null;
        }
      },

      // ============================================================================
      // Partner System Detailed Actions
      // ============================================================================

      fetchFullPartnerStats: async () => {
        set({ isLoadingPartner: true, error: null });
        try {
          const stats = await clientService.getFullPartnerStats();
          set({ fullPartnerStats: stats, isLoadingPartner: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch partner stats';
          set({ error: errorMessage, isLoadingPartner: false });
        }
      },

      fetchPartnerEarnings: async (page = 1, limit = 10) => {
        set({ isLoadingPartnerEarnings: true, error: null });
        try {
          const response = await clientService.getPartnerEarningsHistory(page, limit);
          set({ partnerEarnings: response.items, isLoadingPartnerEarnings: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch partner earnings';
          set({ error: errorMessage, isLoadingPartnerEarnings: false });
        }
      },

      fetchPartnerPayouts: async (page = 1, limit = 10) => {
        set({ isLoadingPartnerPayouts: true, error: null });
        try {
          const response = await clientService.getPartnerPayoutsHistory(page, limit);
          set({ partnerPayouts: response.items, isLoadingPartnerPayouts: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch partner payouts';
          set({ error: errorMessage, isLoadingPartnerPayouts: false });
        }
      },

      fetchPartnerReferrals: async (level?: number) => {
        try {
          const referrals = await clientService.getReferralsByLevel(level);
          set({ partnerReferrals: referrals });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch partner referrals';
          set({ error: errorMessage });
        }
      },

      fetchConversionStats: async (days = 30) => {
        set({ isLoadingConversionStats: true, error: null });
        try {
          const stats = await clientService.getConversionStats(days);
          set({ conversionStats: stats, isLoadingConversionStats: false });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch conversion stats';
          set({ error: errorMessage, isLoadingConversionStats: false });
        }
      },

      // ============================================================================
      // Operation Actions
      // ============================================================================

      renewSubscription: async (id: number) => {
        set({ isRenewing: true, error: null });
        try {
          const result = await clientService.renewSubscription(id);
          set({ isRenewing: false });
          if (result.success) {
            // Refresh subscriptions after renewal
            get().fetchSubscriptions();
          }
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to renew subscription';
          set({ error: errorMessage, isRenewing: false });
          return null;
        }
      },

      getSubscriptionQR: async (id: number) => {
        try {
          return await clientService.getSubscriptionQR(id);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to get QR code';
          set({ error: errorMessage });
          return null;
        }
      },

      createPayment: async (data: CreatePaymentData) => {
        set({ isProcessingPayment: true, error: null });
        try {
          const payment = await clientService.createPayment(data);
          set({ isProcessingPayment: false });
          return payment;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to create payment';
          set({ error: errorMessage, isProcessingPayment: false });
          return null;
        }
      },

      withdrawReferralPoints: async (amount: number) => {
        set({ isWithdrawing: true, error: null });
        try {
          const result = await clientService.withdrawReferralPoints(amount);
          set({ isWithdrawing: false });
          if (result.success) {
            // Refresh referrals and stats after withdrawal
            get().fetchReferrals();
            get().fetchUserStats();
          }
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to withdraw points';
          set({ error: errorMessage, isWithdrawing: false });
          return null;
        }
      },

      requestPayout: async (data: PayoutRequestData) => {
        set({ isRequestingPayout: true, error: null });
        try {
          const result = await clientService.requestPayout(data);
          set({ isRequestingPayout: false });
          if (result.success) {
            // Refresh partner data after payout request
            get().fetchPartnerData();
          }
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to request payout';
          set({ error: errorMessage, isRequestingPayout: false });
          return null;
        }
      },

      markNotificationAsRead: async (id: number) => {
        try {
          const result = await clientService.markNotificationAsRead(id);
          if (result.success) {
            // Update local state
            const { notifications, unreadNotificationsCount } = get();
            const updatedNotifications = notifications.map((n) =>
              n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n
            );
            set({
              notifications: updatedNotifications,
              unreadNotificationsCount: Math.max(0, unreadNotificationsCount - 1),
            });
          }
          return result.success;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to mark notification as read';
          set({ error: errorMessage });
          return false;
        }
      },

      // ============================================================================
      // State Management Actions
      // ============================================================================

      clearError: () => {
        set({ error: null });
      },

      reset: () => {
        set(initialState);
      },
    }),
    { name: 'client-store' }
  )
);

// ============================================================================
// Selector Hooks
// ============================================================================

/**
 * Hook to get client dashboard data
 */
export function useClientDashboard() {
  return useClientStore((state) => ({
    user: state.user,
    stats: state.stats,
    subscriptions: state.subscriptions,
    isLoading: state.isLoadingUser || state.isLoadingStats || state.isLoadingSubscriptions,
    error: state.error,
  }));
}

/**
 * Hook to get client subscriptions
 */
export function useClientSubscriptions() {
  return useClientStore((state) => ({
    subscriptions: state.subscriptions,
    isLoading: state.isLoadingSubscriptions,
    isRenewing: state.isRenewing,
    error: state.error,
  }));
}

/**
 * Hook to get available plans
 */
export function useClientPlans() {
  return useClientStore((state) => ({
    plans: state.plans,
    isLoading: state.isLoadingPlans,
    isProcessingPayment: state.isProcessingPayment,
    error: state.error,
  }));
}

/**
 * Hook to get payment history
 */
export function useClientPayments() {
  return useClientStore((state) => ({
    payments: state.payments,
    isLoading: state.isLoadingPayments,
    error: state.error,
  }));
}

/**
 * Hook to get referrals
 */
export function useClientReferrals() {
  return useClientStore((state) => ({
    referrals: state.referrals,
    referralStats: state.referralStats,
    isLoading: state.isLoadingReferrals,
    isWithdrawing: state.isWithdrawing,
    error: state.error,
  }));
}

/**
 * Hook to get partner data
 */
export function useClientPartner() {
  return useClientStore((state) => ({
    partner: state.partner,
    isLoading: state.isLoadingPartner,
    isRequestingPayout: state.isRequestingPayout,
    error: state.error,
  }));
}

/**
 * Hook to get notifications
 */
export function useClientNotifications() {
  return useClientStore((state) => ({
    notifications: state.notifications,
    unreadCount: state.unreadNotificationsCount,
    isLoading: state.isLoadingNotifications,
    error: state.error,
  }));
}

/**
 * Hook to get detailed referral data
 */
export function useReferralDetails() {
  return useClientStore((state) => ({
    fullInfo: state.fullReferralInfo,
    rules: state.referralRules,
    history: state.referralHistory,
    levels: state.referralLevels,
    topReferrers: state.topReferrers,
    isLoadingInfo: state.isLoadingReferrals,
    isLoadingHistory: state.isLoadingReferralHistory,
    isExchangingPoints: state.isExchangingPoints,
    error: state.error,
  }));
}

/**
 * Hook to get detailed partner data
 */
export function usePartnerDetails() {
  return useClientStore((state) => ({
    fullStats: state.fullPartnerStats,
    earnings: state.partnerEarnings,
    payouts: state.partnerPayouts,
    referrals: state.partnerReferrals,
    conversionStats: state.conversionStats,
    isLoadingStats: state.isLoadingPartner,
    isLoadingEarnings: state.isLoadingPartnerEarnings,
    isLoadingPayouts: state.isLoadingPartnerPayouts,
    isLoadingConversion: state.isLoadingConversionStats,
    error: state.error,
  }));
}

export default useClientStore;
