/**
 * Lazy-loaded i18n feature bundle: addOns
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: addOnSwitches.
 */

import { ru } from './addOns.ru'
import { en } from './addOns.en'

export const addOns = { ru, en } as const
