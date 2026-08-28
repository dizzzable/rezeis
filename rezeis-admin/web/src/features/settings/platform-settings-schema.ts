import { z } from 'zod'
import { platformAccessModeSchema } from '@/features/settings/access-mode'

export function createPlatformSettingsSchema() {
  return z.object({
    rulesRequired: z.boolean(),
    rulesLink: z.string().trim().max(500, 'settings.platform.errors.rulesLinkMax'),
    channelRequired: z.boolean(),
    channelId: z.string().trim().max(120, 'settings.platform.errors.channelIdMax'),
    channelLink: z.string().trim().max(500, 'settings.platform.errors.channelLinkMax'),
    accessMode: platformAccessModeSchema,
    inviteModeStartedAt: z.string(),
    defaultCurrency: z
      .string()
      .trim()
      .min(1, 'settings.platform.errors.defaultCurrencyRequired')
      .max(12, 'settings.platform.errors.defaultCurrencyMax'),
    projectName: z.string().trim().max(120, 'settings.platform.errors.projectNameMax'),
    // Not checked against the zone database: the list ships with the
    // runtime, so a check here could refuse a zone the server would accept.
    // The server falls back to UTC for an unusable value.
    timezone: z.string().trim().max(64, 'settings.platform.errors.timezoneMax'),
    webTitle: z.string().trim().max(160, 'settings.platform.errors.webTitleMax'),
    supportUrl: z.string().trim().max(500, 'settings.platform.errors.supportUrlMax'),
    supportUsername: z.string().trim().max(64, 'settings.platform.errors.supportUsernameMax'),
    accessRequestIntro: z.string().trim().max(1000, 'settings.platform.errors.accessRequestIntroMax'),
    accessApprovedMessage: z.string().trim().max(1000, 'settings.platform.errors.accessApprovedMessageMax'),
    accessRejectedMessage: z.string().trim().max(1000, 'settings.platform.errors.accessRejectedMessageMax'),
  })
}
