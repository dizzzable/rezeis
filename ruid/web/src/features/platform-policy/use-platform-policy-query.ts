import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { platformPolicyApi } from '@/features/platform-policy/platform-policy-api'

type PlatformPolicyData = Awaited<ReturnType<typeof platformPolicyApi.getPlatformPolicy>>

export function usePlatformPolicyQuery({ enabled = true }: { readonly enabled?: boolean } = {}): UseQueryResult<PlatformPolicyData> {
  return useQuery({
    queryKey: ['platform-policy'],
    queryFn: () => platformPolicyApi.getPlatformPolicy(),
    enabled,
  })
}
