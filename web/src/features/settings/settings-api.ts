import { z } from 'zod'
import { DEFAULT_PLATFORM_ACCESS_MODE, platformAccessModeSchema, type PlatformAccessMode } from '@/features/settings/access-mode'
import { api } from '@/lib/api'

const platformSettingsResponseSchema = z.object({
  rulesRequired: z.boolean().catch(false),
  rulesLink: z.string().nullable().optional(),
  channelRequired: z.boolean().catch(false),
  channelId: z.string().nullable().optional(),
  channelLink: z.string().nullable().optional(),
  accessMode: platformAccessModeSchema.catch(DEFAULT_PLATFORM_ACCESS_MODE),
  inviteModeStartedAt: z.string().nullable().optional(),
  defaultCurrency: z.string().nullable().optional(),
  branding: z.object({
    projectName: z.string().nullable().catch(null),
    webTitle: z.string().nullable().catch(null),
    supportUrl: z.string().nullable().catch(null),
    supportUsername: z.string().nullable().catch(null),
    accessRequestIntro: z.string().nullable().catch(null),
    accessApprovedMessage: z.string().nullable().catch(null),
    accessRejectedMessage: z.string().nullable().catch(null),
  }).catch({
    projectName: null,
    webTitle: null,
    supportUrl: null,
    supportUsername: null,
    accessRequestIntro: null,
    accessApprovedMessage: null,
    accessRejectedMessage: null,
  }),
})

const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string().optional(),
  createdBy: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable().optional(),
  createdAt: z.string(),
})

const createdApiTokenResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  prefix: z.string().optional(),
  createdAt: z.string(),
})

const settingsAuditHistorySchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    action: z.string(),
    adminActorPresent: z.boolean(),
    updatedFields: z.array(z.string()),
    createdAt: z.string(),
  })),
})
const notificationSettingsSchema = z.object({ paymentCompleted: z.boolean(), paymentFailed: z.boolean() })
const notificationTemplatesSchema = z.object({ paymentCompleted: z.string().nullable(), paymentFailed: z.string().nullable() })
const notificationTemplatePreviewSchema = z.object({ eventType: z.string(), renderedText: z.string(), sampleVariables: z.record(z.string(), z.string()) })
const notificationOpsSummarySchema = z.object({ total: z.number(), unread: z.number(), read: z.number(), botLinked: z.number(), botDelivered: z.number(), pendingBotDelivery: z.number() })
const notificationDeliveryPolicySchema = z.object({ sourceOfTruth: z.string(), queueName: z.string(), jobName: z.string(), autoEnqueueEnabled: z.boolean(), manualFallbackEnabled: z.boolean(), boundedBatchLimit: z.number(), notes: z.array(z.string()) })
const notificationProblemEventSchema = z.object({ eventId: z.string(), userId: z.string(), type: z.string(), status: z.string(), error: z.string().nullable(), attemptedAt: z.string().nullable(), createdAt: z.string() })
const notificationProblemEventsSchema = z.object({ items: z.array(notificationProblemEventSchema) })
const notificationEnqueueResultSchema = z.object({ eventId: z.string(), queueJobId: z.string().nullable(), enqueued: z.boolean(), alreadyQueued: z.boolean(), reason: z.string().nullable() })
const notificationBotDeliveryResultSchema = z.object({ eventId: z.string().nullable(), status: z.enum(['NO_PENDING_EVENT', 'DELIVERED', 'BLOCKED', 'FAILED']), botMessageId: z.number().nullable(), reason: z.string().nullable(), checkedAt: z.string() })
const notificationBotDeliveryBatchResultSchema = z.object({ attempted: z.number(), delivered: z.number(), blocked: z.number(), failed: z.number(), checkedAt: z.string() })
const referralExchangePolicySchema = z.object({ exchangeEnabled: z.boolean(), giftPromocodeEnabled: z.boolean(), allowedPlanIds: z.array(z.string()), allowedDurationDays: z.array(z.number()), codePrefix: z.string(), costPerDay: z.number() })
const partnerWithdrawalPolicySchema = z.object({ enabled: z.boolean(), minimumAmount: z.number(), supportedMethods: z.array(z.string()), updatedAt: z.string() })

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>
export type NotificationTemplates = z.infer<typeof notificationTemplatesSchema>
export type NotificationTemplatePreview = z.infer<typeof notificationTemplatePreviewSchema>
export type NotificationOpsSummary = z.infer<typeof notificationOpsSummarySchema>
export type NotificationDeliveryPolicy = z.infer<typeof notificationDeliveryPolicySchema>
export type NotificationProblemEvent = z.infer<typeof notificationProblemEventSchema>
export type NotificationEnqueueResult = z.infer<typeof notificationEnqueueResultSchema>
export type NotificationBotDeliveryResult = z.infer<typeof notificationBotDeliveryResultSchema>
export type NotificationBotDeliveryBatchResult = z.infer<typeof notificationBotDeliveryBatchResultSchema>
export type ReferralExchangePolicy = z.infer<typeof referralExchangePolicySchema>
export type PartnerWithdrawalPolicy = z.infer<typeof partnerWithdrawalPolicySchema>

interface PlatformSettingsPayload {
  readonly rulesRequired: boolean
  readonly rulesLink: string | null
  readonly channelRequired: boolean
  readonly channelId: string | null
  readonly channelLink: string | null
  readonly accessMode: PlatformAccessMode
  readonly inviteModeStartedAt: string | null
  readonly defaultCurrency: string
  readonly branding?: {
    readonly projectName: string | null
    readonly webTitle: string | null
    readonly supportUrl: string | null
    readonly supportUsername: string | null
    readonly accessRequestIntro: string | null
    readonly accessApprovedMessage: string | null
    readonly accessRejectedMessage: string | null
  }
}

interface CreateApiTokenPayload {
  readonly name: string
  readonly description?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('errors.unexpectedSettingsPayload')
  }
  const nestedValue: unknown = value.data
  if (isRecord(nestedValue)) {
    return nestedValue
  }
  return value
}

export const settingsApi = {
  async getPlatformSettings(): Promise<z.infer<typeof platformSettingsResponseSchema>> {
    const response = await api.get('/admin/settings/platform')
    return platformSettingsResponseSchema.parse(unwrapPayload(response.data))
  },
  async listApiTokens(): Promise<readonly z.infer<typeof apiTokenSchema>[]> {
    const response = await api.get('/admin/api-tokens')
    const data = Array.isArray(response.data) ? response.data : (response.data?.items ?? response.data ?? [])
    return z.array(apiTokenSchema).parse(data)
  },
  async createApiToken(payload: CreateApiTokenPayload): Promise<z.infer<typeof createdApiTokenResponseSchema>> {
    const response = await api.post('/admin/api-tokens', payload)
    return createdApiTokenResponseSchema.parse(response.data)
  },
  async revokeApiToken(tokenId: string): Promise<void> {
    await api.delete(`/admin/api-tokens/${tokenId}`)
  },
  async updatePlatformSettings(payload: PlatformSettingsPayload): Promise<z.infer<typeof platformSettingsResponseSchema>> {
    const response = await api.patch('/admin/settings/platform', payload)
    return platformSettingsResponseSchema.parse(unwrapPayload(response.data))
  },
  async listAuditHistory(): Promise<z.infer<typeof settingsAuditHistorySchema>> {
    const response = await api.get('/admin/settings/audit-history')
    return settingsAuditHistorySchema.parse(unwrapPayload(response.data))
  },
  async getNotificationSettings(): Promise<NotificationSettings> {
    const response = await api.get('/admin/settings/notification-settings')
    return notificationSettingsSchema.parse(unwrapPayload(response.data))
  },
  async updateNotificationSettings(payload: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const response = await api.patch('/admin/settings/notification-settings', payload)
    return notificationSettingsSchema.parse(unwrapPayload(response.data))
  },
  async getNotificationTemplates(): Promise<NotificationTemplates> {
    const response = await api.get('/admin/settings/notification-templates')
    return notificationTemplatesSchema.parse(unwrapPayload(response.data))
  },
  async updateNotificationTemplates(payload: Partial<NotificationTemplates>): Promise<NotificationTemplates> {
    const response = await api.patch('/admin/settings/notification-templates', payload)
    return notificationTemplatesSchema.parse(unwrapPayload(response.data))
  },
  async previewNotificationTemplate(payload: { readonly eventType: 'PAYMENT_COMPLETED' | 'PAYMENT_FAILED'; readonly template: string }): Promise<NotificationTemplatePreview> {
    const response = await api.post('/admin/settings/notification-templates/preview', payload)
    return notificationTemplatePreviewSchema.parse(unwrapPayload(response.data))
  },
  async getNotificationOpsSummary(): Promise<NotificationOpsSummary> {
    const response = await api.get('/admin/settings/notification-ops-summary')
    return notificationOpsSummarySchema.parse(unwrapPayload(response.data))
  },
  async getNotificationDeliveryPolicy(): Promise<NotificationDeliveryPolicy> {
    const response = await api.get('/admin/settings/notification-delivery-policy')
    return notificationDeliveryPolicySchema.parse(unwrapPayload(response.data))
  },
  async listNotificationProblemEvents(): Promise<readonly NotificationProblemEvent[]> {
    const response = await api.get('/admin/settings/notification-events/problem-events')
    return notificationProblemEventsSchema.parse(unwrapPayload(response.data)).items
  },
  async enqueueNotificationDeliveryEvent(eventId: string): Promise<NotificationEnqueueResult> {
    const response = await api.post(`/admin/settings/notification-events/${encodeURIComponent(eventId)}/enqueue`)
    return notificationEnqueueResultSchema.parse(unwrapPayload(response.data))
  },
  async processNextNotificationBotDelivery(): Promise<NotificationBotDeliveryResult> {
    const response = await api.post('/admin/settings/notification-events/process-next-bot-delivery')
    return notificationBotDeliveryResultSchema.parse(unwrapPayload(response.data))
  },
  async processNotificationBotDeliveryBatch(): Promise<NotificationBotDeliveryBatchResult> {
    const response = await api.post('/admin/settings/notification-events/process-bot-delivery-batch')
    return notificationBotDeliveryBatchResultSchema.parse(unwrapPayload(response.data))
  },
  async getReferralExchangePolicy(): Promise<ReferralExchangePolicy> {
    const response = await api.get('/admin/settings/referral-exchange-policy')
    return referralExchangePolicySchema.parse(unwrapPayload(response.data))
  },
  async updateReferralExchangePolicy(payload: Partial<ReferralExchangePolicy>): Promise<ReferralExchangePolicy> {
    const response = await api.patch('/admin/settings/referral-exchange-policy', payload)
    return referralExchangePolicySchema.parse(unwrapPayload(response.data))
  },
  async getPartnerWithdrawalPolicy(): Promise<PartnerWithdrawalPolicy> {
    const response = await api.get('/admin/settings/partner-withdrawal-policy')
    return partnerWithdrawalPolicySchema.parse(unwrapPayload(response.data))
  },
  async updatePartnerWithdrawalPolicy(payload: Partial<Omit<PartnerWithdrawalPolicy, 'updatedAt'>>): Promise<PartnerWithdrawalPolicy> {
    const response = await api.patch('/admin/settings/partner-withdrawal-policy', payload)
    return partnerWithdrawalPolicySchema.parse(unwrapPayload(response.data))
  },
}
