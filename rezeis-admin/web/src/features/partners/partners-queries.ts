import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  ListPartnersInput,
  ListWithdrawalsInput,
  RangeInput,
  partnersAdminApi,
} from './partners-api'

const PARTNERS_KEY = ['admin', 'partners'] as const

export const partnersKeys = {
  all: PARTNERS_KEY,
  list: (input: ListPartnersInput) => [...PARTNERS_KEY, 'list', input] as const,
  stats: () => [...PARTNERS_KEY, 'stats'] as const,
  withdrawals: (input: ListWithdrawalsInput) => [...PARTNERS_KEY, 'withdrawals', input] as const,
  overview: (partnerId: string) => [...PARTNERS_KEY, 'overview', partnerId] as const,
  earnings: (partnerId: string, limit: number, offset: number) =>
    [...PARTNERS_KEY, 'earnings', partnerId, limit, offset] as const,
  partnerReferrals: (partnerId: string, limit: number, offset: number) =>
    [...PARTNERS_KEY, 'partner-referrals', partnerId, limit, offset] as const,
  partnerWithdrawals: (partnerId: string, limit: number, offset: number) =>
    [...PARTNERS_KEY, 'partner-withdrawals', partnerId, limit, offset] as const,
  partnerAudit: (partnerId: string, limit: number, offset: number) =>
    [...PARTNERS_KEY, 'partner-audit', partnerId, limit, offset] as const,
  funnel: (input: RangeInput) => [...PARTNERS_KEY, 'analytics', 'funnel', input] as const,
  timeseries: (input: RangeInput & { granularity?: 'day' | 'week' }) =>
    [...PARTNERS_KEY, 'analytics', 'timeseries', input] as const,
  topPartners: (input: RangeInput & { limit?: number }) =>
    [...PARTNERS_KEY, 'analytics', 'top', input] as const,
  levelDistribution: (input: RangeInput) =>
    [...PARTNERS_KEY, 'analytics', 'level', input] as const,
  gatewayDistribution: (input: RangeInput) =>
    [...PARTNERS_KEY, 'analytics', 'gateway', input] as const,
  throughput: (input: RangeInput) =>
    [...PARTNERS_KEY, 'analytics', 'throughput', input] as const,
  kpis: (input: RangeInput) => [...PARTNERS_KEY, 'analytics', 'kpis', input] as const,
  cohorts: (input: RangeInput & { horizonWeeks?: number }) =>
    [...PARTNERS_KEY, 'analytics', 'cohorts', input] as const,
}

export function usePartnersList(input: ListPartnersInput) {
  return useQuery({
    queryKey: partnersKeys.list(input),
    queryFn: () => partnersAdminApi.listPartners(input),
  })
}

export function usePartnerStats() {
  return useQuery({
    queryKey: partnersKeys.stats(),
    queryFn: () => partnersAdminApi.getStats(),
    staleTime: 30_000,
  })
}

export function useWithdrawalsList(input: ListWithdrawalsInput) {
  return useQuery({
    queryKey: partnersKeys.withdrawals(input),
    queryFn: () => partnersAdminApi.listWithdrawals(input),
  })
}

export function usePartnerOverview(partnerId: string | null) {
  return useQuery({
    queryKey: partnerId ? partnersKeys.overview(partnerId) : ['admin', 'partners', 'overview', null],
    queryFn: () => partnersAdminApi.getOverview(partnerId as string),
    enabled: partnerId !== null,
  })
}

export function usePartnerEarnings(partnerId: string | null, limit = 50, offset = 0) {
  return useQuery({
    queryKey: partnerId
      ? partnersKeys.earnings(partnerId, limit, offset)
      : ['admin', 'partners', 'earnings', null, limit, offset],
    queryFn: () => partnersAdminApi.listPartnerEarnings(partnerId as string, limit, offset),
    enabled: partnerId !== null,
  })
}

export function usePartnerReferrals(partnerId: string | null, limit = 50, offset = 0) {
  return useQuery({
    queryKey: partnerId
      ? partnersKeys.partnerReferrals(partnerId, limit, offset)
      : ['admin', 'partners', 'partner-referrals', null, limit, offset],
    queryFn: () => partnersAdminApi.listPartnerReferrals(partnerId as string, limit, offset),
    enabled: partnerId !== null,
  })
}

export function usePartnerWithdrawals(partnerId: string | null, limit = 50, offset = 0) {
  return useQuery({
    queryKey: partnerId
      ? partnersKeys.partnerWithdrawals(partnerId, limit, offset)
      : ['admin', 'partners', 'partner-withdrawals', null, limit, offset],
    queryFn: () => partnersAdminApi.listPartnerWithdrawals(partnerId as string, limit, offset),
    enabled: partnerId !== null,
  })
}

export function usePartnerAudit(partnerId: string | null, limit = 50, offset = 0) {
  return useQuery({
    queryKey: partnerId
      ? partnersKeys.partnerAudit(partnerId, limit, offset)
      : ['admin', 'partners', 'partner-audit', null, limit, offset],
    queryFn: () => partnersAdminApi.listPartnerAudit(partnerId as string, limit, offset),
    enabled: partnerId !== null,
  })
}

// Analytics
export function useFunnel(input: RangeInput) {
  return useQuery({
    queryKey: partnersKeys.funnel(input),
    queryFn: () => partnersAdminApi.getFunnel(input),
  })
}
export function useTimeseries(input: RangeInput & { granularity?: 'day' | 'week' }) {
  return useQuery({
    queryKey: partnersKeys.timeseries(input),
    queryFn: () => partnersAdminApi.getTimeseries(input),
  })
}
export function useTopPartners(input: RangeInput & { limit?: number }) {
  return useQuery({
    queryKey: partnersKeys.topPartners(input),
    queryFn: () => partnersAdminApi.getTopPartners(input),
  })
}
export function useLevelDistribution(input: RangeInput) {
  return useQuery({
    queryKey: partnersKeys.levelDistribution(input),
    queryFn: () => partnersAdminApi.getLevelDistribution(input),
  })
}
export function useGatewayDistribution(input: RangeInput) {
  return useQuery({
    queryKey: partnersKeys.gatewayDistribution(input),
    queryFn: () => partnersAdminApi.getGatewayDistribution(input),
  })
}
export function useWithdrawalThroughput(input: RangeInput) {
  return useQuery({
    queryKey: partnersKeys.throughput(input),
    queryFn: () => partnersAdminApi.getWithdrawalThroughput(input),
  })
}
export function useKpis(input: RangeInput) {
  return useQuery({
    queryKey: partnersKeys.kpis(input),
    queryFn: () => partnersAdminApi.getKpis(input),
  })
}
export function useCohortRetention(input: RangeInput & { horizonWeeks?: number }) {
  return useQuery({
    queryKey: partnersKeys.cohorts(input),
    queryFn: () => partnersAdminApi.getCohortRetention(input),
  })
}

// Mutations
export function usePartnerMutations() {
  const queryClient = useQueryClient()

  const invalidateAll = () => queryClient.invalidateQueries({ queryKey: PARTNERS_KEY })

  const togglePartner = useMutation({
    mutationFn: (partnerId: string) => partnersAdminApi.togglePartner(partnerId),
    onSuccess: invalidateAll,
  })

  const adjustBalance = useMutation({
    mutationFn: (input: { partnerId: string; amount: number; reason?: string }) =>
      partnersAdminApi.adjustBalance(input.partnerId, input.amount, input.reason),
    onSuccess: invalidateAll,
  })

  const updateIndividualSettings = useMutation({
    mutationFn: (input: Parameters<typeof partnersAdminApi.updateIndividualSettings>[0]) =>
      partnersAdminApi.updateIndividualSettings(input),
    onSuccess: invalidateAll,
  })

  /**
   * Approve withdrawal — optimistic update marks the row as COMPLETED in
   * every cached `withdrawals` query immediately so the operator sees
   * instant feedback. We rollback on error and always reconcile with
   * a refetch on settle.
   */
  const approveWithdrawal = useMutation({
    mutationFn: (input: { withdrawalId: string; adminComment?: string }) =>
      partnersAdminApi.approveWithdrawal(input.withdrawalId, input.adminComment),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: PARTNERS_KEY })
      const snapshot = queryClient.getQueriesData<unknown>({
        queryKey: [...PARTNERS_KEY, 'withdrawals'],
      })
      patchWithdrawalsCache(queryClient, input.withdrawalId, 'COMPLETED', input.adminComment ?? null)
      return { snapshot }
    },
    onError: (_err, _input, context) => {
      if (context?.snapshot) {
        for (const [key, value] of context.snapshot) {
          queryClient.setQueryData(key, value)
        }
      }
    },
    onSettled: invalidateAll,
  })

  const rejectWithdrawal = useMutation({
    mutationFn: (input: { withdrawalId: string; adminComment?: string }) =>
      partnersAdminApi.rejectWithdrawal(input.withdrawalId, input.adminComment),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: PARTNERS_KEY })
      const snapshot = queryClient.getQueriesData<unknown>({
        queryKey: [...PARTNERS_KEY, 'withdrawals'],
      })
      patchWithdrawalsCache(queryClient, input.withdrawalId, 'REJECTED', input.adminComment ?? null)
      return { snapshot }
    },
    onError: (_err, _input, context) => {
      if (context?.snapshot) {
        for (const [key, value] of context.snapshot) {
          queryClient.setQueryData(key, value)
        }
      }
    },
    onSettled: invalidateAll,
  })

  const bulkApprove = useMutation({
    mutationFn: (input: { withdrawalIds: readonly string[]; adminComment?: string }) =>
      partnersAdminApi.bulkApproveWithdrawals(input.withdrawalIds, input.adminComment),
    onSuccess: invalidateAll,
  })

  return {
    togglePartner,
    adjustBalance,
    updateIndividualSettings,
    approveWithdrawal,
    rejectWithdrawal,
    bulkApprove,
  }
}

interface MutableWithdrawal {
  id: string
  status: string
  adminComment: string | null
  processedAt: string | null
}

function patchWithdrawalsCache(
  queryClient: ReturnType<typeof useQueryClient>,
  withdrawalId: string,
  nextStatus: 'COMPLETED' | 'REJECTED',
  nextComment: string | null,
): void {
  const queries = queryClient.getQueriesData<MutableWithdrawal[] | undefined>({
    queryKey: [...PARTNERS_KEY, 'withdrawals'],
  })
  for (const [key, current] of queries) {
    if (!Array.isArray(current)) continue
    const next = current.map((row) =>
      row.id === withdrawalId
        ? {
            ...row,
            status: nextStatus,
            adminComment: nextComment,
            processedAt: new Date().toISOString(),
          }
        : row,
    )
    queryClient.setQueryData(key, next)
  }
}
