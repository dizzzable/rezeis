import { z } from 'zod'
import { DEFAULT_PLATFORM_ACCESS_MODE, platformAccessModeSchema, type PlatformAccessMode } from '@/features/settings/access-mode'
import { api } from '@/lib/api'
import { unwrapPayload } from '@/lib/api-utils'

/** Presence-only view of a quest partner secret — never carries the secret. */
const questPartnerViewSchema = z.object({
  slug: z.string(),
  label: z.string().optional(),
  configured: z.boolean().catch(true),
})
export type QuestPartnerView = z.infer<typeof questPartnerViewSchema>

/** Upsert instruction: secret undefined=keep, ''=clear, non-empty=set. */
export interface QuestPartnerUpsert {
  slug: string
  secret?: string
  label?: string
}


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
  audience: z.string().optional(),
  createdBy: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable().optional(),
  expiresAt: z.string(),
  createdAt: z.string(),
})

const createdApiTokenResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  prefix: z.string().optional(),
  expiresAt: z.string(),
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
// ── Anti-fraud detector tunables ───────────────────────────────────────────
// Precedence, mirrored from the server: a stored panel value WINS; the
// ANTIFRAUD_* environment variable is only the fallback. `fallback` carries what
// the env (or the built-in default) says, so the form can show an operator who
// set a variable why the number in front of them is different. `ranges` carries
// the documented bounds — they are NOT restated on this side, because a second
// copy is the one place they could drift from the server's validator.
const sharingDetectionConfigSchema = z.object({
  enableHwidOverage: z.boolean(),
  enableIpSharing: z.boolean(),
  ipWindowMinutes: z.number(),
  ipConcurrencyWindowSeconds: z.number(),
  maxNodesPerRun: z.number(),
  maxIpsInMetadata: z.number(),
  ipNetworkGrouping: z.boolean(),
  ipV4PrefixLength: z.number(),
  ipV6PrefixLength: z.number(),
  ipOverageMargin: z.number(),
})
const trafficAbuseConfigSchema = z.object({
  enabled: z.boolean(),
  minGb: z.number(),
  medianMultiplier: z.number(),
  sharePercent: z.number(),
  maxNodesPerRun: z.number(),
})
// The subscription-UA section has NO environment layer — these three knobs are
// new, so no ANTIFRAUD_* variable has ever set them. Its `fallback` is the
// built-in default and the form labels it "default", not "environment".
const subscriptionUaConfigSchema = z.object({
  enableSubscriptionUaTunnel: z.boolean(),
  uaEvidenceWindowMinutes: z.number(),
  uaRequestPageSize: z.number(),
})
const tunableRangeSchema = z.object({
  default: z.number(),
  min: z.number(),
  max: z.number(),
  integer: z.boolean(),
})
const antiFraudSettingsSchema = z.object({
  effective: z.object({
    sharing: sharingDetectionConfigSchema,
    trafficAbuse: trafficAbuseConfigSchema,
    subscriptionUa: subscriptionUaConfigSchema,
  }),
  fallback: z.object({
    sharing: sharingDetectionConfigSchema,
    trafficAbuse: trafficAbuseConfigSchema,
    subscriptionUa: subscriptionUaConfigSchema,
  }),
  stored: z.object({
    sharing: sharingDetectionConfigSchema.partial().optional(),
    trafficAbuse: trafficAbuseConfigSchema.partial().optional(),
    subscriptionUa: subscriptionUaConfigSchema.partial().optional(),
  }),
  overridden: z.object({
    sharing: z.array(z.string()),
    trafficAbuse: z.array(z.string()),
    subscriptionUa: z.array(z.string()),
  }),
  ranges: z.object({
    sharing: z.record(z.string(), tunableRangeSchema),
    trafficAbuse: z.record(z.string(), tunableRangeSchema),
    subscriptionUa: z.record(z.string(), tunableRangeSchema),
  }),
})

export type AntiFraudSettings = z.infer<typeof antiFraudSettingsSchema>
export type SharingDetectionConfig = z.infer<typeof sharingDetectionConfigSchema>
export type TrafficAbuseConfig = z.infer<typeof trafficAbuseConfigSchema>
export type SubscriptionUaConfig = z.infer<typeof subscriptionUaConfigSchema>
export type TunableRange = z.infer<typeof tunableRangeSchema>

/**
 * `null` on a field clears the panel value and restores the env fallback — or,
 * for `subscriptionUa`, the built-in default, which is the only layer under it.
 */
export interface AntiFraudSettingsPatch {
  sharing?: { [K in keyof SharingDetectionConfig]?: SharingDetectionConfig[K] | null }
  trafficAbuse?: { [K in keyof TrafficAbuseConfig]?: TrafficAbuseConfig[K] | null }
  subscriptionUa?: { [K in keyof SubscriptionUaConfig]?: SubscriptionUaConfig[K] | null }
}

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
  async getAntiFraudSettings(): Promise<AntiFraudSettings> {
    const response = await api.get('/admin/settings/anti-fraud')
    return antiFraudSettingsSchema.parse(unwrapPayload(response.data))
  },
  async updateAntiFraudSettings(payload: AntiFraudSettingsPatch): Promise<AntiFraudSettings> {
    const response = await api.patch('/admin/settings/anti-fraud', payload)
    return antiFraudSettingsSchema.parse(unwrapPayload(response.data))
  },
  async getQuestPartnerSecrets(): Promise<readonly QuestPartnerView[]> {
    const response = await api.get('/admin/settings/quest-partner-secrets')
    return z.array(questPartnerViewSchema).parse(unwrapPayload(response.data))
  },
  async updateQuestPartnerSecrets(partners: QuestPartnerUpsert[]): Promise<readonly QuestPartnerView[]> {
    const response = await api.patch('/admin/settings/quest-partner-secrets', { partners })
    return z.array(questPartnerViewSchema).parse(unwrapPayload(response.data))
  },
}
