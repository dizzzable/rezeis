/**
 * Theme Store for Rezeis Panel
 *
 * Zustand store for managing theme state with persistence.
 * Handles theme selection, dark mode toggle, and synchronization
 * with localStorage.
 *
 * @module stores/theme
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getThemeById, getDefaultTheme, type Theme, type ThemeColors } from '@/themes';

/**
 * Theme state interface
 */
export interface ThemeState {
  /** Currently selected theme ID */
  currentThemeId: string;
  /** Whether dark mode is enabled */
  isDarkMode: boolean;
  /** Whether the theme has been initialized */
  isInitialized: boolean;

  /**
   * Set the current theme by ID
   * @param themeId - The theme identifier to set
   */
  setTheme: (themeId: string) => void;

  /**
   * Toggle between light and dark mode
   */
  toggleDarkMode: () => void;

  /**
   * Explicitly set dark mode state
   * @param isDark - Whether to enable dark mode
   */
  setDarkMode: (isDark: boolean) => void;

  /**
   * Get the current theme object
   * @returns The current theme or default theme
   */
  getCurrentTheme: () => Theme;

  /**
   * Get the appropriate colors for current mode
   * @returns Light or dark theme colors
   */
  getCurrentColors: () => ThemeColors;

  /**
   * Initialize theme from system preferences or storage
   */
  initialize: () => void;
}

/**
 * Storage key for theme persistence
 */
const THEME_STORAGE_KEY = 'rezeis-theme-storage';

/**
 * Zustand store for theme state management
 * Uses persist middleware to save preferences to localStorage
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      currentThemeId: getDefaultTheme().id,
      isDarkMode: false,
      isInitialized: false,

      setTheme: (themeId: string) => {
        const theme = getThemeById(themeId);
        if (theme) {
          set({ currentThemeId: themeId });
        }
      },

      toggleDarkMode: () => {
        set((state) => ({ isDarkMode: !state.isDarkMode }));
      },

      setDarkMode: (isDark: boolean) => {
        set({ isDarkMode: isDark });
      },

      getCurrentTheme: () => {
        const { currentThemeId } = get();
        return getThemeById(currentThemeId) ?? getDefaultTheme();
      },

      getCurrentColors: () => {
        const theme = get().getCurrentTheme();
        const { isDarkMode } = get();
        return isDarkMode ? theme.dark : theme.light;
      },

      initialize: () => {
        const { isInitialized } = get();
        if (isInitialized) return;

        // Check system preference for dark mode
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        // If no stored preference, use system preference
        const storedState = localStorage.getItem(THEME_STORAGE_KEY);
        if (!storedState) {
          set({ isDarkMode: prefersDark, isInitialized: true });
        } else {
          set({ isInitialized: true });
        }
      },
    }),
    {
      name: THEME_STORAGE_KEY,
      partialize: (state) => ({
        currentThemeId: state.currentThemeId,
        isDarkMode: state.isDarkMode,
      }),
    }
  )
);

/**
 * Hook to get current theme information
 * @returns Object with current theme, colors, and dark mode state
 */
export function useTheme(): {
  theme: Theme;
  colors: ThemeColors;
  isDarkMode: boolean;
  currentThemeId: string;
} {
  return useThemeStore((state) => ({
    theme: state.getCurrentTheme(),
    colors: state.getCurrentColors(),
    isDarkMode: state.isDarkMode,
    currentThemeId: state.currentThemeId,
  }));
}

/**
 * Hook to get theme actions
 * @returns Object with theme actions
 */
export function useThemeActions(): {
  setTheme: (themeId: string) => void;
  toggleDarkMode: () => void;
  setDarkMode: (isDark: boolean) => void;
} {
  return useThemeStore((state) => ({
    setTheme: state.setTheme,
    toggleDarkMode: state.toggleDarkMode,
    setDarkMode: state.setDarkMode,
  }));
}

/**
 * Hook to check if a specific theme is active
 * @param themeId - Theme ID to check
 * @returns True if the theme is currently active
 */
export function useIsThemeActive(themeId: string): boolean {
  return useThemeStore((state) => state.currentThemeId === themeId);
}

export default useThemeStore;
