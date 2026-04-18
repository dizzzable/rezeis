import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type SessionWebAccountEmailVerificationChallenge } from '@/features/session/session-api'

const WEB_ACCOUNT_EMAIL_VERIFICATION_CHALLENGE_QUERY_KEY = ['session', 'web-account-email-verification-challenge'] as const

export function useWebAccountEmailVerificationChallengeState(): {
  readonly challenge: SessionWebAccountEmailVerificationChallenge | null
  readonly saveChallenge: (challenge: SessionWebAccountEmailVerificationChallenge | null) => void
} {
  const queryClient = useQueryClient()
  const query = useQuery<SessionWebAccountEmailVerificationChallenge | null>({
    queryKey: WEB_ACCOUNT_EMAIL_VERIFICATION_CHALLENGE_QUERY_KEY,
    queryFn: async (): Promise<SessionWebAccountEmailVerificationChallenge | null> => null,
    initialData: null,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const saveChallenge = useCallback((challenge: SessionWebAccountEmailVerificationChallenge | null): void => {
    queryClient.setQueryData<SessionWebAccountEmailVerificationChallenge | null>(WEB_ACCOUNT_EMAIL_VERIFICATION_CHALLENGE_QUERY_KEY, challenge)
  }, [queryClient])
  return {
    challenge: query.data ?? null,
    saveChallenge,
  }
}
