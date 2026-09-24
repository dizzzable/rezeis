import { adminQueryKeys } from '@/lib/admin-query-keys'

/**
 * Under `adminQueryKeys.subscriptions.all` on purpose: a merge, a link or a
 * restore invalidates that prefix, and each of them changes what these lists
 * contain — a merged pair leaves «Подписки без привязки», a linked profile
 * leaves «Лишние профили», a restored row leaves the lifetime census.
 */
export const subscriptionToolsQueryKeys = {
  all: [...adminQueryKeys.subscriptions.all, 'tools'] as const,
  unlinked: [...adminQueryKeys.subscriptions.all, 'tools', 'unlinked'] as const,
  extraProfiles: [...adminQueryKeys.subscriptions.all, 'tools', 'extra-profiles'] as const,
  lifetime: [...adminQueryKeys.subscriptions.all, 'tools', 'lifetime-restore'] as const,
} as const
