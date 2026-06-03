/**
 * Shared TanStack Query keys for admin surfaces.
 *
 * Realtime invalidation and feature queries should import these factories
 * instead of hand-writing arrays so prefix invalidation keeps working when a
 * page adds filters or splits a tab into multiple requests.
 */
export const adminQueryKeys = {
  audit: {
    all: ['audit'] as const,
    facets: ['audit-facets'] as const,
  },
  backups: {
    all: ['admin', 'backups'] as const,
  },
  broadcast: {
    all: ['admin', 'broadcast'] as const,
    audienceCount: (audience: string) => ['admin', 'broadcast', 'audience-count', audience] as const,
  },
  dashboard: {
    all: ['admin', 'dashboard'] as const,
    summary: ['admin', 'dashboard', 'summary'] as const,
    systemHealth: ['admin', 'dashboard', 'system-health'] as const,
  },
  email: {
    settings: ['admin', 'email', 'settings'] as const,
  },
  imports: {
    all: ['admin', 'imports'] as const,
    planPreview: (importRecordId: string) => ['admin', 'imports', importRecordId, 'plan-preview'] as const,
  },
  notifications: {
    all: ['admin', 'notifications'] as const,
    templates: ['admin', 'notifications', 'templates'] as const,
  },
  payments: {
    all: ['admin', 'payments'] as const,
    transactions: {
      all: ['admin', 'payments', 'transactions'] as const,
      list: (searchParams: string) => ['admin', 'payments', 'transactions', searchParams] as const,
    },
    webhooks: {
      all: ['admin', 'payments', 'webhooks'] as const,
    },
    gateways: {
      all: ['admin', 'payments', 'gateways'] as const,
      supportedCurrencies: ['admin', 'payments', 'gateways', 'supported-currencies'] as const,
    },
    analytics: {
      all: ['admin', 'payments', 'analytics'] as const,
      providers: (days: number) => ['admin', 'payments', 'analytics', 'providers', days] as const,
      webhooks: (days: number) => ['admin', 'payments', 'analytics', 'webhooks', days] as const,
    },
  },
  settings: {
    all: ['admin', 'settings'] as const,
  },
  subscriptions: {
    all: ['admin', 'subscriptions'] as const,
    list: (filters: { readonly statusFilter: string; readonly trialOnly: boolean }) =>
      ['admin', 'subscriptions', 'list', filters] as const,
    stats: ['admin', 'subscriptions', 'stats'] as const,
  },
  users: {
    all: ['admin', 'users'] as const,
  },
} as const
