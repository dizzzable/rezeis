import { z } from 'zod'

import { api } from '@/lib/api'

// ─────────────────────────────────────────────────────────────────────────────
//  Schemas (matching backend interfaces in src/modules/partners/interfaces)
// ─────────────────────────────────────────────────────────────────────────────

export const PARTNER_WITHDRAWAL_STATUSES = ['PENDING', 'COMPLETED', 'REJECTED', 'CANCELED'] as const

const partnerWithdrawalStatusSchema = z.enum(PARTNER_WITHDRAWAL_STATUSES)
const partnerAccrualStrategySchema = z.enum(['ON_EACH_PAYMENT', 'ONCE_PER_USER'])
const partnerRewardTypeSchema = z.enum(['PERCENT', 'FIXED'])

const partnerUserSummarySchema = z.object({
  id: z.string(),
  login: z.string().nullable(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  telegramId: z.string().nullable(),
  createdAt: z.string(),
})

const partnerSchema = z.object({
  id: z.string(),
  user: partnerUserSummarySchema,
  balance: z.number(),
  totalEarned: z.number(),
  totalWithdrawn: z.number(),
  isActive: z.boolean(),
  referralsCount: z.number(),
  useGlobalSettings: z.boolean(),
  accrualStrategy: partnerAccrualStrategySchema,
  rewardType: partnerRewardTypeSchema,
  level1Percent: z.string().nullable(),
  level2Percent: z.string().nullable(),
  level3Percent: z.string().nullable(),
  level1FixedAmount: z.number().nullable(),
  level2FixedAmount: z.number().nullable(),
  level3FixedAmount: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const partnerStatsSchema = z.object({
  totalPartners: z.number(),
  activePartners: z.number(),
  pendingWithdrawals: z.number(),
  completedWithdrawals: z.number(),
  rejectedWithdrawals: z.number(),
  totalBalance: z.number(),
  totalEarned: z.number(),
  totalWithdrawn: z.number(),
  earningsLast30d: z.number(),
  earningsLast7d: z.number(),
  completedLast30d: z.number(),
  generatedAt: z.string(),
})

const partnerWithdrawalSchema = z.object({
  id: z.string(),
  partnerId: z.string(),
  amount: z.number(),
  status: partnerWithdrawalStatusSchema,
  method: z.string(),
  requisites: z.string(),
  adminComment: z.string().nullable(),
  processedBy: z.string().nullable(),
  processedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  partner: z
    .object({
      id: z.string(),
      isActive: z.boolean(),
      user: z
        .object({
          id: z.string(),
          name: z.string().nullable(),
          username: z.string().nullable(),
          telegramId: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
})

const partnerEarningSchema = z.object({
  id: z.string(),
  level: z.number(),
  paymentAmount: z.number(),
  percent: z.string(),
  earnedAmount: z.number(),
  sourceTransactionId: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
  referralUser: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      username: z.string().nullable(),
      telegramId: z.string().nullable(),
    })
    .nullable(),
})

const partnerReferralEdgeSchema = z.object({
  id: z.string(),
  level: z.number(),
  parentPartnerId: z.string().nullable(),
  createdAt: z.string(),
  user: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      username: z.string().nullable(),
      telegramId: z.string().nullable(),
    })
    .nullable(),
})

const partnerAuditEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  adminUserId: z.string().nullable(),
  adminUsername: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})

const partnerOverviewSchema = z.object({
  partner: partnerSchema,
  earningsLast30d: z.number(),
  earningsLast7d: z.number(),
  earningsAllTime: z.number(),
  transactionsLast30d: z.number(),
  transactionsAllTime: z.number(),
  referralsByLevel: z.object({ l1: z.number(), l2: z.number(), l3: z.number() }),
})

const paginatedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number() })

// Analytics

const partnerFunnelSchema = z.object({
  newPartners: z.number(),
  activePartners: z.number(),
  partnersWithEarnings: z.number(),
  partnersWithWithdrawals: z.number(),
  conversion: z.object({
    activationRate: z.number(),
    earningRate: z.number(),
    withdrawalRate: z.number(),
  }),
  from: z.string(),
  to: z.string(),
})

const partnerTimeseriesSchema = z.object({
  granularity: z.enum(['day', 'week']),
  from: z.string(),
  to: z.string(),
  points: z.array(
    z.object({
      bucket: z.string(),
      earnings: z.number(),
      withdrawalsApproved: z.number(),
      withdrawalsRequested: z.number(),
      newPartners: z.number(),
    }),
  ),
})

const partnerLevelDistributionSchema = z.object({
  byLevel: z.record(z.string(), z.number()),
  transactionsByLevel: z.record(z.string(), z.number()),
  totalEarnings: z.number(),
  from: z.string(),
  to: z.string(),
})

const partnerGatewayDistributionSchema = z.object({
  byGateway: z.record(
    z.string(),
    z.object({ earnings: z.number(), transactions: z.number() }),
  ),
  totalEarnings: z.number(),
  from: z.string(),
  to: z.string(),
})

const topPartnersSchema = z.object({
  from: z.string(),
  to: z.string(),
  items: z.array(
    z.object({
      partnerId: z.string(),
      userId: z.string(),
      username: z.string().nullable(),
      name: z.string().nullable(),
      telegramId: z.string().nullable(),
      earnings: z.number(),
      transactions: z.number(),
      referrals: z.number(),
      balance: z.number(),
    }),
  ),
})

const withdrawalThroughputSchema = z.object({
  requested: z.number(),
  approved: z.number(),
  rejected: z.number(),
  approvalRate: z.number(),
  medianDecisionSeconds: z.number().nullable(),
  p95DecisionSeconds: z.number().nullable(),
  from: z.string(),
  to: z.string(),
})

const partnerKpiSchema = z.object({
  aov: z.number(),
  epap: z.number(),
  activationRate: z.number(),
  repeatPurchaseContribution: z.number(),
  partnersActiveInWindow: z.number(),
  newPartners: z.number(),
  newPartnersActivated: z.number(),
  totalEarnings: z.number(),
  totalQualifyingPayments: z.number(),
  from: z.string(),
  to: z.string(),
})

const partnerCohortRowSchema = z.object({
  cohortLabel: z.string(),
  cohortSize: z.number(),
  retention: z.array(z.number().nullable()),
})

const partnerCohortSchema = z.object({
  horizonWeeks: z.number(),
  rows: z.array(partnerCohortRowSchema),
  from: z.string(),
  to: z.string(),
})

// ─────────────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────────────

export type Partner = z.infer<typeof partnerSchema>
export type PartnerStats = z.infer<typeof partnerStatsSchema>
export type PartnerWithdrawal = z.infer<typeof partnerWithdrawalSchema>
export type PartnerWithdrawalStatus = z.infer<typeof partnerWithdrawalStatusSchema>
export type PartnerEarning = z.infer<typeof partnerEarningSchema>
export type PartnerReferralEdge = z.infer<typeof partnerReferralEdgeSchema>
export type PartnerAuditEvent = z.infer<typeof partnerAuditEventSchema>
export type PartnerOverview = z.infer<typeof partnerOverviewSchema>
export type PartnerFunnel = z.infer<typeof partnerFunnelSchema>
export type PartnerTimeseries = z.infer<typeof partnerTimeseriesSchema>
export type PartnerLevelDistribution = z.infer<typeof partnerLevelDistributionSchema>
export type PartnerGatewayDistribution = z.infer<typeof partnerGatewayDistributionSchema>
export type TopPartners = z.infer<typeof topPartnersSchema>
export type WithdrawalThroughput = z.infer<typeof withdrawalThroughputSchema>
export type PartnerKpi = z.infer<typeof partnerKpiSchema>
export type PartnerCohort = z.infer<typeof partnerCohortSchema>
export type PartnerCohortRow = z.infer<typeof partnerCohortRowSchema>

export type ListPartnersOrder = 'asc' | 'desc'
export type ListPartnersSort =
  | 'totalEarned'
  | 'balance'
  | 'totalWithdrawn'
  | 'createdAt'
  | 'updatedAt'

export interface ListPartnersInput {
  readonly search?: string
  readonly isActive?: 'true' | 'false'
  readonly sort?: ListPartnersSort
  readonly order?: ListPartnersOrder
  readonly limit?: number
  readonly offset?: number
}

export interface ListWithdrawalsInput {
  readonly status?: PartnerWithdrawalStatus | 'all'
  readonly search?: string
  readonly partnerId?: string
  readonly limit?: number
  readonly offset?: number
}

export interface RangeInput {
  readonly from?: string
  readonly to?: string
}

// ─────────────────────────────────────────────────────────────────────────────
//  API client
// ─────────────────────────────────────────────────────────────────────────────

function paramsForList(input: ListPartnersInput): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  if (input.search) params.search = input.search
  if (input.isActive) params.isActive = input.isActive
  if (input.sort) params.sort = input.sort
  if (input.order) params.order = input.order
  if (input.limit !== undefined) params.limit = input.limit
  if (input.offset !== undefined) params.offset = input.offset
  return params
}

function paramsForWithdrawals(input: ListWithdrawalsInput): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  if (input.status && input.status !== 'all') params.status = input.status
  if (input.search) params.search = input.search
  if (input.partnerId) params.partnerId = input.partnerId
  if (input.limit !== undefined) params.limit = input.limit
  if (input.offset !== undefined) params.offset = input.offset
  return params
}

function paramsForRange(input: RangeInput & { granularity?: string; limit?: number }): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  if (input.from) params.from = input.from
  if (input.to) params.to = input.to
  if (input.granularity) params.granularity = input.granularity
  if (input.limit !== undefined) params.limit = input.limit
  return params
}

export const partnersAdminApi = {
  // Lists & stats
  async listPartners(input: ListPartnersInput = {}): Promise<readonly Partner[]> {
    const response = await api.get('/admin/partners', { params: paramsForList(input) })
    return z.array(partnerSchema).parse(response.data)
  },
  async getStats(): Promise<PartnerStats> {
    const response = await api.get('/admin/partners/stats')
    return partnerStatsSchema.parse(response.data)
  },

  // Withdrawals
  async listWithdrawals(input: ListWithdrawalsInput = {}): Promise<readonly PartnerWithdrawal[]> {
    const response = await api.get('/admin/partners/withdrawals', {
      params: paramsForWithdrawals(input),
    })
    return z.array(partnerWithdrawalSchema).parse(response.data)
  },
  async approveWithdrawal(withdrawalId: string, adminComment?: string): Promise<PartnerWithdrawal> {
    const response = await api.post(`/admin/partners/withdrawals/${withdrawalId}/approve`, {
      adminComment,
    })
    return partnerWithdrawalSchema.parse(response.data)
  },
  async rejectWithdrawal(withdrawalId: string, adminComment?: string): Promise<PartnerWithdrawal> {
    const response = await api.post(`/admin/partners/withdrawals/${withdrawalId}/reject`, {
      adminComment,
    })
    return partnerWithdrawalSchema.parse(response.data)
  },
  async bulkApproveWithdrawals(withdrawalIds: readonly string[], adminComment?: string) {
    const response = await api.post('/admin/partners/withdrawals/bulk-approve', {
      withdrawalIds,
      adminComment,
    })
    return z
      .object({
        approved: z.number(),
        failed: z.number(),
        errors: z.array(z.object({ id: z.string(), error: z.string() })),
      })
      .parse(response.data)
  },

  // Lifecycle
  async togglePartner(partnerId: string): Promise<Partner> {
    const response = await api.post(`/admin/partners/${partnerId}/toggle`)
    return partnerSchema.parse(response.data)
  },
  async adjustBalance(partnerId: string, amount: number, reason?: string): Promise<Partner> {
    const response = await api.post(`/admin/partners/${partnerId}/adjust-balance`, {
      amount,
      reason,
    })
    return partnerSchema.parse(response.data)
  },
  /**
   * Update individual partner settings via the canonical user-facing route
   * (`PATCH /admin/users/:telegramId/partner/settings`) — there's no per-id
   * version on the backend, so we resolve the user's telegram id on the
   * frontend and reuse the existing endpoint.
   */
  async updateIndividualSettings(input: {
    readonly telegramId: string
    readonly useGlobalSettings?: boolean
    readonly accrualStrategy?: 'ON_EACH_PAYMENT' | 'ONCE_PER_USER'
    readonly rewardType?: 'PERCENT' | 'FIXED'
    readonly level1Percent?: number | null
    readonly level2Percent?: number | null
    readonly level3Percent?: number | null
    readonly level1FixedAmount?: number | null
    readonly level2FixedAmount?: number | null
    readonly level3FixedAmount?: number | null
  }) {
    const { telegramId, ...body } = input
    await api.patch(`/admin/users/${telegramId}/partner/settings`, body)
  },

  // Detail (drawer)
  async getOverview(partnerId: string): Promise<PartnerOverview> {
    const response = await api.get(`/admin/partners/${partnerId}/overview`)
    return partnerOverviewSchema.parse(response.data)
  },
  async listPartnerEarnings(partnerId: string, limit = 50, offset = 0) {
    const response = await api.get(`/admin/partners/${partnerId}/earnings`, {
      params: { limit, offset },
    })
    return paginatedSchema(partnerEarningSchema).parse(response.data)
  },
  async listPartnerReferrals(partnerId: string, limit = 50, offset = 0) {
    const response = await api.get(`/admin/partners/${partnerId}/referrals`, {
      params: { limit, offset },
    })
    return paginatedSchema(partnerReferralEdgeSchema).parse(response.data)
  },
  async listPartnerWithdrawals(partnerId: string, limit = 50, offset = 0) {
    const response = await api.get(`/admin/partners/${partnerId}/withdrawals`, {
      params: { limit, offset },
    })
    return paginatedSchema(partnerWithdrawalSchema).parse(response.data)
  },
  async listPartnerAudit(partnerId: string, limit = 50, offset = 0) {
    const response = await api.get(`/admin/partners/${partnerId}/audit`, {
      params: { limit, offset },
    })
    return paginatedSchema(partnerAuditEventSchema).parse(response.data)
  },

  // Analytics
  async getFunnel(input: RangeInput = {}): Promise<PartnerFunnel> {
    const response = await api.get('/admin/partners/analytics/funnel', { params: paramsForRange(input) })
    return partnerFunnelSchema.parse(response.data)
  },
  async getTimeseries(input: RangeInput & { granularity?: 'day' | 'week' } = {}): Promise<PartnerTimeseries> {
    const response = await api.get('/admin/partners/analytics/timeseries', { params: paramsForRange(input) })
    return partnerTimeseriesSchema.parse(response.data)
  },
  async getLevelDistribution(input: RangeInput = {}): Promise<PartnerLevelDistribution> {
    const response = await api.get('/admin/partners/analytics/level-distribution', { params: paramsForRange(input) })
    return partnerLevelDistributionSchema.parse(response.data)
  },
  async getGatewayDistribution(input: RangeInput = {}): Promise<PartnerGatewayDistribution> {
    const response = await api.get('/admin/partners/analytics/gateway-distribution', { params: paramsForRange(input) })
    return partnerGatewayDistributionSchema.parse(response.data)
  },
  async getTopPartners(input: RangeInput & { limit?: number } = {}): Promise<TopPartners> {
    const response = await api.get('/admin/partners/analytics/top-partners', { params: paramsForRange(input) })
    return topPartnersSchema.parse(response.data)
  },
  async getWithdrawalThroughput(input: RangeInput = {}): Promise<WithdrawalThroughput> {
    const response = await api.get('/admin/partners/analytics/withdrawal-throughput', { params: paramsForRange(input) })
    return withdrawalThroughputSchema.parse(response.data)
  },
  async getKpis(input: RangeInput = {}): Promise<PartnerKpi> {
    const response = await api.get('/admin/partners/analytics/kpis', { params: paramsForRange(input) })
    return partnerKpiSchema.parse(response.data)
  },
  async getCohortRetention(input: RangeInput & { horizonWeeks?: number } = {}): Promise<PartnerCohort> {
    const response = await api.get('/admin/partners/analytics/cohorts', {
      params: { ...paramsForRange(input), ...(input.horizonWeeks ? { horizonWeeks: input.horizonWeeks } : {}) },
    })
    return partnerCohortSchema.parse(response.data)
  },
}
