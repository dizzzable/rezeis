import { z } from 'zod'

export function createPlatformSettingsSchema() {
  return z.object({
    rulesRequired: z.boolean(),
    rulesLink: z.string().trim().max(500, 'settings.platform.errors.rulesLinkMax'),
    channelRequired: z.boolean(),
    channelId: z.string().trim().max(120, 'settings.platform.errors.channelIdMax'),
    channelLink: z.string().trim().max(500, 'settings.platform.errors.channelLinkMax'),
    accessMode: z.string().trim().min(1, 'settings.platform.errors.accessModeRequired'),
    inviteModeStartedAt: z.string(),
    defaultCurrency: z
      .string()
      .trim()
      .min(1, 'settings.platform.errors.defaultCurrencyRequired')
      .max(12, 'settings.platform.errors.defaultCurrencyMax'),
  })
}
