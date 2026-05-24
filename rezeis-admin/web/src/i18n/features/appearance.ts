/**
 * Lazy-loaded i18n feature bundle: appearance
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: appearancePage, glassSettings, effectsSettings.
 */

import { ru } from './appearance.ru'
import { en } from './appearance.en'

export const appearance = { ru, en } as const
