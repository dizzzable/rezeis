/**
 * Effects Store — manages visual effects assignments for UI elements.
 *
 * Categories:
 * - Text Animation: effect applied to page titles/headings
 * - Cursor Effect: global cursor trail/interaction effect
 * - Hover Effect: effect on card/element hover
 * - Content Animation: entrance animation for page content
 * - Click Effect: visual feedback on click
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// ── Text Animation options ───────────────────────────────────────────────────

export type TextAnimationId =
  | 'none'
  | 'shiny'
  | 'gradient'
  | 'glitch'
  | 'decrypted'
  | 'blur'
  | 'split'
  | 'scrambled'
  | 'fuzzy'
  | 'rotating'
  | 'trueFocus'
  | 'shuffle'
  | 'typewriter'
  | 'proximity'

export interface TextAnimationDef {
  id: TextAnimationId
  name: string
  nameRu: string
}

export const TEXT_ANIMATIONS: TextAnimationDef[] = [
  { id: 'none', name: 'None', nameRu: 'Нет' },
  { id: 'shiny', name: 'Shiny Text', nameRu: 'Блестящий текст' },
  { id: 'gradient', name: 'Gradient Text', nameRu: 'Градиентный текст' },
  { id: 'glitch', name: 'Glitch Text', nameRu: 'Глитч текст' },
  { id: 'decrypted', name: 'Decrypted Text', nameRu: 'Дешифровка' },
  { id: 'blur', name: 'Blur Text', nameRu: 'Размытие текста' },
  { id: 'split', name: 'Split Text', nameRu: 'Разделение текста' },
  { id: 'scrambled', name: 'Scrambled Text', nameRu: 'Перемешанный текст' },
  { id: 'fuzzy', name: 'Fuzzy Text', nameRu: 'Нечёткий текст' },
  { id: 'rotating', name: 'Rotating Text', nameRu: 'Вращающийся текст' },
  { id: 'trueFocus', name: 'True Focus', nameRu: 'Фокус' },
  // `shuffle` → reactbits/Shuffle, `typewriter` → reactbits/TextType,
  // `proximity` → reactbits/VariableProximity. All three need a plain string —
  // see STRING_ONLY_ANIMATIONS in components/effects/TitleEffect.tsx.
  { id: 'shuffle', name: 'Shuffle Text', nameRu: 'Перетасовка текста' },
  { id: 'typewriter', name: 'Typewriter', nameRu: 'Печатная машинка' },
  { id: 'proximity', name: 'Variable Proximity', nameRu: 'Вариативная близость' },
]

// ── Cursor Effect options ────────────────────────────────────────────────────

export type CursorEffectId =
  | 'none'
  | 'splash'
  | 'blob'
  | 'ghost'
  | 'crosshair'
  | 'pixelTrail'
  | 'target'
  | 'textTrail'

export interface CursorEffectDef {
  id: CursorEffectId
  name: string
  nameRu: string
}

export const CURSOR_EFFECTS: CursorEffectDef[] = [
  { id: 'none', name: 'None', nameRu: 'Нет' },
  { id: 'splash', name: 'Splash Cursor', nameRu: 'Жидкий курсор' },
  { id: 'blob', name: 'Blob Cursor', nameRu: 'Blob курсор' },
  { id: 'ghost', name: 'Ghost Cursor', nameRu: 'Призрачный курсор' },
  { id: 'crosshair', name: 'Crosshair', nameRu: 'Прицел' },
  { id: 'pixelTrail', name: 'Pixel Trail', nameRu: 'Пиксельный след' },
  // `target` → reactbits/TargetCursor (mounts bare — it is its own fixed root),
  // `textTrail` → reactbits/TextCursor (mounts inside FixedOverlay).
  { id: 'target', name: 'Target Cursor', nameRu: 'Курсор-мишень' },
  { id: 'textTrail', name: 'Text Trail', nameRu: 'Текстовый след' },
]

// ── Click Effect options ─────────────────────────────────────────────────────

export type ClickEffectId =
  | 'none'
  | 'spark'

export interface ClickEffectDef {
  id: ClickEffectId
  name: string
  nameRu: string
}

export const CLICK_EFFECTS: ClickEffectDef[] = [
  { id: 'none', name: 'None', nameRu: 'Нет' },
  { id: 'spark', name: 'Click Spark', nameRu: 'Искры при клике' },
]

// ── Hover Effect options ─────────────────────────────────────────────────────

export type HoverEffectId =
  | 'none'
  | 'spotlight'
  | 'glare'

export interface HoverEffectDef {
  id: HoverEffectId
  name: string
  nameRu: string
}

export const HOVER_EFFECTS: HoverEffectDef[] = [
  { id: 'none', name: 'None', nameRu: 'Нет' },
  { id: 'spotlight', name: 'Spotlight', nameRu: 'Прожектор' },
  { id: 'glare', name: 'Glare Hover', nameRu: 'Блик при наведении' },
]

// ── Content Animation options ────────────────────────────────────────────────

export type ContentAnimationId =
  | 'none'
  | 'fadeContent'
  | 'animatedContent'
  | 'gradualBlur'

export interface ContentAnimationDef {
  id: ContentAnimationId
  name: string
  nameRu: string
}

export const CONTENT_ANIMATIONS: ContentAnimationDef[] = [
  { id: 'none', name: 'None', nameRu: 'Нет' },
  { id: 'fadeContent', name: 'Fade Content', nameRu: 'Плавное появление' },
  { id: 'animatedContent', name: 'Animated Content', nameRu: 'Анимированный контент' },
  { id: 'gradualBlur', name: 'Gradual Blur', nameRu: 'Постепенное размытие' },
]

// ── Store interface ──────────────────────────────────────────────────────────

interface EffectsState {
  // Selected effects
  textAnimation: TextAnimationId
  cursorEffect: CursorEffectId
  clickEffect: ClickEffectId
  hoverEffect: HoverEffectId
  contentAnimation: ContentAnimationId

  // Global toggle (respects visualEffects from appearance-store)
  effectsEnabled: boolean

  // Actions
  setTextAnimation: (id: TextAnimationId) => void
  setCursorEffect: (id: CursorEffectId) => void
  setClickEffect: (id: ClickEffectId) => void
  setHoverEffect: (id: HoverEffectId) => void
  setContentAnimation: (id: ContentAnimationId) => void
  setEffectsEnabled: (enabled: boolean) => void
  reset: () => void
}

const DEFAULTS = {
  textAnimation: 'shiny' as TextAnimationId,
  cursorEffect: 'none' as CursorEffectId,
  clickEffect: 'spark' as ClickEffectId,
  hoverEffect: 'spotlight' as HoverEffectId,
  contentAnimation: 'animatedContent' as ContentAnimationId,
  effectsEnabled: true,
}

/**
 * Bumped 2 → 3 when `hoverEffect: 'electricBorder' | 'magnet'` and
 * `clickEffect: 'starBorder'` were removed. Their components
 * (`reactbits/ElectricBorder`, `Magnet`, `StarBorder`) were unreachable and
 * were deleted; neither renderer had ever drawn them — `HoverEffect` fell both
 * hover ids back to `SpotlightCard` and `EffectsProvider` returned `null` for
 * `starBorder`.
 *
 * The bump is the load-bearing half of that removal, not bookkeeping: zustand
 * runs `migrate` only when the PERSISTED version differs from this one. Leave
 * it at 2 and every operator carrying one of those three ids in localStorage
 * today keeps it — the `<Select>` would then hold a value with no matching
 * `<SelectItem>` and render an empty trigger. At 3, `migrate` runs once per
 * browser and snaps them to `DEFAULTS`.
 *
 * NOT bumped to 4 for `shuffle` / `typewriter` / `proximity` / `target` /
 * `textTrail`. The rule is asymmetric, and `migrate` below is the proof: every
 * branch it has only ever REPLACES a persisted id that is missing from a VALID_*
 * set. Adding an id can only grow those sets, so no value that validated at
 * version 3 can stop validating at version 4 — the migration would run once per
 * browser and change nothing. Bump when the union SHRINKS (or when a stored
 * value changes meaning); adding an option is not that.
 */
const STORE_VERSION = 3

// Validation sets so unknown ids snap back to defaults during migration.
const VALID_TEXT = new Set(TEXT_ANIMATIONS.map((a) => a.id as string))
const VALID_CURSOR = new Set(CURSOR_EFFECTS.map((a) => a.id as string))
const VALID_CLICK = new Set(CLICK_EFFECTS.map((a) => a.id as string))
const VALID_HOVER = new Set(HOVER_EFFECTS.map((a) => a.id as string))
const VALID_CONTENT = new Set(CONTENT_ANIMATIONS.map((a) => a.id as string))

interface PersistedEffects {
  textAnimation?: unknown
  cursorEffect?: unknown
  clickEffect?: unknown
  hoverEffect?: unknown
  contentAnimation?: unknown
}

export const useEffectsStore = create<EffectsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,

      setTextAnimation: (textAnimation) => set({ textAnimation }),
      setCursorEffect: (cursorEffect) => set({ cursorEffect }),
      setClickEffect: (clickEffect) => set({ clickEffect }),
      setHoverEffect: (hoverEffect) => set({ hoverEffect }),
      setContentAnimation: (contentAnimation) => set({ contentAnimation }),
      setEffectsEnabled: (effectsEnabled) => set({ effectsEnabled }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'rezeis-admin-effects',
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      // Snap unknown ids back to the default if the union shrank.
      migrate: (persistedState, _version) => {
        const state = persistedState as PersistedEffects | null
        if (!state) return persistedState as EffectsState
        if (typeof state.textAnimation !== 'string' || !VALID_TEXT.has(state.textAnimation)) {
          state.textAnimation = DEFAULTS.textAnimation
        }
        if (typeof state.cursorEffect !== 'string' || !VALID_CURSOR.has(state.cursorEffect)) {
          state.cursorEffect = DEFAULTS.cursorEffect
        }
        if (typeof state.clickEffect !== 'string' || !VALID_CLICK.has(state.clickEffect)) {
          state.clickEffect = DEFAULTS.clickEffect
        }
        if (typeof state.hoverEffect !== 'string' || !VALID_HOVER.has(state.hoverEffect)) {
          state.hoverEffect = DEFAULTS.hoverEffect
        }
        if (typeof state.contentAnimation !== 'string' || !VALID_CONTENT.has(state.contentAnimation)) {
          state.contentAnimation = DEFAULTS.contentAnimation
        }
        return persistedState as EffectsState
      },
    },
  ),
)
