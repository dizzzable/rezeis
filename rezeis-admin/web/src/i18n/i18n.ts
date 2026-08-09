import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { getStoredLocale } from '@/lib/locale-storage';

type SupportedLocale = 'ru' | 'en';

const initialLocale: SupportedLocale = getStoredLocale() === 'ru' ? 'ru' : 'en';

const loadedLocales = new Set<SupportedLocale>();

async function loadLocale(locale: SupportedLocale): Promise<void> {
  if (loadedLocales.has(locale)) return;
  // Vite splits each dynamic import into its own chunk; only the active
  // language reaches the user's browser on first paint. The second
  // language is fetched on demand (operator presses the language menu).
  const dict = locale === 'ru' ? (await import('@/i18n/ru')).ru : (await import('@/i18n/en')).en;
  i18n.addResourceBundle(locale, 'translation', dict, true, true);
  loadedLocales.add(locale);
}

void i18n.use(initReactI18next).init({
  resources: {},
  lng: initialLocale,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

// Pre-load the initial language before first paint. Exposed as a promise so
// the bootstrap (main.tsx) can await it — otherwise `t()` returns raw keys
// (e.g. the "auth.verifyingSession" spinner shown during session probing) until
// the dynamically-imported locale chunk lands, which is visible on slower
// mobile/iOS networks. Subsequent changeLanguage() calls load lazily via the
// languageChanged handler below.
export const i18nReady: Promise<void> = loadLocale(initialLocale);

i18n.on('languageChanged', (lng: string): void => {
  if (lng === 'ru' || lng === 'en') {
    void loadLocale(lng);
    // Re-hydrate any feature bundles that have been loaded for the
    // previous language so the user sees translated keys immediately
    // after switching the UI language.
    for (const feature of loadedFeatureBundles) {
      void loadFeatureBundle(feature).catch((error: unknown) => {
        // Fire-and-forget: a failed re-hydration leaves the previous
        // language's strings on screen, which is survivable. An unhandled
        // rejection here would not be.
        console.warn(`[i18n] re-hydrating "${feature}" for "${lng}" failed:`, error);
      });
    }
  }
});

export { i18n };

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
  | 'branding'
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
  | 'botMap'
  | 'advertising'
  | 'subpageConfig'
  | 'landingBuilder'
  | 'legalDocuments';

const loadedFeatureBundles = new Set<I18nFeature>();
const featureLoadPromises = new Map<string, Promise<void>>();

async function fetchFeatureBundle(
  feature: I18nFeature,
  locale: SupportedLocale,
): Promise<Record<string, unknown>> {
  switch (feature) {
    case 'appearance':
      return locale === 'ru'
        ? (await import('@/i18n/features/appearance.ru')).ru
        : (await import('@/i18n/features/appearance.en')).en;
    case 'branding':
      return locale === 'ru'
        ? (await import('@/i18n/features/branding.ru')).ru
        : (await import('@/i18n/features/branding.en')).en;
    case 'userDetail':
      return locale === 'ru'
        ? (await import('@/i18n/features/userDetail.ru')).ru
        : (await import('@/i18n/features/userDetail.en')).en;
    case 'platformSettings':
      return locale === 'ru'
        ? (await import('@/i18n/features/platformSettings.ru')).ru
        : (await import('@/i18n/features/platformSettings.en')).en;
    case 'notifications':
      return locale === 'ru'
        ? (await import('@/i18n/features/notifications.ru')).ru
        : (await import('@/i18n/features/notifications.en')).en;
    case 'dashboard':
      return locale === 'ru'
        ? (await import('@/i18n/features/dashboard.ru')).ru
        : (await import('@/i18n/features/dashboard.en')).en;
    case 'remnawave':
      return locale === 'ru'
        ? (await import('@/i18n/features/remnawave.ru')).ru
        : (await import('@/i18n/features/remnawave.en')).en;
    case 'payments':
      return locale === 'ru'
        ? (await import('@/i18n/features/payments.ru')).ru
        : (await import('@/i18n/features/payments.en')).en;
    case 'twoFactor':
      return locale === 'ru'
        ? (await import('@/i18n/features/twoFactor.ru')).ru
        : (await import('@/i18n/features/twoFactor.en')).en;
    case 'imports':
      return locale === 'ru'
        ? (await import('@/i18n/features/imports.ru')).ru
        : (await import('@/i18n/features/imports.en')).en;
    case 'analytics':
      return locale === 'ru'
        ? (await import('@/i18n/features/analytics.ru')).ru
        : (await import('@/i18n/features/analytics.en')).en;
    case 'broadcast':
      return locale === 'ru'
        ? (await import('@/i18n/features/broadcast.ru')).ru
        : (await import('@/i18n/features/broadcast.en')).en;
    case 'automations':
      return locale === 'ru'
        ? (await import('@/i18n/features/automations.ru')).ru
        : (await import('@/i18n/features/automations.en')).en;
    case 'botMap':
      return locale === 'ru'
        ? (await import('@/i18n/features/botMap.ru')).ru
        : (await import('@/i18n/features/botMap.en')).en;
    case 'advertising':
      return locale === 'ru'
        ? (await import('@/i18n/features/advertising.ru')).ru
        : (await import('@/i18n/features/advertising.en')).en;
    case 'subpageConfig':
      return locale === 'ru'
        ? (await import('@/i18n/features/subpageConfig.ru')).ru
        : (await import('@/i18n/features/subpageConfig.en')).en;
    case 'landingBuilder':
      return locale === 'ru'
        ? (await import('@/i18n/features/landingBuilder.ru')).ru
        : (await import('@/i18n/features/landingBuilder.en')).en;
    case 'legalDocuments':
      return locale === 'ru'
        ? (await import('@/i18n/features/legalDocuments.ru')).ru
        : (await import('@/i18n/features/legalDocuments.en')).en;
  }
}

export async function loadFeatureBundle(feature: I18nFeature): Promise<void> {
  const lng = (i18n.language as SupportedLocale) ?? initialLocale;
  const cacheKey = `${feature}|${lng}`;
  const existing = featureLoadPromises.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const dict = await fetchFeatureBundle(feature, lng);
    i18n.addResourceBundle(lng, 'translation', dict, true, true);
    loadedFeatureBundles.add(feature);
  })();
  featureLoadPromises.set(cacheKey, promise);
  // Cache the SUCCESS, never the failure. A bundle fetch is a network request
  // for a hashed chunk, and it fails for ordinary reasons: a flaky connection,
  // or a deploy that replaced the chunk while the tab was open. Leaving the
  // rejected promise in the map made that permanent for the life of the tab —
  // every later navigation to the route re-awaited the same rejection, so the
  // page stayed broken until a full reload. Evicting it makes the next
  // navigation a real retry.
  void promise.catch(() => {
    if (featureLoadPromises.get(cacheKey) === promise) {
      featureLoadPromises.delete(cacheKey);
    }
  });
  return promise;
}

/**
 * `lazy()`-compatible loader that ensures the i18n feature bundle is
 * loaded BEFORE the dynamic page chunk resolves. Translation keys for
 * the feature are guaranteed to be present on first render of the page.
 *
 * The bundle load is best-effort. `Promise.all` rejects on the FIRST
 * rejection and discards the other result, so an unhandled bundle failure
 * threw away a perfectly good page module and handed `React.lazy` a
 * rejection — the route rendered as a blank page. Missing translations are
 * a cosmetic failure (i18next falls back to `fallbackLng`, and past that to
 * the key itself); a route that will not render is not. So the page always
 * wins, and the failure is logged rather than propagated. `loadFeatureBundle`
 * drops the rejected promise from its cache, so the next navigation retries.
 *
 * Usage:
 *   const UsersPage = lazy(withFeatureBundle('users', () => import('@/features/users/users-page')))
 */
export function withFeatureBundle<T>(
  feature: I18nFeature,
  importer: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    const [mod] = await Promise.all([
      importer(),
      loadFeatureBundle(feature).catch((error: unknown) => {
        console.warn(`[i18n] feature bundle "${feature}" failed to load:`, error);
      }),
    ]);
    return mod;
  };
}
