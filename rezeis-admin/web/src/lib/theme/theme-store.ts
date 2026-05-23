/**
 * Theme store — persists the operator's appearance choice to localStorage.
 *
 * Aligned with the shadcn/ui 2024 OKLCH variable set:
 *   • https://ui.shadcn.com/docs/theming
 *   • https://ui.shadcn.com/docs/dark-mode/vite
 *
 * Three independent layers compose into the final `<style>` injection:
 *   1. `presetId`   — selects a curated `:root { … } .dark { … }` block
 *                     from THEME_PRESETS (kept as raw CSS strings so
 *                     they can come straight from shadcnthemer.com).
 *   2. `customCss`  — operator-pasted theme block (highest precedence
 *                     among the structured layers — appended last so
 *                     its rules win against any preset).
 *   3. `overrides`  — per-token tweaks made via the color picker. Stored
 *                     as `{ [token]: cssValue }` per mode and emitted
 *                     last of all so individual tweaks always win.
 *
 * The provider concatenates these into a single `<style>` element
 * appended after `index.css`, so source order makes overrides win.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type ColorMode = 'light' | 'dark' | 'system'

/**
 * Canonical token names. Match the shadcn/ui 2024 variable set
 * (without the leading `--`). Used by the per-token color editor and
 * for emitting overrides into a runtime stylesheet.
 */
export const THEME_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

export type TokenOverrides = Partial<Record<ThemeToken, string>>

export interface ThemeState {
  /** Currently-selected preset (one of THEME_PRESETS[].id, or 'default'). */
  presetId: string
  /** Light / dark / system. */
  mode: ColorMode
  /** Base radius in rem (0–1.5). */
  radius: number
  /** Operator-pasted CSS block from shadcnthemer / ui.shadcn / tweakcn. */
  customCss: string
  /** Per-token overrides applied on top of the active preset, light mode. */
  overridesLight: TokenOverrides
  /** Per-token overrides applied on top of the active preset, dark mode. */
  overridesDark: TokenOverrides

  // Actions
  setPreset: (id: string) => void
  setMode: (mode: ColorMode) => void
  setRadius: (value: number) => void
  setCustomCss: (css: string) => void
  setOverride: (mode: 'light' | 'dark', token: ThemeToken, value: string | undefined) => void
  clearOverrides: (mode: 'light' | 'dark') => void
  reset: () => void
}

const INITIAL: Pick<
  ThemeState,
  'presetId' | 'mode' | 'radius' | 'customCss' | 'overridesLight' | 'overridesDark'
> = {
  presetId: 'default',
  mode: 'dark',
  radius: 0.625,
  customCss: '',
  overridesLight: {},
  overridesDark: { 'sidebar-primary': '#aa1d8b' },
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      ...INITIAL,
      setPreset: (id) => set({ presetId: id }),
      setMode: (mode) => set({ mode }),
      setRadius: (radius) => set({ radius: Math.max(0, Math.min(1.5, radius)) }),
      setCustomCss: (css) => set({ customCss: css }),
      setOverride: (mode, token, value) =>
        set((state) => {
          const key = mode === 'dark' ? 'overridesDark' : 'overridesLight'
          const next: TokenOverrides = { ...state[key] }
          if (value === undefined || value === '') {
            delete next[token]
          } else {
            next[token] = value
          }
          return { [key]: next } as Partial<ThemeState>
        }),
      clearOverrides: (mode) =>
        set(
          mode === 'dark'
            ? { overridesDark: {} }
            : { overridesLight: {} },
        ),
      reset: () => set({ ...INITIAL }),
    }),
    {
      name: 'rezeis-admin-theme',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        presetId: s.presetId,
        mode: s.mode,
        radius: s.radius,
        customCss: s.customCss,
        overridesLight: s.overridesLight,
        overridesDark: s.overridesDark,
      }),
      // v1 stored a different shape (HSL triplets, customLight/customDark);
      // discard those values cleanly so the new model starts fresh.
      migrate: (_persisted, _version) => INITIAL,
    },
  ),
)

/**
 * Friendly label for each token, used by the color editor UI.
 */
export const TOKEN_LABELS: Record<ThemeToken, string> = {
  background: 'Background',
  foreground: 'Foreground',
  card: 'Card',
  'card-foreground': 'Card text',
  popover: 'Popover',
  'popover-foreground': 'Popover text',
  primary: 'Primary',
  'primary-foreground': 'Primary text',
  secondary: 'Secondary',
  'secondary-foreground': 'Secondary text',
  muted: 'Muted',
  'muted-foreground': 'Muted text',
  accent: 'Accent',
  'accent-foreground': 'Accent text',
  destructive: 'Destructive',
  'destructive-foreground': 'Destructive text',
  border: 'Border',
  input: 'Input',
  ring: 'Focus ring',
  'chart-1': 'Chart 1',
  'chart-2': 'Chart 2',
  'chart-3': 'Chart 3',
  'chart-4': 'Chart 4',
  'chart-5': 'Chart 5',
  sidebar: 'Sidebar',
  'sidebar-foreground': 'Sidebar text',
  'sidebar-primary': 'Sidebar active',
  'sidebar-primary-foreground': 'Sidebar active text',
  'sidebar-accent': 'Sidebar hover',
  'sidebar-accent-foreground': 'Sidebar hover text',
  'sidebar-border': 'Sidebar border',
  'sidebar-ring': 'Sidebar focus',
}

export interface TokenSection {
  id: string
  label: string
  description: string
  tokens: ThemeToken[]
}

export const TOKEN_SECTIONS: TokenSection[] = [
  {
    id: 'surface',
    label: 'Surface',
    description: 'Page background and primary text',
    tokens: ['background', 'foreground'],
  },
  {
    id: 'card',
    label: 'Cards & popovers',
    description: 'Elevated surfaces and floating menus',
    tokens: ['card', 'card-foreground', 'popover', 'popover-foreground'],
  },
  {
    id: 'primary',
    label: 'Primary',
    description: 'High-emphasis actions and brand surfaces',
    tokens: ['primary', 'primary-foreground'],
  },
  {
    id: 'secondary',
    label: 'Secondary & muted',
    description: 'Supporting colors, hover states and helper text',
    tokens: [
      'secondary',
      'secondary-foreground',
      'muted',
      'muted-foreground',
      'accent',
      'accent-foreground',
    ],
  },
  {
    id: 'semantic',
    label: 'Semantic & forms',
    description: 'Borders, inputs, focus rings and destructive actions',
    tokens: ['destructive', 'destructive-foreground', 'border', 'input', 'ring'],
  },
  {
    id: 'charts',
    label: 'Charts',
    description: 'Default palette used by Recharts dashboards',
    tokens: ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'],
  },
  {
    id: 'sidebar',
    label: 'Sidebar',
    description: 'Navigation sidebar surface, hover and focus',
    tokens: [
      'sidebar',
      'sidebar-foreground',
      'sidebar-primary',
      'sidebar-primary-foreground',
      'sidebar-accent',
      'sidebar-accent-foreground',
      'sidebar-border',
      'sidebar-ring',
    ],
  },
]
