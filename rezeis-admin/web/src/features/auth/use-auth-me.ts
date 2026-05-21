import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { authUserSchema, type AuthUser } from './auth-user'

/**
 * React Query hook that exposes the currently authenticated admin profile.
 * Fetches `/api/admin/auth/me` only when an access token is present.
 */
export function useAuthMe(): UseQueryResult<AuthUser, Error> {
  const token = useAuthStore((state) => state.token)

  return useQuery({
    queryKey: ['auth', 'me'] as const,
    enabled: token.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<AuthUser> => {
      const response = await api.get('/admin/auth/me')
      return authUserSchema.parse(response.data)
    },
  })
}
