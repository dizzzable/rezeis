/**
 * The `branding` i18n feature bundle.
 *
 * `main.tsx` awaits `i18nReady` before the first render, so the core locale
 * chunk (`i18n/ru.ts` / `i18n/en.ts`) is render-blocking for EVERY route —
 * including /sign-in, which has nothing to do with card effects. The
 * card-effect label maps (~450 lines per language) therefore live in a lazy
 * bundle that the web-reiwa route pulls in via `withFeatureBundle`.
 *
 * Unlike its siblings this bundle does not own a whole namespace: it adds
 * blocks *inside* `brandingPage`, which i18next's deep `addResourceBundle`
 * merges over the core dictionary. That makes the "did it leak back into
 * core?" check below the load-bearing one — a merge conflict would not be
 * visible, only a slower login.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { en as coreEn } from '@/i18n/en'
import { ru as coreRu } from '@/i18n/ru'
import { i18n, i18nReady, loadFeatureBundle, withFeatureBundle } from '@/i18n/i18n'
// Shared with `i18n/bundle-parity.test.ts`. Extracted rather than copied: a
// second traversal that drifted would let one of the two suites stop comparing
// what it says it compares, and importing one test file from another
// re-registers its `describe` blocks into the importer.
import { keyPaths } from '@/test/i18n-key-paths'

import { en } from './branding.en'
import { ru } from './branding.ru'

type Dict = Record<string, unknown>

/** Blocks that must exist ONLY in the lazy bundle. */
const BUNDLE_ONLY_BLOCKS = [
  'cardEffectControls',
  'cardEffectControlOverrides',
  'cardEffectOptions',
  'cardEffectOptionOverrides',
] as const

describe('branding bundle shape', () => {
  it('nests everything under brandingPage', () => {
    expect(Object.keys(en)).toEqual(['brandingPage'])
    expect(Object.keys(ru)).toEqual(['brandingPage'])
  })

  it('has identical key paths in both languages', () => {
    const enKeys = keyPaths(en).sort()
    const ruKeys = keyPaths(ru).sort()
    expect(ruKeys.filter((k) => !enKeys.includes(k))).toEqual([])
    expect(enKeys.filter((k) => !ruKeys.includes(k))).toEqual([])
    // Truncation canary: the move out of the core dictionary is a bulk copy,
    // and a half-copied bundle still passes the parity checks above.
    // (363 leaf keys per language at the time of writing.)
    expect(enKeys.length).toBeGreaterThan(300)
  })

  it('translates every string (no English left in the Russian bundle)', () => {
    const enFlat = new Map(
      keyPaths(en).map((k) => [k, k.split('.').reduce<unknown>((n, p) => (n as Dict)?.[p], en)]),
    )
    const identical: string[] = []
    for (const key of keyPaths(ru)) {
      const value = key.split('.').reduce<unknown>((n, p) => (n as Dict)?.[p], ru)
      // Effect NAMES are product names and stay as-is in both languages
      // (Balatro, Grainient…); only the control/option prose must differ.
      if (key.startsWith('brandingPage.cardEffects.')) continue
      if (typeof value === 'string' && value === enFlat.get(key)) identical.push(key)
    }
    expect(identical).toEqual([])
  })
})

describe('render-blocking core dictionary', () => {
  it('does not carry the card-effect label maps', () => {
    // The whole point of the split. If a future edit puts these back into
    // i18n/{ru,en}.ts, the sign-in screen starts paying for them again.
    for (const block of BUNDLE_ONLY_BLOCKS) {
      expect(coreEn.brandingPage).not.toHaveProperty(block)
      expect(coreRu.brandingPage).not.toHaveProperty(block)
    }
  })

  it('does not carry the originkit effect names the bundle adds', () => {
    const coreNames = Object.keys(
      (coreEn.brandingPage as Dict).cardEffects as Dict,
    )
    const bundleNames = Object.keys(
      ((en.brandingPage as Dict).cardEffects ?? {}) as Dict,
    )
    const added = bundleNames.filter((n) => !coreNames.includes(n))
    // The core keeps its original short list; everything the patch added
    // (snowfall, stardust, asciiRain, …) is bundle-only.
    expect(added.length).toBeGreaterThan(20)
    expect(coreNames).not.toContain('snowfall')
  })
})

describe('bundle registration', () => {
  it('loads through the public loader exactly like its siblings', async () => {
    await i18nReady
    await loadFeatureBundle('branding')

    // Resolvable only because `fetchFeatureBundle` has a 'branding' case.
    expect(i18n.t('brandingPage.cardEffects.snowfall')).toBe('Snowfall')
    expect(i18n.t('brandingPage.cardEffectControls.speed')).not.toBe(
      'brandingPage.cardEffectControls.speed',
    )
  })

  it('is attached to the web-reiwa route', () => {
    // Source assertion: `createBrowserRouter` runs at import time and drags in
    // the whole shell, so the route table is not cheaply renderable here. The
    // failure mode this guards is silent — the page renders raw i18n keys —
    // and the wiring is a single call, so pinning the call is worth it.
    const router = readFileSync(join(__dirname, '..', '..', 'app', 'router.tsx'), 'utf8')
    expect(router).toMatch(
      /withFeatureBundle\(\s*'branding',[\s\S]{0,120}?branding\/branding-page'\)/,
    )
  })

  it('re-hydrates on a language switch WITHOUT anyone asking it to', async () => {
    // The previous version of this test awaited `loadFeatureBundle('branding')`
    // itself after `changeLanguage`, which loads the Russian bundle whether or
    // not `i18n.ts` has a re-hydration handler at all — deleting the handler
    // left it green. The subject here is the handler, so the test must not do
    // the handler's job.
    await i18nReady
    await loadFeatureBundle('branding')
    // Precondition: English is live and `branding` is in `loadedFeatureBundles`
    // — the handler only re-hydrates bundles that were already loaded.
    expect(i18n.t('brandingPage.cardEffects.snowfall')).toBe('Snowfall')

    await i18n.changeLanguage('ru')

    // Nothing below loads the bundle. The ONLY thing that can put Russian
    // card-effect names in front of the operator is the `languageChanged`
    // handler in i18n.ts, and it is fire-and-forget (`void loadFeatureBundle`)
    // — so this has to poll. Asserting in the same tick as `changeLanguage`
    // would only ever observe the pre-switch state.
    //
    // The value discriminates: `snowfall` exists ONLY in the lazy bundle (the
    // core-dictionary test above pins that), so with no re-hydration the
    // lookup misses the `ru` resources, falls through to `fallbackLng: 'en'`,
    // and returns 'Snowfall' — indefinitely.
    await vi.waitFor(() => {
      expect(i18n.t('brandingPage.cardEffects.snowfall')).toBe('Снегопад')
    })
  })

  afterAll(async () => {
    // Restore the shared i18next singleton for any suite that runs after this
    // file in the same worker.
    await i18n.changeLanguage('en')
  })
})

describe('withFeatureBundle when the bundle cannot be fetched', () => {
  // A hashed chunk 404s after a deploy, or the connection drops mid-navigation.
  // `Promise.all` rejects on the first rejection and throws away the other
  // result, so the page module — which loaded perfectly well — was discarded
  // and `React.lazy` got a rejection. The route rendered blank, permanently:
  // the rejected promise stayed in the load cache, so every later navigation
  // re-awaited the same failure until the tab was reloaded.

  it('still resolves the page module', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const page = { default: () => null }
    // 'imports' is untouched by the rest of this file, so its cache slot is
    // clean and this test does not depend on execution order.
    const load = withFeatureBundle('imports', () => Promise.resolve(page))

    vi.spyOn(i18n, 'addResourceBundle').mockImplementation(() => {
      throw new Error('chunk 404')
    })

    await expect(load()).resolves.toBe(page)
    expect(warn).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('does not cache the failure — the next navigation really retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const added = vi.spyOn(i18n, 'addResourceBundle')
    added.mockImplementationOnce(() => {
      throw new Error('chunk 404')
    })

    await loadFeatureBundle('analytics').catch(() => {})
    // Second attempt reaches `addResourceBundle` again — proof the rejected
    // promise was evicted rather than replayed.
    await loadFeatureBundle('analytics')

    expect(added).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled() // loadFeatureBundle itself stays quiet
    vi.restoreAllMocks()
  })
})
