/**
 * Lazy-loaded i18n feature bundle: remnawave
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: remnaWavePage.
 */

import { ru } from './remnawave.ru'
import { en } from './remnawave.en'

export const remnawave = { ru, en } as const
