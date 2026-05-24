/**
 * Lazy-loaded i18n feature bundle: dashboard
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: dashboard, dashboardPage.
 */

import { ru } from './dashboard.ru'
import { en } from './dashboard.en'

export const dashboard = { ru, en } as const
