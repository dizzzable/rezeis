import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { referralsAdminApi, type ReferralExchangePolicy, type ReferralInvite, type ReferralQualificationAudit, type ReferralReward, type ReferralSummary } from '@/features/referrals/referrals-api'

const referralRouteUserIdSchema = z.object({
  userId: z.string().uuid(),
})

export interface ReferralsRouteSelection {
  readonly userId: string | null
  readonly isValid: boolean
}

export interface ReferralsSnapshot {
  readonly summary: ReferralSummary
  readonly invites: readonly ReferralInvite[]
  readonly rewards: readonly ReferralReward[]
  readonly qualificationAudit: readonly ReferralQualificationAudit[]
  readonly exchangePolicy: ReferralExchangePolicy | null
}

export function readReferralsRouteSelection(searchParams: URLSearchParams): ReferralsRouteSelection {
  const rawUserId: string | null = searchParams.get('userId')
  if (typeof rawUserId !== 'string') {
    return { userId: null, isValid: true }
  }

  const userId: string = rawUserId.trim()
  if (userId.length === 0) {
    return { userId: null, isValid: true }
  }

  const validation = referralRouteUserIdSchema.safeParse({ userId })
  if (!validation.success) {
    return { userId, isValid: false }
  }

  return {
    userId: validation.data.userId,
    isValid: true,
  }
}

export const referralsQueryKeys = {
  all: ['referrals'] as const,
  detail: (userId: string) => [...referralsQueryKeys.all, 'detail', userId] as const,
  summary: (userId: string) => [...referralsQueryKeys.detail(userId), 'summary'] as const,
  invites: (userId: string) => [...referralsQueryKeys.detail(userId), 'invites'] as const,
  rewards: (userId: string) => [...referralsQueryKeys.detail(userId), 'rewards'] as const,
  qualificationAudit: (userId: string) => [...referralsQueryKeys.detail(userId), 'qualification-audit'] as const,
  exchangePolicy: () => [...referralsQueryKeys.all, 'exchange-policy'] as const,
  snapshot: (userId: string) => [...referralsQueryKeys.detail(userId), 'snapshot'] as const,
}

export function useReferralSummaryQuery(userId: string | null) {
  return useQuery({
    queryKey: userId ? referralsQueryKeys.summary(userId) : [...referralsQueryKeys.all, 'summary', 'idle'],
    queryFn: () => referralsAdminApi.getSummary(userId ?? ''),
    enabled: userId !== null,
  })
}

export function useReferralInvitesQuery(userId: string | null) {
  return useQuery({
    queryKey: userId ? referralsQueryKeys.invites(userId) : [...referralsQueryKeys.all, 'invites', 'idle'],
    queryFn: () => referralsAdminApi.listInvites(userId ?? ''),
    enabled: userId !== null,
  })
}

export function useReferralRewardsQuery(userId: string | null) {
  return useQuery({
    queryKey: userId ? referralsQueryKeys.rewards(userId) : [...referralsQueryKeys.all, 'rewards', 'idle'],
    queryFn: () => referralsAdminApi.listRewards(userId ?? ''),
    enabled: userId !== null,
  })
}

export function useReferralQualificationAuditQuery(userId: string | null) {
  return useQuery({
    queryKey: userId ? referralsQueryKeys.qualificationAudit(userId) : [...referralsQueryKeys.all, 'qualification-audit', 'idle'],
    queryFn: () => referralsAdminApi.listQualificationAudit(userId ?? ''),
    enabled: userId !== null,
  })
}

export function useReferralSnapshotQuery(userId: string | null) {
  const summaryQuery = useReferralSummaryQuery(userId)
  const invitesQuery = useReferralInvitesQuery(userId)
  const rewardsQuery = useReferralRewardsQuery(userId)
  const qualificationAuditQuery = useReferralQualificationAuditQuery(userId)
  const exchangePolicyQuery = useQuery({ queryKey: referralsQueryKeys.exchangePolicy(), queryFn: referralsAdminApi.getExchangePolicy, enabled: userId !== null })

  const data = useMemo<ReferralsSnapshot | null>(() => {
    if (!summaryQuery.data) {
      return null
    }

    return {
      summary: summaryQuery.data,
      invites: invitesQuery.data ?? [],
      rewards: rewardsQuery.data ?? [],
      qualificationAudit: qualificationAuditQuery.data ?? [],
      exchangePolicy: exchangePolicyQuery.data ?? null,
    }
  }, [exchangePolicyQuery.data, invitesQuery.data, qualificationAuditQuery.data, rewardsQuery.data, summaryQuery.data])

  return {
    data,
    summaryQuery,
    invitesQuery,
    rewardsQuery,
    qualificationAuditQuery,
    exchangePolicyQuery,
    isPending: summaryQuery.isPending || invitesQuery.isPending || rewardsQuery.isPending || qualificationAuditQuery.isPending || exchangePolicyQuery.isPending,
    error: summaryQuery.error ?? invitesQuery.error ?? rewardsQuery.error ?? qualificationAuditQuery.error ?? exchangePolicyQuery.error ?? null,
  }
}

export function useCreateReferralInviteMutation(userId: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<ReferralInvite> => {
      if (!userId) {
        throw new Error('referrals.errors.missingUserId')
      }
      return referralsAdminApi.createInvite(userId)
    },
    onSuccess: async (): Promise<void> => {
      if (!userId) {
        return
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: referralsQueryKeys.summary(userId) }),
        queryClient.invalidateQueries({ queryKey: referralsQueryKeys.invites(userId) }),
      ])
    },
  })
}

export function useRevokeReferralInviteMutation(userId: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (inviteId: string): Promise<ReferralInvite> => referralsAdminApi.revokeInvite(inviteId),
    onSuccess: async (): Promise<void> => {
      if (!userId) {
        return
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: referralsQueryKeys.summary(userId) }),
        queryClient.invalidateQueries({ queryKey: referralsQueryKeys.invites(userId) }),
      ])
    },
  })
}

export function useIssueReferralRewardMutation(userId: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (rewardId: string) => referralsAdminApi.issueReward(rewardId),
    onSuccess: async (): Promise<void> => {
      if (!userId) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: referralsQueryKeys.summary(userId) }),
        queryClient.invalidateQueries({ queryKey: referralsQueryKeys.rewards(userId) }),
      ])
    },
  })
}

export function useUpdateReferralExchangePolicyMutation(userId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: referralsAdminApi.updateExchangePolicy,
    onSuccess: async () => {
      if (userId !== null) {
        await queryClient.invalidateQueries({ queryKey: referralsQueryKeys.detail(userId) })
      }
      await queryClient.invalidateQueries({ queryKey: referralsQueryKeys.all })
    },
  })
}
