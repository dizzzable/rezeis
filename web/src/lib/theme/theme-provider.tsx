/**
 * Minimal theme provider — follows the official shadcn/ui Vite recipe:
 *
 *   https://ui.shadcn.com/docs/dark-mode/vite
 *
 * Responsibilities:
 *   1. Toggle the `.dark` class on `<html>` based on the operator's
 *      `mode` selection (`light` / `dark` / `system`).
 *   2. Apply the active layered theme:
 *        a. Curated preset CSS (from `THEME_PRESETS`)
 *        b. Operator-pasted custom CSS (highest of the structured layers)
 *        c. Per-token overrides for light + dark
 *      …merged into a single `<style>` element appended after `index.css`,
 *      so source order makes overrides win.
 *   3. Set the global `--radius` token from the radius slider.
 *
 * `useTheme()` is kept as a simple `{ resolvedMode }` accessor for any
 * downstream component that wants to know the effective light/dark.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'

import { useThemeStore, THEME_TOKENS } from './theme-store'
import type { TokenOverrides } from './theme-store'
import { getPresetCss } from './presets'

interface ThemeContextValue {
  resolvedMode: 'light' | 'dark'
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const RUNTIME_STYLE_ID = 'rezeis-runtime-theme'

/** Watch `prefers-color-scheme: dark` so 'system' mode tracks the OS. */
function useSystemPrefersDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect((): (() => void) => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent): void => setDark(e.matches)
    mq.addEventListener('change', handler)
    return (): void => mq.removeEventListener('change', handler)
  }, [])
  return dark
}

function buildOverrideBlock(
  selector: string,
  overrides: TokenOverrides,
): string {
  const declarations: string[] = []
  for (const token of THEME_TOKENS) {
    const value = overrides[token]
    if (typeof value === 'string' && value.length > 0) {
      declarations.push(`  --${token}: ${value};`)
    }
  }
  if (declarations.length === 0) return ''
  return `${selector} {\n${declarations.join('\n')}\n}`
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useThemeStore((s) => s.mode)
  const presetId = useThemeStore((s) => s.presetId)
  const radius = useThemeStore((s) => s.radius)
  const customCss = useThemeStore((s) => s.customCss)
  const overridesLight = useThemeStore((s) => s.overridesLight)
  const overridesDark = useThemeStore((s) => s.overridesDark)
  const systemDark = useSystemPrefersDark()

  const resolvedMode: 'light' | 'dark' =
    mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  // 1. Toggle `.dark` class on <html> so the matching CSS rules apply.
  useEffect((): void => {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedMode === 'dark')
  }, [resolvedMode])

  // 2. Inject the layered theme into a single <style> appended after index.css.
  useEffect((): void => {
    const layers: string[] = []

    const presetCss = getPresetCss(presetId)
    if (presetCss.length > 0) layers.push(presetCss)

    const trimmedCustom = customCss.trim()
    if (trimmedCustom.length > 0) layers.push(trimmedCustom)

    const lightBlock = buildOverrideBlock(':root', overridesLight)
    if (lightBlock.length > 0) layers.push(lightBlock)
    const darkBlock = buildOverrideBlock('.dark', overridesDark)
    if (darkBlock.length > 0) layers.push(darkBlock)

    layers.push(`:root { --radius: ${radius}rem; }`)

    const css = layers.join('\n\n')

    let tag = document.getElementById(
      RUNTIME_STYLE_ID,
    ) as HTMLStyleElement | null
    if (!tag) {
      tag = document.createElement('style')
      tag.id = RUNTIME_STYLE_ID
      document.head.appendChild(tag)
    }
    tag.textContent = css
  }, [presetId, customCss, overridesLight, overridesDark, radius])

  const value = useMemo<ThemeContextValue>(
    (): ThemeContextValue => ({ resolvedMode }),
    [resolvedMode],
  )

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (ctx === null) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return ctx
}
