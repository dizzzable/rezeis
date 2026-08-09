/**
 * Guard: a component rendered BEFORE its dictionary arrives must not keep
 * showing the previous language — or the raw key — once the bundle lands.
 *
 * This exercises the shipped bootstrap, not a stand-in for it:
 *   - it imports the real `@/i18n/i18n`, so `init({ resources: {} })` and
 *     `initReactI18next` run exactly as they do in the browser;
 *   - it awaits `i18nReady` first, which is what `main.tsx` does before the
 *     first render, so the masking that hides this on cold boot is in place;
 *   - the language switch goes through the real `changeLanguage`, the real
 *     `languageChanged` handler, the real dynamic `import()` of the locale
 *     module and the real `addResourceBundle`.
 *
 * Nothing here re-renders the component on its own: the only thing that can
 * repaint it after the bundle lands is react-i18next's own store binding.
 * That is the thing under test. A hand-rolled i18n stub, or a test that
 * pokes state after the switch, would pass with the defect present.
 *
 * The component mirrors `conceptCardGalleryLabels` in
 * `src/features/branding/branding-page.tsx`: `t()` called inside a
 * `useMemo` keyed on `[t]`. That shape is the strict case — a component
 * that calls `t()` during render recovers on any later re-render, one that
 * memoises never does — so it is what the guard renders.
 */
import { useMemo, type JSX } from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { i18n as I18nType } from 'i18next'

import { i18n, i18nReady } from '@/i18n/i18n'

/** A key from the CORE dictionary (`src/i18n/{en,ru}.ts`), which is the
 *  bundle that arrives late on a language switch. */
const KEY = 'brandingPage.sections.card.catalogSearchPlaceholder'

function MemoisedLabel({ instance }: { readonly instance: I18nType }): JSX.Element {
  const { t } = useTranslation(undefined, { i18n: instance })
  const labels = useMemo(() => ({ searchPlaceholder: t(KEY) }), [t])
  return <span data-testid="label">{labels.searchPlaceholder}</span>
}

function readBundleValue(instance: I18nType, lng: string): string {
  const value = instance.getResource(lng, 'translation', KEY)
  expect(
    typeof value === 'string' && value.length > 0 && value !== KEY,
    `Precondition failed: "${KEY}" is missing from the ${lng} core dictionary ` +
      `(src/i18n/${lng}.ts), so this guard cannot tell a late bundle from a ` +
      `typo. Point KEY at a key that exists in both dictionaries.`,
  ).toBe(true)
  return value as string
}

describe('late-arriving locale bundle repaints what is already on screen', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('switching to a language whose bundle has not arrived still lands on that language', async () => {
    // main.tsx: the initial bundle is awaited before the first render.
    await i18nReady
    expect(i18n.language).toBe('en')
    expect(i18n.hasResourceBundle('ru', 'translation')).toBe(false)

    render(
      <I18nextProvider i18n={i18n}>
        <MemoisedLabel instance={i18n} />
      </I18nextProvider>,
    )
    const english = readBundleValue(i18n, 'en')
    expect(screen.getByTestId('label').textContent).toBe(english)

    // Exactly what the topbar's LanguageToggle does. With no i18next backend
    // configured this resolves immediately, before `loadLocale('ru')` — kicked
    // off out of band by the `languageChanged` handler — has fetched anything.
    await act(async () => {
      await i18n.changeLanguage('ru')
    })

    // The bundle lands here. This is the ONLY thing that happens between the
    // switch and the assertion below — no interaction, no state change.
    await waitFor(() => {
      expect(i18n.hasResourceBundle('ru', 'translation')).toBe(true)
    })

    const russian = readBundleValue(i18n, 'ru')
    expect(
      russian !== english,
      `Precondition failed: "${KEY}" reads the same in en and ru, so a frozen ` +
        `label would be indistinguishable from a correct one. Point KEY at a ` +
        `key whose translations differ.`,
    ).toBe(true)

    await waitFor(() => {
      expect(
        screen.getByTestId('label').textContent,
        `DEFECT: the ru bundle is in the i18next store (i18n.t(KEY) === ` +
          `"${russian}") but the mounted component never re-rendered, so the ` +
          `operator is still looking at the old language. react-i18next only ` +
          `re-renders on the events named by bindI18n/bindI18nStore; every ` +
          `dictionary in this app arrives via addResourceBundle AFTER ` +
          `languageChanged has already fired. See src/i18n/i18n.ts.`,
      ).toBe(russian)
    })
  })

  it('switching to the fallback language whose bundle has not arrived does not strand raw keys', async () => {
    // Boot cold in ru, so only the ru bundle is loaded. Switching to en then
    // has no fallback left to borrow from and `t()` returns the raw key —
    // the symptom originally reported.
    window.localStorage.setItem('rezeis.admin.locale', 'ru')
    const mod = await import('@/i18n/i18n')
    const ruFirst = mod.i18n

    await mod.i18nReady
    expect(ruFirst.language).toBe('ru')
    expect(ruFirst.hasResourceBundle('en', 'translation')).toBe(false)

    render(
      <I18nextProvider i18n={ruFirst}>
        <MemoisedLabel instance={ruFirst} />
      </I18nextProvider>,
    )
    const russian = readBundleValue(ruFirst, 'ru')
    expect(screen.getByTestId('label').textContent).toBe(russian)

    await act(async () => {
      await ruFirst.changeLanguage('en')
    })
    await waitFor(() => {
      expect(ruFirst.hasResourceBundle('en', 'translation')).toBe(true)
    })

    const english = readBundleValue(ruFirst, 'en')
    await waitFor(() => {
      expect(
        screen.getByTestId('label').textContent,
        `DEFECT: the en bundle is in the i18next store (i18n.t(KEY) === ` +
          `"${english}") but the mounted component never re-rendered. Because ` +
          `en IS the fallback language there is nothing left to fall back to, ` +
          `so the panel is showing the raw key "${KEY}" to the operator. See ` +
          `src/i18n/i18n.ts.`,
      ).toBe(english)
    })

    window.localStorage.removeItem('rezeis.admin.locale')
  })
})
