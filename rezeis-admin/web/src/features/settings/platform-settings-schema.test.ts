import { describe, expect, it } from 'vitest'
import { PLATFORM_ACCESS_MODES } from '@/features/settings/access-mode'
import { createPlatformSettingsSchema } from '@/features/settings/platform-settings-schema'

const schema = createPlatformSettingsSchema()

function createValidSettingsInput(accessMode: (typeof PLATFORM_ACCESS_MODES)[number] | string) {
  return {
    rulesRequired: true,
    rulesLink: 'https://example.com/rules',
    channelRequired: false,
    channelId: '@rezeis',
    channelLink: 'https://t.me/rezeis',
    accessMode,
    inviteModeStartedAt: '',
    defaultCurrency: 'USD',
    projectName: 'Rezeis',
    webTitle: 'Rezeis VPN',
    supportUrl: 'https://t.me/rezeis_support',
    supportUsername: '@rezeis_support',
    accessRequestIntro: 'Request access to Rezeis.',
    accessApprovedMessage: 'Your request has been approved.',
    accessRejectedMessage: 'Your request has been rejected.',
  }
}

describe('platform settings schema', () => {
  it('accepts every backend-supported access mode', () => {
    for (const accessMode of PLATFORM_ACCESS_MODES) {
      const result = schema.safeParse(createValidSettingsInput(accessMode))

      expect(result.success).toBe(true)
    }
  })

  it('rejects legacy admin access mode values', () => {
    for (const accessMode of ['open', 'approval', 'invite']) {
      const result = schema.safeParse(createValidSettingsInput(accessMode))

      expect(result.success).toBe(false)
    }
  })
})
