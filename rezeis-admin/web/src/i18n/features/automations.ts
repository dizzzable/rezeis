/**
 * Lazy-loaded i18n feature bundle: automations
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: automationsPage.
 */

import { ru } from './automations.ru'
import { en } from './automations.en'

export const automations = { ru, en } as const
