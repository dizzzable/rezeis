import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { sessionApi } from '@/features/session/session-api'

type SessionData = Awaited<ReturnType<typeof sessionApi.getSession>>

export function useSessionQuery({ enabled = true }: { readonly enabled?: boolean } = {}): UseQueryResult<SessionData> {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => sessionApi.getSession(),
    enabled,
  })
}
