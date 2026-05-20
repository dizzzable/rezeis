/**
 * Appearance store — UI density, font size and animation toggles.
 *
 * Lives next to `theme-store.ts` (which already owns colours / mode /
 * radius). They are kept in separate stores so a redesign of one axis
 * doesn't force the other to migrate.
 *
 * The values are applied to `<html>` as data attributes by
 * `AppearanceProvider`; CSS rules in `index.css` translate them into
 * concrete spacing / font-size variables.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type UiDensity = 'compact' | 'comfortable' | 'spacious';
export type UiFontSize = 'small' | 'default' | 'large';

interface AppearanceState {
  density: UiDensity;
  fontSize: UiFontSize;
  animationsEnabled: boolean;
  setDensity: (density: UiDensity) => void;
  setFontSize: (fontSize: UiFontSize) => void;
  setAnimationsEnabled: (enabled: boolean) => void;
  reset: () => void;
}

const DEFAULTS: Pick<AppearanceState, 'density' | 'fontSize' | 'animationsEnabled'> = {
  density: 'comfortable',
  fontSize: 'default',
  animationsEnabled: true,
};

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setDensity: (density) => set({ density }),
      setFontSize: (fontSize) => set({ fontSize }),
      setAnimationsEnabled: (animationsEnabled) => set({ animationsEnabled }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'rezeis-admin-appearance',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
