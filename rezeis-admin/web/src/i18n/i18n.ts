import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { getStoredLocale } from '@/lib/locale-storage'

type SupportedLocale = 'ru' | 'en'

const initialLocale: SupportedLocale = getStoredLocale() === 'ru' ? 'ru' : 'en'

const loadedLocales = new Set<SupportedLocale>()

async function loadLocale(locale: SupportedLocale): Promise<void> {
  if (loadedLocales.has(locale)) return
  // Vite splits each dynamic import into its own chunk; only the active
  // language reaches the user's browser on first paint. The second
  // language is fetched on demand (operator presses the language menu).
  const dict =
    locale === 'ru'
      ? (await import('@/i18n/ru')).ru
      : (await import('@/i18n/en')).en
  i18n.addResourceBundle(locale, 'translation', dict, true, true)
  loadedLocales.add(locale)
}

void i18n.use(initReactI18next).init({
  resources: {},
  lng: initialLocale,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
})

// Pre-load the initial language synchronously so the first render has
// translations available. Subsequent changeLanguage() calls trigger
// loadLocale() lazily through the language change event.
void loadLocale(initialLocale)

i18n.on('languageChanged', (lng: string): void => {
  if (lng === 'ru' || lng === 'en') {
    void loadLocale(lng)
    // Re-hydrate any feature bundles that have been loaded for the
    // previous language so the user sees translated keys immediately
    // after switching the UI language.
    for (const feature of loadedFeatureBundles) {
      void loadFeatureBundle(feature)
    }
  }
})

export { i18n }

// ─────────────────────────────────────────────────────────────────────────────
// Feature bundles (lazy-loaded namespaces)
// ─────────────────────────────────────────────────────────────────────────────
//
// Heavy namespaces are extracted into per-feature modules under
// `src/i18n/features/` to shrink the core i18n bundle. Each lazy page
// calls `loadFeatureBundle(feature)` (typically via the `withFeatureBundle`
// helper applied to `lazy()`) before its component renders so the
// translations are merged into the active i18next bundle.
//
// The bundle resolves once per (locale, feature) pair. Subsequent
// `changeLanguage` calls re-hydrate every previously-loaded bundle for
// the new language automatically.

export type I18nFeature =
  | 'appearance'
  | 'userDetail'
  | 'platformSettings'
  | 'notifications'
  | 'dashboard'
  | 'remnawave'
  | 'payments'
  | 'twoFactor'
  | 'imports'
  | 'analytics'
  | 'broadcast'
  | 'automations'

const loadedFeatureBundles = new Set<I18nFeature>()
const featureLoadPromises = new Map<string, Promise<void>>()

async function fetchFeatureBundle(
  feature: I18nFeature,
  locale: SupportedLocale,
): Promise<Record<string, unknown>> {
  switch (feature) {
    case 'appearance':
      return locale === 'ru'
        ? (await import('@/i18n/features/appearance.ru')).ru
        : (await import('@/i18n/features/appearance.en')).en
    case 'userDetail':
      return locale === 'ru'
        ? (await import('@/i18n/features/userDetail.ru')).ru
        : (await import('@/i18n/features/userDetail.en')).en
    case 'platformSettings':
      return locale === 'ru'
        ? (await import('@/i18n/features/platformSettings.ru')).ru
        : (await import('@/i18n/features/platformSettings.en')).en
    case 'notifications':
      return locale === 'ru'
        ? (await import('@/i18n/features/notifications.ru')).ru
        : (await import('@/i18n/features/notifications.en')).en
    case 'dashboard':
      return locale === 'ru'
        ? (await import('@/i18n/features/dashboard.ru')).ru
        : (await import('@/i18n/features/dashboard.en')).en
    case 'remnawave':
      return locale === 'ru'
        ? (await import('@/i18n/features/remnawave.ru')).ru
        : (await import('@/i18n/features/remnawave.en')).en
    case 'payments':
      return locale === 'ru'
        ? (await import('@/i18n/features/payments.ru')).ru
        : (await import('@/i18n/features/payments.en')).en
    case 'twoFactor':
      return locale === 'ru'
        ? (await import('@/i18n/features/twoFactor.ru')).ru
        : (await import('@/i18n/features/twoFactor.en')).en
    case 'imports':
      return locale === 'ru'
        ? (await import('@/i18n/features/imports.ru')).ru
        : (await import('@/i18n/features/imports.en')).en
    case 'analytics':
      return locale === 'ru'
        ? (await import('@/i18n/features/analytics.ru')).ru
        : (await import('@/i18n/features/analytics.en')).en
    case 'broadcast':
      return locale === 'ru'
        ? (await import('@/i18n/features/broadcast.ru')).ru
        : (await import('@/i18n/features/broadcast.en')).en
    case 'automations':
      return locale === 'ru'
        ? (await import('@/i18n/features/automations.ru')).ru
        : (await import('@/i18n/features/automations.en')).en
  }
}

export async function loadFeatureBundle(feature: I18nFeature): Promise<void> {
  const lng = (i18n.language as SupportedLocale) ?? initialLocale
  const cacheKey = `${feature}|${lng}`
  const existing = featureLoadPromises.get(cacheKey)
  if (existing) return existing

  const promise = (async () => {
    const dict = await fetchFeatureBundle(feature, lng)
    i18n.addResourceBundle(lng, 'translation', dict, true, true)
    loadedFeatureBundles.add(feature)
  })()
  featureLoadPromises.set(cacheKey, promise)
  return promise
}

/**
 * `lazy()`-compatible loader that ensures the i18n feature bundle is
 * loaded BEFORE the dynamic page chunk resolves. Translation keys for
 * the feature are guaranteed to be present on first render of the page.
 *
 * Usage:
 *   const UsersPage = lazy(withFeatureBundle('users', () => import('@/features/users/users-page')))
 */
export function withFeatureBundle<T>(
  feature: I18nFeature,
  importer: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    const [mod] = await Promise.all([importer(), loadFeatureBundle(feature)])
    return mod
  }
}
