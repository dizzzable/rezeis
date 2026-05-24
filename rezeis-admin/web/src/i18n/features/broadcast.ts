/**
 * Lazy-loaded i18n feature bundle: broadcast
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: broadcastPage.
 */

import { ru } from './broadcast.ru'
import { en } from './broadcast.en'

export const broadcast = { ru, en } as const
