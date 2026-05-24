/**
 * Lazy-loaded i18n feature bundle: twoFactor
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: twoFactorPage.
 */

import { ru } from './twoFactor.ru'
import { en } from './twoFactor.en'

export const twoFactor = { ru, en } as const
