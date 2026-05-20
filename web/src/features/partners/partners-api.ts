import { z } from 'zod'
import { api } from '@/lib/api'

const partnerWithdrawalStatusSchema = z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED'])

const partnerSummarySchema = z.object({
  userId: z.string(),
  partnerId: z.string(),
  balance: z.number(),
  totalEarned: z.number(),
  totalWithdrawn: z.number(),
  referralsCount: z.number(),
  level2ReferralsCount: z.number(),
  level3ReferralsCount: z.number(),
  isActive: z.boolean(),
})

const partnerEarningSchema = z.object({
  id: z.string(),
  partnerId: z.string(),
  referralTelegramId: z.string(),
  level: z.string(),
  paymentAmount: z.number(),
  percent: z.string(),
  earnedAmount: z.number(),
  sourceTransactionId: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
})

const partnerWithdrawalSchema = z.object({
  id: z.string(),
  partnerId: z.string(),
  amount: z.number(),
  requestedAmount: z.string(),
  requestedCurrency: z.string(),
  quoteRate: z.string(),
  quoteSource: z.string().nullable(),
  status: partnerWithdrawalStatusSchema,
  method: z.string().nullable(),
  requisites: z.string().nullable(),
  adminComment: z.string().nullable(),
  processedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const partnerWithdrawalAuditEventSchema = z.object({
  action: z.string(),
  withdrawalId: z.string().nullable(),
  partnerId: z.string().nullable(),
  balanceReserved: z.boolean().nullable(),
  balanceRefunded: z.boolean().nullable(),
  createdAt: z.string(),
})

export type PartnerSummary = z.infer<typeof partnerSummarySchema>
export type PartnerEarning = z.infer<typeof partnerEarningSchema>
export type PartnerWithdrawalStatus = z.infer<typeof partnerWithdrawalStatusSchema>
export type PartnerWithdrawal = z.infer<typeof partnerWithdrawalSchema>
export type PartnerWithdrawalAuditEvent = z.infer<typeof partnerWithdrawalAuditEventSchema>

export interface CreatePartnerWithdrawalInput {
  readonly userId: string
  readonly requestedAmount: number
  readonly requestedCurrency: string
  readonly method?: string
  readonly requisites?: string
}

export const partnersAdminApi = {
  async getSummary(userId: string): Promise<PartnerSummary> {
    const response = await api.get('/admin/partners/summary', { params: { userId } })
    return partnerSummarySchema.parse(response.data)
  },

  async listEarnings(userId: string): Promise<PartnerEarning[]> {
    const response = await api.get('/admin/partners/earnings', { params: { userId } })
    return z.array(partnerEarningSchema).parse(response.data)
  },

  async listWithdrawals(userId: string): Promise<PartnerWithdrawal[]> {
    const response = await api.get('/admin/partners/withdrawals', { params: { userId } })
    return z.array(partnerWithdrawalSchema).parse(response.data)
  },

  async listWithdrawalAuditEvents(userId: string): Promise<PartnerWithdrawalAuditEvent[]> {
    const response = await api.get('/admin/partners/withdrawals/audit-events', { params: { userId } })
    return z.array(partnerWithdrawalAuditEventSchema).parse(response.data)
  },

  async createWithdrawal(input: CreatePartnerWithdrawalInput): Promise<PartnerWithdrawal> {
    const response = await api.post('/admin/partners/withdrawals', input)
    return partnerWithdrawalSchema.parse(response.data)
  },

  async approveWithdrawal(withdrawalId: string, adminComment?: string): Promise<PartnerWithdrawal> {
    const response = await api.post(`/admin/partners/withdrawals/${withdrawalId}/approve`, { adminComment })
    return partnerWithdrawalSchema.parse(response.data)
  },

  async rejectWithdrawal(withdrawalId: string, adminComment?: string): Promise<PartnerWithdrawal> {
    const response = await api.post(`/admin/partners/withdrawals/${withdrawalId}/reject`, { adminComment })
    return partnerWithdrawalSchema.parse(response.data)
  },

  async completeWithdrawal(withdrawalId: string, adminComment?: string): Promise<PartnerWithdrawal> {
    const response = await api.post(`/admin/partners/withdrawals/${withdrawalId}/complete`, { adminComment })
    return partnerWithdrawalSchema.parse(response.data)
  },
}
