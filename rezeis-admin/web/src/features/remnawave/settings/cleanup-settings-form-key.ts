import type { RemnawaveCleanupSettings } from '../remnawave-api'

/**
 * Keep local edits through unchanged background refetches. React Query updates
 * `dataUpdatedAt` for every successful fetch, whereas this key changes only
 * when the actual cleanup policy changes and the form should be reinitialized.
 */
export function getCleanupSettingsFormKey(data: RemnawaveCleanupSettings | undefined): string {
  if (!data) return 'initial'
  return JSON.stringify([data.deleteEnabled, data.graceDays])
}
