import { z } from 'zod'
import { api } from '@/lib/api'

const referralSummarySchema = z.object({
  userId: z.string(),
  referralCode: z.string(),
  referralPointsBalance: z.number(),
  activeInvitesCount: z.number(),
  totalReferrals: z.number(),
  qualifiedReferrals: z.number(),
  issuedRewardsCount: z.number(),
  pendingRewardsCount: z.number(),
  totalRewardAmount: z.number(),
})

const referralInviteSchema = z.object({
  id: z.string(),
  inviterId: z.string(),
  token: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
})

const referralRewardSchema = z.object({
  id: z.string(),
  referralId: z.string(),
  userId: z.string(),
  type: z.string(),
  amount: z.number(),
  isIssued: z.boolean(),
  createdAt: z.string(),
})
const referralRewardIssueSchema = referralRewardSchema.extend({
  status: z.enum(['ISSUED', 'BLOCKED']),
  reason: z.string().nullable(),
})
const referralQualificationAuditSchema = z.object({
  action: z.string(),
  referredUserId: z.string().nullable(),
  transactionId: z.string().nullable(),
  purchaseChannel: z.string().nullable(),
  qualifiedReferralCount: z.number().nullable(),
  rewardsIssuedCount: z.number().nullable(),
  totalRewardAmount: z.number().nullable(),
  createdAt: z.string(),
})
const referralExchangePolicySchema = z.object({ exchangeEnabled: z.boolean(), giftPromocodeEnabled: z.boolean(), allowedPlanIds: z.array(z.string()), allowedDurationDays: z.array(z.number()), codePrefix: z.string(), costPerDay: z.number() })

export type ReferralSummary = z.infer<typeof referralSummarySchema>
export type ReferralInvite = z.infer<typeof referralInviteSchema>
export type ReferralReward = z.infer<typeof referralRewardSchema>
export type ReferralRewardIssue = z.infer<typeof referralRewardIssueSchema>
export type ReferralQualificationAudit = z.infer<typeof referralQualificationAuditSchema>
export type ReferralExchangePolicy = z.infer<typeof referralExchangePolicySchema>

export const referralsAdminApi = {
  async getSummary(userId: string): Promise<ReferralSummary> {
    const response = await api.get('/admin/referrals/summary', { params: { userId } })
    return referralSummarySchema.parse(response.data)
  },

  async listInvites(inviterId: string): Promise<ReferralInvite[]> {
    const response = await api.get('/admin/referrals/invites', { params: { inviterId } })
    return z.array(referralInviteSchema).parse(response.data)
  },

  async createInvite(inviterId: string, ttlHours?: number): Promise<ReferralInvite> {
    const response = await api.post('/admin/referrals/invites', {
      inviterId,
      ttlHours: ttlHours ?? null,
    })
    return referralInviteSchema.parse(response.data)
  },

  async revokeInvite(inviteId: string): Promise<ReferralInvite> {
    const response = await api.post(`/admin/referrals/invites/${inviteId}/revoke`)
    return referralInviteSchema.parse(response.data)
  },

  async listRewards(userId: string): Promise<ReferralReward[]> {
    const response = await api.get('/admin/referrals/rewards', { params: { userId } })
    return z.array(referralRewardSchema).parse(response.data)
  },

  async issueReward(rewardId: string): Promise<ReferralRewardIssue> {
    const response = await api.post(`/admin/referrals/rewards/${rewardId}/issue`)
    return referralRewardIssueSchema.parse(response.data)
  },

  async listQualificationAudit(userId: string): Promise<ReferralQualificationAudit[]> {
    const response = await api.get('/admin/referrals/qualification-audit', { params: { userId } })
    return z.array(referralQualificationAuditSchema).parse(response.data)
  },

  async getExchangePolicy(): Promise<ReferralExchangePolicy> {
    const response = await api.get('/admin/referrals/exchange-policy')
    return referralExchangePolicySchema.parse(response.data)
  },

  async updateExchangePolicy(input: Partial<ReferralExchangePolicy>): Promise<ReferralExchangePolicy> {
    const response = await api.post('/admin/referrals/exchange-policy', input)
    return referralExchangePolicySchema.parse(response.data)
  },
}
