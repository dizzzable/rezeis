/**
 * Lazy-loaded i18n feature bundle: subscriptionTools
 *
 * Re-exports per-language modules so Vite can split each language into
 * its own chunk; only the active language ships when the feature loads.
 *
 * Contains namespaces: subscriptionTools, duplicateMerge.
 *
 * Both are read on ONE page — `/subscriptions`, which loads this feature key —
 * because both live behind its «Инструменты» button: `duplicateMerge` is the
 * first tab of that sheet. A second lazy bundle would be a second chunk and a
 * second `loadFeatureBundle` call for one sheet on a screen that has already
 * fetched this one.
 */

import { ru } from './subscriptionTools.ru'
import { en } from './subscriptionTools.en'

export const subscriptionTools = { ru, en } as const
