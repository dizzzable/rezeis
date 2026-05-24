/**
 * Lazy-loaded i18n feature bundle: notifications
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: notificationsPage.
 */

import { ru } from './notifications.ru'
import { en } from './notifications.en'

export const notifications = { ru, en } as const
