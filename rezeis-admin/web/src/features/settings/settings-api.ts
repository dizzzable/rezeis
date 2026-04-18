import { z } from 'zod'
import { api } from '@/lib/api'

const platformSettingsResponseSchema = z.object({
  rulesRequired: z.boolean().catch(false),
  rulesLink: z.string().nullable().optional(),
  channelRequired: z.boolean().catch(false),
  channelId: z.string().nullable().optional(),
  channelLink: z.string().nullable().optional(),
  accessMode: z.string().nullable().optional(),
  inviteModeStartedAt: z.string().nullable().optional(),
  defaultCurrency: z.string().nullable().optional(),
})

interface PlatformSettingsPayload {
  readonly rulesRequired: boolean
  readonly rulesLink: string | null
  readonly channelRequired: boolean
  readonly channelId: string | null
  readonly channelLink: string | null
  readonly accessMode: string
  readonly inviteModeStartedAt: string | null
  readonly defaultCurrency: string
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
  async updatePlatformSettings(payload: PlatformSettingsPayload): Promise<z.infer<typeof platformSettingsResponseSchema>> {
    const response = await api.patch('/admin/settings/platform', payload)
    return platformSettingsResponseSchema.parse(unwrapPayload(response.data))
  },
}
