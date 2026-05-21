import { z } from 'zod'
import { api } from '@/lib/api'

export const promoCodeAvailabilitySchema = z.enum(['ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED'])
export type PromoCodeAvailability = z.infer<typeof promoCodeAvailabilitySchema>

export const promoCodeRewardTypeSchema = z.enum([
  'DURATION', 'TRAFFIC', 'DEVICES', 'SUBSCRIPTION', 'PERSONAL_DISCOUNT', 'PURCHASE_DISCOUNT',
])
export type PromoCodeRewardType = z.infer<typeof promoCodeRewardTypeSchema>

export const promoCodeRecordSchema = z.object({
  id: z.string(),
  code: z.string(),
  codeNormalized: z.string(),
  isActive: z.boolean(),
  availability: promoCodeAvailabilitySchema,
  rewardType: promoCodeRewardTypeSchema,
  rewardValue: z.number(),
  maxActivations: z.number().nullable(),
  activationsCount: z.number(),
  remainingUses: z.number().nullable(),
  allowedUserIds: z.array(z.string()),
  allowedPlanIds: z.array(z.string()),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type PromoCodeRecord = z.infer<typeof promoCodeRecordSchema>

export const promoCodeActivationSchema = z.object({
  id: z.string(),
  promoCodeId: z.string(),
  code: z.string(),
  userId: z.string(),
  rewardType: promoCodeRewardTypeSchema,
  rewardValue: z.number(),
  rewardSnapshot: z.record(z.string(), z.unknown()).nullable(),
  promoCodeSnapshot: z.record(z.string(), z.unknown()).nullable(),
  targetSubscriptionId: z.string().nullable(),
  targetSubscriptionSnapshot: z.record(z.string(), z.unknown()).nullable(),
  activatedAt: z.string(),
  user: z.object({
    id: z.string(),
    telegramId: z.string().nullable(),
    username: z.string().nullable(),
  }).nullable(),
})
export type PromoCodeActivation = z.infer<typeof promoCodeActivationSchema>

export const promoCodeActivationNextStepSchema = z.enum(['NONE', 'SELECT_SUBSCRIPTION'])
export type PromoCodeActivationNextStep = z.infer<typeof promoCodeActivationNextStepSchema>

export const activatePromocodeRequestSchema = z.object({
  userId: z.string().min(1),
  code: z.string().min(1),
  targetSubscriptionId: z.string().min(1).optional(),
})
export type ActivatePromocodeRequest = z.infer<typeof activatePromocodeRequestSchema>

export const availableActivationSubscriptionSchema = z.object({
  id: z.string(),
  planId: z.string(),
  planName: z.string(),
})
export type AvailableActivationSubscription = z.infer<typeof availableActivationSubscriptionSchema>

export const activatePromocodeResponseSchema = z.object({
  success: z.boolean(),
  code: z.string(),
  message: z.string(),
  reward: z.unknown().nullable().optional(),
  nextStep: promoCodeActivationNextStepSchema,
  availableSubscriptions: z.array(availableActivationSubscriptionSchema).default([]),
  errorCode: z.string().nullable().optional(),
})
export type ActivatePromocodeResponse = z.infer<typeof activatePromocodeResponseSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapPayload(value: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) throw new Error('errors.unexpectedResponsePayload')
  const nested = value.data
  if (Array.isArray(nested) || isRecord(nested)) return nested
  return value
}

export const promocodesApi = {
  async listPromocodes(params?: {
    page?: number
    limit?: number
    search?: string
    isActive?: boolean
    availability?: PromoCodeAvailability
    rewardType?: PromoCodeRewardType
    sortBy?: 'createdAt' | 'expiresAt' | 'code'
    sortOrder?: 'asc' | 'desc'
  }): Promise<{ data: PromoCodeRecord[]; total: number; page: number; limit: number }> {
    const response = await api.get('/admin/promocodes', { params })
    const payload = unwrapPayload(response.data) as Record<string, unknown>
    return {
      data: z.array(promoCodeRecordSchema).parse(payload.data ?? []),
      total: z.number().parse(payload.total ?? 0),
      page: z.number().parse(payload.page ?? 1),
      limit: z.number().parse(payload.limit ?? 20),
    }
  },

  async getPromocode(id: string): Promise<PromoCodeRecord> {
    const response = await api.get(`/admin/promocodes/${id}`)
    return promoCodeRecordSchema.parse(unwrapPayload(response.data))
  },

  async createPromocode(payload: unknown): Promise<PromoCodeRecord> {
    const response = await api.post('/admin/promocodes', payload)
    return promoCodeRecordSchema.parse(unwrapPayload(response.data))
  },

  async updatePromocode(id: string, payload: unknown): Promise<PromoCodeRecord> {
    const response = await api.patch(`/admin/promocodes/${id}`, payload)
    return promoCodeRecordSchema.parse(unwrapPayload(response.data))
  },

  async deletePromocode(id: string): Promise<void> {
    await api.delete(`/admin/promocodes/${id}`)
  },

  async togglePromocode(id: string): Promise<PromoCodeRecord> {
    const response = await api.post(`/admin/promocodes/${id}/toggle`)
    return promoCodeRecordSchema.parse(unwrapPayload(response.data))
  },

  async listActivations(params?: {
    page?: number
    limit?: number
    userId?: string
    promoCodeId?: string
  }): Promise<{ data: PromoCodeActivation[]; total: number; page: number; limit: number }> {
    const response = await api.get('/admin/promocodes/activations', { params })
    const payload = unwrapPayload(response.data) as Record<string, unknown>
    return {
      data: z.array(promoCodeActivationSchema).parse(payload.data ?? []),
      total: z.number().parse(payload.total ?? 0),
      page: z.number().parse(payload.page ?? 1),
      limit: z.number().parse(payload.limit ?? 20),
    }
  },

  async listPromocodeActivations(
    promoCodeId: string,
    params?: { page?: number; limit?: number },
  ): Promise<{ data: PromoCodeActivation[]; total: number; page: number; limit: number }> {
    const response = await api.get(`/admin/promocodes/${promoCodeId}/activations`, { params })
    const payload = unwrapPayload(response.data) as Record<string, unknown>
    return {
      data: z.array(promoCodeActivationSchema).parse(payload.data ?? []),
      total: z.number().parse(payload.total ?? 0),
      page: z.number().parse(payload.page ?? 1),
      limit: z.number().parse(payload.limit ?? 20),
    }
  },

  async activatePromocode(payload: ActivatePromocodeRequest): Promise<ActivatePromocodeResponse> {
    const parsedPayload = activatePromocodeRequestSchema.parse(payload)
    const response = await api.post('/admin/promocodes/activate', parsedPayload)
    return activatePromocodeResponseSchema.parse(unwrapPayload(response.data))
  },
}

export const promoCodeFormSchema = z.object({
  code: z.string().min(3).max(32),
  isActive: z.boolean(),
  availability: promoCodeAvailabilitySchema,
  rewardType: promoCodeRewardTypeSchema,
  rewardValue: z.number().int().min(0),
  maxActivations: z.number().int().min(1).nullable(),
  allowedUserIds: z.array(z.string()),
  allowedPlanIds: z.array(z.string()),
  expiresAt: z.string().nullable().optional(),
  lifetimeDays: z.number().int().min(1).max(3650).nullable().optional(),
})
export type PromoCodeFormValues = z.infer<typeof promoCodeFormSchema>

export function createEmptyPromoCodeFormValues(): PromoCodeFormValues {
  return {
    code: '',
    isActive: true,
    availability: 'ALL',
    rewardType: 'DURATION',
    rewardValue: 30,
    maxActivations: null,
    allowedUserIds: [],
    allowedPlanIds: [],
    expiresAt: null,
    lifetimeDays: null,
  }
}
