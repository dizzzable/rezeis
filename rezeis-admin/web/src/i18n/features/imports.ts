/**
 * Lazy-loaded i18n feature bundle: imports
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: importsPage.
 */

import { ru } from './imports.ru'
import { en } from './imports.en'

export const imports = { ru, en } as const
