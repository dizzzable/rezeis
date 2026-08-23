/**
 * Lazy-loaded i18n feature bundle: panelLinkReconciliation
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: panelLinkReconciliation, duplicateMerge.
 *
 * `duplicateMerge` rides in this bundle rather than in one of its own because
 * both surfaces sit on the SAME page (`/subscriptions`, which loads this
 * feature key) and look at the same rows: the merge discovers its pairs by
 * running the reconciliation sweep. A second lazy bundle would be a second
 * chunk and a second `loadFeatureBundle` call for one card on a screen that
 * has already fetched this one.
 */

import { ru } from './panelLinkReconciliation.ru'
import { en } from './panelLinkReconciliation.en'

export const panelLinkReconciliation = { ru, en } as const
