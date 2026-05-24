/**
 * Lazy-loaded i18n feature bundle: analytics
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: analyticsPage.
 */

import { ru } from './analytics.ru'
import { en } from './analytics.en'

export const analytics = { ru, en } as const
