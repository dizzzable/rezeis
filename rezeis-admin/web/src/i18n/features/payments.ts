/**
 * Lazy-loaded i18n feature bundle: payments
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: paymentGateways, paymentsAnalytics.
 */

import { ru } from './payments.ru'
import { en } from './payments.en'

export const payments = { ru, en } as const
