/**
 * Telegram Theme Integration Service
 * Converts Telegram WebApp theme parameters to CSS variables
 */

import { getThemeParams, getColorScheme, isInTelegram, onThemeChange } from './telegram';
import type { ThemeParams } from '@/types/telegram-webapp';

/**
 * CSS variable names for Telegram theme
 */
export const TG_CSS_VARIABLES = {
  bgColor: '--tg-bg-color',
  textColor: '--tg-text-color',
  hintColor: '--tg-hint-color',
  linkColor: '--tg-link-color',
  buttonColor: '--tg-button-color',
  buttonTextColor: '--tg-button-text-color',
  secondaryBgColor: '--tg-secondary-bg-color',
  headerBgColor: '--tg-header-bg-color',
  sectionBgColor: '--tg-section-bg-color',
  sectionSeparatorColor: '--tg-section-separator-color',
  subtitleTextColor: '--tg-subtitle-text-color',
  destructiveTextColor: '--tg-destructive-text-color',
} as const;

/**
 * Apply Telegram theme colors to CSS variables
 * @param themeParams - Telegram theme parameters
 */
export function applyTelegramTheme(themeParams: ThemeParams): void {
  const root = document.documentElement;

  // Apply theme colors
  if (themeParams.bg_color) {
    root.style.setProperty(TG_CSS_VARIABLES.bgColor, themeParams.bg_color);
  }
  if (themeParams.text_color) {
    root.style.setProperty(TG_CSS_VARIABLES.textColor, themeParams.text_color);
  }
  if (themeParams.hint_color) {
    root.style.setProperty(TG_CSS_VARIABLES.hintColor, themeParams.hint_color);
  }
  if (themeParams.link_color) {
    root.style.setProperty(TG_CSS_VARIABLES.linkColor, themeParams.link_color);
  }
  if (themeParams.button_color) {
    root.style.setProperty(TG_CSS_VARIABLES.buttonColor, themeParams.button_color);
  }
  if (themeParams.button_text_color) {
    root.style.setProperty(TG_CSS_VARIABLES.buttonTextColor, themeParams.button_text_color);
  }
  if (themeParams.secondary_bg_color) {
    root.style.setProperty(TG_CSS_VARIABLES.secondaryBgColor, themeParams.secondary_bg_color);
  }

  // Set derived colors
  root.style.setProperty(TG_CSS_VARIABLES.headerBgColor, themeParams.bg_color || 'var(--tg-bg-color, #ffffff)');
  root.style.setProperty(TG_CSS_VARIABLES.sectionBgColor, themeParams.secondary_bg_color || themeParams.bg_color || '#ffffff');
  root.style.setProperty(TG_CSS_VARIABLES.sectionSeparatorColor, themeParams.hint_color || 'rgba(0,0,0,0.1)');
  root.style.setProperty(TG_CSS_VARIABLES.subtitleTextColor, themeParams.hint_color || '#999999');
  root.style.setProperty(TG_CSS_VARIABLES.destructiveTextColor, '#ff3b30');
}

/**
 * Clear Telegram theme CSS variables
 */
export function clearTelegramTheme(): void {
  const root = document.documentElement;

  Object.values(TG_CSS_VARIABLES).forEach((variable) => {
    root.style.removeProperty(variable);
  });
}

/**
 * Initialize Telegram theme integration
 * @returns Unsubscribe function for theme change listener
 */
export function initTelegramTheme(): () => void {
  if (!isInTelegram()) {
    return () => {};
  }

  const themeParams = getThemeParams();
  if (themeParams) {
    applyTelegramTheme(themeParams);
  }

  // Listen for theme changes
  return onThemeChange(() => {
    const newThemeParams = getThemeParams();
    if (newThemeParams) {
      applyTelegramTheme(newThemeParams);
    }
  });
}

/**
 * Get color palette based on current Telegram theme
 * @returns Color palette object
 */
export function getTelegramColorPalette(): {
  bgColor: string;
  textColor: string;
  hintColor: string;
  linkColor: string;
  buttonColor: string;
  buttonTextColor: string;
  secondaryBgColor: string;
} {
  const themeParams = getThemeParams();
  const colorScheme = getColorScheme();

  // Default colors for light/dark themes
  const defaults = {
    light: {
      bgColor: '#ffffff',
      textColor: '#000000',
      hintColor: '#999999',
      linkColor: '#007aff',
      buttonColor: '#007aff',
      buttonTextColor: '#ffffff',
      secondaryBgColor: '#f1f1f1',
    },
    dark: {
      bgColor: '#000000',
      textColor: '#ffffff',
      hintColor: '#8e8e93',
      linkColor: '#0a84ff',
      buttonColor: '#0a84ff',
      buttonTextColor: '#ffffff',
      secondaryBgColor: '#1c1c1e',
    },
  };

  const defaultsForScheme = defaults[colorScheme];

  return {
    bgColor: themeParams?.bg_color ?? defaultsForScheme.bgColor,
    textColor: themeParams?.text_color ?? defaultsForScheme.textColor,
    hintColor: themeParams?.hint_color ?? defaultsForScheme.hintColor,
    linkColor: themeParams?.link_color ?? defaultsForScheme.linkColor,
    buttonColor: themeParams?.button_color ?? defaultsForScheme.buttonColor,
    buttonTextColor: themeParams?.button_text_color ?? defaultsForScheme.buttonTextColor,
    secondaryBgColor: themeParams?.secondary_bg_color ?? defaultsForScheme.secondaryBgColor,
  };
}

/**
 * Check if current Telegram theme is dark
 * @returns True if dark theme
 */
export function isTelegramDarkTheme(): boolean {
  return getColorScheme() === 'dark';
}

/**
 * Telegram theme CSS class generator
 * @returns CSS class string for Telegram theme
 */
export function getTelegramThemeClass(): string {
  const isDark = isTelegramDarkTheme();
  return isDark ? 'tg-dark' : 'tg-light';
}

/**
 * Theme service object with all methods
 */
export const telegramThemeService = {
  applyTelegramTheme,
  clearTelegramTheme,
  initTelegramTheme,
  getTelegramColorPalette,
  isTelegramDarkTheme,
  getTelegramThemeClass,
  TG_CSS_VARIABLES,
};

export default telegramThemeService;
