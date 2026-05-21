/**
 * Branding settings shape — strongly-typed view over the
 * `Settings.brandingSettings` JSON column.
 *
 * Every value is optional in the persisted JSON; the interface stays nullable
 * so the reading side can fall back to safe defaults without throwing.
 *
 * The `BgEffect` enum lists the predefined background-effect presets the
 * reiwa SPA knows how to render. Adding a new preset requires updates in
 * three places:
 *   1. `BG_EFFECTS` here,
 *   2. the SPA `BrandingProvider` switch,
 *   3. the admin configurator dropdown.
 */

export const BG_EFFECTS = ['NONE', 'MESH', 'PARTICLES', 'NOISE', 'AURORA'] as const;
export type BgEffect = (typeof BG_EFFECTS)[number];

export interface BrandingSettingsInterface {
  /** Display name shown on the subscription card and headers. */
  readonly brandName: string;
  /** Optional logo URL (data: or http(s)). */
  readonly logoUrl: string | null;

  /** Primary action / accent colour (hex, e.g. `#22c55e`). */
  readonly primary: string;
  /** Foreground colour for primary surfaces (hex). */
  readonly primaryFg: string;
  /** Page background colour (hex). */
  readonly bgPrimary: string;
  /** Surface background colour (hex). */
  readonly bgSecondary: string;

  /** CSS background string for the subscription card. */
  readonly cardGradient: string;
  /** Optional CSS background-image (pattern overlay) for the card. */
  readonly cardPattern: string | null;

  /** Site-wide background-effect preset. */
  readonly bgEffect: BgEffect;

  /** Tailwind-friendly border-radius token (e.g. `rounded-2xl`). */
  readonly borderRadius: string;
  /** Display font family. */
  readonly fontFamily: string;
}

export const DEFAULT_BRANDING: BrandingSettingsInterface = {
  brandName: 'Rezeis',
  logoUrl: null,
  primary: '#22c55e',
  primaryFg: '#0a0a0a',
  bgPrimary: '#0a0a0a',
  bgSecondary: '#171717',
  cardGradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
  cardPattern: null,
  bgEffect: 'NONE',
  borderRadius: 'rounded-2xl',
  fontFamily: 'Inter, system-ui, sans-serif',
};
