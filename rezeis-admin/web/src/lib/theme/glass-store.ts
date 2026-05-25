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
  /** Blur/frost amount (0 = no blur, 1 = max blur). Mapped to px via glassBlurPx(). */
  blur: number
  /** Surface opacity (0 = fully transparent, 1 = fully opaque). Mapped to a
   *  percentage in `color-mix(in oklch, <role-token> N%, transparent)`. */
  opacity: number
  /** Saturation multiplier for `backdrop-filter: saturate(...)`. Range 1..2. */
  saturation: number
  /** Apply SVG-based liquid refraction (`filter: url(#lg-...)`) on top of the
   *  blur. Only takes effect on Chromium browsers and on small surfaces;
   *  enabling it on large panels is a perf trap. */
  refraction: 'off' | 'soft' | 'prominent'
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
  /** Specular highlight intensity for the pointer-driven shimmer.
   *  Range 0..0.5 mapped to `--lg-shimmer-strength`. */
  shimmerStrength: number

  // Accessibility guards
  /** When true, the effect dims to a solid surface if the OS reports
   *  `prefers-reduced-transparency: reduce`. Default: true. */
  respectReducedTransparency: boolean
  /** When true, motion-driven extras (idle shimmer, pointer parallax)
   *  honour `prefers-reduced-motion: reduce`. Default: true. */
  respectReducedMotion: boolean

  // Background
  background: BackgroundConfig

  // Actions
  setGlassEnabled: (enabled: boolean) => void
  setElementGlass: (element: GlassElement, settings: Partial<GlassElementSettings>) => void
  setDisplacementScale: (value: number) => void
  setAberrationIntensity: (value: number) => void
  setElasticity: (value: number) => void
  setSaturation: (value: number) => void
  setShimmerStrength: (value: number) => void
  setRespectReducedTransparency: (value: boolean) => void
  setRespectReducedMotion: (value: boolean) => void
  setBackgroundId: (id: BackgroundId) => void
  setBackgroundOpacity: (opacity: number) => void
  setBackgroundProp: (prop: string, value: unknown) => void
  setBackgroundProps: (props: Record<string, unknown>) => void
  reset: () => void
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_BACKGROUND: BackgroundConfig = {
  id: 'none',
  opacity: 0.3,
  props: {},
}

const DEFAULTS = {
  glassEnabled: true,
  // Defaults match the percentages previously hard-coded in index.css so
  // the visual baseline doesn't change when this version migrates.
  // Refraction is OFF by default for static, large surfaces (sidebar,
  // header, cards, modals, tabs) — these are perf-sensitive and Apple's
  // own HIG steers clear of refraction on long-form content. It is ON
  // for buttons and popovers — small interactive surfaces where the
  // displacement reads as the marquee Liquid Glass feel.
  sidebar: { enabled: true, blur: 0, opacity: 0.4, saturation: 1.4, refraction: 'off' as const },
  header: { enabled: false, blur: 0, opacity: 0.35, saturation: 1.4, refraction: 'off' as const },
  cards: { enabled: true, blur: 0.01, opacity: 0.4, saturation: 1.4, refraction: 'off' as const },
  modals: { enabled: true, blur: 0.01, opacity: 0.45, saturation: 1.4, refraction: 'off' as const },
  tabs: { enabled: true, blur: 0.01, opacity: 0.4, saturation: 1.3, refraction: 'off' as const },
  buttons: { enabled: true, blur: 0.02, opacity: 0.6, saturation: 1.2, refraction: 'soft' as const },
  popover: { enabled: true, blur: 0.02, opacity: 0.5, saturation: 1.4, refraction: 'soft' as const },
  displacementScale: 70,
  aberrationIntensity: 2,
  elasticity: 0.15,
  saturation: 140,
  shimmerStrength: 0.18,
  respectReducedTransparency: true,
  respectReducedMotion: true,
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

const STORE_VERSION = 4

/** All BackgroundIds we know about. New ids must be added to BOTH the union
 *  and to BG_COMPONENTS in components/glass/backgrounds.ts. */
const VALID_BACKGROUND_IDS: ReadonlySet<BackgroundId> = new Set<BackgroundId>([
  'none', 'silk', 'aurora', 'threads', 'waves', 'iridescence', 'galaxy',
  'particles', 'dotGrid', 'liquidChrome', 'balatro', 'beams', 'plasma',
  'grainient', 'softAurora', 'dither', 'lineWaves', 'rippleGrid',
  'lightning', 'radar',
])

const ELEMENT_KEYS = [
  'sidebar', 'header', 'cards', 'modals', 'tabs', 'buttons', 'popover',
] as const satisfies ReadonlyArray<GlassElement>

interface PersistedShape {
  background?: { id?: unknown }
  sidebar?: Partial<GlassElementSettings>
  header?: Partial<GlassElementSettings>
  cards?: Partial<GlassElementSettings>
  modals?: Partial<GlassElementSettings>
  tabs?: Partial<GlassElementSettings>
  buttons?: Partial<GlassElementSettings>
  popover?: Partial<GlassElementSettings>
  respectReducedTransparency?: boolean
  respectReducedMotion?: boolean
  shimmerStrength?: number
}

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
      setShimmerStrength: (shimmerStrength) => set({ shimmerStrength }),
      setRespectReducedTransparency: (respectReducedTransparency) => set({ respectReducedTransparency }),
      setRespectReducedMotion: (respectReducedMotion) => set({ respectReducedMotion }),

      setBackgroundId: (id) =>
        set(() => ({
          background: {
            id,
            opacity: DEFAULT_BACKGROUND.opacity,
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
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      // Snap unknown background ids back to 'none' so a removed bg
      // doesn't render as undefined. Also fills in fields added in
      // newer store versions for users coming from v1 (per-element
      // opacity/saturation, accessibility flags).
      migrate: (persistedState, _version) => {
        const state = persistedState as PersistedShape | null
        if (!state) return persistedState as GlassState

        if (state.background) {
          const bgId = state.background.id
          if (typeof bgId !== 'string' || !VALID_BACKGROUND_IDS.has(bgId as BackgroundId)) {
            state.background = { ...DEFAULT_BACKGROUND }
          }
        }

        // v1 → v2: per-element opacity/saturation didn't exist. Backfill
        // them from DEFAULTS without touching `enabled`/`blur` the user
        // had set previously.
        // v2 → v3: per-element `refraction` added — backfill from DEFAULTS.
        for (const key of ELEMENT_KEYS) {
          const existing = state[key]
          if (existing && typeof existing === 'object') {
            if (typeof existing.opacity !== 'number') {
              existing.opacity = DEFAULTS[key].opacity
            }
            if (typeof existing.saturation !== 'number') {
              existing.saturation = DEFAULTS[key].saturation
            }
            if (
              existing.refraction !== 'off'
              && existing.refraction !== 'soft'
              && existing.refraction !== 'prominent'
            ) {
              existing.refraction = DEFAULTS[key].refraction
            }
          }
        }

        // v1 → v2: new accessibility guards default to true for safety.
        if (typeof state.respectReducedTransparency !== 'boolean') {
          state.respectReducedTransparency = DEFAULTS.respectReducedTransparency
        }
        if (typeof state.respectReducedMotion !== 'boolean') {
          state.respectReducedMotion = DEFAULTS.respectReducedMotion
        }

        // v3 → v4 (shimmer): backfill global shimmer strength if missing.
        if (typeof state.shimmerStrength !== 'number') {
          state.shimmerStrength = DEFAULTS.shimmerStrength
        }

        return persistedState as GlassState
      },
    },
  ),
)

