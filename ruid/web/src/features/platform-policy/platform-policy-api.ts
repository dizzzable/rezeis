import { z } from 'zod'
import { api } from '@/lib/api'

const accessModeSchema = z.enum(['PUBLIC', 'INVITED', 'PURCHASE_BLOCKED', 'REG_BLOCKED', 'RESTRICTED'])

const platformPolicySchema = z.object({
  rulesRequired: z.boolean(),
  rulesLink: z.string().nullable(),
  channelRequired: z.boolean(),
  channelLink: z.string().nullable(),
  accessMode: accessModeSchema,
  inviteModeStartedAt: z.string().datetime().nullable(),
  defaultCurrency: z.string().trim().min(1),
})

export const platformPolicyApi = {
  async getPlatformPolicy() {
    const response = await api.get('/platform-policy')
    return platformPolicySchema.parse(response.data)
  },
}
