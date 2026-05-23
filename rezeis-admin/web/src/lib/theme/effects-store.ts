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
]

// ── Cursor Effect options ────────────────────────────────────────────────────

export type CursorEffectId =
  | 'none'
  | 'splash'
  | 'blob'
  | 'ghost'
  | 'crosshair'
  | 'magnetLines'
  | 'pixelTrail'

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
  { id: 'magnetLines', name: 'Magnet Lines', nameRu: 'Магнитные линии' },
  { id: 'pixelTrail', name: 'Pixel Trail', nameRu: 'Пиксельный след' },
]

// ── Click Effect options ─────────────────────────────────────────────────────

export type ClickEffectId =
  | 'none'
  | 'spark'
  | 'starBorder'

export interface ClickEffectDef {
  id: ClickEffectId
  name: string
  nameRu: string
}

export const CLICK_EFFECTS: ClickEffectDef[] = [
  { id: 'none', name: 'None', nameRu: 'Нет' },
  { id: 'spark', name: 'Click Spark', nameRu: 'Искры при клике' },
  { id: 'starBorder', name: 'Star Border', nameRu: 'Звёздная рамка' },
]

// ── Hover Effect options ─────────────────────────────────────────────────────

export type HoverEffectId =
  | 'none'
  | 'spotlight'
  | 'glare'
  | 'electricBorder'
  | 'magnet'

export interface HoverEffectDef {
  id: HoverEffectId
  name: string
  nameRu: string
}

export const HOVER_EFFECTS: HoverEffectDef[] = [
  { id: 'none', name: 'None', nameRu: 'Нет' },
  { id: 'spotlight', name: 'Spotlight', nameRu: 'Прожектор' },
  { id: 'glare', name: 'Glare Hover', nameRu: 'Блик при наведении' },
  { id: 'electricBorder', name: 'Electric Border', nameRu: 'Электрическая рамка' },
  { id: 'magnet', name: 'Magnet', nameRu: 'Магнит' },
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
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
