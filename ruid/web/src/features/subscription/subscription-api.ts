import { z } from 'zod'
import { api } from '@/lib/api'

const subscriptionPlanSchema = z.object({
  name: z.string().nullable(),
  type: z.enum(['TRAFFIC', 'DEVICES', 'BOTH', 'UNLIMITED']).nullable(),
})

const subscriptionSchema = z.object({
  id: z.string(),
  status: z.enum(['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED', 'DELETED']),
  isTrial: z.boolean(),
  plan: subscriptionPlanSchema.nullable(),
  trafficLimit: z.number().nullable(),
  deviceLimit: z.number(),
  configUrl: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const subscriptionApi = {
  async getSubscription() {
    const response = await api.get('/subscription')
    return subscriptionSchema.nullable().parse(response.data)
  },
}
