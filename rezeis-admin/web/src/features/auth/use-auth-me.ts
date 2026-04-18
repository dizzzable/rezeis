import { useEffect } from 'react'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { authApi } from '@/features/auth/auth-api'
import { authUserSchema } from '@/features/auth/auth-user'
import { ApiError } from '@/lib/api'
import { queryClient } from '@/lib/query-client'
import { useAuthStore } from '@/stores/auth-store'

type AuthUser = z.infer<typeof authUserSchema>

function createAuthMeQueryKey(sessionRevision: number): readonly ['auth', 'me', number] {
  return ['auth', 'me', sessionRevision] as const
}

function isAuthInvalidatingError(error: Error): boolean {
  if (!(error instanceof ApiError)) {
    return false
  }
  return error.status === 401 || error.status === 403
}

export function useAuthMe(): UseQueryResult<AuthUser, Error> {
  const token: string = useAuthStore((state) => state.token)
  const sessionRevision: number = useAuthStore((state) => state.sessionRevision)
  const setUser = useAuthStore((state) => state.setUser)
  const markSessionVerified = useAuthStore((state) => state.markSessionVerified)
  const clearSession = useAuthStore((state) => state.clearSession)
  const authMeQuery = useQuery<AuthUser, Error>({
    queryKey: createAuthMeQueryKey(sessionRevision),
    queryFn: authApi.getMe,
    enabled: Boolean(token),
  })
  useEffect((): void => {
    if (authMeQuery.data) {
      setUser(authMeQuery.data)
      markSessionVerified(sessionRevision)
    }
  }, [authMeQuery.data, markSessionVerified, sessionRevision, setUser])
  useEffect((): void => {
    if (!authMeQuery.error || !isAuthInvalidatingError(authMeQuery.error)) {
      return
    }
    clearSession()
    queryClient.removeQueries({ queryKey: ['auth'] })
  }, [authMeQuery.error, clearSession])
  return authMeQuery
}
