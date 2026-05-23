/**
 * Glass Store — per-element Liquid Glass settings + background selection.
 *
 * Controls:
 * - Global glass on/off
 * - Per-element frost/blur level (sidebar, header, cards, modals, tabs, buttons, popover)
 * - Global glass properties (displacement, aberration, elasticity)
 * - Background selection with per-background props from registry
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { getDefaultProps } from '@/features/appearance/background-controls'

// ── Per-element glass settings ───────────────────────────────────────────────

export interface GlassElementSettings {
  enabled: boolean
  /** Blur/frost amount (0 = fully transparent, 1 = fully frosted) */
  blur: number
}

// ── All glass-able element keys ──────────────────────────────────────────────

export type GlassElement = 'sidebar' | 'header' | 'cards' | 'modals' | 'tabs' | 'buttons' | 'popover'

// ── Background configuration ─────────────────────────────────────────────────

export type BackgroundId =
  | 'none'
  | 'silk'
  | 'aurora'
  | 'threads'
  | 'waves'
  | 'iridescence'
  | 'galaxy'
  | 'particles'
  | 'dotGrid'
  | 'liquidChrome'
  | 'balatro'
  | 'beams'
  | 'plasma'
  | 'grainient'
  | 'softAurora'
  | 'dither'
  | 'lineWaves'
  | 'rippleGrid'
  | 'lightning'
  | 'radar'

export interface BackgroundConfig {
  id: BackgroundId
  /** Opacity of the background layer (0-1) */
  opacity: number
  /** Per-background props from registry (ControlDef defaults) */
  props: Record<string, unknown>
}

// ── Store interface ──────────────────────────────────────────────────────────

interface GlassState {
  // Global toggle
  glassEnabled: boolean

  // Per-element settings
  sidebar: GlassElementSettings
  header: GlassElementSettings
  cards: GlassElementSettings
  modals: GlassElementSettings
  tabs: GlassElementSettings
  buttons: GlassElementSettings
  popover: GlassElementSettings

  // Global glass properties
  displacementScale: number
  aberrationIntensity: number
  elasticity: number
  saturation: number

  // Background
  background: BackgroundConfig

  // Actions
  setGlassEnabled: (enabled: boolean) => void
  setElementGlass: (element: GlassElement, settings: Partial<GlassElementSettings>) => void
  setDisplacementScale: (value: number) => void
  setAberrationIntensity: (value: number) => void
  setElasticity: (value: number) => void
  setSaturation: (value: number) => void
  setBackgroundId: (id: BackgroundId) => void
  setBackgroundOpacity: (opacity: number) => void
  setBackgroundProp: (prop: string, value: unknown) => void
  setBackgroundProps: (props: Record<string, unknown>) => void
  reset: () => void
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_ELEMENT: GlassElementSettings = {
  enabled: true,
  blur: 0.15,
}

const DEFAULT_BACKGROUND: BackgroundConfig = {
  id: 'none',
  opacity: 0.3,
  props: {},
}

const DEFAULTS = {
  glassEnabled: true,
  sidebar: { enabled: true, blur: 0 },
  header: { enabled: false, blur: 0 },
  cards: { enabled: true, blur: 0.01 },
  modals: { enabled: true, blur: 0.01 },
  tabs: { enabled: true, blur: 0.01 },
  buttons: { enabled: true, blur: 0.02 },
  popover: { enabled: true, blur: 0.02 },
  displacementScale: 70,
  aberrationIntensity: 2,
  elasticity: 0.15,
  saturation: 140,
  background: {
    id: 'liquidChrome' as BackgroundId,
    opacity: 0.5,
    props: {
      baseColor: [0.047, 0.031, 0.039],
      speed: 0.27,
      amplitude: 0.6,
      frequencyX: 2.5,
      frequencyY: 2.5,
    },
  },
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useGlassStore = create<GlassState>()(
  persist(
    (set) => ({
      ...DEFAULTS,

      setGlassEnabled: (glassEnabled) => set({ glassEnabled }),

      setElementGlass: (element, settings) =>
        set((s) => ({ [element]: { ...s[element], ...settings } })),

      setDisplacementScale: (displacementScale) => set({ displacementScale }),
      setAberrationIntensity: (aberrationIntensity) => set({ aberrationIntensity }),
      setElasticity: (elasticity) => set({ elasticity }),
      setSaturation: (saturation) => set({ saturation }),

      setBackgroundId: (id) =>
        set(() => ({
          background: {
            id,
            opacity: 0.3,
            props: getDefaultProps(id),
          },
        })),

      setBackgroundOpacity: (opacity) =>
        set((s) => ({
          background: { ...s.background, opacity: Math.max(0.05, Math.min(1, opacity)) },
        })),

      setBackgroundProp: (prop, value) =>
        set((s) => ({
          background: {
            ...s.background,
            props: { ...s.background.props, [prop]: value },
          },
        })),

      setBackgroundProps: (props) =>
        set((s) => ({
          background: {
            ...s.background,
            props: { ...s.background.props, ...props },
          },
        })),

      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'rezeis-admin-glass',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)

// ── Selectors ────────────────────────────────────────────────────────────────

/** Check if glass is active for a specific element */
export function useIsGlassActive(element: GlassElement): boolean {
  const glassEnabled = useGlassStore((s) => s.glassEnabled)
  const elementEnabled = useGlassStore((s) => s[element].enabled)
  return glassEnabled && elementEnabled
}
