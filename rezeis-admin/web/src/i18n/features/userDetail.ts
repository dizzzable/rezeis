/**
 * Lazy-loaded i18n feature bundle: userDetail
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: userDetailPanel, userDetailPage.
 */

import { ru } from './userDetail.ru'
import { en } from './userDetail.en'

export const userDetail = { ru, en } as const
