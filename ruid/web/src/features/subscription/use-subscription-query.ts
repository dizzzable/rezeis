import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { subscriptionApi } from '@/features/subscription/subscription-api'

type SubscriptionData = Awaited<ReturnType<typeof subscriptionApi.getSubscription>>

export function useSubscriptionQuery({ enabled = true }: { readonly enabled?: boolean } = {}): UseQueryResult<SubscriptionData> {
  return useQuery({
    queryKey: ['subscription'],
    queryFn: () => subscriptionApi.getSubscription(),
    enabled,
  })
}
