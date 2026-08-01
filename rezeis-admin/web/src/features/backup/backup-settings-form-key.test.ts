import { describe, expect, it } from 'vitest'

import { getBackupSettingsFormKey } from './backup-settings-form-key'

describe('getBackupSettingsFormKey', () => {
  it('preserves the editable form across an unchanged background refetch', () => {
    const settings = {
      autoEnabled: true,
      intervalHours: 24,
      maxKeep: 7,
      telegram: { enabled: true, chatId: '-100123', topicId: 9 },
      botTokenConfigured: true,
    }

    expect(getBackupSettingsFormKey({ ...settings, telegram: { ...settings.telegram } }))
      .toBe(getBackupSettingsFormKey(settings))
  })

  it('reinitializes the form only when the server settings change', () => {
    const settings = {
      autoEnabled: true,
      intervalHours: 24,
      maxKeep: 7,
      telegram: { enabled: false, chatId: null, topicId: null },
      botTokenConfigured: false,
    }

    expect(getBackupSettingsFormKey({ ...settings, intervalHours: 12 }))
      .not.toBe(getBackupSettingsFormKey(settings))
  })
})
