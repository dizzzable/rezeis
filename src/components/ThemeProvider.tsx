/**
 * Theme Provider Component
 * 
 * Provides theme context to the application by applying CSS variables
 * and managing dark mode class on the document element.
 * 
 * @module components/ThemeProvider
 */

import { useEffect, type ReactNode } from 'react';
import { useThemeStore } from '@/stores/theme.store';
import type { ThemeColors } from '@/themes';

/**
 * Props for the ThemeProvider component
 */
interface ThemeProviderProps {
  /** Child components */
  children: ReactNode;
}

/**
 * Apply theme colors to CSS custom properties
 * @param colors - Theme colors to apply
 * @param isDark - Whether dark mode is active
 */
function applyThemeColorsToDocument(colors: ThemeColors, isDark: boolean): void {
  const root = document.documentElement;

  // Set data attribute for theme-specific CSS selectors
  const themeId = useThemeStore.getState().getCurrentTheme().id;
  root.setAttribute('data-theme', themeId);

  // Apply dark class for Tailwind dark mode
  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  // Apply CSS variables
  root.style.setProperty('--background', colors.background);
  root.style.setProperty('--foreground', colors.foreground);
  root.style.setProperty('--card', colors.card);
  root.style.setProperty('--card-foreground', colors.cardForeground);
  root.style.setProperty('--popover', colors.popover);
  root.style.setProperty('--popover-foreground', colors.popoverForeground);
  root.style.setProperty('--primary', colors.primary);
  root.style.setProperty('--primary-foreground', colors.primaryForeground);
  root.style.setProperty('--secondary', colors.secondary);
  root.style.setProperty('--secondary-foreground', colors.secondaryForeground);
  root.style.setProperty('--muted', colors.muted);
  root.style.setProperty('--muted-foreground', colors.mutedForeground);
  root.style.setProperty('--accent', colors.accent);
  root.style.setProperty('--accent-foreground', colors.accentForeground);
  root.style.setProperty('--destructive', colors.destructive);
  root.style.setProperty('--border', colors.border);
  root.style.setProperty('--input', colors.input);
  root.style.setProperty('--ring', colors.ring);
  root.style.setProperty('--chart-1', colors.chart1);
  root.style.setProperty('--chart-2', colors.chart2);
  root.style.setProperty('--chart-3', colors.chart3);
  root.style.setProperty('--chart-4', colors.chart4);
  root.style.setProperty('--chart-5', colors.chart5);
  root.style.setProperty('--sidebar', colors.sidebar);
  root.style.setProperty('--sidebar-foreground', colors.sidebarForeground);
  root.style.setProperty('--sidebar-primary', colors.sidebarPrimary);
  root.style.setProperty('--sidebar-primary-foreground', colors.sidebarPrimaryForeground);
  root.style.setProperty('--sidebar-accent', colors.sidebarAccent);
  root.style.setProperty('--sidebar-accent-foreground', colors.sidebarAccentForeground);
  root.style.setProperty('--sidebar-border', colors.sidebarBorder);
  root.style.setProperty('--sidebar-ring', colors.sidebarRing);
  root.style.setProperty('--radius', colors.radius);
}

/**
 * Theme Provider component
 * 
 * Wraps the application and manages theme application to the DOM.
 * Subscribes to theme store changes and applies CSS variables.
 * 
 * @param props - Component props
 * @returns The provider wrapping children
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const initialize = useThemeStore((state) => state.initialize);
  const getCurrentColors = useThemeStore((state) => state.getCurrentColors);
  const isDarkMode = useThemeStore((state) => state.isDarkMode);
  const currentThemeId = useThemeStore((state) => state.currentThemeId);

  // Initialize theme on mount
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Apply theme colors when theme or dark mode changes
  useEffect(() => {
    const colors = getCurrentColors();
    applyThemeColorsToDocument(colors, isDarkMode);
  }, [getCurrentColors, isDarkMode, currentThemeId]);

  // Listen for system color scheme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = (event: MediaQueryListEvent) => {
      // Only auto-switch if user hasn't manually set preference
      const stored = localStorage.getItem('rezeis-theme-storage');
      if (!stored) {
        useThemeStore.getState().setDarkMode(event.matches);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return <>{children}</>;
}

export default ThemeProvider;
