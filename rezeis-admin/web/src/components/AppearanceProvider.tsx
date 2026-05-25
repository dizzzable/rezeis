import { useEffect, useState, type ReactNode } from 'react'
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
  const cardsOpacity = useGlassStore((s) => s.cards.opacity)
  const cardsSaturation = useGlassStore((s) => s.cards.saturation)
  const cardsRefraction = useGlassStore((s) => s.cards.refraction)
  const headerEnabled = useGlassStore((s) => s.header.enabled)
  const headerBlur = useGlassStore((s) => s.header.blur)
  const headerOpacity = useGlassStore((s) => s.header.opacity)
  const headerSaturation = useGlassStore((s) => s.header.saturation)
  const headerRefraction = useGlassStore((s) => s.header.refraction)
  const modalsEnabled = useGlassStore((s) => s.modals.enabled)
  const modalsBlur = useGlassStore((s) => s.modals.blur)
  const modalsOpacity = useGlassStore((s) => s.modals.opacity)
  const modalsSaturation = useGlassStore((s) => s.modals.saturation)
  const modalsRefraction = useGlassStore((s) => s.modals.refraction)
  const sidebarEnabled = useGlassStore((s) => s.sidebar.enabled)
  const sidebarBlur = useGlassStore((s) => s.sidebar.blur)
  const sidebarOpacity = useGlassStore((s) => s.sidebar.opacity)
  const sidebarSaturation = useGlassStore((s) => s.sidebar.saturation)
  const sidebarRefraction = useGlassStore((s) => s.sidebar.refraction)
  const tabsEnabled = useGlassStore((s) => s.tabs.enabled)
  const tabsBlur = useGlassStore((s) => s.tabs.blur)
  const tabsOpacity = useGlassStore((s) => s.tabs.opacity)
  const tabsSaturation = useGlassStore((s) => s.tabs.saturation)
  const tabsRefraction = useGlassStore((s) => s.tabs.refraction)
  const buttonsEnabled = useGlassStore((s) => s.buttons.enabled)
  const buttonsBlur = useGlassStore((s) => s.buttons.blur)
  const buttonsOpacity = useGlassStore((s) => s.buttons.opacity)
  const buttonsSaturation = useGlassStore((s) => s.buttons.saturation)
  const buttonsRefraction = useGlassStore((s) => s.buttons.refraction)
  const popoverEnabled = useGlassStore((s) => s.popover.enabled)
  const popoverBlur = useGlassStore((s) => s.popover.blur)
  const popoverOpacity = useGlassStore((s) => s.popover.opacity)
  const popoverSaturation = useGlassStore((s) => s.popover.saturation)
  const popoverRefraction = useGlassStore((s) => s.popover.refraction)

  // Accessibility — keep observation reactive so flipping an OS setting
  // updates the `data-prefers-reduced-*` attributes immediately.
  const respectReducedTransparency = useGlassStore((s) => s.respectReducedTransparency)
  const respectReducedMotion = useGlassStore((s) => s.respectReducedMotion)
  const shimmerStrength = useGlassStore((s) => s.shimmerStrength)
  const elasticity = useGlassStore((s) => s.elasticity)
  const [prefersReducedTransparency, setPrefersReducedTransparency] =
    useState(() => readMedia('(prefers-reduced-transparency: reduce)'))
  const [prefersReducedMotion, setPrefersReducedMotion] =
    useState(() => readMedia('(prefers-reduced-motion: reduce)'))

  useEffect(() => {
    const mqTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onTransparency = (e: MediaQueryListEvent) => setPrefersReducedTransparency(e.matches)
    const onMotion = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches)
    mqTransparency.addEventListener('change', onTransparency)
    mqMotion.addEventListener('change', onMotion)
    return () => {
      mqTransparency.removeEventListener('change', onTransparency)
      mqMotion.removeEventListener('change', onMotion)
    }
  }, [])

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

    // Honour OS-level "reduce transparency" only when the store opts in.
    // When suppressed, every per-element data-attr falls back to "off" so
    // the CSS rules in index.css collapse to solid surfaces.
    const transparencySuppressed = respectReducedTransparency && prefersReducedTransparency
    const motionSuppressed = respectReducedMotion && prefersReducedMotion
    const effectiveEnabled = glassEnabled && !transparencySuppressed

    root.dataset.liquidGlass = effectiveEnabled ? 'on' : 'off'
    root.dataset.liquidGlassCards = effectiveEnabled && cardsEnabled ? 'on' : 'off'
    root.dataset.liquidGlassHeader = effectiveEnabled && headerEnabled ? 'on' : 'off'
    root.dataset.liquidGlassModals = effectiveEnabled && modalsEnabled ? 'on' : 'off'
    root.dataset.liquidGlassSidebar = effectiveEnabled && sidebarEnabled ? 'on' : 'off'
    root.dataset.liquidGlassTabs = effectiveEnabled && tabsEnabled ? 'on' : 'off'
    root.dataset.liquidGlassButtons = effectiveEnabled && buttonsEnabled ? 'on' : 'off'
    root.dataset.liquidGlassPopover = effectiveEnabled && popoverEnabled ? 'on' : 'off'

    // Expose the OS preferences as data-attrs so other components (CSS
    // animations, framer transitions) can react without remounting.
    root.dataset.prefersReducedTransparency = prefersReducedTransparency ? 'reduce' : 'no-preference'
    root.dataset.prefersReducedMotion = prefersReducedMotion ? 'reduce' : 'no-preference'
    root.dataset.glassMotion = motionSuppressed ? 'off' : 'on'

    // Per-element CSS variables. Names are namespaced as `--lg-<elem>-<prop>`
    // so the index.css rules can read them with var(--lg-cards-opacity) etc.
    const setElement = (
      name: GlassElementVarName,
      blur: number,
      opacity: number,
      saturation: number,
    ) => {
      root.style.setProperty(`--lg-${name}-blur`, `${glassBlurPx(blur)}px`)
      root.style.setProperty(`--lg-${name}-opacity`, `${(opacity * 100).toFixed(1)}%`)
      root.style.setProperty(`--lg-${name}-saturation`, saturation.toFixed(2))
      // Legacy aliases used by older selectors in index.css. Keeping them
      // in sync until we rename all rules to the new namespace.
      root.style.setProperty(`--liquid-glass-${name}-blur`, `${glassBlurPx(blur)}px`)
    }

    setElement('cards', cardsBlur, cardsOpacity, cardsSaturation)
    setElement('header', headerBlur, headerOpacity, headerSaturation)
    setElement('modals', modalsBlur, modalsOpacity, modalsSaturation)
    setElement('sidebar', sidebarBlur, sidebarOpacity, sidebarSaturation)
    setElement('tabs', tabsBlur, tabsOpacity, tabsSaturation)
    setElement('buttons', buttonsBlur, buttonsOpacity, buttonsSaturation)
    setElement('popover', popoverBlur, popoverOpacity, popoverSaturation)

    // Per-element refraction. The data-attribute carries the preset name
    // ('off' | 'soft' | 'prominent') so CSS can pick the matching SVG
    // filter through `[data-lg-cards-refraction="prominent"]`.
    const refractionFor = (enabled: boolean, value: 'off' | 'soft' | 'prominent') =>
      effectiveEnabled && enabled ? value : 'off'
    root.dataset.lgCardsRefraction = refractionFor(cardsEnabled, cardsRefraction)
    root.dataset.lgHeaderRefraction = refractionFor(headerEnabled, headerRefraction)
    root.dataset.lgModalsRefraction = refractionFor(modalsEnabled, modalsRefraction)
    root.dataset.lgSidebarRefraction = refractionFor(sidebarEnabled, sidebarRefraction)
    root.dataset.lgTabsRefraction = refractionFor(tabsEnabled, tabsRefraction)
    root.dataset.lgButtonsRefraction = refractionFor(buttonsEnabled, buttonsRefraction)
    root.dataset.lgPopoverRefraction = refractionFor(popoverEnabled, popoverRefraction)

    // Pointer-driven shimmer strength. Clamp into the [0..0.5] band to
    // avoid washing out content with too-bright a highlight.
    const clampedShimmer = Math.max(0, Math.min(0.5, shimmerStrength))
    root.style.setProperty('--lg-shimmer-strength', clampedShimmer.toFixed(3))

    // Press elasticity. Clamp into [0..0.5] so the cubic-bezier rebound
    // stays in spring territory and doesn't overshoot the visible
    // bounding box.
    const clampedElasticity = Math.max(0, Math.min(0.5, elasticity))
    root.style.setProperty('--lg-elasticity', clampedElasticity.toFixed(3))
  }, [
    glassEnabled,
    cardsEnabled, cardsBlur, cardsOpacity, cardsSaturation, cardsRefraction,
    headerEnabled, headerBlur, headerOpacity, headerSaturation, headerRefraction,
    modalsEnabled, modalsBlur, modalsOpacity, modalsSaturation, modalsRefraction,
    sidebarEnabled, sidebarBlur, sidebarOpacity, sidebarSaturation, sidebarRefraction,
    tabsEnabled, tabsBlur, tabsOpacity, tabsSaturation, tabsRefraction,
    buttonsEnabled, buttonsBlur, buttonsOpacity, buttonsSaturation, buttonsRefraction,
    popoverEnabled, popoverBlur, popoverOpacity, popoverSaturation, popoverRefraction,
    respectReducedTransparency, respectReducedMotion,
    prefersReducedTransparency, prefersReducedMotion,
    shimmerStrength, elasticity,
  ])

  return <>{children}</>
}

type GlassElementVarName =
  | 'cards' | 'header' | 'modals' | 'sidebar' | 'tabs' | 'buttons' | 'popover'

function readMedia(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(query).matches
}
