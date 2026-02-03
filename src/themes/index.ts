/**
 * Theme System for AltShop Panel
 * 
 * This module contains the theme registry with all available themes
 * for the application. Themes use OKLCH color format for better
 * perceptual uniformity and dark mode support.
 * 
 * @module themes
 */

/**
 * Theme category for grouping themes in the UI
 */
export type ThemeCategory =
  | 'minimal'
  | 'colorful'
  | 'dark'
  | 'nature'
  | 'tech'
  | 'retro'
  | 'other';

/**
 * Color definition using OKLCH format
 */
export interface ThemeColors {
  /** Background color */
  background: string;
  /** Foreground/text color */
  foreground: string;
  /** Card background color */
  card: string;
  /** Card text color */
  cardForeground: string;
  /** Popover background color */
  popover: string;
  /** Popover text color */
  popoverForeground: string;
  /** Primary action color */
  primary: string;
  /** Primary action text color */
  primaryForeground: string;
  /** Secondary action color */
  secondary: string;
  /** Secondary action text color */
  secondaryForeground: string;
  /** Muted background color */
  muted: string;
  /** Muted text color */
  mutedForeground: string;
  /** Accent color */
  accent: string;
  /** Accent text color */
  accentForeground: string;
  /** Destructive/error color */
  destructive: string;
  /** Border color */
  border: string;
  /** Input field background */
  input: string;
  /** Focus ring color */
  ring: string;
  /** Chart colors */
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  /** Sidebar colors */
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
  sidebarRing: string;
  /** Border radius */
  radius: string;
}

/**
 * Complete theme definition with light and dark variants
 */
export interface Theme {
  /** Unique theme identifier */
  id: string;
  /** Display name */
  name: string;
  /** Theme description */
  description: string;
  /** Category for grouping */
  category: ThemeCategory;
  /** Preview colors for the theme selector */
  previewColors: {
    background: string;
    foreground: string;
    primary: string;
    secondary: string;
    accent: string;
  };
  /** Light mode colors */
  light: ThemeColors;
  /** Dark mode colors */
  dark: ThemeColors;
}

/**
 * Default light colors fallback
 */
const defaultLight: ThemeColors = {
  background: 'oklch(1 0 0)',
  foreground: 'oklch(0.145 0 0)',
  card: 'oklch(1 0 0)',
  cardForeground: 'oklch(0.145 0 0)',
  popover: 'oklch(1 0 0)',
  popoverForeground: 'oklch(0.145 0 0)',
  primary: 'oklch(0.205 0 0)',
  primaryForeground: 'oklch(0.985 0 0)',
  secondary: 'oklch(0.97 0 0)',
  secondaryForeground: 'oklch(0.205 0 0)',
  muted: 'oklch(0.97 0 0)',
  mutedForeground: 'oklch(0.556 0 0)',
  accent: 'oklch(0.97 0 0)',
  accentForeground: 'oklch(0.205 0 0)',
  destructive: 'oklch(0.577 0.245 27.325)',
  border: 'oklch(0.922 0 0)',
  input: 'oklch(0.922 0 0)',
  ring: 'oklch(0.708 0 0)',
  chart1: 'oklch(0.646 0.222 41.116)',
  chart2: 'oklch(0.6 0.118 184.704)',
  chart3: 'oklch(0.398 0.07 227.392)',
  chart4: 'oklch(0.828 0.189 84.429)',
  chart5: 'oklch(0.769 0.188 70.08)',
  sidebar: 'oklch(0.985 0 0)',
  sidebarForeground: 'oklch(0.145 0 0)',
  sidebarPrimary: 'oklch(0.205 0 0)',
  sidebarPrimaryForeground: 'oklch(0.985 0 0)',
  sidebarAccent: 'oklch(0.97 0 0)',
  sidebarAccentForeground: 'oklch(0.205 0 0)',
  sidebarBorder: 'oklch(0.922 0 0)',
  sidebarRing: 'oklch(0.708 0 0)',
  radius: '0.625rem',
};

/**
 * Default dark colors fallback
 */
const defaultDark: ThemeColors = {
  background: 'oklch(0.145 0 0)',
  foreground: 'oklch(0.985 0 0)',
  card: 'oklch(0.205 0 0)',
  cardForeground: 'oklch(0.985 0 0)',
  popover: 'oklch(0.205 0 0)',
  popoverForeground: 'oklch(0.985 0 0)',
  primary: 'oklch(0.922 0 0)',
  primaryForeground: 'oklch(0.205 0 0)',
  secondary: 'oklch(0.269 0 0)',
  secondaryForeground: 'oklch(0.985 0 0)',
  muted: 'oklch(0.269 0 0)',
  mutedForeground: 'oklch(0.708 0 0)',
  accent: 'oklch(0.269 0 0)',
  accentForeground: 'oklch(0.985 0 0)',
  destructive: 'oklch(0.704 0.191 22.216)',
  border: 'oklch(1 0 0 / 10%)',
  input: 'oklch(1 0 0 / 15%)',
  ring: 'oklch(0.556 0 0)',
  chart1: 'oklch(0.488 0.243 264.376)',
  chart2: 'oklch(0.696 0.17 162.48)',
  chart3: 'oklch(0.769 0.188 70.08)',
  chart4: 'oklch(0.627 0.265 303.9)',
  chart5: 'oklch(0.645 0.246 16.439)',
  sidebar: 'oklch(0.205 0 0)',
  sidebarForeground: 'oklch(0.985 0 0)',
  sidebarPrimary: 'oklch(0.488 0.243 264.376)',
  sidebarPrimaryForeground: 'oklch(0.985 0 0)',
  sidebarAccent: 'oklch(0.269 0 0)',
  sidebarAccentForeground: 'oklch(0.985 0 0)',
  sidebarBorder: 'oklch(1 0 0 / 10%)',
  sidebarRing: 'oklch(0.439 0 0)',
  radius: '0.625rem',
};

/**
 * Theme registry containing all available themes
 */
export const themes: Theme[] = [
  {
    id: 'amber-minimal',
    name: 'Amber Minimal',
    description: 'Warm amber tones with minimal design',
    category: 'minimal',
    previewColors: {
      background: '#fffefd',
      foreground: '#2a241e',
      primary: '#d97706',
      secondary: '#f5f5f4',
      accent: '#fef3c7',
    },
    light: {
      ...defaultLight,
      background: 'oklch(1 0 0)',
      foreground: 'oklch(0.2686 0 0)',
      card: 'oklch(1 0 0)',
      cardForeground: 'oklch(0.2686 0 0)',
      primary: 'oklch(0.7686 0.1647 70.0804)',
      primaryForeground: 'oklch(0 0 0)',
      secondary: 'oklch(0.967 0.0029 264.5419)',
      secondaryForeground: 'oklch(0.4461 0.0263 256.8018)',
      muted: 'oklch(0.9846 0.0017 247.8389)',
      mutedForeground: 'oklch(0.551 0.0234 264.3637)',
      accent: 'oklch(0.9869 0.0214 95.2774)',
      accentForeground: 'oklch(0.4732 0.1247 46.2007)',
      border: 'oklch(0.9276 0.0058 264.5313)',
      input: 'oklch(0.9276 0.0058 264.5313)',
      ring: 'oklch(0.7686 0.1647 70.0804)',
      sidebar: 'oklch(0.9846 0.0017 247.8389)',
      sidebarForeground: 'oklch(0.2686 0 0)',
      sidebarPrimary: 'oklch(0.7686 0.1647 70.0804)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.9869 0.0214 95.2774)',
      sidebarAccentForeground: 'oklch(0.4732 0.1247 46.2007)',
      sidebarBorder: 'oklch(0.9276 0.0058 264.5313)',
      sidebarRing: 'oklch(0.7686 0.1647 70.0804)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.2046 0 0)',
      foreground: 'oklch(0.9219 0 0)',
      card: 'oklch(0.2686 0 0)',
      cardForeground: 'oklch(0.9219 0 0)',
      popover: 'oklch(0.2686 0 0)',
      popoverForeground: 'oklch(0.9219 0 0)',
      primary: 'oklch(0.7686 0.1647 70.0804)',
      primaryForeground: 'oklch(0 0 0)',
      secondary: 'oklch(0.2686 0 0)',
      secondaryForeground: 'oklch(0.9219 0 0)',
      muted: 'oklch(0.2393 0 0)',
      mutedForeground: 'oklch(0.7155 0 0)',
      accent: 'oklch(0.4732 0.1247 46.2007)',
      accentForeground: 'oklch(0.9243 0.1151 95.7459)',
      border: 'oklch(0.3715 0 0)',
      input: 'oklch(0.3715 0 0)',
      ring: 'oklch(0.7686 0.1647 70.0804)',
      sidebar: 'oklch(0.1684 0 0)',
      sidebarForeground: 'oklch(0.9219 0 0)',
      sidebarPrimary: 'oklch(0.7686 0.1647 70.0804)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.4732 0.1247 46.2007)',
      sidebarAccentForeground: 'oklch(0.9243 0.1151 95.7459)',
      sidebarBorder: 'oklch(0.3715 0 0)',
      sidebarRing: 'oklch(0.7686 0.1647 70.0804)',
    },
  },
  {
    id: 'caffeine',
    name: 'Caffeine',
    description: 'Warm coffee-inspired tones for focused work',
    category: 'nature',
    previewColors: {
      background: '#faf9f7',
      foreground: '#2d2926',
      primary: '#6b5b4f',
      secondary: '#e8e0d5',
      accent: '#d4c5b5',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.9821 0 0)',
      foreground: 'oklch(0.2435 0 0)',
      card: 'oklch(0.9911 0 0)',
      cardForeground: 'oklch(0.2435 0 0)',
      primary: 'oklch(0.4341 0.0392 41.9938)',
      primaryForeground: 'oklch(1 0 0)',
      secondary: 'oklch(0.92 0.0651 74.3695)',
      secondaryForeground: 'oklch(0.3499 0.0685 40.8288)',
      muted: 'oklch(0.9521 0 0)',
      mutedForeground: 'oklch(0.5032 0 0)',
      accent: 'oklch(0.931 0 0)',
      accentForeground: 'oklch(0.2435 0 0)',
      border: 'oklch(0.8822 0 0)',
      input: 'oklch(0.8822 0 0)',
      ring: 'oklch(0.4341 0.0392 41.9938)',
      sidebar: 'oklch(0.9881 0 0)',
      sidebarForeground: 'oklch(0.2645 0 0)',
      sidebarPrimary: 'oklch(0.325 0 0)',
      sidebarPrimaryForeground: 'oklch(0.9881 0 0)',
      sidebarAccent: 'oklch(0.9761 0 0)',
      sidebarAccentForeground: 'oklch(0.325 0 0)',
      sidebarBorder: 'oklch(0.9401 0 0)',
      sidebarRing: 'oklch(0.7731 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.1776 0 0)',
      foreground: 'oklch(0.9491 0 0)',
      card: 'oklch(0.2134 0 0)',
      cardForeground: 'oklch(0.9491 0 0)',
      popover: 'oklch(0.2134 0 0)',
      popoverForeground: 'oklch(0.9491 0 0)',
      primary: 'oklch(0.9247 0.0524 66.1732)',
      primaryForeground: 'oklch(0.2029 0.024 200.1962)',
      secondary: 'oklch(0.3163 0.019 63.6992)',
      secondaryForeground: 'oklch(0.9247 0.0524 66.1732)',
      muted: 'oklch(0.252 0 0)',
      mutedForeground: 'oklch(0.7699 0 0)',
      accent: 'oklch(0.285 0 0)',
      accentForeground: 'oklch(0.9491 0 0)',
      border: 'oklch(0.2351 0.0115 91.7467)',
      input: 'oklch(0.4017 0 0)',
      ring: 'oklch(0.9247 0.0524 66.1732)',
      sidebar: 'oklch(0.2103 0.0059 285.8852)',
      sidebarForeground: 'oklch(0.9674 0.0013 286.3752)',
      sidebarPrimary: 'oklch(0.4882 0.2172 264.3763)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.2739 0.0055 286.0326)',
      sidebarAccentForeground: 'oklch(0.9674 0.0013 286.3752)',
      sidebarBorder: 'oklch(0.2739 0.0055 286.0326)',
      sidebarRing: 'oklch(0.8711 0.0055 286.286)',
    },
  },
  {
    id: 'candyland',
    name: 'Candyland',
    description: 'Playful candy-inspired pastel colors',
    category: 'colorful',
    previewColors: {
      background: '#fafbfc',
      foreground: '#2d3436',
      primary: '#ff7675',
      secondary: '#74b9ff',
      accent: '#fdcb6e',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.9809 0.0025 228.7836)',
      foreground: 'oklch(0.3211 0 0)',
      card: 'oklch(1 0 0)',
      cardForeground: 'oklch(0.3211 0 0)',
      primary: 'oklch(0.8677 0.0735 7.0855)',
      primaryForeground: 'oklch(0 0 0)',
      secondary: 'oklch(0.8148 0.0819 225.7537)',
      secondaryForeground: 'oklch(0 0 0)',
      muted: 'oklch(0.8828 0.0285 98.1033)',
      mutedForeground: 'oklch(0.5382 0 0)',
      accent: 'oklch(0.968 0.211 109.7692)',
      accentForeground: 'oklch(0 0 0)',
      border: 'oklch(0.8699 0 0)',
      input: 'oklch(0.8699 0 0)',
      ring: 'oklch(0.8677 0.0735 7.0855)',
      sidebar: 'oklch(0.9809 0.0025 228.7836)',
      sidebarForeground: 'oklch(0.3211 0 0)',
      sidebarPrimary: 'oklch(0.8677 0.0735 7.0855)',
      sidebarPrimaryForeground: 'oklch(0 0 0)',
      sidebarAccent: 'oklch(0.968 0.211 109.7692)',
      sidebarAccentForeground: 'oklch(0 0 0)',
      sidebarBorder: 'oklch(0.8699 0 0)',
      sidebarRing: 'oklch(0.8677 0.0735 7.0855)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.2303 0.0125 264.2926)',
      foreground: 'oklch(0.9219 0 0)',
      card: 'oklch(0.321 0.0078 223.6661)',
      cardForeground: 'oklch(0.9219 0 0)',
      popover: 'oklch(0.321 0.0078 223.6661)',
      popoverForeground: 'oklch(0.9219 0 0)',
      primary: 'oklch(0.8027 0.1355 349.2347)',
      primaryForeground: 'oklch(0 0 0)',
      secondary: 'oklch(0.7395 0.2268 142.8504)',
      secondaryForeground: 'oklch(0 0 0)',
      muted: 'oklch(0.3867 0 0)',
      mutedForeground: 'oklch(0.7155 0 0)',
      accent: 'oklch(0.8148 0.0819 225.7537)',
      accentForeground: 'oklch(0 0 0)',
      border: 'oklch(0.3867 0 0)',
      input: 'oklch(0.3867 0 0)',
      ring: 'oklch(0.8027 0.1355 349.2347)',
      sidebar: 'oklch(0.2303 0.0125 264.2926)',
      sidebarForeground: 'oklch(0.9219 0 0)',
      sidebarPrimary: 'oklch(0.8027 0.1355 349.2347)',
      sidebarPrimaryForeground: 'oklch(0 0 0)',
      sidebarAccent: 'oklch(0.8148 0.0819 225.7537)',
      sidebarAccentForeground: 'oklch(0 0 0)',
      sidebarBorder: 'oklch(0.3867 0 0)',
      sidebarRing: 'oklch(0.8027 0.1355 349.2347)',
    },
  },
  {
    id: 'cyberpunk-2077',
    name: 'Cyberpunk 2077',
    description: 'Neon-drenched futuristic cyberpunk aesthetic',
    category: 'tech',
    previewColors: {
      background: '#000000',
      foreground: '#fcee0a',
      primary: '#fcee0a',
      secondary: '#00f0ff',
      accent: '#ff003c',
    },
    light: {
      ...defaultLight,
      background: 'oklch(1 0 0)',
      foreground: 'oklch(0.145 0 0)',
      primary: 'oklch(0.205 0 0)',
      primaryForeground: 'oklch(0.985 0 0)',
      secondary: 'oklch(0.97 0 0)',
      secondaryForeground: 'oklch(0.205 0 0)',
      muted: 'oklch(0.97 0 0)',
      mutedForeground: 'oklch(0.556 0 0)',
      accent: 'oklch(0.97 0 0)',
      accentForeground: 'oklch(0.205 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0 0 0)',
      foreground: 'oklch(0.832 0.015 43.985)',
      card: 'oklch(0 0 0)',
      cardForeground: 'oklch(1 0 263.283)',
      popover: 'oklch(0 0 0)',
      popoverForeground: 'oklch(1 0 263.283)',
      primary: 'oklch(0.926 0.195 104.561)',
      primaryForeground: 'oklch(0 0 0)',
      secondary: 'oklch(0.521 0 263.283)',
      secondaryForeground: 'oklch(1 0 263.283)',
      muted: 'oklch(0 0 0)',
      mutedForeground: 'oklch(1 0 263.283)',
      accent: 'oklch(0.315 0.087 281.076)',
      accentForeground: 'oklch(1 0 263.283)',
      border: 'oklch(1 0 263.283 / 6%)',
      input: 'oklch(0 0 0)',
      ring: 'oklch(0.926 0.195 104.561)',
      sidebar: 'oklch(0 0 0)',
      sidebarForeground: 'oklch(1 0 263.283)',
      sidebarPrimary: 'oklch(0.926 0.195 104.561)',
      sidebarPrimaryForeground: 'oklch(0 0 0)',
      sidebarAccent: 'oklch(1 0 263.283 / 6%)',
      sidebarAccentForeground: 'oklch(1 0 263.283)',
      sidebarBorder: 'oklch(0.5 0 0)',
      sidebarRing: 'oklch(0.315 0.087 281.076)',
    },
  },
  {
    id: 'darkmatter',
    name: 'Darkmatter',
    description: 'Deep space dark theme with subtle accents',
    category: 'dark',
    previewColors: {
      background: '#0f0f11',
      foreground: '#e4e4e7',
      primary: '#f59e0b',
      secondary: '#06b6d4',
      accent: '#10b981',
    },
    light: {
      ...defaultLight,
      background: 'oklch(1 0 0)',
      foreground: 'oklch(0.2101 0.0318 264.6645)',
      card: 'oklch(1 0 0)',
      cardForeground: 'oklch(0.2101 0.0318 264.6645)',
      primary: 'oklch(0.6716 0.1368 48.513)',
      primaryForeground: 'oklch(1 0 0)',
      secondary: 'oklch(0.536 0.0398 196.028)',
      secondaryForeground: 'oklch(1 0 0)',
      muted: 'oklch(0.967 0.0029 264.5419)',
      mutedForeground: 'oklch(0.551 0.0234 264.3637)',
      accent: 'oklch(0.9491 0 0)',
      accentForeground: 'oklch(0.2101 0.0318 264.6645)',
      border: 'oklch(0.9276 0.0058 264.5313)',
      input: 'oklch(0.9276 0.0058 264.5313)',
      ring: 'oklch(0.6716 0.1368 48.513)',
      sidebar: 'oklch(0.967 0.0029 264.5419)',
      sidebarForeground: 'oklch(0.2101 0.0318 264.6645)',
      sidebarPrimary: 'oklch(0.6716 0.1368 48.513)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(1 0 0)',
      sidebarAccentForeground: 'oklch(0.2101 0.0318 264.6645)',
      sidebarBorder: 'oklch(0.9276 0.0058 264.5313)',
      sidebarRing: 'oklch(0.6716 0.1368 48.513)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.1797 0.0043 308.1928)',
      foreground: 'oklch(0.8109 0 0)',
      card: 'oklch(0.1822 0 0)',
      cardForeground: 'oklch(0.8109 0 0)',
      popover: 'oklch(0.1797 0.0043 308.1928)',
      popoverForeground: 'oklch(0.8109 0 0)',
      primary: 'oklch(0.7214 0.1337 49.9802)',
      primaryForeground: 'oklch(0.1797 0.0043 308.1928)',
      secondary: 'oklch(0.594 0.0443 196.0233)',
      secondaryForeground: 'oklch(0.1797 0.0043 308.1928)',
      muted: 'oklch(0.252 0 0)',
      mutedForeground: 'oklch(0.6268 0 0)',
      accent: 'oklch(0.3211 0 0)',
      accentForeground: 'oklch(0.8109 0 0)',
      border: 'oklch(0.252 0 0)',
      input: 'oklch(0.252 0 0)',
      ring: 'oklch(0.7214 0.1337 49.9802)',
      sidebar: 'oklch(0.1822 0 0)',
      sidebarForeground: 'oklch(0.8109 0 0)',
      sidebarPrimary: 'oklch(0.7214 0.1337 49.9802)',
      sidebarPrimaryForeground: 'oklch(0.1797 0.0043 308.1928)',
      sidebarAccent: 'oklch(0.3211 0 0)',
      sidebarAccentForeground: 'oklch(0.8109 0 0)',
      sidebarBorder: 'oklch(0.252 0 0)',
      sidebarRing: 'oklch(0.7214 0.1337 49.9802)',
    },
  },
  {
    id: 'doom-64',
    name: 'Doom 64',
    description: 'Retro gaming aesthetic inspired by classic Doom',
    category: 'retro',
    previewColors: {
      background: '#1a1a1a',
      foreground: '#e8e8e8',
      primary: '#c41e3a',
      secondary: '#4a7c59',
      accent: '#6b5ce7',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.8452 0 0)',
      foreground: 'oklch(0.2393 0 0)',
      card: 'oklch(0.7572 0 0)',
      cardForeground: 'oklch(0.2393 0 0)',
      primary: 'oklch(0.5016 0.1887 27.4816)',
      primaryForeground: 'oklch(1 0 0)',
      secondary: 'oklch(0.4955 0.0896 126.1858)',
      secondaryForeground: 'oklch(1 0 0)',
      muted: 'oklch(0.7826 0 0)',
      mutedForeground: 'oklch(0.4091 0 0)',
      accent: 'oklch(0.588 0.0993 245.7394)',
      accentForeground: 'oklch(1 0 0)',
      border: 'oklch(0.4313 0 0)',
      input: 'oklch(0.4313 0 0)',
      ring: 'oklch(0.5016 0.1887 27.4816)',
      radius: '0rem',
      sidebar: 'oklch(0.7572 0 0)',
      sidebarForeground: 'oklch(0.2393 0 0)',
      sidebarPrimary: 'oklch(0.5016 0.1887 27.4816)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.588 0.0993 245.7394)',
      sidebarAccentForeground: 'oklch(1 0 0)',
      sidebarBorder: 'oklch(0.4313 0 0)',
      sidebarRing: 'oklch(0.5016 0.1887 27.4816)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.2178 0 0)',
      foreground: 'oklch(0.9067 0 0)',
      card: 'oklch(0.285 0 0)',
      cardForeground: 'oklch(0.9067 0 0)',
      popover: 'oklch(0.285 0 0)',
      popoverForeground: 'oklch(0.9067 0 0)',
      primary: 'oklch(0.6083 0.209 27.0276)',
      primaryForeground: 'oklch(1 0 0)',
      secondary: 'oklch(0.6423 0.1467 133.0145)',
      secondaryForeground: 'oklch(0 0 0)',
      muted: 'oklch(0.2645 0 0)',
      mutedForeground: 'oklch(0.7058 0 0)',
      accent: 'oklch(0.7482 0.1235 244.7492)',
      accentForeground: 'oklch(0 0 0)',
      border: 'oklch(0.4091 0 0)',
      input: 'oklch(0.4091 0 0)',
      ring: 'oklch(0.6083 0.209 27.0276)',
      radius: '0rem',
      sidebar: 'oklch(0.1913 0 0)',
      sidebarForeground: 'oklch(0.9067 0 0)',
      sidebarPrimary: 'oklch(0.6083 0.209 27.0276)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.7482 0.1235 244.7492)',
      sidebarAccentForeground: 'oklch(0 0 0)',
      sidebarBorder: 'oklch(0.4091 0 0)',
      sidebarRing: 'oklch(0.6083 0.209 27.0276)',
    },
  },
  {
    id: 'gentle-green',
    name: 'Gentle Green',
    description: 'Soothing natural green tones',
    category: 'nature',
    previewColors: {
      background: '#f6f7f6',
      foreground: '#1a1f1c',
      primary: '#4ade80',
      secondary: '#bbf7d0',
      accent: '#86efac',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.964 0.001 0)',
      foreground: 'oklch(0.109 0.01 144.857)',
      card: 'oklch(1 0.001 0)',
      cardForeground: 'oklch(0.109 0.01 144.857)',
      primary: 'oklch(0.572 0.076 159.328)',
      primaryForeground: 'oklch(1 0.001 0)',
      secondary: 'oklch(0.726 0.046 86.56)',
      secondaryForeground: 'oklch(0.973 0.004 91.446)',
      muted: 'oklch(0.855 0.008 80.719)',
      mutedForeground: 'oklch(0.264 0.042 82.489)',
      accent: 'oklch(0.949 0.005 165.005)',
      accentForeground: 'oklch(0.203 0.016 195.974)',
      border: 'oklch(0.908 0.008 80.72)',
      input: 'oklch(0.855 0.008 80.719)',
      ring: 'oklch(0.572 0.076 159.328)',
      sidebar: 'oklch(1 0.001 0)',
      sidebarForeground: 'oklch(0.093 0.007 145.003)',
      sidebarPrimary: 'oklch(0.572 0.076 159.328)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.572 0.076 159.328)',
      sidebarAccentForeground: 'oklch(1 0.001 0)',
      sidebarBorder: 'oklch(0.908 0.008 80.72)',
      sidebarRing: 'oklch(0.572 0.076 159.328)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.1797 0.0043 308.1928)',
      foreground: 'oklch(0.8109 0 0)',
      card: 'oklch(0.072 0.007 18.809)',
      cardForeground: 'oklch(0.811 0.001 0)',
      popover: 'oklch(0.1797 0.0043 308.1928)',
      popoverForeground: 'oklch(0.8109 0 0)',
      primary: 'oklch(0.572 0.076 159.328)',
      primaryForeground: 'oklch(0.941 0.015 164.719)',
      secondary: 'oklch(0.357 0.049 82.576)',
      secondaryForeground: 'oklch(0.926 0.016 86.427)',
      muted: 'oklch(0.271 0.008 169.75)',
      mutedForeground: 'oklch(0.805 0.022 170.461)',
      accent: 'oklch(0.271 0.008 169.75)',
      accentForeground: 'oklch(0.805 0.022 170.461)',
      border: 'oklch(0.271 0.008 169.75)',
      input: 'oklch(0.444 0.019 165.96)',
      ring: 'oklch(0.572 0.076 159.328)',
      sidebar: 'oklch(0.1822 0 0)',
      sidebarForeground: 'oklch(0.8109 0 0)',
      sidebarPrimary: 'oklch(0.572 0.076 159.328)',
      sidebarPrimaryForeground: 'oklch(0.1797 0.0043 308.1928)',
      sidebarAccent: 'oklch(0.3211 0 0)',
      sidebarAccentForeground: 'oklch(0.8109 0 0)',
      sidebarBorder: 'oklch(0.252 0 0)',
      sidebarRing: 'oklch(0.572 0.076 159.328)',
    },
  },
  {
    id: 'mono',
    name: 'Mono',
    description: 'Clean monochrome design without colors',
    category: 'minimal',
    previewColors: {
      background: '#ffffff',
      foreground: '#171717',
      primary: '#525252',
      secondary: '#f5f5f5',
      accent: '#e5e5e5',
    },
    light: {
      ...defaultLight,
      background: 'oklch(1 0 0)',
      foreground: 'oklch(0.1448 0 0)',
      card: 'oklch(1 0 0)',
      cardForeground: 'oklch(0.1448 0 0)',
      primary: 'oklch(0.5555 0 0)',
      primaryForeground: 'oklch(0.9851 0 0)',
      secondary: 'oklch(0.9702 0 0)',
      secondaryForeground: 'oklch(0.2046 0 0)',
      muted: 'oklch(0.9702 0 0)',
      mutedForeground: 'oklch(0.5486 0 0)',
      accent: 'oklch(0.9702 0 0)',
      accentForeground: 'oklch(0.2046 0 0)',
      border: 'oklch(0.9219 0 0)',
      input: 'oklch(0.9219 0 0)',
      ring: 'oklch(0.709 0 0)',
      sidebar: 'oklch(0.9851 0 0)',
      sidebarForeground: 'oklch(0.1448 0 0)',
      sidebarPrimary: 'oklch(0.2046 0 0)',
      sidebarPrimaryForeground: 'oklch(0.9851 0 0)',
      sidebarAccent: 'oklch(0.9702 0 0)',
      sidebarAccentForeground: 'oklch(0.2046 0 0)',
      sidebarBorder: 'oklch(0.9219 0 0)',
      sidebarRing: 'oklch(0.709 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.1448 0 0)',
      foreground: 'oklch(0.9851 0 0)',
      card: 'oklch(0.2134 0 0)',
      cardForeground: 'oklch(0.9851 0 0)',
      popover: 'oklch(0.2686 0 0)',
      popoverForeground: 'oklch(0.9851 0 0)',
      primary: 'oklch(0.5555 0 0)',
      primaryForeground: 'oklch(0.9851 0 0)',
      secondary: 'oklch(0.2686 0 0)',
      secondaryForeground: 'oklch(0.9851 0 0)',
      muted: 'oklch(0.2686 0 0)',
      mutedForeground: 'oklch(0.709 0 0)',
      accent: 'oklch(0.3715 0 0)',
      accentForeground: 'oklch(0.9851 0 0)',
      border: 'oklch(0.3407 0 0)',
      input: 'oklch(0.4386 0 0)',
      ring: 'oklch(0.5555 0 0)',
      sidebar: 'oklch(0.2046 0 0)',
      sidebarForeground: 'oklch(0.9851 0 0)',
      sidebarPrimary: 'oklch(0.9851 0 0)',
      sidebarPrimaryForeground: 'oklch(0.2046 0 0)',
      sidebarAccent: 'oklch(0.2686 0 0)',
      sidebarAccentForeground: 'oklch(0.9851 0 0)',
      sidebarBorder: 'oklch(1 0 0)',
      sidebarRing: 'oklch(0.4386 0 0)',
    },
  },
  {
    id: 'notebook',
    name: 'Notebook',
    description: 'Paper-like background for a writing feel',
    category: 'minimal',
    previewColors: {
      background: '#fafaf9',
      foreground: '#44403c',
      primary: '#57534e',
      secondary: '#e7e5e4',
      accent: '#fef3c7',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.9821 0 0)',
      foreground: 'oklch(0.3485 0 0)',
      card: 'oklch(1 0 0)',
      cardForeground: 'oklch(0.3485 0 0)',
      primary: 'oklch(0.4891 0 0)',
      primaryForeground: 'oklch(0.9551 0 0)',
      secondary: 'oklch(0.9006 0 0)',
      secondaryForeground: 'oklch(0.3485 0 0)',
      muted: 'oklch(0.9158 0 0)',
      mutedForeground: 'oklch(0.4313 0 0)',
      accent: 'oklch(0.9354 0.0456 94.8549)',
      accentForeground: 'oklch(0.4015 0.0436 37.9587)',
      border: 'oklch(0.5538 0.0025 17.232)',
      input: 'oklch(1 0 0)',
      ring: 'oklch(0.7058 0 0)',
      sidebar: 'oklch(0.9551 0 0)',
      sidebarForeground: 'oklch(0.3485 0 0)',
      sidebarPrimary: 'oklch(0.4891 0 0)',
      sidebarPrimaryForeground: 'oklch(0.9551 0 0)',
      sidebarAccent: 'oklch(0.9354 0.0456 94.8549)',
      sidebarAccentForeground: 'oklch(0.4015 0.0436 37.9587)',
      sidebarBorder: 'oklch(0.8078 0 0)',
      sidebarRing: 'oklch(0.7058 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.2891 0 0)',
      foreground: 'oklch(0.8945 0 0)',
      card: 'oklch(0.3211 0 0)',
      cardForeground: 'oklch(0.8945 0 0)',
      popover: 'oklch(0.3211 0 0)',
      popoverForeground: 'oklch(0.8945 0 0)',
      primary: 'oklch(0.7572 0 0)',
      primaryForeground: 'oklch(0.2891 0 0)',
      secondary: 'oklch(0.4676 0 0)',
      secondaryForeground: 'oklch(0.8078 0 0)',
      muted: 'oklch(0.3904 0 0)',
      mutedForeground: 'oklch(0.7058 0 0)',
      accent: 'oklch(0.9067 0 0)',
      accentForeground: 'oklch(0.3211 0 0)',
      border: 'oklch(0.4276 0 0)',
      input: 'oklch(0.3211 0 0)',
      ring: 'oklch(0.8078 0 0)',
      sidebar: 'oklch(0.2478 0 0)',
      sidebarForeground: 'oklch(0.8945 0 0)',
      sidebarPrimary: 'oklch(0.7572 0 0)',
      sidebarPrimaryForeground: 'oklch(0.2478 0 0)',
      sidebarAccent: 'oklch(0.9067 0 0)',
      sidebarAccentForeground: 'oklch(0.3211 0 0)',
      sidebarBorder: 'oklch(0.4276 0 0)',
      sidebarRing: 'oklch(0.8078 0 0)',
    },
  },
  {
    id: 'sakura',
    name: 'Sakura',
    description: 'Delicate cherry blossom pink theme',
    category: 'nature',
    previewColors: {
      background: '#fff5f7',
      foreground: '#4a4a4a',
      primary: '#ec4899',
      secondary: '#fbcfe8',
      accent: '#fce7f3',
    },
    light: {
      ...defaultLight,
      background: 'oklch(1 0 0)',
      foreground: 'oklch(0.145 0 0)',
      primary: 'oklch(0.205 0 0)',
      primaryForeground: 'oklch(0.985 0 0)',
      secondary: 'oklch(0.97 0 0)',
      secondaryForeground: 'oklch(0.205 0 0)',
      muted: 'oklch(0.97 0 0)',
      mutedForeground: 'oklch(0.556 0 0)',
      accent: 'oklch(0.97 0 0)',
      accentForeground: 'oklch(0.205 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.148 0.015 256.699)',
      foreground: 'oklch(0.811 0.146 217.732)',
      card: 'oklch(0.148 0.015 256.699)',
      cardForeground: 'oklch(0.845 0 263.283)',
      popover: 'oklch(0.178 0.018 284.351)',
      popoverForeground: 'oklch(0.845 0 263.283)',
      primary: 'oklch(0.615 0.227 12.142)',
      primaryForeground: 'oklch(1 0 263.283)',
      secondary: 'oklch(0.359 0.008 255.578)',
      secondaryForeground: 'oklch(1 0 263.283)',
      muted: 'oklch(0.148 0.015 256.699)',
      mutedForeground: 'oklch(1 0 263.283)',
      accent: 'oklch(0.924 0.039 17.775 / 13%)',
      accentForeground: 'oklch(1 0 263.283)',
      border: 'oklch(0.371 0 263.283)',
      input: 'oklch(0.196 0 263.283)',
      ring: 'oklch(0.493 0 263.283)',
      sidebar: 'oklch(0.148 0.015 256.699)',
      sidebarForeground: 'oklch(0.845 0 263.283)',
      sidebarPrimary: 'oklch(0.615 0.227 12.142)',
      sidebarPrimaryForeground: 'oklch(1 0 263.283)',
      sidebarAccent: 'oklch(0.924 0.039 17.775 / 30%)',
      sidebarAccentForeground: 'oklch(1 0 263.283)',
      sidebarBorder: 'oklch(1 0 263.283 / 0%)',
      sidebarRing: 'oklch(0.902 0.023 252.226 / 21%)',
    },
  },
  {
    id: 't3-chat',
    name: 'T3 Chat',
    description: 'Modern purple-pink gradient inspired theme',
    category: 'tech',
    previewColors: {
      background: '#fdf4ff',
      foreground: '#581c87',
      primary: '#c026d3',
      secondary: '#e9d5ff',
      accent: '#f0abfc',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.9754 0.0084 325.6414)',
      foreground: 'oklch(0.3257 0.1161 325.0372)',
      card: 'oklch(0.9754 0.0084 325.6414)',
      cardForeground: 'oklch(0.3257 0.1161 325.0372)',
      popover: 'oklch(1 0 0)',
      popoverForeground: 'oklch(0.3257 0.1161 325.0372)',
      primary: 'oklch(0.5316 0.1409 355.1999)',
      primaryForeground: 'oklch(1 0 0)',
      secondary: 'oklch(0.8696 0.0675 334.8991)',
      secondaryForeground: 'oklch(0.4448 0.1341 324.7991)',
      muted: 'oklch(0.9395 0.026 331.5454)',
      mutedForeground: 'oklch(0.4924 0.1244 324.4523)',
      accent: 'oklch(0.8696 0.0675 334.8991)',
      accentForeground: 'oklch(0.4448 0.1341 324.7991)',
      border: 'oklch(0.8568 0.0829 328.911)',
      input: 'oklch(0.8517 0.0558 336.6002)',
      ring: 'oklch(0.5916 0.218 0.5844)',
      sidebar: 'oklch(0.936 0.0288 320.5788)',
      sidebarForeground: 'oklch(0.4948 0.1909 354.5435)',
      sidebarPrimary: 'oklch(0.3963 0.0251 285.1962)',
      sidebarPrimaryForeground: 'oklch(0.9668 0.0124 337.5228)',
      sidebarAccent: 'oklch(0.9789 0.0013 106.4235)',
      sidebarAccentForeground: 'oklch(0.3963 0.0251 285.1962)',
      sidebarBorder: 'oklch(0.9383 0.0026 48.7178)',
      sidebarRing: 'oklch(0.5916 0.218 0.5844)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.2409 0.0201 307.5346)',
      foreground: 'oklch(0.8398 0.0387 309.5391)',
      card: 'oklch(0.2803 0.0232 307.5413)',
      cardForeground: 'oklch(0.8456 0.0302 341.4597)',
      popover: 'oklch(0.1548 0.0132 338.9015)',
      popoverForeground: 'oklch(0.9647 0.0091 341.8035)',
      primary: 'oklch(0.4607 0.1853 4.0994)',
      primaryForeground: 'oklch(0.856 0.0618 346.3684)',
      secondary: 'oklch(0.3137 0.0306 310.061)',
      secondaryForeground: 'oklch(0.8483 0.0382 307.9613)',
      muted: 'oklch(0.2634 0.0219 309.4748)',
      mutedForeground: 'oklch(0.794 0.0372 307.1032)',
      accent: 'oklch(0.3649 0.0508 308.4911)',
      accentForeground: 'oklch(0.9647 0.0091 341.8035)',
      border: 'oklch(0.3286 0.0154 343.4461)',
      input: 'oklch(0.3387 0.0195 332.8347)',
      ring: 'oklch(0.5916 0.218 0.5844)',
      sidebar: 'oklch(0.1893 0.0163 331.0475)',
      sidebarForeground: 'oklch(0.8607 0.0293 343.6612)',
      sidebarPrimary: 'oklch(0.4882 0.2172 264.3763)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.2337 0.0261 338.1961)',
      sidebarAccentForeground: 'oklch(0.9674 0.0013 286.3752)',
      sidebarBorder: 'oklch(0 0 0)',
      sidebarRing: 'oklch(0.5916 0.218 0.5844)',
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Clean black and white design inspired by Vercel',
    category: 'minimal',
    previewColors: {
      background: '#ffffff',
      foreground: '#000000',
      primary: '#000000',
      secondary: '#f2f2f2',
      accent: '#f2f2f2',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.99 0 0)',
      foreground: 'oklch(0 0 0)',
      card: 'oklch(1 0 0)',
      cardForeground: 'oklch(0 0 0)',
      popover: 'oklch(0.99 0 0)',
      popoverForeground: 'oklch(0 0 0)',
      primary: 'oklch(0 0 0)',
      primaryForeground: 'oklch(1 0 0)',
      secondary: 'oklch(0.94 0 0)',
      secondaryForeground: 'oklch(0 0 0)',
      muted: 'oklch(0.97 0 0)',
      mutedForeground: 'oklch(0.44 0 0)',
      accent: 'oklch(0.94 0 0)',
      accentForeground: 'oklch(0 0 0)',
      border: 'oklch(0.92 0 0)',
      input: 'oklch(0.94 0 0)',
      ring: 'oklch(0 0 0)',
      sidebar: 'oklch(0.99 0 0)',
      sidebarForeground: 'oklch(0 0 0)',
      sidebarPrimary: 'oklch(0 0 0)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.94 0 0)',
      sidebarAccentForeground: 'oklch(0 0 0)',
      sidebarBorder: 'oklch(0.94 0 0)',
      sidebarRing: 'oklch(0 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0 0 0)',
      foreground: 'oklch(1 0 0)',
      card: 'oklch(0.14 0 0)',
      cardForeground: 'oklch(1 0 0)',
      popover: 'oklch(0.18 0 0)',
      popoverForeground: 'oklch(1 0 0)',
      primary: 'oklch(1 0 0)',
      primaryForeground: 'oklch(0 0 0)',
      secondary: 'oklch(0.25 0 0)',
      secondaryForeground: 'oklch(1 0 0)',
      muted: 'oklch(0.23 0 0)',
      mutedForeground: 'oklch(0.72 0 0)',
      accent: 'oklch(0.32 0 0)',
      accentForeground: 'oklch(1 0 0)',
      border: 'oklch(0.26 0 0)',
      input: 'oklch(0.32 0 0)',
      ring: 'oklch(0.72 0 0)',
      sidebar: 'oklch(0.18 0 0)',
      sidebarForeground: 'oklch(1 0 0)',
      sidebarPrimary: 'oklch(1 0 0)',
      sidebarPrimaryForeground: 'oklch(0 0 0)',
      sidebarAccent: 'oklch(0.32 0 0)',
      sidebarAccentForeground: 'oklch(1 0 0)',
      sidebarBorder: 'oklch(0.32 0 0)',
      sidebarRing: 'oklch(0.72 0 0)',
    },
  },
  {
    id: 'violet-bloom',
    name: 'Violet Bloom',
    description: 'Elegant purple tones with soft gradients',
    category: 'colorful',
    previewColors: {
      background: '#fdfcfd',
      foreground: '#2e1065',
      primary: '#7c3aed',
      secondary: '#ddd6fe',
      accent: '#c4b5fd',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.994 0 0)',
      foreground: 'oklch(0 0 0)',
      card: 'oklch(0.994 0 0)',
      cardForeground: 'oklch(0 0 0)',
      popover: 'oklch(0.9911 0 0)',
      popoverForeground: 'oklch(0 0 0)',
      primary: 'oklch(0.5393 0.2713 286.7462)',
      primaryForeground: 'oklch(1 0 0)',
      secondary: 'oklch(0.954 0.0063 255.4755)',
      secondaryForeground: 'oklch(0.1344 0 0)',
      muted: 'oklch(0.9702 0 0)',
      mutedForeground: 'oklch(0.4386 0 0)',
      accent: 'oklch(0.9393 0.0288 266.368)',
      accentForeground: 'oklch(0.5445 0.1903 259.4848)',
      border: 'oklch(0.93 0.0094 286.2156)',
      input: 'oklch(0.9401 0 0)',
      ring: 'oklch(0 0 0)',
      radius: '0.375rem',
      sidebar: 'oklch(0.9777 0.0051 247.8763)',
      sidebarForeground: 'oklch(0 0 0)',
      sidebarPrimary: 'oklch(0 0 0)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.9401 0 0)',
      sidebarAccentForeground: 'oklch(0 0 0)',
      sidebarBorder: 'oklch(0.9401 0 0)',
      sidebarRing: 'oklch(0 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.2223 0.006 271.1393)',
      foreground: 'oklch(0.9551 0 0)',
      card: 'oklch(0.2568 0.0076 274.6528)',
      cardForeground: 'oklch(0.9551 0 0)',
      popover: 'oklch(0.2568 0.0076 274.6528)',
      popoverForeground: 'oklch(0.9551 0 0)',
      primary: 'oklch(0.6132 0.2294 291.7437)',
      primaryForeground: 'oklch(1 0 0)',
      secondary: 'oklch(0.294 0.013 272.9312)',
      secondaryForeground: 'oklch(0.9551 0 0)',
      muted: 'oklch(0.294 0.013 272.9312)',
      mutedForeground: 'oklch(0.7058 0 0)',
      accent: 'oklch(0.2795 0.0368 260.031)',
      accentForeground: 'oklch(0.7857 0.1153 246.6596)',
      border: 'oklch(0.3289 0.0092 268.3843)',
      input: 'oklch(0.3289 0.0092 268.3843)',
      ring: 'oklch(0.6132 0.2294 291.7437)',
      radius: '0.375rem',
      sidebar: 'oklch(0.2011 0.0039 286.0396)',
      sidebarForeground: 'oklch(0.9551 0 0)',
      sidebarPrimary: 'oklch(0.6132 0.2294 291.7437)',
      sidebarPrimaryForeground: 'oklch(1 0 0)',
      sidebarAccent: 'oklch(0.294 0.013 272.9312)',
      sidebarAccentForeground: 'oklch(0.6132 0.2294 291.7437)',
      sidebarBorder: 'oklch(0.3289 0.0092 268.3843)',
      sidebarRing: 'oklch(0.6132 0.2294 291.7437)',
    },
  },
  {
    id: 'wired',
    name: 'Wired',
    description: 'High contrast tech magazine aesthetic',
    category: 'tech',
    previewColors: {
      background: '#000000',
      foreground: '#f5f5dc',
      primary: '#ff6b35',
      secondary: '#4ecdc4',
      accent: '#ffe66d',
    },
    light: {
      ...defaultLight,
      background: 'oklch(1 0 0)',
      foreground: 'oklch(0.145 0 0)',
      primary: 'oklch(0.205 0 0)',
      primaryForeground: 'oklch(0.985 0 0)',
      secondary: 'oklch(0.97 0 0)',
      secondaryForeground: 'oklch(0.205 0 0)',
      muted: 'oklch(0.97 0 0)',
      mutedForeground: 'oklch(0.556 0 0)',
      accent: 'oklch(0.97 0 0)',
      accentForeground: 'oklch(0.205 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0 0 0)',
      foreground: 'oklch(0.772 0.049 89.603)',
      card: 'oklch(0 0 0)',
      cardForeground: 'oklch(0.581 0.104 3.55)',
      popover: 'oklch(0 0 0)',
      popoverForeground: 'oklch(0.772 0.049 89.603)',
      primary: 'oklch(0.724 0.062 31.421)',
      primaryForeground: 'oklch(0 0 0)',
      secondary: 'oklch(0.333 0.061 4.909)',
      secondaryForeground: 'oklch(0.772 0.049 89.603)',
      muted: 'oklch(0 0 0)',
      mutedForeground: 'oklch(0.772 0.049 89.603)',
      accent: 'oklch(0.421 0.077 5.549)',
      accentForeground: 'oklch(0.668 0.121 5.386)',
      border: 'oklch(0.333 0.061 4.909 / 50%)',
      input: 'oklch(0 0 0)',
      ring: 'oklch(0.668 0.121 5.386)',
      sidebar: 'oklch(0 0 0)',
      sidebarForeground: 'oklch(0.581 0.104 3.55)',
      sidebarPrimary: 'oklch(0 0 0)',
      sidebarPrimaryForeground: 'oklch(0.772 0.049 89.603)',
      sidebarAccent: 'oklch(0.333 0.061 4.909)',
      sidebarAccentForeground: 'oklch(0.772 0.049 89.603)',
      sidebarBorder: 'oklch(0.421 0.077 5.549)',
      sidebarRing: 'oklch(0.421 0.077 5.549)',
    },
  },
  {
    id: 'uxcanvas',
    name: 'UXCanvas',
    description: 'Professional design tool aesthetic',
    category: 'minimal',
    previewColors: {
      background: '#ffffff',
      foreground: '#171717',
      primary: '#171717',
      secondary: '#f5f5f5',
      accent: '#e5e5e5',
    },
    light: {
      ...defaultLight,
      background: 'oklch(1 0 0)',
      foreground: 'oklch(0.145 0 0)',
      card: 'oklch(1 0 0)',
      cardForeground: 'oklch(0.145 0 0)',
      popover: 'oklch(1 0 0)',
      popoverForeground: 'oklch(0.145 0 0)',
      primary: 'oklch(0.205 0 0)',
      primaryForeground: 'oklch(0.985 0 0)',
      secondary: 'oklch(0.97 0 0)',
      secondaryForeground: 'oklch(0.205 0 0)',
      muted: 'oklch(0.97 0 0)',
      mutedForeground: 'oklch(0.556 0 0)',
      accent: 'oklch(0.97 0 0)',
      accentForeground: 'oklch(0.205 0 0)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.145 0 0)',
      foreground: 'oklch(0.985 0 0)',
      card: 'oklch(0.205 0 0)',
      cardForeground: 'oklch(0.985 0 0)',
      popover: 'oklch(0.269 0 0)',
      popoverForeground: 'oklch(0.985 0 0)',
      primary: 'oklch(0.922 0 0)',
      primaryForeground: 'oklch(0.205 0 0)',
      secondary: 'oklch(0.269 0 0)',
      secondaryForeground: 'oklch(0.985 0 0)',
      muted: 'oklch(0.269 0 0)',
      mutedForeground: 'oklch(0.708 0 0)',
      accent: 'oklch(0.371 0 0)',
      accentForeground: 'oklch(0.985 0 0)',
      border: 'oklch(1 0 0 / 10%)',
      input: 'oklch(1 0 0 / 15%)',
      ring: 'oklch(0.556 0 0)',
      sidebar: 'oklch(0.205 0 0)',
      sidebarForeground: 'oklch(0.985 0 0)',
      sidebarPrimary: 'oklch(0.488 0.243 264.376)',
      sidebarPrimaryForeground: 'oklch(0.985 0 0)',
      sidebarAccent: 'oklch(0.269 0 0)',
      sidebarAccentForeground: 'oklch(0.985 0 0)',
      sidebarBorder: 'oklch(1 0 0 / 10%)',
      sidebarRing: 'oklch(0.439 0 0)',
    },
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Modern green theme inspired by Supabase',
    category: 'tech',
    previewColors: {
      background: '#fcfcfc',
      foreground: '#1c1c1c',
      primary: '#3ecf8e',
      secondary: '#f0fdf4',
      accent: '#dcfce7',
    },
    light: {
      ...defaultLight,
      background: 'oklch(0.9911 0 0)',
      foreground: 'oklch(0.2046 0 0)',
      card: 'oklch(0.9911 0 0)',
      cardForeground: 'oklch(0.2046 0 0)',
      popover: 'oklch(0.9911 0 0)',
      popoverForeground: 'oklch(0.4386 0 0)',
      primary: 'oklch(0.8348 0.1302 160.908)',
      primaryForeground: 'oklch(0.2626 0.0147 166.4589)',
      secondary: 'oklch(0.994 0 0)',
      secondaryForeground: 'oklch(0.2046 0 0)',
      muted: 'oklch(0.9461 0 0)',
      mutedForeground: 'oklch(0.2435 0 0)',
      accent: 'oklch(0.9461 0 0)',
      accentForeground: 'oklch(0.2435 0 0)',
      border: 'oklch(0.9037 0 0)',
      input: 'oklch(0.9731 0 0)',
      ring: 'oklch(0.8348 0.1302 160.908)',
      radius: '0.375rem',
      sidebar: 'oklch(0.9911 0 0)',
      sidebarForeground: 'oklch(0.5452 0 0)',
      sidebarPrimary: 'oklch(0.8348 0.1302 160.908)',
      sidebarPrimaryForeground: 'oklch(0.2626 0.0147 166.4589)',
      sidebarAccent: 'oklch(0.9461 0 0)',
      sidebarAccentForeground: 'oklch(0.2435 0 0)',
      sidebarBorder: 'oklch(0.9037 0 0)',
      sidebarRing: 'oklch(0.8348 0.1302 160.908)',
    },
    dark: {
      ...defaultDark,
      background: 'oklch(0.1822 0 0)',
      foreground: 'oklch(0.9288 0.0126 255.5078)',
      card: 'oklch(0.2046 0 0)',
      cardForeground: 'oklch(0.9288 0.0126 255.5078)',
      popover: 'oklch(0.2603 0 0)',
      popoverForeground: 'oklch(0.7348 0 0)',
      primary: 'oklch(0.4365 0.1044 156.7556)',
      primaryForeground: 'oklch(0.9213 0.0135 167.1556)',
      secondary: 'oklch(0.2603 0 0)',
      secondaryForeground: 'oklch(0.9851 0 0)',
      muted: 'oklch(0.2393 0 0)',
      mutedForeground: 'oklch(0.7122 0 0)',
      accent: 'oklch(0.3132 0 0)',
      accentForeground: 'oklch(0.9851 0 0)',
      border: 'oklch(0.2809 0 0)',
      input: 'oklch(0.2603 0 0)',
      ring: 'oklch(0.8003 0.1821 151.711)',
      radius: '0.375rem',
      sidebar: 'oklch(0.1822 0 0)',
      sidebarForeground: 'oklch(0.6301 0 0)',
      sidebarPrimary: 'oklch(0.4365 0.1044 156.7556)',
      sidebarPrimaryForeground: 'oklch(0.9213 0.0135 167.1556)',
      sidebarAccent: 'oklch(0.3132 0 0)',
      sidebarAccentForeground: 'oklch(0.9851 0 0)',
      sidebarBorder: 'oklch(0.2809 0 0)',
      sidebarRing: 'oklch(0.8003 0.1821 151.711)',
    },
  },
];

/**
 * Get a theme by its ID
 * @param themeId - The unique theme identifier
 * @returns The theme object or undefined if not found
 */
export function getThemeById(themeId: string): Theme | undefined {
  return themes.find((theme) => theme.id === themeId);
}

/**
 * Get the default theme
 * @returns The default theme (Vercel)
 */
export function getDefaultTheme(): Theme {
  return themes.find((theme) => theme.id === 'vercel') ?? themes[0];
}

/**
 * Get themes grouped by category
 * @returns Record of category to themes array
 */
export function getThemesByCategory(): Record<ThemeCategory, Theme[]> {
  return themes.reduce((acc, theme) => {
    if (!acc[theme.category]) {
      acc[theme.category] = [];
    }
    acc[theme.category].push(theme);
    return acc;
  }, {} as Record<ThemeCategory, Theme[]>);
}

/**
 * Apply theme colors to CSS variables
 * @param colors - The theme colors to apply
 * @param isDark - Whether to apply dark mode
 */
export function applyThemeColors(colors: ThemeColors, isDark: boolean): void {
  const root = document.documentElement;
  const prefix = isDark ? '--' : '--';

  // Apply all color variables
  root.style.setProperty(`${prefix}background`, colors.background);
  root.style.setProperty(`${prefix}foreground`, colors.foreground);
  root.style.setProperty(`${prefix}card`, colors.card);
  root.style.setProperty(`${prefix}card-foreground`, colors.cardForeground);
  root.style.setProperty(`${prefix}popover`, colors.popover);
  root.style.setProperty(`${prefix}popover-foreground`, colors.popoverForeground);
  root.style.setProperty(`${prefix}primary`, colors.primary);
  root.style.setProperty(`${prefix}primary-foreground`, colors.primaryForeground);
  root.style.setProperty(`${prefix}secondary`, colors.secondary);
  root.style.setProperty(`${prefix}secondary-foreground`, colors.secondaryForeground);
  root.style.setProperty(`${prefix}muted`, colors.muted);
  root.style.setProperty(`${prefix}muted-foreground`, colors.mutedForeground);
  root.style.setProperty(`${prefix}accent`, colors.accent);
  root.style.setProperty(`${prefix}accent-foreground`, colors.accentForeground);
  root.style.setProperty(`${prefix}destructive`, colors.destructive);
  root.style.setProperty(`${prefix}border`, colors.border);
  root.style.setProperty(`${prefix}input`, colors.input);
  root.style.setProperty(`${prefix}ring`, colors.ring);
  root.style.setProperty(`${prefix}chart-1`, colors.chart1);
  root.style.setProperty(`${prefix}chart-2`, colors.chart2);
  root.style.setProperty(`${prefix}chart-3`, colors.chart3);
  root.style.setProperty(`${prefix}chart-4`, colors.chart4);
  root.style.setProperty(`${prefix}chart-5`, colors.chart5);
  root.style.setProperty(`${prefix}sidebar`, colors.sidebar);
  root.style.setProperty(`${prefix}sidebar-foreground`, colors.sidebarForeground);
  root.style.setProperty(`${prefix}sidebar-primary`, colors.sidebarPrimary);
  root.style.setProperty(`${prefix}sidebar-primary-foreground`, colors.sidebarPrimaryForeground);
  root.style.setProperty(`${prefix}sidebar-accent`, colors.sidebarAccent);
  root.style.setProperty(`${prefix}sidebar-accent-foreground`, colors.sidebarAccentForeground);
  root.style.setProperty(`${prefix}sidebar-border`, colors.sidebarBorder);
  root.style.setProperty(`${prefix}sidebar-ring`, colors.sidebarRing);
  root.style.setProperty(`${prefix}radius`, colors.radius);
}

/**
 * Theme category labels for display
 */
export const categoryLabels: Record<ThemeCategory, string> = {
  minimal: 'Minimal',
  colorful: 'Colorful',
  dark: 'Dark',
  nature: 'Nature',
  tech: 'Tech',
  retro: 'Retro',
  other: 'Other',
};

export default themes;
