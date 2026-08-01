import { describe, expect, it } from 'vitest'

import { getCleanupSettingsFormKey } from './cleanup-settings-form-key'

describe('getCleanupSettingsFormKey', () => {
  it('preserves edits across an unchanged background refetch', () => {
    expect(getCleanupSettingsFormKey({ deleteEnabled: true, graceDays: 3 }))
      .toBe(getCleanupSettingsFormKey({ deleteEnabled: true, graceDays: 3 }))
  })

  it('changes only for a changed cleanup policy', () => {
    expect(getCleanupSettingsFormKey({ deleteEnabled: true, graceDays: 3 }))
      .not.toBe(getCleanupSettingsFormKey({ deleteEnabled: false, graceDays: 3 }))
  })
})
