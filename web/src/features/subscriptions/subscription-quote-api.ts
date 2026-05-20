import { z } from 'zod'
import { api } from '@/lib/api'

const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
})

const quoteDurationSchema = z.object({
  id: z.string(),
  days: z.number(),
})

const quotePlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  tag: z.string().nullable(),
  type: z.string(),
  trafficLimit: z.number().nullable(),
  deviceLimit: z.number(),
  trafficLimitStrategy: z.string(),
  durations: z.array(quoteDurationSchema),
})

const quotePriceSchema = z.object({
  gatewayType: z.enum(['TELEGRAM_STARS', 'YOOKASSA', 'PLATEGA', 'HELEKET', 'CRYPTOMUS', 'MULENPAY']),
  currency: z.string(),
  originalPrice: z.string(),
  price: z.string(),
  discountPercent: z.number(),
  discountSource: z.string(),
})

const actionPolicySchema = z.object({
  userId: z.string(),
  channel: z.enum(['WEB', 'TELEGRAM', 'MINI_APP']),
  actions: z.object({
    NEW: z.boolean(),
    ADDITIONAL: z.boolean(),
    RENEW: z.boolean(),
    UPGRADE: z.boolean(),
    TRIAL: z.boolean(),
  }),
  activeSubscriptionCount: z.number(),
  maxSubscriptions: z.number(),
  currentSubscriptionId: z.string().nullable(),
  availablePlans: z.array(quotePlanSchema),
  warnings: z.array(warningSchema),
})

const quoteSchema = z.object({
  userId: z.string(),
  purchaseType: z.enum(['NEW', 'ADDITIONAL', 'RENEW', 'UPGRADE', 'TRIAL']),
  channel: z.enum(['WEB', 'TELEGRAM', 'MINI_APP']),
  isEligible: z.boolean(),
  selectedSubscriptionId: z.string().nullable(),
  selectedPlan: quotePlanSchema.nullable(),
  selectedDuration: quoteDurationSchema.nullable(),
  availablePlans: z.array(quotePlanSchema),
  price: quotePriceSchema.nullable(),
  warnings: z.array(warningSchema),
})

export type SubscriptionQuoteAction = z.infer<typeof quoteSchema>['purchaseType']
export type SubscriptionQuoteChannel = z.infer<typeof quoteSchema>['channel']
export type SubscriptionActionPolicy = z.infer<typeof actionPolicySchema>
export type SubscriptionQuote = z.infer<typeof quoteSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('errors.unexpectedResponsePayload')
  }
  const nestedValue: unknown = value.data
  if (isRecord(nestedValue)) {
    return nestedValue
  }
  return value
}

export const subscriptionQuoteApi = {
  async getActionPolicy(payload: {
    readonly userId: string
    readonly subscriptionId?: string
    readonly channel?: SubscriptionQuoteChannel
  }): Promise<SubscriptionActionPolicy> {
    const response = await api.post('/admin/subscriptions/action-policy', payload)
    return actionPolicySchema.parse(unwrapPayload(response.data))
  },
  async getQuote(payload: {
    readonly userId: string
    readonly purchaseType: SubscriptionQuoteAction
    readonly subscriptionId?: string
    readonly planId?: string
    readonly durationDays?: number
    readonly channel?: SubscriptionQuoteChannel
  }): Promise<SubscriptionQuote> {
    const response = await api.post('/admin/subscriptions/quote', payload)
    return quoteSchema.parse(unwrapPayload(response.data))
  },
}
