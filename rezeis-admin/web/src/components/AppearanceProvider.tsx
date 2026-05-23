import { useEffect, type ReactNode } from 'react'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useGlassStore } from '@/lib/theme/glass-store'
import { glassBlurPx } from '@/lib/theme/glass-utils'

/**
 * Applies appearance preferences (density, font size, animations, visual
 * effects) to the document root as data attributes. CSS in `index.css`
 * reacts to these attributes via attribute selectors, no JS-side
 * recomputation needed.
 *
 * To minimize re-renders, the provider subscribes to primitive values
 * only (boolean / number) — never object slices — so toggling one
 * setting doesn't cascade-rerun unrelated effects.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const density = useAppearanceStore((s) => s.density)
  const fontSize = useAppearanceStore((s) => s.fontSize)
  const animationsEnabled = useAppearanceStore((s) => s.animationsEnabled)
  const visualEffects = useAppearanceStore((s) => s.visualEffects)
  const glassBlur = useAppearanceStore((s) => s.glassBlur)
  const blurIntensity = useAppearanceStore((s) => s.blurIntensity)
  const glassOpacity = useAppearanceStore((s) => s.glassOpacity)

  // Liquid Glass — primitive selectors so changing one element's blur
  // doesn't re-trigger the effect for all elements.
  const glassEnabled = useGlassStore((s) => s.glassEnabled)
  const cardsEnabled = useGlassStore((s) => s.cards.enabled)
  const cardsBlur = useGlassStore((s) => s.cards.blur)
  const headerEnabled = useGlassStore((s) => s.header.enabled)
  const headerBlur = useGlassStore((s) => s.header.blur)
  const modalsEnabled = useGlassStore((s) => s.modals.enabled)
  const modalsBlur = useGlassStore((s) => s.modals.blur)
  const sidebarEnabled = useGlassStore((s) => s.sidebar.enabled)
  const sidebarBlur = useGlassStore((s) => s.sidebar.blur)
  const tabsEnabled = useGlassStore((s) => s.tabs.enabled)
  const tabsBlur = useGlassStore((s) => s.tabs.blur)
  const buttonsEnabled = useGlassStore((s) => s.buttons.enabled)
  const buttonsBlur = useGlassStore((s) => s.buttons.blur)
  const popoverEnabled = useGlassStore((s) => s.popover.enabled)
  const popoverBlur = useGlassStore((s) => s.popover.blur)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.density = density
    root.dataset.fontSize = fontSize
    root.dataset.animations = animationsEnabled ? 'on' : 'off'
    root.dataset.effects = visualEffects ? 'on' : 'off'
    root.dataset.glassBlur = glassBlur ? 'on' : 'off'
    root.style.setProperty('--glass-blur', `${blurIntensity}px`)
    root.style.setProperty('--glass-opacity', `${glassOpacity}%`)
  }, [density, fontSize, animationsEnabled, visualEffects, glassBlur, blurIntensity, glassOpacity])

  // Liquid Glass — set data-attrs and CSS variables in a single effect
  useEffect(() => {
    const root = document.documentElement
    root.dataset.liquidGlass = glassEnabled ? 'on' : 'off'
    root.dataset.liquidGlassCards = glassEnabled && cardsEnabled ? 'on' : 'off'
    root.dataset.liquidGlassHeader = glassEnabled && headerEnabled ? 'on' : 'off'
    root.dataset.liquidGlassModals = glassEnabled && modalsEnabled ? 'on' : 'off'
    root.dataset.liquidGlassSidebar = glassEnabled && sidebarEnabled ? 'on' : 'off'
    root.dataset.liquidGlassTabs = glassEnabled && tabsEnabled ? 'on' : 'off'
    root.dataset.liquidGlassButtons = glassEnabled && buttonsEnabled ? 'on' : 'off'
    root.dataset.liquidGlassPopover = glassEnabled && popoverEnabled ? 'on' : 'off'

    root.style.setProperty('--liquid-glass-cards-blur', `${glassBlurPx(cardsBlur)}px`)
    root.style.setProperty('--liquid-glass-header-blur', `${glassBlurPx(headerBlur)}px`)
    root.style.setProperty('--liquid-glass-modals-blur', `${glassBlurPx(modalsBlur)}px`)
    root.style.setProperty('--liquid-glass-sidebar-blur', `${glassBlurPx(sidebarBlur)}px`)
    root.style.setProperty('--liquid-glass-tabs-blur', `${glassBlurPx(tabsBlur)}px`)
    root.style.setProperty('--liquid-glass-buttons-blur', `${glassBlurPx(buttonsBlur)}px`)
    root.style.setProperty('--liquid-glass-popover-blur', `${glassBlurPx(popoverBlur)}px`)
  }, [
    glassEnabled,
    cardsEnabled, cardsBlur,
    headerEnabled, headerBlur,
    modalsEnabled, modalsBlur,
    sidebarEnabled, sidebarBlur,
    tabsEnabled, tabsBlur,
    buttonsEnabled, buttonsBlur,
    popoverEnabled, popoverBlur,
  ])

  return <>{children}</>
}
