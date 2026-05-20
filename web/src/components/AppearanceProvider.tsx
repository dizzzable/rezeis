import { useEffect, type ReactNode } from 'react';
import { useAppearanceStore } from '@/lib/theme/appearance-store';

/**
 * Applies appearance preferences (density, font size, animations) to the
 * document root as data attributes. CSS in `index.css` reacts to these
 * attributes via attribute selectors, no JS-side recomputation needed.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const density = useAppearanceStore((s) => s.density);
  const fontSize = useAppearanceStore((s) => s.fontSize);
  const animationsEnabled = useAppearanceStore((s) => s.animationsEnabled);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = density;
    root.dataset.fontSize = fontSize;
    root.dataset.animations = animationsEnabled ? 'on' : 'off';
  }, [density, fontSize, animationsEnabled]);

  return <>{children}</>;
}
