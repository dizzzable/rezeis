import type { BackupSettings } from './backup-api'

/**
 * A form should reset when the server configuration actually changes, not when
 * React Query records another successful fetch of the same configuration.
 * `dataUpdatedAt` changes for the latter case, so it must not be used as a
 * component key for an editable form.
 */
export function getBackupSettingsFormKey(data: BackupSettings | undefined): string {
  if (!data) return 'initial'

  return JSON.stringify([
    data.autoEnabled,
    data.intervalHours,
    data.maxKeep,
    data.telegram.enabled,
    data.telegram.chatId ?? null,
    data.telegram.topicId ?? null,
    data.botTokenConfigured,
  ])
}
