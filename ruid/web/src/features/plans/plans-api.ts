import { z } from 'zod'
import { api } from '@/lib/api'

const planPriceSchema = z.object({
  currency: z.enum(['USD', 'RUB', 'USDT', 'TON', 'BTC', 'ETH']),
  price: z.string(),
})

const planDurationSchema = z.object({
  id: z.string(),
  days: z.number(),
  prices: z.array(planPriceSchema),
})

const planSchema = z.object({
  id: z.string(),
  orderIndex: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  tag: z.string().nullable(),
  type: z.enum(['TRAFFIC', 'DEVICES', 'BOTH', 'UNLIMITED']),
  trafficLimit: z.number().nullable(),
  deviceLimit: z.number(),
  durations: z.array(planDurationSchema),
})

export const plansApi = {
  async getPlans() {
    const response = await api.get('/plans')
    const plans = z.array(planSchema).parse(response.data)
    return [...plans].sort((leftPlan, rightPlan) => leftPlan.orderIndex - rightPlan.orderIndex)
  },
}
