/**
 * Lazy-loaded i18n feature bundle: platformSettings
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: settings, accessModePage.
 */

import { ru } from './platformSettings.ru'
import { en } from './platformSettings.en'

export const platformSettings = { ru, en } as const
