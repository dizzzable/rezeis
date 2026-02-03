import { QueryClient } from '@tanstack/react-query';

/**
 * Default stale time for queries (5 minutes)
 */
const DEFAULT_STALE_TIME = 5 * 60 * 1000;

/**
 * Default cache time for queries (30 minutes)
 */
const DEFAULT_CACHE_TIME = 30 * 60 * 1000;

/**
 * Query client configuration for optimal caching
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data remains fresh for 5 minutes
      staleTime: DEFAULT_STALE_TIME,
      // Data is cached for 30 minutes (gcTime replaces cacheTime in v5)
      gcTime: DEFAULT_CACHE_TIME,
      // Refetch on window focus
      refetchOnWindowFocus: true,
      // Retry failed requests once
      retry: 1,
      // Retry delay increases exponentially
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      // Keep previous data while fetching new data
      placeholderData: (previousData: unknown) => previousData,
    },
    mutations: {
      // Retry mutations once
      retry: 1,
      // Retry delay
      retryDelay: 1000,
    },
  },
});

/**
 * Query keys for cache organization
 */
export const queryKeys = {
  /** User-related queries */
  user: {
    profile: ['user', 'profile'] as const,
    stats: ['user', 'stats'] as const,
    all: ['user'] as const,
  },
  /** Subscription-related queries */
  subscriptions: {
    list: ['subscriptions', 'list'] as const,
    detail: (id: number) => ['subscriptions', 'detail', id] as const,
    all: ['subscriptions'] as const,
  },
  /** Plan-related queries */
  plans: {
    list: ['plans', 'list'] as const,
    all: ['plans'] as const,
  },
  /** Payment-related queries */
  payments: {
    history: (page: number) => ['payments', 'history', page] as const,
    all: ['payments'] as const,
  },
  /** Referral-related queries */
  referrals: {
    list: ['referrals', 'list'] as const,
    stats: ['referrals', 'stats'] as const,
    fullInfo: ['referrals', 'fullInfo'] as const,
    rules: ['referrals', 'rules'] as const,
    history: (page: number) => ['referrals', 'history', page] as const,
    levels: ['referrals', 'levels'] as const,
    top: ['referrals', 'top'] as const,
    all: ['referrals'] as const,
  },
  /** Partner-related queries */
  partner: {
    data: ['partner', 'data'] as const,
    fullStats: ['partner', 'fullStats'] as const,
    earnings: (page: number) => ['partner', 'earnings', page] as const,
    payouts: (page: number) => ['partner', 'payouts', page] as const,
    conversion: (days: number) => ['partner', 'conversion', days] as const,
    all: ['partner'] as const,
  },
  /** Notification-related queries */
  notifications: {
    list: (page: number, unreadOnly: boolean) => ['notifications', 'list', page, unreadOnly] as const,
    all: ['notifications'] as const,
  },
} as const;

/**
 * Prefetch critical data for a user
 * Call this after login or on app initialization
 * @param userId - User ID
 */
export async function prefetchCriticalData(_userId: string): Promise<void> {
  const prefetchPromises = [
    // Prefetch user profile
    queryClient.prefetchQuery({
      queryKey: queryKeys.user.profile,
      queryFn: async () => {
        const response = await fetch(`/api/client/me`);
        if (!response.ok) throw new Error('Failed to fetch user profile');
        return response.json();
      },
      staleTime: 10 * 60 * 1000, // 10 minutes
    }),

    // Prefetch user stats
    queryClient.prefetchQuery({
      queryKey: queryKeys.user.stats,
      queryFn: async () => {
        const response = await fetch(`/api/client/stats`);
        if (!response.ok) throw new Error('Failed to fetch user stats');
        return response.json();
      },
      staleTime: 2 * 60 * 1000, // 2 minutes
    }),

    // Prefetch subscriptions
    queryClient.prefetchQuery({
      queryKey: queryKeys.subscriptions.list,
      queryFn: async () => {
        const response = await fetch(`/api/client/subscriptions`);
        if (!response.ok) throw new Error('Failed to fetch subscriptions');
        return response.json();
      },
      staleTime: 5 * 60 * 1000, // 5 minutes
    }),

    // Prefetch available plans
    queryClient.prefetchQuery({
      queryKey: queryKeys.plans.list,
      queryFn: async () => {
        const response = await fetch(`/api/client/plans`);
        if (!response.ok) throw new Error('Failed to fetch plans');
        return response.json();
      },
      staleTime: 60 * 60 * 1000, // 1 hour - plans rarely change
    }),
  ];

  await Promise.all(prefetchPromises);
}

/**
 * Invalidate all user-related queries
 * Call this after logout
 */
export function invalidateUserQueries(): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.user.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.payments.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.referrals.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.partner.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
}

/**
 * Invalidate subscription-related queries
 */
export function invalidateSubscriptionQueries(): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.user.stats });
}

/**
 * Invalidate payment-related queries
 */
export function invalidatePaymentQueries(): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.payments.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.user.stats });
}

/**
 * Invalidate referral-related queries
 */
export function invalidateReferralQueries(): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.referrals.all });
}

/**
 * Invalidate partner-related queries
 */
export function invalidatePartnerQueries(): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.partner.all });
}

/**
 * Clear all cached data
 * Useful for logout
 */
export function clearAllCache(): void {
  queryClient.clear();
}

/**
 * Cancel all ongoing queries
 * Useful when navigating away
 */
export async function cancelAllQueries(): Promise<void> {
  await queryClient.cancelQueries();
}

/**
 * Setup WebSocket integration with TanStack Query
 * Invalidates relevant queries when WebSocket events are received
 */
export function setupWebSocketIntegration(
  onEvent: (event: string, handler: (payload: unknown) => void) => () => void
): () => void {
  const unsubscribers: (() => void)[] = [];

  // Subscription events
  unsubscribers.push(
    onEvent('subscription:created', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.user.all });
    })
  );

  unsubscribers.push(
    onEvent('subscription:expired', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.user.all });
    })
  );

  unsubscribers.push(
    onEvent('subscription:renewed', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.user.all });
    })
  );

  // Payment events
  unsubscribers.push(
    onEvent('payment:received', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.user.all });
    })
  );

  unsubscribers.push(
    onEvent('payment:failed', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.all });
    })
  );

  // Referral events
  unsubscribers.push(
    onEvent('referral:registered', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.referrals.all });
    })
  );

  unsubscribers.push(
    onEvent('points:earned', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.referrals.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.user.all });
    })
  );

  // Partner events
  unsubscribers.push(
    onEvent('partner:commission', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.partner.all });
    })
  );

  unsubscribers.push(
    onEvent('payout:completed', () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.partner.all });
    })
  );

  // Return cleanup function
  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}
