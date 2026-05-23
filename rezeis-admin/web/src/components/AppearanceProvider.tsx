import { useEffect, type ReactNode } from 'react';
import { useAppearanceStore } from '@/lib/theme/appearance-store';
import { useGlassStore } from '@/lib/theme/glass-store';

/**
 * Applies appearance preferences (density, font size, animations, visual
 * effects) to the document root as data attributes. CSS in `index.css`
 * reacts to these attributes via attribute selectors, no JS-side
 * recomputation needed.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const density = useAppearanceStore((s) => s.density);
  const fontSize = useAppearanceStore((s) => s.fontSize);
  const animationsEnabled = useAppearanceStore((s) => s.animationsEnabled);
  const visualEffects = useAppearanceStore((s) => s.visualEffects);
  const glassBlur = useAppearanceStore((s) => s.glassBlur);
  const blurIntensity = useAppearanceStore((s) => s.blurIntensity);
  const glassOpacity = useAppearanceStore((s) => s.glassOpacity);

  // Liquid Glass store
  const glassEnabled = useGlassStore((s) => s.glassEnabled);
  const cardsGlass = useGlassStore((s) => s.cards);
  const headerGlass = useGlassStore((s) => s.header);
  const modalsGlass = useGlassStore((s) => s.modals);
  const sidebarGlass = useGlassStore((s) => s.sidebar);
  const tabsGlass = useGlassStore((s) => s.tabs);
  const buttonsGlass = useGlassStore((s) => s.buttons);
  const popoverGlass = useGlassStore((s) => s.popover);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = density;
    root.dataset.fontSize = fontSize;
    root.dataset.animations = animationsEnabled ? 'on' : 'off';
    root.dataset.effects = visualEffects ? 'on' : 'off';
    root.dataset.glassBlur = glassBlur ? 'on' : 'off';
    root.style.setProperty('--glass-blur', `${blurIntensity}px`);
    root.style.setProperty('--glass-opacity', `${glassOpacity}%`);
  }, [density, fontSize, animationsEnabled, visualEffects, glassBlur, blurIntensity, glassOpacity]);

  // Liquid Glass — set CSS custom properties and data attributes
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.liquidGlass = glassEnabled ? 'on' : 'off';
    root.dataset.liquidGlassCards = glassEnabled && cardsGlass.enabled ? 'on' : 'off';
    root.dataset.liquidGlassHeader = glassEnabled && headerGlass.enabled ? 'on' : 'off';
    root.dataset.liquidGlassModals = glassEnabled && modalsGlass.enabled ? 'on' : 'off';
    root.dataset.liquidGlassSidebar = glassEnabled && sidebarGlass.enabled ? 'on' : 'off';
    root.dataset.liquidGlassTabs = glassEnabled && tabsGlass.enabled ? 'on' : 'off';
    root.dataset.liquidGlassButtons = glassEnabled && buttonsGlass.enabled ? 'on' : 'off';
    root.dataset.liquidGlassPopover = glassEnabled && popoverGlass.enabled ? 'on' : 'off';

    // CSS variables for blur amounts
    root.style.setProperty('--liquid-glass-cards-blur', `${Math.round(cardsGlass.blur * 80)}px`);
    root.style.setProperty('--liquid-glass-header-blur', `${Math.round(headerGlass.blur * 80)}px`);
    root.style.setProperty('--liquid-glass-modals-blur', `${Math.round(modalsGlass.blur * 80)}px`);
    root.style.setProperty('--liquid-glass-sidebar-blur', `${Math.round(sidebarGlass.blur * 80)}px`);
    root.style.setProperty('--liquid-glass-tabs-blur', `${Math.round(tabsGlass.blur * 80)}px`);
    root.style.setProperty('--liquid-glass-buttons-blur', `${Math.round(buttonsGlass.blur * 80)}px`);
    root.style.setProperty('--liquid-glass-popover-blur', `${Math.round(popoverGlass.blur * 80)}px`);
  }, [glassEnabled, cardsGlass, headerGlass, modalsGlass, sidebarGlass, tabsGlass, buttonsGlass, popoverGlass]);

  return <>{children}</>;
}
